const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore, deliveryKey } = require('../studioStore');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n% test fixture\n%%EOF\n');

async function fixture(overrides = {}) {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const created = await routeService.createRoute({ chatId: '123@g.us', name: 'Sales', createdBy: 'admin' });
    const sends = [];
    const client = { sendMessage: async (...args) => sends.push(args) };
    const emailService = new StudioEmailService({
        routeService,
        store,
        client,
        isClientReady: () => true,
        convertPdf: async () => [png, png],
        allowedSenders: new Set(['approved@example.com']),
        ...overrides
    });
    return { store, created, sends, emailService };
}

test('routes a PDF to the mapped chat as ordered PNG pages', async () => {
    const { created, sends, emailService } = await fixture();
    const result = await emailService.process({
        messageId: 'gmail:abc123',
        from: 'Looker <approved@example.com>',
        to: created.address,
        subject: 'Daily report',
        attachments: [{ filename: 'report.pdf', mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });
    assert.equal(result.deliveredPages, 2);
    assert.equal(sends.length, 2);
    assert.equal(sends[0][0], '123@g.us');
    assert.match(sends[0][2].caption, /Page 1 of 2/);
    assert.match(sends[1][2].caption, /Page 2 of 2/);
});

test('suppresses a duplicate Gmail message', async () => {
    const { created, sends, emailService } = await fixture();
    const payload = {
        messageId: 'gmail:duplicate123', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    await emailService.process(payload);
    const duplicate = await emailService.process(payload);
    assert.equal(duplicate.duplicate, true);
    assert.equal(sends.length, 2);
});

test('returns a retryable error for an outstanding lease and recovers after the worker crashes', async () => {
    const { store, created, sends, emailService } = await fixture();
    let clock = new Date('2026-09-10T00:00:00.000Z');
    store.now = () => clock;
    store.deliveryLeaseMs = 1000;
    const payload = {
        messageId: 'gmail:pending-worker123', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    await store.beginDelivery({ messageId: payload.messageId, chatId: '123@g.us', routeId: created.route._id });

    await assert.rejects(() => emailService.process(payload), error => error.statusCode === 503);
    assert.equal(sends.length, 0);
    clock = new Date(clock.getTime() + 1001);
    const recovered = await emailService.process(payload);
    assert.equal(recovered.deliveredRoutes, 1);
    assert.equal(sends.length, 2);
    assert.equal((await emailService.process(payload)).duplicate, true);
});

test('finishes available destinations when another lease is busy and only retries the unfinished chat', async () => {
    const { store, created, sends, emailService } = await fixture();
    let clock = new Date('2026-09-10T00:00:00.000Z');
    store.now = () => clock;
    store.deliveryLeaseMs = 1000;
    const finance = await emailService.routeService.createRoute({
        chatId: '456@g.us', name: 'Finance', createdBy: 'admin'
    });
    const payload = {
        messageId: 'gmail:busy-fanout123', from: 'approved@example.com',
        to: `${created.address}, ${finance.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    // The first destination will be newly claimed before the second is found busy.
    await store.beginDelivery({ messageId: payload.messageId, chatId: '456@g.us', routeId: finance.route._id });

    await assert.rejects(() => emailService.process(payload), error => error.statusCode === 503);
    assert.deepEqual(sends.map(send => send[0]), ['123@g.us', '123@g.us']);
    assert.equal(store.deliveries.get(deliveryKey(payload.messageId, '123@g.us')).status, 'delivered');
    assert.equal(store.deliveries.get(deliveryKey(payload.messageId, '456@g.us')).status, 'processing');
    clock = new Date(clock.getTime() + 1001);
    const recovered = await emailService.process(payload);
    assert.equal(recovered.deliveredRoutes, 1);
    assert.equal(recovered.duplicateRoutes, 1);
    assert.deepEqual(sends.map(send => send[0]), ['123@g.us', '123@g.us', '456@g.us', '456@g.us']);
});

test('releases earlier claims if a later destination cannot be claimed due to a store failure', async () => {
    const { store, created, sends, emailService } = await fixture();
    const finance = await emailService.routeService.createRoute({
        chatId: '456@g.us', name: 'Finance', createdBy: 'admin'
    });
    const originalBegin = store.beginDelivery.bind(store);
    store.beginDelivery = async request => {
        if (request.chatId === '456@g.us') throw new Error('temporary database failure');
        return originalBegin(request);
    };
    const payload = {
        messageId: 'gmail:claim-failure123', from: 'approved@example.com',
        to: `${created.address}, ${finance.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };

    await assert.rejects(() => emailService.process(payload), error => error.statusCode === 503);
    assert.equal(store.deliveries.get(deliveryKey(payload.messageId, '123@g.us')).status, 'failed');
    assert.equal(sends.length, 0);
    store.beginDelivery = originalBegin;
    assert.equal((await emailService.process(payload)).deliveredRoutes, 2);
});

test('rejects an unapproved sender and acknowledges a deliberately paused route', async () => {
    const { created, emailService } = await fixture();
    await assert.rejects(() => emailService.process({
        messageId: 'gmail:bad-sender', from: 'bad@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), /sender is not approved/i);
    await emailService.routeService.setRouteStatus('123@g.us', 'Sales', 'paused');
    const paused = await emailService.process({
        messageId: 'gmail:paused-route', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });
    assert.equal(paused.deliveredRoutes, 0);
    assert.equal(paused.skippedPausedRoutes, 1);
    assert.equal(paused.skippedReason, 'paused');
});

test('rejects offline WhatsApp, an unknown recipient and a missing PDF', async () => {
    const offline = await fixture({ isClientReady: () => false });
    await assert.rejects(() => offline.emailService.process({
        messageId: 'gmail:offline123', from: 'approved@example.com', to: offline.created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), error => error.statusCode === 503 && /not connected/i.test(error.message));

    const { created, emailService } = await fixture();
    await assert.rejects(() => emailService.process({
        messageId: 'gmail:unknown123', from: 'approved@example.com', to: 'reports+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com',
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), error => error.statusCode === 404 && /no active report route/i.test(error.message));
    await assert.rejects(() => emailService.process({
        messageId: 'gmail:no-pdf123', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'text/plain', data: 'dGVzdA==' }]
    }), /PDF attachment is required/i);
});

test('rejects malformed, non-PDF and oversized attachment data', async () => {
    const { created, emailService } = await fixture({ maxPdfBytes: 16 });
    const base = { from: 'approved@example.com', to: created.address };
    await assert.rejects(() => emailService.process({
        ...base, messageId: 'gmail:bad-base64',
        attachments: [{ mimetype: 'application/pdf', data: '%%%invalid%%%' }]
    }), /not valid base64/i);
    await assert.rejects(() => emailService.process({
        ...base, messageId: 'gmail:not-pdf123',
        attachments: [{ mimetype: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') }]
    }), /not a valid PDF/i);
    await assert.rejects(() => emailService.process({
        ...base, messageId: 'gmail:too-large123',
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), /exceeds the allowed size/i);
});

test('allows the same message to retry after a conversion failure', async () => {
    let attempts = 0;
    const { store, created, sends, emailService } = await fixture({
        convertPdf: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('temporary renderer failure');
            return [png];
        }
    });
    const payload = {
        messageId: 'gmail:retry123', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };
    await assert.rejects(() => emailService.process(payload), error =>
        error.statusCode === 502 && /temporary renderer failure/i.test(error.message));
    const delivered = await emailService.process(payload);
    assert.equal(delivered.deliveredPages, 1);
    assert.equal(sends.length, 1);
    const delivery = store.deliveries.get(deliveryKey(payload.messageId, '123@g.us'));
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attempts, 2);
});

test('fans one email out to multiple chats and deduplicates each destination independently', async () => {
    const { store, created, sends, emailService } = await fixture();
    const finance = await emailService.routeService.createRoute({
        chatId: '456@g.us', name: 'Finance', createdBy: 'admin'
    });
    const payload = {
        messageId: 'gmail:fanout123',
        from: 'approved@example.com',
        to: `${created.address}, ${finance.address}`,
        subject: 'Shared report',
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };

    const delivered = await emailService.process(payload);
    assert.equal(delivered.deliveredRoutes, 2);
    assert.equal(delivered.pagesPerRoute, 2);
    assert.equal(delivered.deliveredPages, 4);
    assert.deepEqual(sends.map(send => send[0]), ['123@g.us', '123@g.us', '456@g.us', '456@g.us']);

    const replay = await emailService.process(payload);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.duplicateRoutes, 2);
    assert.equal(sends.length, 4);
    assert.equal(store.deliveries.size, 2);
});

test('does not deliver twice when two aliases in one email map to the same chat', async () => {
    const { created, sends, emailService } = await fixture();
    const second = await emailService.routeService.createRoute({
        chatId: '123@g.us', name: 'Sales Copy', createdBy: 'admin'
    });
    const result = await emailService.process({
        messageId: 'gmail:same-chat123',
        from: 'approved@example.com',
        to: `${created.address}, ${second.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });
    assert.equal(result.deliveredRoutes, 1);
    assert.equal(sends.length, 2);
});

test('uses an active alias when a paused alias for the same chat appears first or last', async () => {
    const { created, sends, emailService } = await fixture();
    const active = await emailService.routeService.createRoute({
        chatId: '123@g.us', name: 'Sales Active', createdBy: 'admin'
    });
    await emailService.routeService.setRouteStatus('123@g.us', 'Sales', 'paused');

    const pausedFirst = await emailService.process({
        messageId: 'gmail:paused-first123',
        from: 'approved@example.com',
        to: `${created.address}, ${active.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });
    const activeFirst = await emailService.process({
        messageId: 'gmail:active-first123',
        from: 'approved@example.com',
        to: `${active.address}, ${created.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });

    assert.equal(pausedFirst.deliveredRoutes, 1);
    assert.equal(pausedFirst.skippedPausedRoutes, 1);
    assert.equal(activeFirst.deliveredRoutes, 1);
    assert.equal(activeFirst.skippedPausedRoutes, 1);
    assert.equal(sends.length, 4);
    assert.ok(sends.every(send => /Sales Active/.test(send[2].caption)));
});

test('honors a successful delivery record created by the previous single-route release', async () => {
    const { store, created, sends, emailService } = await fixture();
    store.deliveries.set('gmail:legacy123', {
        messageId: 'gmail:legacy123', chatId: '123@g.us', status: 'delivered', attempts: 1
    });
    const result = await emailService.process({
        messageId: 'gmail:legacy123',
        from: 'approved@example.com',
        to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });
    assert.equal(result.duplicate, true);
    assert.equal(sends.length, 0);
});

test('resumes page progress from a failed legacy single-route delivery record', async () => {
    const sentPages = [];
    const { store, created, emailService } = await fixture({
        client: {
            sendMessage: async (chatId, media) => sentPages.push(`${chatId}:${media.filename}`)
        },
        convertPdf: async () => [png, png, png]
    });
    store.deliveries.set('gmail:legacy-partial123', {
        messageId: 'gmail:legacy-partial123',
        chatId: '123@g.us',
        status: 'failed',
        deliveredPages: 1,
        totalPages: 3,
        attempts: 1
    });

    const result = await emailService.process({
        messageId: 'gmail:legacy-partial123',
        from: 'approved@example.com',
        to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    });

    assert.equal(result.deliveredPages, 3);
    assert.deepEqual(sentPages, [
        '123@g.us:studio-report-page-2.png',
        '123@g.us:studio-report-page-3.png'
    ]);
    const delivery = store.deliveries.get(deliveryKey('gmail:legacy-partial123', '123@g.us'));
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.deliveredPages, 3);
    assert.equal(delivery.attempts, 2);
});

test('retries a partial multi-page failure from the first unsent page', async () => {
    const attemptedPages = [];
    let failSecondPage = true;
    const { store, created, emailService } = await fixture({
        client: {
            sendMessage: async (chatId, media) => {
                attemptedPages.push(`${chatId}:${media.filename}`);
                if (failSecondPage && media.filename === 'studio-report-page-2.png') {
                    failSecondPage = false;
                    throw new Error('temporary page send failure');
                }
            }
        },
        convertPdf: async () => [png, png, png]
    });
    const payload = {
        messageId: 'gmail:page-resume123',
        from: 'approved@example.com',
        to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };

    await assert.rejects(() => emailService.process(payload), /1 destination/i);
    const failed = store.deliveries.get(deliveryKey(payload.messageId, '123@g.us'));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.deliveredPages, 1);

    const retried = await emailService.process(payload);
    assert.equal(retried.deliveredPages, 3);
    assert.deepEqual(attemptedPages, [
        '123@g.us:studio-report-page-1.png',
        '123@g.us:studio-report-page-2.png',
        '123@g.us:studio-report-page-2.png',
        '123@g.us:studio-report-page-3.png'
    ]);
    const delivered = store.deliveries.get(deliveryKey(payload.messageId, '123@g.us'));
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.deliveredPages, 3);
    assert.equal(delivered.attempts, 2);
});

test('continues other destinations when one chat send fails and retries only the failed chat', async () => {
    const { created, emailService, store } = await fixture({
        client: {
            sendMessage: async chatId => {
                if (chatId === '123@g.us' && !store.retryAllowed) throw new Error('temporary WhatsApp failure');
            }
        },
        convertPdf: async () => [png]
    });
    const finance = await emailService.routeService.createRoute({
        chatId: '456@g.us', name: 'Finance', createdBy: 'admin'
    });
    const payload = {
        messageId: 'gmail:partial123',
        from: 'approved@example.com',
        to: `${created.address}, ${finance.address}`,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    };

    await assert.rejects(() => emailService.process(payload), /1 destination/i);
    assert.equal(store.deliveries.get(deliveryKey(payload.messageId, '123@g.us')).status, 'failed');
    assert.equal(store.deliveries.get(deliveryKey(payload.messageId, '456@g.us')).status, 'delivered');

    store.retryAllowed = true;
    const retried = await emailService.process(payload);
    assert.equal(retried.deliveredRoutes, 1);
    assert.equal(retried.duplicateRoutes, 1);
});
