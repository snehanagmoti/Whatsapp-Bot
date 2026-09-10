const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../server');

process.env.NODE_ENV = 'test';
const servers = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function serve(options) {
    const server = createApp(options).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('Action Hub list uses the Looker Action API contract and requires its token', async () => {
    const base = await serve({ client: {}, lookerToken: 'secret', publicBaseUrl: 'https://bot.example.com' });
    const denied = await fetch(`${base}/actions`, { method: 'POST' });
    assert.equal(denied.status, 401);

    const response = await fetch(`${base}/actions`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"' }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.label, 'WhatsApp Screenshot Bot');
    assert.equal(body.integrations[0].supported_formats[0], 'wysiwyg_png');
    assert.equal(body.integrations[0].supported_download_settings[0], 'push');
    assert.equal(body.integrations[0].url, 'https://bot.example.com/looker/execute');
});

test('execute returns retryable failure while WhatsApp is disconnected', async () => {
    const base = await serve({ client: {}, isClientReady: () => false, lookerToken: 'secret' });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(response.status, 503);
});

test('execute delivers a valid PNG only to an approved chat', async () => {
    const deliveries = [];
    const client = { sendMessage: async (...args) => deliveries.push(args) };
    const chatId = '120363000000000000@g.us';
    const base = await serve({
        client,
        isClientReady: () => true,
        lookerToken: 'secret',
        allowedChatIds: new Set([chatId])
    });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scheduled_plan: { title: 'Sales' },
            attachment: { mimetype: 'image/png;base64', data: png },
            form_params: { chatId }
        })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).looker.success, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0][0], chatId);
    assert.equal(deliveries[0][2].caption, 'Looker dashboard: Sales');
});

test('execute rejects an unapproved destination', async () => {
    const base = await serve({
        client: { sendMessage: async () => assert.fail('must not send') },
        isClientReady: () => true,
        lookerToken: 'secret',
        allowedChatIds: new Set(['120363000000000000@g.us'])
    });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            attachment: { mimetype: 'image/png', data: png },
            form_params: { chatId: '120363999999999999@g.us' }
        })
    });
    assert.equal(response.status, 403);
});

test('execute returns a retryable upstream status when WhatsApp sending fails', async () => {
    const chatId = '120363000000000000@g.us';
    const base = await serve({
        client: { sendMessage: async () => { throw new Error('temporary send failure'); } },
        isClientReady: () => true,
        lookerToken: 'secret',
        allowedChatIds: new Set([chatId])
    });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            attachment: { mimetype: 'image/png', data: png },
            form_params: { chatId }
        })
    });
    assert.equal(response.status, 502);
});

test('Studio email ingestion requires its bearer token and invokes the service', async () => {
    const received = [];
    const base = await serve({
        client: {},
        studioIngestToken: 'studio-secret',
        studioEmailService: { process: async payload => { received.push(payload); return { deliveredPages: 1 }; } }
    });
    const denied = await fetch(`${base}/studio/email/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${base}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: 'gmail:test123' })
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).deliveredPages, 1);
    assert.equal(received.length, 1);
});

test('Studio ingestion reports configuration and service failures with safe status codes', async () => {
    const missing = await serve({ client: {}, studioIngestToken: 'studio-secret' });
    const unavailable = await fetch(`${missing}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(unavailable.status, 503);

    const failing = await serve({
        client: {},
        studioIngestToken: 'studio-secret',
        studioEmailService: { process: async () => { const error = new Error('Unknown report route.'); error.statusCode = 404; throw error; } }
    });
    const rejected = await fetch(`${failing}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(rejected.status, 404);
    assert.deepEqual(await rejected.json(), { success: false, error: 'Unknown report route.' });
});

test('health endpoints expose a safe application version without leaking environment values', async () => {
    const base = await serve({ client: {}, isClientReady: () => true });
    const response = await fetch(`${base}/versionz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(body.commit, null);

    const ready = await (await fetch(`${base}/readyz`)).json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.version, body.version);
});

test('QR setup uses a credential separate from the Looker Action token', async () => {
    const base = await serve({
        client: {},
        isClientReady: () => false,
        getLatestQr: () => 'test-whatsapp-qr-value',
        lookerToken: 'action-secret',
        qrSetupToken: 'qr-secret'
    });
    const wrongPurpose = await fetch(`${base}/setup/qr.svg`, {
        headers: { Authorization: 'Bearer action-secret' }
    });
    assert.equal(wrongPurpose.status, 401);
    const accepted = await fetch(`${base}/setup/qr.svg`, {
        headers: { Authorization: 'Bearer qr-secret' }
    });
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get('content-type'), /image\/svg\+xml/);
});

test('Studio ingestion is rate limited after authentication', async () => {
    const base = await serve({
        client: {},
        studioIngestToken: 'studio-secret',
        studioRateLimit: 1,
        studioEmailService: { process: async () => ({ deliveredPages: 0 }) }
    });
    const request = () => fetch(`${base}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
});

test('Studio ingestion rejects excess concurrent conversion work with a retryable status', async () => {
    let releaseFirst;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const hold = new Promise(resolve => { releaseFirst = resolve; });
    let calls = 0;
    const base = await serve({
        client: {},
        studioIngestToken: 'studio-secret',
        studioMaxConcurrent: 1,
        studioEmailService: {
            process: async () => {
                calls += 1;
                if (calls === 1) {
                    markStarted();
                    await hold;
                }
                return { deliveredPages: 0 };
            }
        }
    });
    const request = () => fetch(`${base}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: '{}'
    });
    const first = request();
    await started;
    const busy = await request();
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '10');
    releaseFirst();
    assert.equal((await first).status, 200);
    assert.equal(calls, 1);
});

test('Studio ingestion returns JSON for malformed and oversized request bodies', async () => {
    const base = await serve({
        client: {},
        studioIngestToken: 'studio-secret',
        studioRequestBytes: 32,
        studioEmailService: { process: async () => assert.fail('invalid bodies must not reach the service') }
    });
    const malformed = await fetch(`${base}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: '{not json'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid JSON body.' });

    const oversized = await fetch(`${base}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'x'.repeat(100) })
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'Request body exceeds the allowed size.' });
});

test('a disconnected ingest caller cannot free a slot while processing continues', async () => {
    let releaseWork;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const pending = new Promise(resolve => { releaseWork = resolve; });
    const base = await serve({
        client: {}, studioIngestToken: 'studio-secret', studioMaxConcurrent: 1,
        studioEmailService: { process: async () => { signalStarted(); await pending; return {}; } }
    });
    const headers = { Authorization: 'Bearer studio-secret', 'Content-Type': 'application/json' };
    const controller = new AbortController();
    const first = fetch(`${base}/studio/email/ingest`, {
        method: 'POST', headers, body: '{}', signal: controller.signal
    }).catch(error => error);
    await started;
    controller.abort();
    await first;
    // Give the server the socket-close event before checking the active slot.
    await new Promise(resolve => setTimeout(resolve, 25));
    const second = await fetch(`${base}/studio/email/ingest`, { method: 'POST', headers, body: '{}' });
    releaseWork();
    assert.equal(second.status, 503);
});
