const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleStudioCommand } = require('../studioCommands');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

test('authorized chat setup creates a routing address', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const replies = [];
    const client = { sendMessage: async (...args) => replies.push(args) };
    const handled = await handleStudioCommand({
        message: { from: '123@g.us', senderId: 'admin@s.whatsapp.net', body: '!setupreport Daily Sales' },
        client,
        routeService,
        canManage: async () => true
    });
    assert.equal(handled, true);
    assert.equal(replies.length, 1);
    assert.match(replies[0][1], /reports\+[A-Za-z0-9_-]+@example\.com/);
    assert.equal((await routeService.listRoutes('123@g.us')).length, 1);
});

test('unauthorized users cannot create report routes', async () => {
    const replies = [];
    const handled = await handleStudioCommand({
        message: { from: '123@g.us', senderId: 'member@s.whatsapp.net', body: '!setupreport Sales' },
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService: {},
        canManage: async () => false,
        canSetup: async () => false
    });
    assert.equal(handled, true);
    assert.match(replies[0][1], /Report setup is not available to you/i);
});

test('public setup users cannot manage existing routes', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    await routeService.createRoute({ chatId: '123@g.us', name: 'Daily Sales', createdBy: 'admin' });
    const replies = [];
    const handled = await handleStudioCommand({
        message: { from: '123@g.us', senderId: 'member@s.whatsapp.net', body: '!removereport Daily Sales' },
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService,
        canManage: async () => false,
        canSetup: async () => true
    });
    assert.equal(handled, true);
    assert.match(replies[0][1], /authorized user or group administrator can manage existing/i);
});

test('requires an explicit confirmation before permanently removing a route', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    await routeService.createRoute({ chatId: '123@g.us', name: 'Daily Sales', createdBy: 'admin' });
    const replies = [];
    const options = {
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService,
        canManage: async () => true
    };

    await handleStudioCommand({
        ...options,
        message: { from: '123@g.us', senderId: 'admin', body: '!removereport Daily Sales' }
    });
    assert.equal((await routeService.listRoutes('123@g.us')).length, 1);
    assert.match(replies[0][1], /!removereport Daily Sales --confirm/);

    await handleStudioCommand({
        ...options,
        message: { from: '123@g.us', senderId: 'admin', body: '!removereport Daily Sales --confirm' }
    });
    assert.equal((await routeService.listRoutes('123@g.us')).length, 0);
    assert.match(replies[1][1], /removed/);
});

test('requires an explicit confirmation before rotating a route', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const created = await routeService.createRoute({ chatId: '123@g.us', name: 'Daily Sales', createdBy: 'admin' });
    const originalTokenHash = created.route.tokenHash;
    const replies = [];
    const options = {
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService,
        canManage: async () => true
    };

    await handleStudioCommand({
        ...options,
        message: { from: '123@g.us', senderId: 'admin', body: '!rotatereport Daily Sales' }
    });
    assert.match(replies[0][1], /!rotatereport Daily Sales --confirm/);
    assert.match(replies[0][1], /invalidates the current address/i);

    await handleStudioCommand({
        ...options,
        message: { from: '123@g.us', senderId: 'admin', body: '!rotatereport Daily Sales --confirm' }
    });
    assert.match(replies[1][1], /Route rotated/);
    const rotatedRoute = (await routeService.listRoutes('123@g.us'))[0];
    assert.notEqual(rotatedRoute.tokenHash, originalTokenHash);
});

test('!help lists commands without requiring management permission or configured routing', async () => {
    const replies = [];
    const handledWithoutRouting = await handleStudioCommand({
        message: { from: '123@g.us', senderId: 'member@s.whatsapp.net', body: '!help' },
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService: null,
        canManage: async () => false,
        canSetup: async () => false
    });
    assert.equal(handledWithoutRouting, true);
    assert.match(replies[0][1], /!setupreport/);
    assert.match(replies[0][1], /!chatid/);
});

test('explains the per-chat route quota when setup would exceed it', async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value',
        maxRoutesPerChat: 1
    });
    await routeService.createRoute({ chatId: '123@g.us', name: 'First', createdBy: 'admin' });
    const replies = [];
    await handleStudioCommand({
        message: { from: '123@g.us', senderId: 'admin', body: '!setupreport Second' },
        client: { sendMessage: async (...args) => replies.push(args) },
        routeService,
        canManage: async () => true
    });
    assert.match(replies[0][1], /maximum of 1 report routes/i);
    assert.match(replies[0][1], /remove an unused route/i);
});
