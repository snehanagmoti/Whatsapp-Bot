const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { authenticateSession } = require('./screenshot');
const { isValidWhatsAppChatId, parseCsvSet } = require('./validation');

const DEFAULT_MAX_IMAGE_BYTES = 7 * 1024 * 1024;

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

function createApp({
    client,
    isClientReady = () => Boolean(client && client.info),
    lookerToken = process.env.LOOKER_ACTION_TOKEN,
    allowedChatIds = parseCsvSet(process.env.LOOKER_ALLOWED_CHAT_IDS),
    publicBaseUrl = process.env.PUBLIC_BASE_URL,
    enableCookieAuthPortal = process.env.ENABLE_COOKIE_AUTH_PORTAL === 'true',
    maxImageBytes = Number(process.env.LOOKER_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES
} = {}) {
    if (!client) throw new Error('A WhatsApp client is required.');
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false, limit: '256kb' }));
    app.use(express.json({ limit: '12mb' }));
    app.use(express.static(path.join(__dirname, 'public')));

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

    app.get('/healthz', (req, res) => res.json({ status: 'ok', whatsappReady: Boolean(isClientReady()) }));
    app.get('/readyz', (req, res) => {
        const ready = Boolean(isClientReady());
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
    });

    app.get('/login', (req, res) => {
        if (!enableCookieAuthPortal) return res.status(404).send('Not found.');
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    });
    app.post('/auth', async (req, res) => {
        if (!enableCookieAuthPortal) return res.status(404).send('Not found.');
        const { chatId, url, cookies } = req.body;
        if (!isValidWhatsAppChatId(chatId) || !url || !cookies) return res.status(400).send('Invalid or missing fields.');
        res.send('<h2>Session import is in progress.</h2><p>You may close this window.</p>');
        try {
            await authenticateSession(url, chatId, cookies);
            await client.sendMessage(chatId, `Successfully authenticated for: ${url}`);
        } catch (error) {
            console.error('Authentication failed:', error.message);
            await client.sendMessage(chatId, 'Authentication failed. Contact the bot operator.').catch(() => {});
        }
    });

    // Looker POSTs to the exact Action Hub URL configured by the administrator.
    app.post('/', requireToken, listActions);
    app.post('/actions', requireToken, listActions);
    app.post('/actions.json', requireToken, listActions);
    app.get('/actions.json', requireToken, listActions);

    app.post('/looker/form', requireToken, (req, res) => res.json([
        { name: 'chatId', label: 'WhatsApp Chat ID', description: 'An approved ID returned by !chatid.', type: 'string', required: true },
        { name: 'customMessage', label: 'Custom Message (Optional)', description: 'Optional caption (maximum 1,024 characters).', type: 'string', required: false }
    ]));

    app.post('/looker/execute', requireToken, async (req, res) => {
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
            const media = new MessageMedia('image/png', image.toString('base64'), 'looker_dashboard.png');
            await client.sendMessage(chatId, media, { caption });
            return res.json({ looker: { success: true } });
        } catch (error) {
            console.error('Looker action failed:', error.message);
            return res.status(400).json({ looker: { success: false, message: error.message } });
        }
    });

    app.use((error, req, res, next) => {
        if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON body.' });
        return next(error);
    });
    return app;
}

function startServer(client, options = {}) {
    const app = createApp({ client, ...options });
    const port = Number(process.env.PORT) || 3000;
    return app.listen(port, '0.0.0.0', () => console.log(`HTTP server listening on port ${port}`));
}

module.exports = { buildActionList, createApp, decodePngBase64, parseLookerAuthorization, startServer };
