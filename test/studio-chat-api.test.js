const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../server');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

process.env.NODE_ENV = 'test';
const servers = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function start(extra = {}) {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({ store, routingEmail: 'reports@example.com', pepper: 'a-long-test-only-route-pepper-value' });
    const server = createApp({ client: {}, isClientReady: () => true, routeService, studioStore: store, studioAdminToken: 'admin-secret', ...extra })
        .listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (chatId, path, body) => fetch(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Chat-Id': chatId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { base, store, routeService, call };
}

test('a chat dashboard can create, pause, rotate and remove its own reports with just the chat ID', async () => {
    const { call, routeService } = await start();
    const created = await call('111@g.us', '/chat/api/routes', { name: 'Sales' });
    assert.equal(created.status, 201);
    assert.match((await created.json()).address, /^reports\+[a-z0-9]+@example\.com$/);

    const listed = await (await call('111@g.us', '/chat/api/routes')).json();
    assert.equal(listed.chatId, '111@g.us');
    assert.equal(listed.whatsappReady, true);
    assert.deepEqual(listed.routes.map(route => [route.name, route.status]), [['Sales', 'active']]);

    assert.equal((await call('111@g.us', '/chat/api/routes/status', { name: 'Sales', status: 'paused' })).status, 200);
    const rotated = await call('111@g.us', '/chat/api/routes/rotate', { name: 'Sales' });
    assert.equal(rotated.status, 200);
    assert.match((await rotated.json()).address, /^reports\+/);
    assert.equal((await call('111@g.us', '/chat/api/routes/remove', { name: 'Sales' })).status, 400, 'removal needs confirm');
    assert.equal((await call('111@g.us', '/chat/api/routes/remove', { name: 'Sales', confirm: true })).status, 200);
    assert.equal((await routeService.listRoutes('111@g.us')).length, 0);
});

test('one chat can never see or change another chat\'s reports or deliveries', async () => {
    const { call, store, routeService } = await start();
    await routeService.createRoute({ chatId: '222@g.us', name: 'Secret', createdBy: 'x' });
    const pdfRef = await store.savePdf('gmail:other-1', Buffer.from('%PDF-1.4'));
    const claim = await store.beginDelivery({ messageId: 'gmail:other-1', routeId: 'r', chatId: '222@g.us', subject: 'S', pdfRef });
    await store.failDelivery('gmail:other-1', '222@g.us', 'x', { claimToken: claim.claimToken, maxAttempts: 1 });

    assert.deepEqual((await (await call('111@g.us', '/chat/api/routes')).json()).routes, []);
    assert.deepEqual((await (await call('111@g.us', '/chat/api/deliveries')).json()).deliveries, []);
    for (const [path, body] of [
        ['/chat/api/routes/status', { name: 'Secret', status: 'paused', chatId: '222@g.us' }],
        ['/chat/api/routes/rotate', { name: 'Secret', chatId: '222@g.us' }],
        ['/chat/api/routes/remove', { name: 'Secret', confirm: true, chatId: '222@g.us' }],
        ['/chat/api/deliveries/retry', { messageId: 'gmail:other-1', chatId: '222@g.us' }]
    ]) {
        assert.equal((await call('111@g.us', path, body)).status, 404, `${path} ignores a chatId in the body`);
    }
    const [route] = await routeService.listRoutes('222@g.us');
    assert.equal(route.status, 'active');

    const own = await (await call('222@g.us', '/chat/api/deliveries')).json();
    assert.equal(own.deliveries.length, 1);
    assert.equal(own.deliveries[0].canRetry, true);
    assert.equal((await call('222@g.us', '/chat/api/deliveries/retry', { messageId: 'gmail:other-1' })).status, 200);
});

test('the chat dashboard needs a valid chat ID and is rate limited', async () => {
    const { call } = await start({ adminRateLimit: 3 });
    assert.equal((await call('', '/chat/api/routes')).status, 400);
    assert.equal((await call('not-a-chat', '/chat/api/routes')).status, 400);
    assert.equal((await call('111@g.us', '/chat/api/routes')).status, 200);
    assert.equal((await call('111@g.us', '/chat/api/routes')).status, 429);
});

test('the chat dashboard page is served', async () => {
    const { base } = await start();
    const page = await fetch(`${base}/chat/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /My chat's reports/);
});
