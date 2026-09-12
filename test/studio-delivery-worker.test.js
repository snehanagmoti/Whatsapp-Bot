const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StudioDeliveryWorker } = require('../studioDeliveryWorker');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore, deliveryKey } = require('../studioStore');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n% test fixture\n%%EOF\n');
const silentLog = { log() {}, warn() {}, error() {} };

async function fixture({ deliveryLeaseMs, now, maxAttempts = 3, retryBaseMs = 1000, isClientReady } = {}) {
    const store = new MemoryStudioStore({ deliveryLeaseMs, now });
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const created = await routeService.createRoute({ chatId: '123@g.us', name: 'Sales', createdBy: 'admin' });
    const sends = [];
    let sendImpl = async (...args) => { sends.push(args); };
    const client = { sendMessage: (...args) => sendImpl(...args) };
    let convertImpl = async () => [png, png];
    const worker = new StudioDeliveryWorker({
        store,
        client,
        convertPdf: (...args) => convertImpl(...args),
        isClientReady: isClientReady || (() => true),
        maxAttempts,
        retryBaseMs,
        intervalMs: 5000,
        log: silentLog
    });
    return {
        store, created, sends, worker,
        setSendImpl: fn => { sendImpl = fn; },
        setConvertImpl: fn => { convertImpl = fn; }
    };
}

test('retries a failed delivery once its backoff elapses and delivers it', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const { store, created, sends, worker } = await fixture({ now: () => clock, retryBaseMs: 1000 });
    const messageId = 'gmail:retry-success123';
    const chatId = '123@g.us';

    const claim = await store.beginDelivery({ messageId, routeId: created.route._id, chatId, subject: 'Weekly', pdf });
    await store.failDelivery(messageId, chatId, 'WhatsApp send failed', {
        claimToken: claim.claimToken, maxAttempts: 3, retryBaseMs: 1000
    });

    const beforeBackoff = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(beforeBackoff.status, 'failed');
    assert.ok(beforeBackoff.nextAttemptAt, 'a backoff time must be recorded');
    assert.ok(Buffer.isBuffer(beforeBackoff.pdfData), 'the PDF must be kept for a retryable failure');

    // Backoff has not elapsed yet: nothing should be claimed or sent.
    await worker.tick();
    assert.equal(sends.length, 0);
    assert.equal(store.deliveries.get(deliveryKey(messageId, chatId)).status, 'failed');

    clock = new Date(beforeBackoff.nextAttemptAt.getTime() + 1);
    await worker.tick();

    const delivered = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.attempts, 2);
    assert.equal(sends.length, 2, 'both pages should be (re-)sent since none had been confirmed');
    assert.equal(sends[0][0], chatId);
    assert.equal(delivered.pdfData, undefined, 'the stored PDF should be released once delivered');
});

test('moves a delivery to dead_letter after exhausting max attempts and stops retrying it', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const { store, created, sends, worker, setSendImpl } = await fixture({
        now: () => clock, maxAttempts: 2, retryBaseMs: 1000
    });
    const messageId = 'gmail:dead-letter123';
    const chatId = '123@g.us';
    setSendImpl(async () => { throw new Error('WhatsApp rejected the image'); });

    const claim = await store.beginDelivery({ messageId, routeId: created.route._id, chatId, subject: '', pdf });
    await store.failDelivery(messageId, chatId, 'first failure', {
        claimToken: claim.claimToken, maxAttempts: 2, retryBaseMs: 1000
    });
    const afterFirstFailure = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(afterFirstFailure.status, 'failed');
    assert.equal(afterFirstFailure.attempts, 1);

    clock = new Date(afterFirstFailure.nextAttemptAt.getTime() + 1);
    await worker.tick(); // second attempt: also fails, and 2 >= maxAttempts(2)

    const exhausted = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(exhausted.status, 'dead_letter');
    assert.equal(exhausted.attempts, 2);
    assert.equal(exhausted.error, 'WhatsApp rejected the image');
    assert.equal(exhausted.pdfData, undefined, 'a dead-lettered delivery must not keep holding the PDF bytes');

    clock = new Date(clock.getTime() + 10 * 60 * 1000);
    await worker.tick();
    assert.equal(sends.length, 0, 'a dead-lettered delivery must never be retried again');
    assert.equal(store.deliveries.get(deliveryKey(messageId, chatId)).status, 'dead_letter');
});

test('reclaims a delivery abandoned mid-processing (simulated crash) and completes it', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const { store, created, sends, worker } = await fixture({
        now: () => clock, deliveryLeaseMs: 1000, retryBaseMs: 1000
    });
    const messageId = 'gmail:crash-recovery123';
    const chatId = '123@g.us';

    // A claim that never reaches completeDelivery or failDelivery, as if the
    // process died mid-send.
    await store.beginDelivery({ messageId, routeId: created.route._id, chatId, subject: '', pdf });
    assert.equal(store.deliveries.get(deliveryKey(messageId, chatId)).status, 'processing');

    clock = new Date(clock.getTime() + 1001); // past the delivery lease
    await worker.tick();

    const recovered = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(recovered.status, 'delivered');
    assert.equal(recovered.attempts, 2, 'the reclaim itself counts as another attempt');
    assert.equal(sends.length, 2);
});

test('does not claim or send anything while WhatsApp is not connected', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const { store, created, sends, worker } = await fixture({
        now: () => clock, retryBaseMs: 1000, isClientReady: () => false
    });
    const messageId = 'gmail:not-ready123';
    const chatId = '123@g.us';
    const claim = await store.beginDelivery({ messageId, routeId: created.route._id, chatId, subject: '', pdf });
    await store.failDelivery(messageId, chatId, 'boom', { claimToken: claim.claimToken, maxAttempts: 3, retryBaseMs: 1000 });

    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await worker.tick();

    assert.equal(sends.length, 0);
    assert.equal(store.deliveries.get(deliveryKey(messageId, chatId)).status, 'failed');
});

test('keeps a delivery retryable (bounded by attempts) when its route was removed', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const { store, created, sends, worker } = await fixture({ now: () => clock, maxAttempts: 5, retryBaseMs: 1000 });
    const messageId = 'gmail:missing-route123';
    const chatId = '123@g.us';
    const claim = await store.beginDelivery({ messageId, routeId: created.route._id, chatId, subject: '', pdf });
    await store.failDelivery(messageId, chatId, 'boom', { claimToken: claim.claimToken, maxAttempts: 5, retryBaseMs: 1000 });
    await store.removeRoute(chatId, 'Sales');

    const record = store.deliveries.get(deliveryKey(messageId, chatId));
    clock = new Date(record.nextAttemptAt.getTime() + 1);
    await worker.tick();

    const afterMissingRoute = store.deliveries.get(deliveryKey(messageId, chatId));
    assert.equal(afterMissingRoute.status, 'failed', 'a missing route is a retryable failure, not an immediate dead end');
    assert.match(afterMissingRoute.error, /route.*no longer exists/i);
    assert.equal(sends.length, 0);
});

test('a synchronous ingest failure becomes retryable by the worker without Apps Script resending', async () => {
    let clock = new Date('2026-09-12T00:00:00.000Z');
    const store = new MemoryStudioStore({ now: () => clock });
    const routeService = new StudioRouteService({
        store, routingEmail: 'reports@example.com', pepper: 'a-long-test-only-route-pepper-value'
    });
    const created = await routeService.createRoute({ chatId: '123@g.us', name: 'Sales', createdBy: 'admin' });
    const sends = [];
    let sendShouldFail = true;
    const client = { sendMessage: async (...args) => {
        if (sendShouldFail) throw new Error('temporary WhatsApp outage');
        sends.push(args);
    } };
    const emailService = new StudioEmailService({
        routeService, store, client, isClientReady: () => true,
        convertPdf: async () => [png, png],
        allowedSenders: new Set(['approved@example.com']),
        maxAttempts: 3, retryBaseMs: 1000
    });
    const worker = new StudioDeliveryWorker({
        store, client, convertPdf: async () => [png, png], isClientReady: () => true,
        maxAttempts: 3, retryBaseMs: 1000, intervalMs: 5000, log: silentLog
    });

    const payload = {
        messageId: 'gmail:ingest-then-retry123',
        from: 'approved@example.com',
        to: created.address,
        subject: 'Ops report',
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    await assert.rejects(() => emailService.process(payload), error => error.statusCode === 502);
    assert.equal(sends.length, 0);

    const afterIngestFailure = store.deliveries.get(deliveryKey(payload.messageId, '123@g.us'));
    assert.equal(afterIngestFailure.status, 'failed');
    assert.ok(Buffer.isBuffer(afterIngestFailure.pdfData), 'the PDF from the failed ingest must be retained for the worker');

    sendShouldFail = false;
    clock = new Date(afterIngestFailure.nextAttemptAt.getTime() + 1);
    await worker.tick();

    const recovered = store.deliveries.get(deliveryKey(payload.messageId, '123@g.us'));
    assert.equal(recovered.status, 'delivered');
    assert.equal(sends.length, 2);
});
