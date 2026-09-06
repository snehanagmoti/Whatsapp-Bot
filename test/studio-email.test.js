const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

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

test('rejects an unapproved sender and a paused route', async () => {
    const { created, emailService } = await fixture();
    await assert.rejects(() => emailService.process({
        messageId: 'gmail:bad-sender', from: 'bad@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), /sender is not approved/i);
    await emailService.routeService.setRouteStatus('123@g.us', 'Sales', 'paused');
    await assert.rejects(() => emailService.process({
        messageId: 'gmail:paused-route', from: 'approved@example.com', to: created.address,
        attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
    }), /route is paused/i);
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
    assert.equal(store.deliveries.get(payload.messageId).status, 'delivered');
    assert.equal(store.deliveries.get(payload.messageId).attempts, 2);
});
