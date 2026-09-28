const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StudioDeliveryWorker } = require('../studioDeliveryWorker');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore, deliveryKey, pdfKeyFor } = require('../studioStore');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n% shared storage fixture\n%%EOF\n');
const silentLog = { log() {}, warn() {}, error() {} };

async function setup({ maxAttempts = 3, sendImpl, clockStart = '2026-09-20T00:00:00.000Z' } = {}) {
    const clock = { now: new Date(clockStart) };
    const store = new MemoryStudioStore({ now: () => clock.now });
    const routeService = new StudioRouteService({ store, routingEmail: 'reports@example.com', pepper: 'a-long-test-only-route-pepper-value' });
    const sales = await routeService.createRoute({ chatId: '111@g.us', name: 'Sales', createdBy: 'admin' });
    const ops = await routeService.createRoute({ chatId: '222@g.us', name: 'Ops', createdBy: 'admin' });
    const sends = [];
    const alerts = [];
    const client = { sendMessage: async (...args) => (sendImpl ? sendImpl(...args) : sends.push(args)) };
    const common = { store, client, isClientReady: () => true, convertPdf: async () => [png], maxAttempts, retryBaseMs: 1000, onDeadLetter: async info => alerts.push(info) };
    const service = new StudioEmailService({ ...common, routeService, allowedSenders: new Set(['approved@example.com']) });
    const worker = new StudioDeliveryWorker({ ...common, intervalMs: 5000, log: silentLog });
    const payload = {
        messageId: 'gmail:shared-pdf-1', from: 'approved@example.com', to: `${sales.address}, ${ops.address}`,
        subject: 'Weekly', attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    return { clock, store, service, worker, sends, alerts, payload };
}

test('an email for several chats stores its PDF once and releases it after delivery', async () => {
    let savedDuringDelivery = null;
    const context = await setup({
        sendImpl: async () => { savedDuringDelivery = context.store.pdfs.size; }
    });
    const result = await context.service.process(context.payload);
    assert.equal(result.deliveredRoutes, 2);
    assert.equal(savedDuringDelivery, 1, 'one stored copy for two destination chats');
    for (const chatId of ['111@g.us', '222@g.us']) {
        const record = context.store.deliveries.get(deliveryKey(context.payload.messageId, chatId));
        assert.equal(record.pdfData, undefined);
        assert.equal(record.pdfRef, undefined, 'delivered records drop their reference');
    }
    assert.equal(context.store.pdfs.size, 0);
});

test('the shared PDF stays while any destination still needs it', async () => {
    let failOps = true;
    const sends = [];
    const context = await setup({
        sendImpl: async chatId => {
            if (chatId === '222@g.us' && failOps) throw new Error('temporary failure');
            sends.push(chatId);
        }
    });
    await assert.rejects(() => context.service.process(context.payload), error => error.statusCode === 502);
    const ref = pdfKeyFor(context.payload.messageId);
    assert.ok(context.store.pdfs.has(ref), 'kept for the failed destination');

    failOps = false;
    context.clock.now = new Date(context.clock.now.getTime() + 60_000);
    await context.worker.tick();
    assert.deepEqual(sends, ['111@g.us', '222@g.us']);
    assert.equal(context.store.pdfs.has(ref), false, 'released once the last destination delivered');
});

test('a fully duplicate email does not leave a stored PDF behind', async () => {
    const context = await setup();
    await context.service.process(context.payload);
    const replay = await context.service.process(context.payload);
    assert.equal(replay.duplicate, true);
    assert.equal(context.store.pdfs.size, 0);
});

test('dead-lettered deliveries alert, keep their PDF, and can be requeued', async () => {
    let failing = true;
    const sends = [];
    const context = await setup({
        maxAttempts: 1,
        sendImpl: async chatId => {
            if (failing && chatId === '222@g.us') throw new Error('WhatsApp rejected the image');
            sends.push(chatId);
        }
    });
    await assert.rejects(() => context.service.process(context.payload), error => error.statusCode === 502);
    const key = deliveryKey(context.payload.messageId, '222@g.us');
    assert.equal(context.store.deliveries.get(key).status, 'dead_letter');
    assert.equal(context.alerts.length, 1);
    assert.equal(context.alerts[0].routeName, 'Ops');
    assert.equal(context.alerts[0].chatId, '222@g.us');
    assert.match(context.alerts[0].error, /rejected the image/);
    assert.ok(context.store.pdfs.has(pdfKeyFor(context.payload.messageId)));

    assert.deepEqual(await context.store.requeueDelivery(context.payload.messageId, '111@g.us'), { status: 'not_dead_letter', current: 'delivered' });
    assert.deepEqual(await context.store.requeueDelivery('gmail:unknown-1', '222@g.us'), { status: 'not_found' });
    failing = false;
    assert.deepEqual(await context.store.requeueDelivery(context.payload.messageId, '222@g.us'), { status: 'requeued' });
    const requeued = context.store.deliveries.get(key);
    assert.equal(requeued.status, 'failed');
    assert.equal(requeued.attempts, 0, 'a fresh attempt budget');

    await context.worker.tick();
    assert.equal(context.store.deliveries.get(key).status, 'delivered');
    assert.deepEqual(sends, ['111@g.us', '222@g.us']);
    assert.equal(context.store.pdfs.size, 0);
});

test('the worker alerts when its retry dead-letters a delivery', async () => {
    const context = await setup({
        maxAttempts: 2,
        sendImpl: async chatId => { if (chatId === '222@g.us') throw new Error('still failing'); }
    });
    await assert.rejects(() => context.service.process(context.payload));
    assert.equal(context.alerts.length, 0, 'first failure is retryable, no alert');
    context.clock.now = new Date(context.clock.now.getTime() + 60_000);
    await context.worker.tick();
    assert.equal(context.alerts.length, 1);
    assert.equal(context.alerts[0].routeName, 'Ops');
    assert.equal(context.alerts[0].error, 'still failing');
});

test('dead-letter PDFs are released after the retention window and cannot be requeued afterwards', async () => {
    const context = await setup({
        maxAttempts: 1,
        sendImpl: async chatId => { if (chatId === '222@g.us') throw new Error('nope'); }
    });
    await assert.rejects(() => context.service.process(context.payload));
    context.clock.now = new Date(context.clock.now.getTime() + 7 * 24 * 60 * 60 * 1000 + 1);
    await context.worker.tick();
    assert.equal(context.store.pdfs.size, 0);
    assert.deepEqual(await context.store.requeueDelivery(context.payload.messageId, '222@g.us'), { status: 'pdf_missing' });
});

test('an alert failure never breaks delivery handling', async () => {
    const context = await setup({ maxAttempts: 1, sendImpl: async chatId => { if (chatId === '222@g.us') throw new Error('x'); } });
    context.service.onDeadLetter = async () => { throw new Error('alert channel down'); };
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(() => context.service.process(context.payload), error => error.statusCode === 502);
    } finally {
        console.error = originalError;
    }
    assert.equal(context.store.deliveries.get(deliveryKey(context.payload.messageId, '222@g.us')).status, 'dead_letter');
});
