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
        canManage: async () => false
    });
    assert.equal(handled, true);
    assert.match(replies[0][1], /authorized user or group administrator/i);
});
