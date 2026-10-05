const crypto = require('crypto');
const express = require('express');
const path = require('path');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const { isValidWhatsAppChatId } = require('./validation');
const { version: APP_VERSION } = require('./package.json');

const DEFAULT_STUDIO_REQUEST_BYTES = 22 * 1024 * 1024;

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

// Fixed-window limiter. `keyBy: 'credential'` buckets by the Authorization
// header and must only be mounted after authentication, so the key space is
// bounded by valid secrets. Limiters mounted before authentication must use
// `keyBy: 'ip'`; otherwise every invented token would get a fresh bucket,
// bypassing the limit and growing memory without bound. Expired buckets are
// swept once per window and the table size is capped.
// Render sits behind Cloudflare, so req.ip is the address of whichever
// Cloudflare server forwarded the request, and it changes from request to
// request: every request landed in a fresh bucket and limits never applied.
// Cloudflare puts the visitor's own address in CF-Connecting-IP (and
// True-Client-IP); use it when present, otherwise fall back to req.ip.
function clientAddress(req) {
    const forwarded = String(req.get('cf-connecting-ip') || req.get('true-client-ip') || '').trim();
    if (forwarded && forwarded.length <= 64 && /^[0-9a-fA-F:.]+$/.test(forwarded)) return forwarded;
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createRateLimiter({
    maxRequests = 30,
    windowMs = 60_000,
    keyBy = 'credential',
    maxBuckets = 10_000,
    now = () => Date.now()
} = {}) {
    if (keyBy !== 'credential' && keyBy !== 'ip') throw new Error('keyBy must be "credential" or "ip".');
    const buckets = new Map();
    let nextSweepAt = 0;
    const sweep = currentMs => {
        for (const [key, bucket] of buckets) {
            if (currentMs >= bucket.resetAt) buckets.delete(key);
        }
        nextSweepAt = currentMs + windowMs;
    };
    const limiter = (req, res, next) => {
        const currentMs = now();
        if (currentMs >= nextSweepAt) sweep(currentMs);
        const address = clientAddress(req);
        const identity = keyBy === 'ip' ? `ip:${address}` : (req.get('authorization') || `ip:${address}`);
        const key = crypto.createHash('sha256').update(identity).digest('hex');
        let bucket = buckets.get(key);
        if (!bucket || currentMs >= bucket.resetAt) {
            if (!bucket && buckets.size >= maxBuckets) {
                res.set('Retry-After', String(Math.max(1, Math.ceil((nextSweepAt - currentMs) / 1000))));
                return res.status(429).json({ error: 'Too many requests. Retry later.' });
            }
            bucket = { count: 0, resetAt: currentMs + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)));
        if (bucket.count <= maxRequests) return next();
        res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - currentMs) / 1000))));
        return res.status(429).json({ error: 'Too many requests. Retry later.' });
    };
    limiter.bucketCount = () => buckets.size;
    return limiter;
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
        messageId: delivery.messageId || null,
        chatId: delivery.chatId,
        routeId: delivery.routeId ? String(delivery.routeId) : null,
        subject: delivery.subject || '',
        status: delivery.status,
        deliveredPages: delivery.deliveredPages || 0,
        totalPages: delivery.totalPages ?? null,
        attempts: delivery.attempts || 0,
        error: delivery.error || null,
        nextAttemptAt: delivery.nextAttemptAt || null,
        // Only dead letters whose source PDF is still stored can be retried.
        canRetry: delivery.status === 'dead_letter' && Boolean(delivery.pdfRef),
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

function bodyText(req, field) {
    return typeof req.body[field] === 'string' ? req.body[field].trim() : '';
}

// The route-management actions shared by the admin dashboard (any chat, chat
// ID in the request) and the chat dashboard (one chat, chat ID fixed by the
// login). `chatIdOf(req)` decides which chat a request may touch.
function registerRouteApi(app, prefix, guards, { routeService, studioStore, chatIdOf, createdBy, deliveryChatIdOf }) {
    const withChat = handler => async (req, res) => {
        const chatId = chatIdOf(req);
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        return handler(req, res, chatId);
    };
    const withName = handler => withChat(async (req, res, chatId) => {
        const name = bodyText(req, 'name');
        if (!name) return res.status(400).json({ error: 'A report name is required.' });
        return handler(req, res, chatId, name);
    });

    app.post(`${prefix}/routes`, ...guards, withChat(async (req, res, chatId) => {
        const name = bodyText(req, 'name');
        if (!name || name.length > 80) return res.status(400).json({ error: 'Report name must be 1-80 characters.' });
        try {
            const created = await routeService.createRoute({ chatId, name, createdBy });
            return res.status(201).json({ route: sanitizeRoute(created.route), address: created.address });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    }));

    app.post(`${prefix}/routes/status`, ...guards, withName(async (req, res, chatId, name) => {
        const status = req.body.status;
        if (status !== 'active' && status !== 'paused') return res.status(400).json({ error: 'status must be "active" or "paused".' });
        try {
            const route = await routeService.setRouteStatus(chatId, name, status);
            if (!route) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ route: sanitizeRoute(route) });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    }));

    app.post(`${prefix}/routes/rotate`, ...guards, withName(async (req, res, chatId, name) => {
        try {
            const rotated = await routeService.rotateRoute(chatId, name);
            if (!rotated) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ route: sanitizeRoute(rotated.route), address: rotated.address });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    }));

    app.post(`${prefix}/routes/remove`, ...guards, withName(async (req, res, chatId, name) => {
        if (req.body.confirm !== true) return res.status(400).json({ error: 'Set confirm:true to permanently remove this route.' });
        try {
            const removed = await routeService.removeRoute(chatId, name);
            if (!removed) return res.status(404).json({ error: 'Report route not found.' });
            return res.json({ removed: true });
        } catch (error) {
            return handleAdminRouteError(res, error);
        }
    }));

    app.get(`${prefix}/deliveries`, ...guards, async (req, res) => {
        const chatId = deliveryChatIdOf(req);
        if (chatId && !isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        try {
            const deliveries = await studioStore.listRecentDeliveries({ chatId: chatId || undefined, limit });
            return res.json({ deliveries: deliveries.map(sanitizeDelivery) });
        } catch (error) {
            console.error('Delivery listing failed:', error.message || error);
            return res.status(500).json({ error: 'Could not list recent deliveries.' });
        }
    });

    app.post(`${prefix}/deliveries/retry`, ...guards, withChat(async (req, res, chatId) => {
        const messageId = bodyText(req, 'messageId');
        if (!/^[A-Za-z0-9._:@/-]{6,250}$/.test(messageId)) return res.status(400).json({ error: 'A valid messageId is required.' });
        try {
            const result = await studioStore.requeueDelivery(messageId, chatId);
            if (result.status === 'requeued') {
                return res.json({ requeued: true, message: 'Queued. The delivery worker retries it within about a minute.' });
            }
            if (result.status === 'not_found') return res.status(404).json({ error: 'Delivery not found.' });
            if (result.status === 'pdf_missing') {
                return res.status(410).json({ error: 'The stored report PDF has expired. Send the report again from Looker Studio.' });
            }
            return res.status(409).json({ error: `Only deliveries that gave up can be retried (current status: ${result.current || 'unknown'}).` });
        } catch (error) {
            console.error('Delivery retry failed:', error.message || error);
            return res.status(500).json({ error: 'Could not queue the retry.' });
        }
    }));
}

function createApp({
    client,
    isClientReady = () => Boolean(client && client.info),
    getLatestQr = () => null,
    studioEmailService = null,
    routeService = null,
    studioStore = null,
    studioIngestToken = process.env.STUDIO_INGEST_TOKEN_OVERRIDE || process.env.STUDIO_INGEST_TOKEN,
    studioAdminToken = process.env.STUDIO_ADMIN_TOKEN,
    studioRateLimit = positiveInteger(process.env.STUDIO_RATE_LIMIT_PER_MINUTE, 30),
    adminRateLimit = positiveInteger(process.env.STUDIO_ADMIN_RATE_LIMIT_PER_MINUTE, 60),
    studioMaxConcurrent = positiveInteger(process.env.STUDIO_MAX_CONCURRENT_INGESTS, 2),
    studioRequestBytes = positiveInteger(process.env.STUDIO_MAX_REQUEST_BYTES, DEFAULT_STUDIO_REQUEST_BYTES)
} = {}) {
    if (!client) throw new Error('A WhatsApp client is required.');
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    // Status, QR and API answers change from second to second and some carry
    // per-chat data: browsers must never reuse a saved copy. (A cached
    // /admin/api/status left the dashboard stuck on "Could not load status".)
    app.use((req, res, next) => {
        if (/^\/(admin\/api|chat\/api|studio)\//.test(req.path) || /^\/(healthz|readyz|versionz)$/.test(req.path)) {
            res.set('Cache-Control', 'no-store');
        }
        next();
    });
    app.use(express.static(path.join(__dirname, 'public')));
    const studioBody = express.json({ limit: studioRequestBytes });
    const limitStudio = createRateLimiter({ maxRequests: studioRateLimit });
    // Dashboard endpoints are throttled before their login check, so they are
    // keyed by client address (Express resolves it via `trust proxy`).
    const limitAdmin = createRateLimiter({ maxRequests: adminRateLimit, keyBy: 'ip' });
    const limitChat = createRateLimiter({ maxRequests: adminRateLimit, keyBy: 'ip' });
    const gateStudio = createConcurrencyGate(studioMaxConcurrent);
    const jsonBody = express.json({ limit: '64kb' });

    const requireStudioToken = (req, res, next) => {
        if (!studioIngestToken) return res.status(503).json({ error: 'STUDIO_INGEST_TOKEN is not configured.' });
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        const supplied = match && match[1];
        if (supplied && secretsMatch(supplied, studioIngestToken)) return next();
        // Answer "try again later" rather than 401: the Gmail bridge treats a
        // 4xx as permanent, so a token mismatch (for example after changing it
        // on one side only) would otherwise drop every report sent meanwhile.
        console.warn('Studio ingestion token rejected. Check that Apps Script BOT_INGEST_TOKEN matches STUDIO_INGEST_TOKEN.');
        res.set('Retry-After', '300');
        return res.status(503).json({ error: 'Ingest token rejected. Retry after fixing the token.' });
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
    // The chat dashboard logs in with a chat ID only (by design: simple to
    // use). The ID is sent as X-Chat-Id and every chat endpoint is limited to
    // that one chat.
    // Chat IDs never contain spaces or WhatsApp formatting marks; drop any
    // that were copied along with the ID (for example a stray '*').
    const chatHeader = req => String(req.get('x-chat-id') || '').replace(/[\s*_~`]/g, '');

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

    // ---- Admin dashboard API (every chat; STUDIO_ADMIN_TOKEN) ----
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

    registerRouteApi(app, '/admin/api', [limitAdmin, requireAdminToken, requireRouting, jsonBody], {
        routeService, studioStore,
        createdBy: 'admin-dashboard',
        chatIdOf: req => bodyText(req, 'chatId'),
        deliveryChatIdOf: req => (typeof req.query.chatId === 'string' ? req.query.chatId.trim() : '')
    });

    // ---- Chat dashboard API (one chat; logged in with its chat ID) ----
    app.get('/chat/api/routes', limitChat, requireRouting, async (req, res) => {
        const chatId = chatHeader(req);
        if (!isValidWhatsAppChatId(chatId)) return res.status(400).json({ error: 'Enter a valid WhatsApp chat ID.' });
        try {
            const routes = await routeService.listRoutes(chatId);
            return res.json({ chatId, whatsappReady: Boolean(isClientReady()), routes: routes.map(sanitizeRoute) });
        } catch (error) {
            console.error('Chat route listing failed:', error.message || error);
            return res.status(500).json({ error: 'Could not list report routes.' });
        }
    });

    registerRouteApi(app, '/chat/api', [limitChat, requireRouting, jsonBody], {
        routeService, studioStore,
        createdBy: 'chat-dashboard',
        chatIdOf: chatHeader,
        deliveryChatIdOf: req => chatHeader(req) || 'missing'
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
    createApp,
    createConcurrencyGate,
    createRateLimiter,
    deploymentInfo,
    startServer
};
