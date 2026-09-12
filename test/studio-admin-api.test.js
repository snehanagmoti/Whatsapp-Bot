const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../server');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

process.env.NODE_ENV = 'test';
const servers = [];

async function serve(options) {
    const server = createApp(options).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

async function withRouting(extraOptions = {}) {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const base = await serve({
        client: {},
        studioAdminToken: 'admin-secret',
        routeService,
        studioStore: store,
        ...extraOptions
    });
    return { base, store, routeService };
}

function authed(base, path, init = {}) {
    return fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: 'Bearer admin-secret', ...(init.headers || {}) }
    });
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('admin API rejects requests without a valid bearer token', async () => {
    const { base } = await withRouting();
    const missing = await fetch(`${base}/admin/api/status`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${base}/admin/api/status`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
});

test('admin API is disabled with a clear error when no token is configured', async () => {
    const base = await serve({ client: {}, studioAdminToken: undefined });
    const response = await fetch(`${base}/admin/api/status`, { headers: { Authorization: 'Bearer anything' } });
    assert.equal(response.status, 503);
});

test('status reports WhatsApp readiness and studio configuration', async () => {
    const { base } = await withRouting({ isClientReady: () => true, studioEmailService: {} });
    const response = await authed(base, '/admin/api/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.whatsappReady, true);
    assert.equal(body.studioConfigured, true);
});

test('admin API responds 503 for route endpoints when routing is not configured', async () => {
    const base = await serve({ client: {}, studioAdminToken: 'admin-secret' });
    const response = await authed(base, '/admin/api/routes');
    assert.equal(response.status, 503);
});

test('create, list, pause, resume, rotate and remove a route end to end', async () => {
    const { base } = await withRouting();
    const chatId = '123@g.us';

    const created = await authed(base, '/admin/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales' })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.match(createdBody.address, /reports\+[a-f0-9]+@example\.com/);
    assert.equal(createdBody.route.status, 'active');
    assert.equal(createdBody.route.chatId, chatId);
    assert.equal(createdBody.route.tokenHash, undefined, 'route listing must never expose the token hash');

    const listed = await authed(base, `/admin/api/routes?chatId=${encodeURIComponent(chatId)}`);
    const listedBody = await listed.json();
    assert.equal(listedBody.routes.length, 1);

    const paused = await authed(base, '/admin/api/routes/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales', status: 'paused' })
    });
    assert.equal((await paused.json()).route.status, 'paused');

    const resumed = await authed(base, '/admin/api/routes/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales', status: 'active' })
    });
    assert.equal((await resumed.json()).route.status, 'active');

    const rotated = await authed(base, '/admin/api/routes/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales' })
    });
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json();
    assert.notEqual(rotatedBody.address, createdBody.address);

    const removeWithoutConfirm = await authed(base, '/admin/api/routes/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales' })
    });
    assert.equal(removeWithoutConfirm.status, 400);

    const removed = await authed(base, '/admin/api/routes/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales', confirm: true })
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).removed, true);

    const listedAfterRemoval = await authed(base, `/admin/api/routes?chatId=${encodeURIComponent(chatId)}`);
    assert.equal((await listedAfterRemoval.json()).routes.length, 0);
});

test('rejects an invalid chat ID and a duplicate route name', async () => {
    const { base } = await withRouting();
    const invalid = await authed(base, '/admin/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'not-a-chat-id', name: 'X' })
    });
    assert.equal(invalid.status, 400);

    const chatId = '123@g.us';
    await authed(base, '/admin/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales' })
    });
    const duplicate = await authed(base, '/admin/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, name: 'Daily Sales' })
    });
    assert.equal(duplicate.status, 409);
});

test('lists recent deliveries, optionally scoped to a chat', async () => {
    const { base, store } = await withRouting();
    await store.beginDelivery({ messageId: 'm1', chatId: '1@g.us', routeId: 'r1', subject: 'One' });
    await store.beginDelivery({ messageId: 'm2', chatId: '2@g.us', routeId: 'r2', subject: 'Two' });

    const all = await authed(base, '/admin/api/deliveries');
    assert.equal((await all.json()).deliveries.length, 2);

    const scoped = await authed(base, '/admin/api/deliveries?chatId=1%40g.us');
    const scopedBody = await scoped.json();
    assert.equal(scopedBody.deliveries.length, 1);
    assert.equal(scopedBody.deliveries[0].chatId, '1@g.us');
    assert.equal(scopedBody.deliveries[0].claimToken, undefined, 'deliveries must never expose the claim token');
});

test('QR endpoint requires the admin token and reflects link state', async () => {
    const { base } = await withRouting({
        isClientReady: () => false,
        getLatestQr: () => '2@1,ABCDEF,GHIJKL='
    });
    const denied = await fetch(`${base}/admin/api/qr.svg`);
    assert.equal(denied.status, 401);
    const response = await authed(base, '/admin/api/qr.svg');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
});
