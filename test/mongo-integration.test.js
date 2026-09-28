// Integration tests against a real MongoDB server. They are skipped unless
// MONGODB_TEST_URI is set (CI starts a mongo service container for them).
// Every test uses its own throwaway database, which is dropped afterwards.
// Never point MONGODB_TEST_URI at a production cluster.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, test } = require('node:test');
const { MongoClient } = require('mongodb');
const { createMongoAuthState } = require('../baileysAuthStore');
const { StudioDeliveryWorker } = require('../studioDeliveryWorker');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MongoStudioStore, deliveryKey } = require('../studioStore');

const uri = process.env.MONGODB_TEST_URI;
const skip = uri ? false : 'MONGODB_TEST_URI is not set';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n% integration fixture\n%%EOF\n');
const cleanups = [];

after(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

function testDbName() {
    return `wa_bot_it_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

async function dropDatabase(dbName) {
    const admin = await new MongoClient(uri).connect();
    try {
        await admin.db(dbName).dropDatabase();
    } finally {
        await admin.close();
    }
}

async function openStore(options = {}) {
    const dbName = testDbName();
    const store = new MongoStudioStore({ uri, dbName, ...options });
    // Register cleanup before connecting so a failed connect cannot leave an
    // open client that keeps the test process alive.
    cleanups.push(async () => {
        await store.close();
        await dropDatabase(dbName);
    });
    return store.connect();
}

function routeServiceFor(store) {
    return new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'an-integration-test-route-pepper'
    });
}

test('route lifecycle and unique indexes behave on a real server', { skip }, async () => {
    const store = await openStore();
    const routes = routeServiceFor(store);
    const created = await routes.createRoute({ chatId: '123@g.us', name: 'Sales', createdBy: 'admin' });
    await assert.rejects(
        () => routes.createRoute({ chatId: '123@g.us', name: '  sales ', createdBy: 'admin' }),
        error => error.code === 11000
    );
    const [resolved] = await routes.resolveRecipients(`Bot <${created.address}>`);
    assert.equal(String(resolved._id), String(created.route._id));

    assert.equal((await routes.setRouteStatus('123@g.us', 'SALES', 'paused')).status, 'paused');
    const rotated = await routes.rotateRoute('123@g.us', 'Sales');
    assert.notEqual(rotated.address, created.address);
    assert.equal(rotated.route.status, 'active');
    assert.deepEqual(await routes.resolveRecipients(created.address), [], 'the old alias stops resolving');
    assert.equal((await routes.resolveRecipients(rotated.address)).length, 1);

    assert.equal((await store.listAllRoutes()).length, 1);
    assert.equal(await routes.removeRoute('123@g.us', 'sales'), true);
    assert.equal(await routes.removeRoute('123@g.us', 'sales'), false);
});

test('delivery claims, completion and duplicate detection', { skip }, async () => {
    const store = await openStore();
    const request = { messageId: 'gmail:it-claim', routeId: 'r1', chatId: '123@g.us', subject: 'Daily', pdf };
    const claim = await store.beginDelivery(request);
    assert.equal(claim.status, 'claimed');
    assert.equal((await store.beginDelivery(request)).status, 'busy', 'a live lease is not reclaimable');

    assert.equal(await store.recordDeliveryProgress(request.messageId, request.chatId, 1, { totalPages: 2, claimToken: claim.claimToken }), true);
    assert.equal(await store.recordDeliveryProgress(request.messageId, request.chatId, 1, { claimToken: 'someone-else' }), false);
    assert.equal(await store.completeDelivery(request.messageId, request.chatId, { deliveredPages: 2, totalPages: 2, claimToken: claim.claimToken }), true);

    const record = await store.deliveries.findOne({ _id: deliveryKey(request.messageId, request.chatId) });
    assert.equal(record.status, 'delivered');
    assert.equal(record.pdfData, undefined, 'a delivered record releases its PDF');
    assert.equal(record.claimToken, undefined);
    assert.equal((await store.beginDelivery(request)).status, 'delivered');
});

test('stale leases are reclaimed and resume from saved page progress', { skip }, async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = await openStore({ deliveryLeaseMs: 60_000, now: () => clock });
    const request = { messageId: 'gmail:it-stale', routeId: 'r1', chatId: '123@g.us', pdf };
    const first = await store.beginDelivery(request);
    await store.recordDeliveryProgress(request.messageId, request.chatId, 2, { totalPages: 3, claimToken: first.claimToken });
    clock = new Date(clock.getTime() + 60_001);
    const second = await store.beginDelivery(request);
    assert.equal(second.status, 'claimed');
    assert.equal(second.nextPage, 2);
    assert.equal(await store.completeDelivery(request.messageId, request.chatId, { claimToken: first.claimToken }), false,
        'the crashed worker lost ownership');
});

test('failed deliveries honour their backoff window, refunds and dead-lettering', { skip }, async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = await openStore({ now: () => clock });
    const request = { messageId: 'gmail:it-backoff', routeId: 'r1', chatId: '123@g.us', pdf };
    const key = deliveryKey(request.messageId, request.chatId);

    let claim = await store.beginDelivery(request);
    await store.failDelivery(request.messageId, request.chatId, 'send failed', { claimToken: claim.claimToken, maxAttempts: 2, retryBaseMs: 60_000 });
    let record = await store.deliveries.findOne({ _id: key });
    assert.equal(record.status, 'failed');
    assert.equal(record.nextAttemptAt.getTime(), clock.getTime() + 60_000);
    assert.equal((await store.beginDelivery(request)).status, 'busy', 'inside the retry window');
    assert.equal(await store.claimRetryableDelivery({ maxAttempts: 2 }), null);

    clock = new Date(clock.getTime() + 60_000);
    claim = await store.beginDelivery(request);
    assert.equal(claim.status, 'claimed');
    // An uncounted failure (e.g. WhatsApp dropped mid-send) refunds the attempt.
    await store.failDelivery(request.messageId, request.chatId, 'disconnected', { claimToken: claim.claimToken, maxAttempts: 2, countAttempt: false, retryDelayMs: 0 });
    record = await store.deliveries.findOne({ _id: key });
    assert.equal(record.attempts, 1);
    assert.equal(record.uncountedFailures, 1);

    const retried = await store.claimRetryableDelivery({ maxAttempts: 2 });
    assert.equal(retried.messageId, request.messageId);
    assert.ok(Buffer.isBuffer(retried.pdfData), 'the worker receives the stored PDF as a Buffer');
    assert.ok(retried.pdfData.equals(pdf), 'the stored PDF survives for the worker');
    await store.failDelivery(request.messageId, request.chatId, 'send failed again', { claimToken: retried.claimToken, maxAttempts: 2 });
    record = await store.deliveries.findOne({ _id: key });
    assert.equal(record.status, 'dead_letter');
    assert.equal(record.pdfData, undefined);
    assert.deepEqual(await store.beginDelivery(request), { status: 'dead_letter', error: 'send failed again' });
});

test('the worker sweep dead-letters abandoned leases that are already at the attempt cap', { skip }, async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = await openStore({ deliveryLeaseMs: 1000, now: () => clock });
    await store.beginDelivery({ messageId: 'gmail:it-sweep', routeId: 'r1', chatId: '123@g.us', pdf });
    clock = new Date(clock.getTime() + 5000);
    assert.equal(await store.claimRetryableDelivery({ maxAttempts: 1 }), null);
    const record = await store.deliveries.findOne({ _id: deliveryKey('gmail:it-sweep', '123@g.us') });
    assert.equal(record.status, 'dead_letter');
});

test('listings exclude stored PDFs and a legacy record keeps its progress', { skip }, async () => {
    const store = await openStore();
    await store.beginDelivery({ messageId: 'gmail:it-list', routeId: 'r1', chatId: '123@g.us', pdf });
    const [listed] = await store.listRecentDeliveries({ chatId: '123@g.us' });
    assert.equal(listed.messageId, 'gmail:it-list');
    assert.equal(listed.pdfData, undefined);
    assert.equal(listed.claimToken, undefined);

    await store.deliveries.insertOne({
        _id: 'gmail:it-legacy', messageId: 'gmail:it-legacy', chatId: '123@g.us',
        status: 'failed', deliveredPages: 1, totalPages: 2, attempts: 1, createdAt: new Date(0), updatedAt: new Date(0)
    });
    const migrated = await store.beginDelivery({ messageId: 'gmail:it-legacy', routeId: 'r1', chatId: '123@g.us', pdf });
    assert.equal(migrated.status, 'claimed');
    assert.equal(migrated.nextPage, 1);
});

test('email ingest, failure and worker recovery end to end', { skip }, async () => {
    let clock = new Date('2026-09-10T00:00:00.000Z');
    const store = await openStore({ now: () => clock });
    const routes = routeServiceFor(store);
    const sales = await routes.createRoute({ chatId: '123@g.us', name: 'Sales', createdBy: 'admin' });
    const ops = await routes.createRoute({ chatId: '456@g.us', name: 'Ops', createdBy: 'admin' });
    const sends = [];
    let failSales = true;
    const client = {
        sendMessage: async (chatId, media, options) => {
            if (chatId === '123@g.us' && failSales) throw new Error('temporary send failure');
            sends.push({ chatId, caption: options.caption });
        }
    };
    // Behaves like the real renderer's input check, so a PDF that comes back
    // from MongoDB as anything but a Buffer fails the test.
    const convertPdf = async input => {
        assert.ok(Buffer.isBuffer(input), `convertPdf received ${input && input.constructor && input.constructor.name}`);
        assert.equal(input.subarray(0, 5).toString(), '%PDF-');
        return [png, png];
    };
    const service = new StudioEmailService({
        routeService: routes, store, client, convertPdf,
        allowedSenders: new Set(['approved@example.com']), retryBaseMs: 60_000
    });
    const payload = {
        messageId: 'gmail:it-e2e', from: 'Looker <approved@example.com>', to: `${sales.address}, ${ops.address}`,
        subject: 'Weekly', attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    await assert.rejects(() => service.process(payload), error => error.statusCode === 502);
    assert.deepEqual(sends.map(send => send.chatId), ['456@g.us', '456@g.us']);

    const worker = new StudioDeliveryWorker({
        store, client, convertPdf, retryBaseMs: 60_000, log: { log() {}, warn() {}, error() {} }
    });
    await worker.tick();
    assert.equal(sends.length, 2, 'the worker waits for the backoff window');

    failSales = false;
    clock = new Date(clock.getTime() + 60_000);
    await worker.tick();
    assert.equal(sends.filter(send => send.chatId === '123@g.us').length, 2);
    const replay = await service.process(payload);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.duplicateRoutes, 2);
});

test('WhatsApp auth state encrypts, claims commands once and resets on a real server', { skip }, async () => {
    const baileys = await import('@whiskeysockets/baileys');
    const dbName = testDbName();
    cleanups.push(() => dropDatabase(dbName));
    const options = { uri, dbName, sessionId: 'it', baileys, encryptionKey: 'k'.repeat(40) };

    const auth = await createMongoAuthState(options);
    auth.state.creds.registered = true;
    await auth.saveCreds();
    await auth.state.keys.set({ 'pre-key': { 1: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } });
    assert.equal(await auth.claimMessage('123@g.us::message-1', Date.now()), true);
    assert.equal(await auth.claimMessage('123@g.us::message-1', Date.now()), false);

    const raw = await new MongoClient(uri).connect();
    cleanups.push(() => raw.close());
    const stored = await raw.db(dbName).collection('baileys_auth').findOne({ _id: 'it:creds' });
    assert.equal(stored.value, undefined);
    assert.equal(stored.encryptedValue.algorithm, 'aes-256-gcm');
    const ttlIndex = (await raw.db(dbName).collection('baileys_message_claims').indexes())
        .find(index => index.name === 'message_claim_expiry');
    assert.equal(ttlIndex.expireAfterSeconds, 0);

    const reopened = await createMongoAuthState(options);
    assert.equal(reopened.state.creds.registered, true);
    const keys = await reopened.state.keys.get('pre-key', ['1']);
    assert.ok(Buffer.from(keys[1].public).equals(Buffer.from([1, 2, 3])));
    await reopened.close();

    await auth.reset();
    assert.notEqual(auth.state.creds.registered, true);
    assert.equal(await raw.db(dbName).collection('baileys_auth').countDocuments({ sessionId: 'it' }), 0);
    assert.equal(await auth.claimMessage('123@g.us::message-1', Date.now()), false, 'replay claims survive a reset');
    await auth.close();
});

test('Signal keys are read and written in batches on a real server', { skip }, async () => {
    const baileys = await import('@whiskeysockets/baileys');
    const dbName = testDbName();
    cleanups.push(() => dropDatabase(dbName));
    const auth = await createMongoAuthState({ uri, dbName, sessionId: 'batch', baileys, encryptionKey: 'b'.repeat(40) });
    cleanups.push(() => auth.close());

    const sessions = {};
    for (let index = 0; index < 50; index += 1) sessions[`contact-${index}.0`] = { index, key: Buffer.from([index]) };
    await auth.state.keys.set({ session: sessions, 'pre-key': { 1: { public: Buffer.from([9]) } } });

    const ids = Object.keys(sessions);
    const loaded = await auth.state.keys.get('session', [...ids, 'missing.0']);
    assert.equal(Object.keys(loaded).length, 50);
    assert.ok(Buffer.from(loaded['contact-7.0'].key).equals(Buffer.from([7])));

    await auth.state.keys.set({ session: { 'contact-0.0': null, 'contact-1.0': null }, 'pre-key': { 1: null } });
    assert.equal(Object.keys(await auth.state.keys.get('session', ids)).length, 48);
    assert.deepEqual(await auth.state.keys.get('pre-key', ['1']), {});
});
