const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { convertPdfToPngPages } = require('../pdfProcessor');
const { createApp } = require('../server');
const { createTestPdf } = require('../scratch/test_studio_email_delivery');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore } = require('../studioStore');

const configuredCommand = process.env.PDFTOPPM_PATH;
const hasRenderer = configuredCommand
    ? fs.existsSync(configuredCommand)
    : !spawnSync('pdftoppm', ['-h'], { windowsHide: true }).error;

test('HTTP ingest performs a real PDF-to-PNG delivery and suppresses a replay', {
    skip: hasRenderer ? false : 'Poppler is unavailable on this host'
}, async () => {
    const store = new MemoryStudioStore();
    const routeService = new StudioRouteService({
        store,
        routingEmail: 'reports@example.com',
        pepper: 'a-long-test-only-route-pepper-value'
    });
    const route = await routeService.createRoute({ chatId: '123@g.us', name: 'Integration', createdBy: 'admin' });
    const sends = [];
    const client = { sendMessage: async (...args) => sends.push(args) };
    const service = new StudioEmailService({
        routeService,
        store,
        client,
        isClientReady: () => true,
        convertPdf: pdf => convertPdfToPngPages(pdf, { command: configuredCommand || 'pdftoppm', dpi: 96 }),
        allowedSenders: new Set(['approved@example.com'])
    });
    const server = createApp({
        client,
        studioEmailService: service,
        studioIngestToken: 'integration-secret'
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/studio/email/ingest`;
    const payload = {
        messageId: 'gmail:integration123',
        from: 'Looker Studio <approved@example.com>',
        to: route.address,
        subject: 'Actual generated PDF',
        attachments: [{
            filename: 'report.pdf',
            mimetype: 'application/pdf',
            data: createTestPdf().toString('base64')
        }]
    };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer integration-secret', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).deliveredPages, 1);
        assert.equal(sends.length, 1);
        assert.equal(sends[0][0], '123@g.us');
        assert.equal(Buffer.from(sends[0][1].data, 'base64').subarray(1, 4).toString(), 'PNG');

        const replay = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer integration-secret', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        assert.equal((await replay.json()).duplicate, true);
        assert.equal(sends.length, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
