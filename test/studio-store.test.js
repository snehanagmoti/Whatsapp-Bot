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
