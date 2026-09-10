const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

function service() {
    const store = new MemoryStudioStore();
    let seed = 7;
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'looker-reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value',
        randomBytes: () => Buffer.alloc(18, seed++)
    });
    return { store, routeService };
}

test('creates a plus-address route and resolves it without exposing the chat ID', async () => {
    const { routeService } = service();
    const created = await routeService.createRoute({ chatId: '120363@g.us', name: 'Daily Sales', createdBy: 'admin' });
    assert.match(created.address, /^looker-reports\+[A-Za-z0-9_-]{20,64}@example\.com$/);
    assert.equal(created.address.includes('120363'), false);
    const resolved = await routeService.resolveRecipient(`Reports <${created.address}>`);
    assert.equal(resolved.chatId, '120363@g.us');
    assert.equal(resolved.name, 'Daily Sales');
});

test('pauses, rotates and removes a route', async () => {
    const { routeService } = service();
    const created = await routeService.createRoute({ chatId: '1@g.us', name: 'Sales', createdBy: 'admin' });
    await routeService.setRouteStatus('1@g.us', 'Sales', 'paused');
    assert.equal((await routeService.resolveRecipient(created.address)).status, 'paused');
    const rotated = await routeService.rotateRoute('1@g.us', 'Sales');
    assert.equal((await routeService.resolveRecipient(created.address)), null);
    assert.equal((await routeService.resolveRecipient(rotated.address)).status, 'active');
    assert.equal(await routeService.removeRoute('1@g.us', 'Sales'), true);
    assert.equal(await routeService.resolveRecipient(rotated.address), null);
});

test('matches normalized email casing and rejects duplicate route names per chat', async () => {
    const { routeService } = service();
    const created = await routeService.createRoute({ chatId: '1@g.us', name: 'Daily Sales', createdBy: 'admin' });
    assert.equal((await routeService.resolveRecipient(created.address.toUpperCase())).chatId, '1@g.us');
    await assert.rejects(() => routeService.createRoute({
        chatId: '1@g.us', name: '  daily   SALES  ', createdBy: 'admin'
    }), error => error.code === 11000);
    const otherChat = await routeService.createRoute({ chatId: '2@g.us', name: 'Daily Sales', createdBy: 'admin' });
    assert.equal((await routeService.resolveRecipient(otherChat.address)).chatId, '2@g.us');
});

test('resolves every distinct routing alias in a recipient list', async () => {
    const { routeService } = service();
    const sales = await routeService.createRoute({ chatId: '1@g.us', name: 'Sales', createdBy: 'admin' });
    const finance = await routeService.createRoute({ chatId: '2@g.us', name: 'Finance', createdBy: 'admin' });
    const routes = await routeService.resolveRecipients(
        `Owner <owner@example.com>, Sales <${sales.address}>, Finance <${finance.address}>, ${sales.address}`
    );
    assert.deepEqual(routes.map(route => route.chatId), ['1@g.us', '2@g.us']);
});

test('enforces the configured per-chat route quota and frees capacity after removal', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'looker-reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value',
        maxRoutesPerChat: 2
    });
    await routeService.createRoute({ chatId: '1@g.us', name: 'One', createdBy: 'admin' });
    await routeService.createRoute({ chatId: '1@g.us', name: 'Two', createdBy: 'admin' });
    await assert.rejects(
        () => routeService.createRoute({ chatId: '1@g.us', name: 'Three', createdBy: 'admin' }),
        error => error.code === 'ROUTE_QUOTA_EXCEEDED' && error.statusCode === 409
    );
    await routeService.createRoute({ chatId: '2@g.us', name: 'Other chat', createdBy: 'admin' });
    await routeService.removeRoute('1@g.us', 'One');
    await routeService.createRoute({ chatId: '1@g.us', name: 'Three', createdBy: 'admin' });
    assert.equal((await routeService.listRoutes('1@g.us')).length, 2);
});

test('serializes concurrent route creation so the quota cannot be bypassed in one process', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'looker-reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value',
        maxRoutesPerChat: 1
    });
    const results = await Promise.allSettled([
        routeService.createRoute({ chatId: '1@g.us', name: 'One', createdBy: 'admin' }),
        routeService.createRoute({ chatId: '1@g.us', name: 'Two', createdBy: 'admin' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.reason?.code === 'ROUTE_QUOTA_EXCEEDED').length, 1);
    assert.equal((await routeService.listRoutes('1@g.us')).length, 1);
});
