const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MemoryStudioStore, MongoStudioStore, deliveryKey } = require('../studioStore');

test('reclaims an expired processing lease without letting the old owner update it', async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = new MemoryStudioStore({
        deliveryLeaseMs: 1000,
        now: () => clock
    });
    const request = {
        messageId: 'gmail:stale-claim123',
        routeId: 'route-1',
        chatId: '123@g.us',
        subject: 'Daily report'
    };

    const original = await store.beginDelivery(request);
    assert.ok(original.claimToken);
    assert.deepEqual(await store.beginDelivery(request), { status: 'busy' });

    clock = new Date(clock.getTime() + 1001);
    const reclaimed = await store.beginDelivery(request);
    assert.ok(reclaimed.claimToken);
    assert.notEqual(reclaimed.claimToken, original.claimToken);
    assert.equal(reclaimed.nextPage, 0);
    assert.equal(await store.completeDelivery(request.messageId, request.chatId, {
        deliveredPages: 1,
        claimToken: original.claimToken
    }), false);
    assert.equal(await store.recordDeliveryProgress(request.messageId, request.chatId, 1, {
        totalPages: 2,
        claimToken: reclaimed.claimToken
    }), true);
    assert.equal(await store.completeDelivery(request.messageId, request.chatId, {
        deliveredPages: 2,
        totalPages: 2,
        claimToken: reclaimed.claimToken
    }), true);

    const delivery = store.deliveries.get(deliveryKey(request.messageId, request.chatId));
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attempts, 2);
    assert.equal(delivery.deliveredPages, 2);
    assert.deepEqual(await store.beginDelivery(request), { status: 'delivered' });
});

test('reclaims an old processing record that predates lease timestamps', async () => {
    const store = new MemoryStudioStore();
    const messageId = 'gmail:legacy-processing123';
    const chatId = 'legacy@g.us';
    store.deliveries.set(messageId, {
        messageId,
        chatId,
        status: 'processing',
        attempts: 1,
        deliveredPages: 2
    });

    const claim = await store.beginDelivery({ messageId, chatId, routeId: 'route-1', subject: '' });
    assert.equal(claim.nextPage, 2);
    assert.ok(claim.claimToken);
    const migrated = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(migrated.status, 'processing');
    assert.equal(migrated.deliveredPages, 2);
    assert.equal(migrated.attempts, 2);
});

test('a live legacy processing lease stays busy until it can be reclaimed', async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = new MemoryStudioStore({ deliveryLeaseMs: 1000, now: () => clock });
    const request = { messageId: 'gmail:legacy-busy123', chatId: '123@g.us', routeId: 'route-1' };
    store.deliveries.set(request.messageId, {
        ...request, status: 'processing', updatedAt: clock, deliveredPages: 1
    });

    assert.deepEqual(await store.beginDelivery(request), { status: 'busy' });
    assert.equal(store.deliveries.has(deliveryKey(request.messageId, request.chatId)), false);
    clock = new Date(clock.getTime() + 1001);
    const recovered = await store.beginDelivery(request);
    assert.equal(recovered.status, 'claimed');
    assert.equal(recovered.nextPage, 1);
});

test('Mongo distinguishes an outstanding claim from delivered after losing a reclaim race', async () => {
    const request = { messageId: 'gmail:mongo-race123', chatId: '123@g.us', routeId: 'route-1' };
    for (const status of ['processing', 'delivered']) {
        const store = new MongoStudioStore({ uri: 'mongodb://127.0.0.1:27017' });
        let reads = 0;
        store.deliveries = {
            findOne: async () => (++reads === 1 ? { status: 'failed' } : { status }),
            findOneAndUpdate: async () => null
        };
        assert.deepEqual(await store.beginDelivery(request), {
            status: status === 'delivered' ? 'delivered' : 'busy'
        });
        assert.equal(reads, 2, 'must re-read the winning worker state after a failed claim');
    }
});

test('Mongo insert races only acknowledge a winner that has actually completed', async () => {
    const request = { messageId: 'gmail:mongo-insert123', chatId: '123@g.us', routeId: 'route-1' };
    for (const winner of [{ status: 'processing' }, { status: 'delivered' }, null]) {
        const store = new MongoStudioStore({ uri: 'mongodb://127.0.0.1:27017' });
        let reads = 0;
        store.deliveries = {
            findOne: async () => (++reads <= 2 ? null : winner),
            insertOne: async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); }
        };
        assert.deepEqual(await store.beginDelivery(request), {
            status: winner?.status === 'delivered' ? 'delivered' : 'busy'
        });
        assert.equal(reads, 3);
    }
});

test('listAllRoutes returns routes across chats, most recently updated first', async () => {
    const store = new MemoryStudioStore();
    await store.createRoute({ chatId: '1@g.us', name: 'Alpha', tokenHash: 'a', createdBy: 'x' });
    await new Promise(resolve => setTimeout(resolve, 2));
    await store.createRoute({ chatId: '2@g.us', name: 'Beta', tokenHash: 'b', createdBy: 'x' });
    const routes = await store.listAllRoutes();
    assert.equal(routes.length, 2);
    assert.equal(routes[0].name, 'Beta');
    assert.equal(routes[1].name, 'Alpha');
    assert.equal(routes[0].tokenHash, 'b');
});

test('listRecentDeliveries filters by chat and sorts by most recently updated', async () => {
    const store = new MemoryStudioStore();
    await store.beginDelivery({ messageId: 'm1', chatId: '1@g.us', routeId: 'r1', subject: 'One' });
    await new Promise(resolve => setTimeout(resolve, 2));
    await store.beginDelivery({ messageId: 'm2', chatId: '2@g.us', routeId: 'r2', subject: 'Two' });

    const all = await store.listRecentDeliveries();
    assert.equal(all.length, 2);
    assert.equal(all[0].subject, 'Two');

    const scoped = await store.listRecentDeliveries({ chatId: '1@g.us' });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].chatId, '1@g.us');

    const limited = await store.listRecentDeliveries({ limit: 1 });
    assert.equal(limited.length, 1);
});

test('Mongo legacy processing records return busy without acknowledging or inserting a new claim', async () => {
    const clock = new Date('2026-09-10T00:00:00.000Z');
    const request = { messageId: 'gmail:mongo-legacy123', chatId: '123@g.us', routeId: 'route-1' };
    for (const status of ['processing', 'delivered']) {
        const store = new MongoStudioStore({ uri: 'mongodb://127.0.0.1:27017', now: () => clock });
        let reads = 0;
        store.deliveries = {
            findOne: async () => (++reads === 1 ? null : { status, updatedAt: clock }),
            insertOne: async () => assert.fail('legacy ownership must be respected')
        };
        assert.deepEqual(await store.beginDelivery(request), {
            status: status === 'delivered' ? 'delivered' : 'busy'
        });
    }
});

test('Mongo reclaim filter only matches failed deliveries whose retry window has opened', async () => {
    const store = new MongoStudioStore({ uri: 'mongodb://127.0.0.1:27017', now: () => new Date('2026-09-10T00:10:00.000Z') });
    let capturedFilter = null;
    store.deliveries = {
        findOne: async () => ({ _id: 'existing', status: 'failed', nextAttemptAt: new Date('2026-09-10T01:00:00.000Z') }),
        findOneAndUpdate: async filter => { capturedFilter = filter; return null; }
    };
    const result = await store.beginDelivery({ messageId: 'gmail:filter123', routeId: 'r1', chatId: '123@g.us' });
    assert.equal(result.status, 'busy');
    const failedBranches = capturedFilter.$or.filter(branch => branch.status === 'failed');
    assert.deepEqual(failedBranches, [
        { status: 'failed', nextAttemptAt: { $exists: false } },
        { status: 'failed', nextAttemptAt: { $lte: new Date('2026-09-10T00:10:00.000Z') } }
    ]);
});

test('a failure recorded with countAttempt:false refunds the attempt and never dead-letters', async () => {
    const clock = new Date('2026-09-10T00:00:00.000Z');
    const store = new MemoryStudioStore({ now: () => clock });
    const claim = await store.beginDelivery({ messageId: 'gmail:refund123', routeId: 'r1', chatId: '123@g.us', pdf: Buffer.from('%PDF-') });
    await store.failDelivery('gmail:refund123', '123@g.us', 'released', {
        claimToken: claim.claimToken, maxAttempts: 1, countAttempt: false, retryDelayMs: 0
    });
    const record = store.deliveries.get(deliveryKey('gmail:refund123', '123@g.us'));
    assert.equal(record.status, 'failed');
    assert.equal(record.attempts, 0);
    assert.equal(record.nextAttemptAt.getTime(), clock.getTime());
});

test('delivery listings never load stored PDFs or claim tokens', async () => {
    const store = new MongoStudioStore({ uri: 'mongodb://127.0.0.1:27017' });
    let captured = null;
    const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => [] };
    store.deliveries = { find: (filter, options) => { captured = { filter, options }; return cursor; } };
    await store.listRecentDeliveries({ chatId: '123@g.us', limit: 20 });
    assert.deepEqual(captured.filter, { chatId: '123@g.us' });
    assert.deepEqual({ ...captured.options.projection }, { pdfData: 0, claimToken: 0 });

    const memory = new MemoryStudioStore();
    await memory.beginDelivery({ messageId: 'gmail:list123', routeId: 'r1', chatId: '123@g.us', pdf: Buffer.from('%PDF-') });
    const [listed] = await memory.listRecentDeliveries();
    assert.equal(listed.pdfData, undefined);
    assert.equal(listed.claimToken, undefined);
    assert.ok(memory.deliveries.get(deliveryKey('gmail:list123', '123@g.us')).pdfData, 'the stored record keeps its PDF');
});
