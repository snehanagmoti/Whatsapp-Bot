const crypto = require('crypto');
const express = require('express');
const path = require('path');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const { isValidWhatsAppChatId, parseCsvSet } = require('./validation');
const { version: APP_VERSION } = require('./package.json');

const DEFAULT_MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const DEFAULT_STUDIO_REQUEST_BYTES = 22 * 1024 * 1024;

function parseLookerAuthorization(header = '') {
    const match = /^Token\s+token="([^"]+)"$/i.exec(header.trim());
    return match ? match[1] : null;
}

function secretsMatch(actual, expected) {
    if (!actual || !expected) return false;
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createRateLimiter({ maxRequests = 30, windowMs = 60_000 } = {}) {
    const buckets = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const authorization = req.get('authorization') || '';
        const identity = authorization || req.ip || req.socket.remoteAddress || 'unknown';
        const key = crypto.createHash('sha256').update(identity).digest('hex');
        let bucket = buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)));
        if (bucket.count <= maxRequests) return next();
        res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        return res.status(429).json({ error: 'Too many requests. Retry later.' });
    };
}

function createConcurrencyGate(maxConcurrent = 2) {
    let active = 0;
    return (req, res, next) => {
        if (active >= maxConcurrent) {
            res.set('Retry-After', '10');
            return res.status(503).json({ error: 'Report processing is busy. Retry later.' });
        }
        active += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            active = Math.max(0, active - 1);
        };
        res.locals.releaseConcurrencySlot = release;
        res.once('finish', release);
        // A disconnected HTTP caller does not stop Poppler or WhatsApp work.
        // Keep its slot occupied until that work has actually settled.
        res.once('close', () => {
            if (!res.locals.concurrencyWorkStarted) release();
        });
        return next();
    };
}

function deploymentInfo() {
    const candidate = process.env.RENDER_GIT_COMMIT || process.env.APP_COMMIT || '';
    const commit = /^[a-f0-9]{7,40}$/i.test(candidate) ? candidate.toLowerCase() : null;
    return { version: APP_VERSION, commit };
}

function decodePngBase64(value, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
    if (typeof value !== 'string') throw new Error('Image attachment data must be a base64 string.');
    const data = value.replace(/^data:image\/png;base64,/i, '').replace(/\s/g, '');
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error('Image attachment is not valid base64.');
    }
    const image = Buffer.from(data, 'base64');
    if (!image.length || image.length > maxBytes) throw new Error('Image attachment exceeds the allowed size.');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (image.length < 8 || !image.subarray(0, 8).equals(png)) throw new Error('Only PNG attachments are supported.');
    return image;
}

function buildActionList(baseUrl) {
    return {
        label: 'WhatsApp Screenshot Bot',
        integrations: [{
            name: 'whatsapp_bot',
            label: 'WhatsApp Bot',
            description: 'Send a rendered Looker dashboard to an approved WhatsApp destination.',
            url: `${baseUrl}/looker/execute`,
            form_url: `${baseUrl}/looker/form`,
            supported_action_types: ['query', 'dashboard'],
            supported_formats: ['wysiwyg_png'],
            supported_download_settings: ['push'],
            uses_oauth: false,
            params: []
        }]
    };
}

function sanitizeRoute(route) {
    if (!route) return null;
    return {
        id: String(route._id),
        chatId: route.chatId,
        name: route.name,
        status: route.status,
        createdAt: route.createdAt,
        updatedAt: route.updatedAt
    };
}

function sanitizeDelivery(delivery) {
    if (!delivery) return null;
    return {
        chatId: delivery.chatId,
        routeId: delivery.routeId ? String(delivery.routeId) : null,
        subject: delivery.subject || '',
        status: delivery.status,
        deliveredPages: delivery.deliveredPages || 0,
        totalPages: delivery.totalPages ?? null,
        attempts: delivery.attempts || 0,
        error: delivery.error || null,
        nextAttemptAt: delivery.nextAttemptAt || null,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt
    };
}

function handleAdminRouteError(res, error) {
    if (error && error.code === 11000) {
        return res.status(409).json({ error: 'A report route with that name already exists for this chat. Use rotate instead.' });
    }
    if (error && error.code === 'ROUTE_QUOTA_EXCEEDED') {
        return res.status(error.statusCode || 409).json({ error: error.message });
    }
    console.error('Admin route request failed:', error && (error.message || error));
    return res.status(500).json({ error: 'Could not complete the request.' });
}

function qrToSvg(value) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(value);
    qr.make();
    const quietZone = 4;
    const size = qr.getModuleCount() + (quietZone * 2);
    const cells = [];
    for (let row = 0; row < qr.getModuleCount(); row += 1) {
        for (let col = 0; col < qr.getModuleCount(); col += 1) {
            if (qr.isDark(row, col)) cells.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${cells.join('')}" fill="black"/></svg>`;
}

function createApp({
    client,
    isClientReady = () => Boolean(client && client.info),
    getLatestQr = () => null,
    lookerToken = process.env.LOOKER_ACTION_TOKEN,
    allowedChatIds = parseCsvSet(process.env.LOOKER_ALLOWED_CHAT_IDS),
    publicBaseUrl = process.env.PUBLIC_BASE_URL,
    maxImageBytes = Number(process.env.LOOKER_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES,
    studioEmailService = null,
    routeService = null,
    studioStore = null,
    studioIngestToken = process.env.STUDIO_INGEST_TOKEN_OVERRIDE || process.env.STUDIO_INGEST_TOKEN,
    qrSetupToken = process.env.QR_SETUP_TOKEN || (process.env.NODE_ENV === 'production' ? undefined : lookerToken),
    studioAdminToken = process.env.STUDIO_ADMIN_TOKEN
        || (process.env.NODE_ENV === 'production' ? undefined : (process.env.QR_SETUP_TOKEN || lookerToken)),
    studioRateLimit = positiveInteger(process.env.STUDIO_RATE_LIMIT_PER_MINUTE, 30),
    actionRateLimit = positiveInteger(process.env.LOOKER_RATE_LIMIT_PER_MINUTE, 30),
    adminRateLimit = positiveInteger(process.env.STUDIO_ADMIN_RATE_LIMIT_PER_MINUTE, 60),
    studioMaxConcurrent = positiveInteger(process.env.STUDIO_MAX_CONCURRENT_INGESTS, 2),
    studioRequestBytes = positiveInteger(process.env.STUDIO_MAX_REQUEST_BYTES, DEFAULT_STUDIO_REQUEST_BYTES)
} = {}) {
    if (!client) throw new Error('A WhatsApp client is required.');
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(express.static(path.join(__dirname, 'public')));
    const actionBody = [express.urlencoded({ extended: false, limit: '256kb' }), express.json({ limit: '10mb' })];
    const studioBody = express.json({ limit: studioRequestBytes });
    const limitStudio = createRateLimiter({ maxRequests: studioRateLimit });
    const limitActions = createRateLimiter({ maxRequests: actionRateLimit });
    const limitAdmin = createRateLimiter({ maxRequests: adminRateLimit });
    const gateStudio = createConcurrencyGate(studioMaxConcurrent);
    const adminBody = express.json({ limit: '64kb' });

    const baseUrl = publicBaseUrl && publicBaseUrl.replace(/\/$/, '');
    const requireToken = (req, res, next) => {
        if (!lookerToken) {
            if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'LOOKER_ACTION_TOKEN is not configured.' });
            return next();
        }
        const supplied = parseLookerAuthorization(req.get('authorization'));
        return secretsMatch(supplied, lookerToken) ? next() : res.status(401).json({ error: 'Unauthorized.' });
    };
    const listActions = (req, res) => res.json(buildActionList(baseUrl || `${req.protocol}://${req.get('host')}`));
    const requireStudioToken = (req, res, next) => {
        if (!studioIngestToken) return res.status(503).json({ error: 'STUDIO_INGEST_TOKEN is not configured.' });
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        const supplied = match && match[1];
        if (supplied && secretsMatch(supplied, studioIngestToken)) return next();
        console.warn('Studio ingestion token rejected.');
        return res.status(401).json({ error: 'Unauthorized.' });
    };
    const requireAdminToken = (req, res, next) => {
        if (!studioAdminToken) return res.status(503).json({ error: 'STUDIO_ADMIN_TOKEN is not configured.' });
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        const supplied = match && match[1];
        if (supplied && secretsMatch(supplied, studioAdminToken)) return next();
        console.warn('Admin dashboard token rejected.');
        return res.status(401).json({ error: 'Unauthorized.' });
    };
    const requireRouting = (req, res, next) => {
        if (!routeService || !studioStore) {
            return res.status(503).json({ error: 'Looker Studio email routing is not configured on this bot.' });
        }
        return next();
    };

    app.get('/healthz', (req, res) => res.json({
        status: 'ok',
        whatsappReady: Boolean(isClientReady()),
        ...deploymentInfo()
    }));
    app.get('/readyz', (req, res) => {
        const ready = Boolean(isClientReady());
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', ...deploymentInfo() });
    });
    app.get('/versionz', (req, res) => res.json(deploymentInfo()));

    // Render's log viewer distorts terminal QR blocks. This setup-only page
    // fetches a clean SVG using its own setup credential. Keeping the token in
    // the URL fragment prevents it from being sent in request URLs.
    app.get('/setup/qr', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; connect-src 'self'; img-src blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
        res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link WhatsApp Bot</title><style>body{font-family:system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#f5f7f8;color:#172b24}.card{width:min(92vw,520px);padding:28px;background:#fff;border-radius:18px;box-shadow:0 10px 35px #0002;text-align:center}img{width:min(78vw,430px);height:auto;image-rendering:pixelated}p{line-height:1.5}.error{color:#a62929}</style></head><body><main class="card"><h1>Link WhatsApp Bot</h1><p id="status">Loading the latest secure QR code…</p><img id="qr" alt="WhatsApp linking QR code" hidden></main><script>const token=location.hash.slice(1);const status=document.getElementById('status');const image=document.getElementById('qr');async function refresh(){if(!token){status.className='error';status.textContent='The secure setup link is incomplete.';return;}try{const response=await fetch('/setup/qr.svg',{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(response.status===409){image.hidden=true;status.textContent='Connected successfully. You may close this page.';return;}if(!response.ok){image.hidden=true;status.className='error';status.textContent=response.status===425?'Waiting for a fresh QR code…':'Unable to load the QR code.';return;}const blob=await response.blob();const old=image.src;image.src=URL.createObjectURL(blob);if(old)URL.revokeObjectURL(old);image.hidden=false;status.className='';status.textContent='WhatsApp → Settings → Linked devices → Link a device';}catch{status.className='error';status.textContent='Could not refresh the QR code.';}}refresh();setInterval(refresh,5000);</script></body></html>`);
    });

    app.get('/setup/qr.svg', (req, res) => {
        if (!qrSetupToken) return res.status(503).send('Setup token is not configured.');
        const supplied = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        if (!supplied || !secretsMatch(supplied[1], qrSetupToken)) return res.status(401).send('Unauthorized.');
        if (isClientReady()) return res.status(409).send('WhatsApp is already connected.');
        const qr = getLatestQr();
        if (!qr) return res.status(425).send('Waiting for a QR code.');
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.type('image/svg+xml').send(qrToSvg(qr));
    });

    // Management dashboard API. Separate from the QR setup token and the
    // Studio ingestion token so an operator's dashboard credential does not
    // have to be handed to whoever only needs to complete the WhatsApp link.
    app.get('/admin/api/status', limitAdmin, requireAdminToken, (req, res) => res.json({
        whatsappReady: Boolean(isClientReady()),
        studioConfigured: Boolean(routeService && studioStore),
        qrAvailable: Boolean(getLatestQr()),
        ...deploymentInfo()
    }));

    app.get('/admin/api/qr.svg', limitAdmin, requireAdminToken, (req, res) => {
        if (isClientReady()) return res.status(409).json({ error: 'WhatsApp is already connected.' });
        const qr = getLatestQr();
        if (!qr) return res.status(425).json({ error: 'Waiting for a QR code.' });
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.type('image/svg+xml').send(qrToSvg(qr));
    });

    app.get('/admin/api/routes', limitAdmin, requireAdminToken, requireRouting, async (req, res) => {
        try {
            const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : '';
            if (chatId && !isValidWhatsAppChatId(chatId)) {
                return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
            }
            const routes = chatId ? await routeService.listRoutes(chatId) : await studioStore.listAllRoutes({ limit: 500 });
            return res.json({ routes: routes.map(sanitizeRoute) });
        } catch (error) {
            console.error('Admin route listing failed:', error.message || error);
            return res.status(500).json({ error: 'Could not list report routes.' });
        }
    });

    app.post('/admin/api/routes', limitAdmin, requireAdminToken, requireRouting, adminBody, async (req, res) => {
        const chatId = typeof req.body.chatId === 'string' ? req.body.chatId.trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        if (!name || name.length > 80) return res.status(400).json({ error: 'Report name must be 1-80 characters.' });
        try {
            const created = await routeService.createRoute({ chatId, name, createdBy: 'admin-dashboard' });
            return res.status(201).json({ route: sanitizeRoute(created.route), address: created.address });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    });

    app.post('/admin/api/routes/status', limitAdmin, requireAdminToken, requireRouting, adminBody, async (req, res) => {
        const chatId = typeof req.body.chatId === 'string' ? req.body.chatId.trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const status = req.body.status;
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        if (!name) return res.status(400).json({ error: 'A report name is required.' });
        if (status !== 'active' && status !== 'paused') return res.status(400).json({ error: 'status must be "active" or "paused".' });
        try {
            const route = await routeService.setRouteStatus(chatId, name, status);
            if (!route) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ route: sanitizeRoute(route) });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    });

    app.post('/admin/api/routes/rotate', limitAdmin, requireAdminToken, requireRouting, adminBody, async (req, res) => {
        const chatId = typeof req.body.chatId === 'string' ? req.body.chatId.trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        if (!name) return res.status(400).json({ error: 'A report name is required.' });
        try {
            const rotated = await routeService.rotateRoute(chatId, name);
            if (!rotated) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ route: sanitizeRoute(rotated.route), address: rotated.address });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    });

    app.post('/admin/api/routes/remove', limitAdmin, requireAdminToken, requireRouting, adminBody, async (req, res) => {
        const chatId = typeof req.body.chatId === 'string' ? req.body.chatId.trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        if (!name) return res.status(400).json({ error: 'A report name is required.' });
        if (req.body.confirm !== true) return res.status(400).json({ error: 'Set confirm:true to permanently remove this route.' });
        try {
            const removed = await routeService.removeRoute(chatId, name);
            if (!removed) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ removed: true });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    });

    app.get('/admin/api/deliveries', limitAdmin, requireAdminToken, requireRouting, async (req, res) => {
        const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : '';
        if (chatId && !isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        try {
            const deliveries = await studioStore.listRecentDeliveries({ chatId: chatId || undefined, limit });
            return res.json({ deliveries: deliveries.map(sanitizeDelivery) });
        } catch (error) {
            console.error('Admin delivery listing failed:', error.message || error);
            return res.status(500).json({ error: 'Could not list recent deliveries.' });
        }
    });

    app.post('/studio/email/ingest', requireStudioToken, limitStudio, gateStudio, studioBody, async (req, res) => {
        if (!studioEmailService) return res.status(503).json({ error: 'Looker Studio email ingestion is not configured.' });
        res.locals.concurrencyWorkStarted = true;
        try {
            const result = await studioEmailService.process(req.body || {});
            console.log('Looker Studio email delivery completed:', {
                messageId: req.body && req.body.messageId,
                duplicate: Boolean(result.duplicate),
                deliveredPages: result.deliveredPages,
                deliveredRoutes: result.deliveredRoutes,
                duplicateRoutes: result.duplicateRoutes,
                skippedPausedRoutes: result.skippedPausedRoutes
            });
            return res.json({ success: true, ...result });
        } catch (error) {
            console.error('Looker Studio email ingestion failed:', error.message || error);
            return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Delivery failed.' });
        } finally {
            res.locals.releaseConcurrencySlot();
        }
    });

    // Looker POSTs to the exact Action Hub URL configured by the administrator.
    app.post('/', requireToken, limitActions, listActions);
    app.post('/actions', requireToken, limitActions, listActions);
    app.post('/actions.json', requireToken, limitActions, listActions);
    app.get('/actions.json', requireToken, listActions);

    app.post('/looker/form', requireToken, limitActions, ...actionBody, (req, res) => res.json([
        { name: 'chatId', label: 'WhatsApp Chat ID', description: 'An approved ID returned by !chatid.', type: 'string', required: true },
        { name: 'customMessage', label: 'Custom Message (Optional)', description: 'Optional caption (maximum 1,024 characters).', type: 'string', required: false }
    ]));

    app.post('/looker/execute', requireToken, limitActions, ...actionBody, async (req, res) => {
        try {
            if (!isClientReady()) return res.status(503).json({ looker: { success: false, message: 'WhatsApp is not connected.' } });
            const payload = req.body || {};
            const form = payload.form_params || {};
            const chatId = typeof form.chatId === 'string' ? form.chatId.trim() : '';
            if (!isValidWhatsAppChatId(chatId)) {
                return res.status(400).json({ looker: { success: false, validation_errors: { chatId: 'Enter a valid WhatsApp ID.' } } });
            }
            if (!allowedChatIds.size && process.env.NODE_ENV === 'production') {
                return res.status(503).json({ looker: { success: false, message: 'No WhatsApp destinations are configured.' } });
            }
            if (allowedChatIds.size && !allowedChatIds.has(chatId)) {
                return res.status(403).json({ looker: { success: false, validation_errors: { chatId: 'Destination is not approved.' } } });
            }
            const attachment = payload.attachment;
            if (!attachment || !/^image\/png(?:;base64)?$/i.test(attachment.mimetype || '')) {
                return res.status(400).json({ looker: { success: false, message: 'A base64 PNG attachment is required.' } });
            }
            const image = decodePngBase64(attachment.data, maxImageBytes);
            const customMessage = typeof form.customMessage === 'string' ? form.customMessage.trim() : '';
            if (customMessage.length > 1024) {
                return res.status(400).json({ looker: { success: false, validation_errors: { customMessage: 'Caption is too long.' } } });
            }
            const title = payload.scheduled_plan && typeof payload.scheduled_plan.title === 'string'
                ? payload.scheduled_plan.title.trim().slice(0, 200) : '';
            const caption = customMessage || (title ? `Looker dashboard: ${title}` : 'Looker dashboard');
            const media = { mimetype: 'image/png', data: image.toString('base64'), filename: 'looker_dashboard.png' };
            await client.sendMessage(chatId, media, { caption });
            return res.json({ looker: { success: true } });
        } catch (error) {
            console.error('Looker action failed:', error.message);
            return res.status(502).json({ looker: { success: false, message: error.message || 'WhatsApp delivery failed.' } });
        }
    });

    app.use((error, req, res, next) => {
        if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON body.' });
        if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body exceeds the allowed size.' });
        console.error('HTTP request failed:', error && (error.message || error));
        return res.status(500).json({ error: 'Internal server error.' });
    });
    return app;
}

function startServer(client, options = {}) {
    const app = createApp({ client, ...options });
    const port = Number(process.env.PORT) || 3000;
    return app.listen(port, '0.0.0.0', () => console.log(`HTTP server listening on port ${port}`));
}

module.exports = {
    buildActionList,
    createApp,
    createConcurrencyGate,
    createRateLimiter,
    decodePngBase64,
    deploymentInfo,
    parseLookerAuthorization,
    startServer
};
