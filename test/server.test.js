const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { once } = require('node:events');
const { createApp, createRateLimiter } = require('../server');

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
    // A wrong or missing token is "try again later", so the Gmail bridge keeps
    // the email and resends it once the tokens match again.
    assert.equal(denied.status, 503);
    assert.equal(denied.headers.get('retry-after'), '300');
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

test('the separate QR setup page and the Looker Action Hub are gone', async () => {
    const base = await serve({ client: {}, isClientReady: () => false, getLatestQr: () => 'qr-value', studioAdminToken: 'admin-secret' });
    for (const [method, path] of [['GET', '/setup/qr'], ['GET', '/setup/qr.svg'], ['POST', '/actions'], ['POST', '/looker/execute'], ['POST', '/looker/form']]) {
        assert.equal((await fetch(`${base}${path}`, { method })).status, 404, `${method} ${path}`);
    }
    const qr = await fetch(`${base}/admin/api/qr.svg`, { headers: { Authorization: 'Bearer admin-secret' } });
    assert.equal(qr.status, 200, 'the dashboard still serves the QR');
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
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

function fakeLimiterCall(limiter, { authorization = '', ip = '203.0.113.7' } = {}) {
    let passed = false;
    let statusCode = 200;
    const req = { get: () => authorization, ip, socket: {} };
    const res = { set() {}, status(code) { statusCode = code; return this; }, json() { return this; } };
    limiter(req, res, () => { passed = true; });
    return { passed, statusCode };
}

test('an IP-keyed limiter cannot be bypassed by inventing Authorization headers', () => {
    const limiter = createRateLimiter({ maxRequests: 3, keyBy: 'ip' });
    let passed = 0;
    for (let index = 0; index < 500; index += 1) {
        if (fakeLimiterCall(limiter, { authorization: `Bearer junk-${index}` }).passed) passed += 1;
    }
    assert.equal(passed, 3);
    assert.equal(limiter.bucketCount(), 1);
    assert.equal(fakeLimiterCall(limiter, { ip: '198.51.100.9' }).passed, true, 'other clients keep their own budget');
});

test('rate limiter sweeps expired buckets and caps the bucket table', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000, maxBuckets: 5, now: () => clock });
    for (let index = 0; index < 5; index += 1) fakeLimiterCall(limiter, { authorization: `Bearer ${index}` });
    assert.equal(limiter.bucketCount(), 5);
    const overflow = fakeLimiterCall(limiter, { authorization: 'Bearer overflow' });
    assert.equal(overflow.passed, false);
    assert.equal(overflow.statusCode, 429);

    clock += 1001;
    assert.equal(fakeLimiterCall(limiter, { authorization: 'Bearer after-window' }).passed, true);
    assert.equal(limiter.bucketCount(), 1, 'expired buckets are removed');
});
