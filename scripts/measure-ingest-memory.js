#!/usr/bin/env node
// Measures peak memory while the real HTTP ingest path processes large PDFs.
//
//   node scripts/measure-ingest-memory.js [pdfMiB] [concurrent] [routes]
//
// The measured server runs with --max-old-space-size=128 (override with
// MEASURE_HEAP_MB) and MALLOC_ARENA_MAX=2, matching the Render Blueprint.
//
// Uses the real Express app, request limits and Poppler renderer. WhatsApp is
// stubbed (no network). Storage is MongoDB when MONGODB_TEST_URI is set (a
// throwaway database, dropped afterwards), otherwise the in-memory store, which
// keeps each route's PDF copy in this process and therefore overstates RSS.
// Never point MONGODB_TEST_URI at production.
const crypto = require('crypto');
const { once } = require('events');
const { createApp } = require('../server');
const { convertPdfToPngPages } = require('../pdfProcessor');
const { StudioEmailService } = require('../studioEmailService');
const { StudioRouteService } = require('../studioRouting');
const { MemoryStudioStore, MongoStudioStore } = require('../studioStore');

const pdfMiB = Number(process.argv[2] || 14);
const concurrent = Number(process.argv[3] || 2);
const routesPerEmail = Number(process.argv[4] || 1);
const MiB = 1024 * 1024;

// A valid two-page PDF padded with an incompressible, unreferenced stream so
// the attachment reaches the requested size without changing render cost.
function buildPdf(targetBytes) {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 5 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 5 0 R >>',
        null,
        null
    ];
    const content = 'BT /F1 24 Tf 72 500 Td (Memory test) Tj ET';
    objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    const padding = crypto.randomBytes(Math.max(0, targetBytes - 2048));
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [];
    let length = chunks[0].length;
    objects.forEach((body, index) => {
        offsets.push(length);
        const parts = index === 5
            ? [Buffer.from(`6 0 obj\n<< /Length ${padding.length} >>\nstream\n`), padding, Buffer.from('\nendstream\nendobj\n')]
            : [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`)];
        parts.forEach(part => { chunks.push(part); length += part.length; });
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
        ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`].join('');
    chunks.push(Buffer.from(xref));
    return Buffer.concat(chunks);
}

// The server runs in a child process (with the production heap flag) so the
// load generator's own request strings do not distort its measurements.
async function runServer() {
    let peakRss = 0;
    let peakHeap = 0;
    let peakExternal = 0;
    const sample = () => {
        const usage = process.memoryUsage();
        peakRss = Math.max(peakRss, usage.rss);
        peakHeap = Math.max(peakHeap, usage.heapUsed);
        peakExternal = Math.max(peakExternal, usage.external + usage.arrayBuffers);
    };

    const dbName = `wa_bot_mem_${Date.now().toString(36)}`;
    const store = process.env.MONGODB_TEST_URI
        ? await new MongoStudioStore({ uri: process.env.MONGODB_TEST_URI, dbName }).connect()
        : new MemoryStudioStore();
    const routeService = new StudioRouteService({ store, routingEmail: 'reports@example.com', pepper: 'a-measurement-only-route-pepper' });
    const addresses = [];
    for (let index = 0; index < routesPerEmail; index += 1) {
        addresses.push((await routeService.createRoute({ chatId: `${100 + index}@g.us`, name: `Route ${index}`, createdBy: 'bench' })).address);
    }
    const client = { sendMessage: async () => new Promise(resolve => setTimeout(resolve, 50)) };
    const studioEmailService = new StudioEmailService({
        routeService, store, client, convertPdf: convertPdfToPngPages, allowedSenders: new Set(['approved@example.com'])
    });
    const server = createApp({
        client, isClientReady: () => true, studioEmailService, routeService, studioStore: store,
        studioIngestToken: 'measurement-token', studioMaxConcurrent: concurrent
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    if (global.gc) global.gc();
    sample();
    const baselineRss = peakRss;
    const sampler = setInterval(sample, 10);
    process.send({ type: 'ready', port: server.address().port, addresses });
    process.on('message', async message => {
        if (message.type !== 'report') return;
        clearInterval(sampler);
        sample();
        process.send({
            type: 'report',
            heapLimit: require('v8').getHeapStatistics().heap_size_limit,
            baselineRss, peakRss, peakHeap, peakExternal
        });
        server.close();
        if (store instanceof MongoStudioStore) {
            await store.client.db(dbName).dropDatabase().catch(() => {});
            await store.close();
        }
        process.exit(0);
    });
}

async function main() {
    const { fork } = require('child_process');
    const child = fork(__filename, [...process.argv.slice(2, 5), '--server'], {
        execArgv: [`--max-old-space-size=${process.env.MEASURE_HEAP_MB || 128}`, '--expose-gc'],
        env: { ...process.env, MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2' }
    });
    const exited = once(child, 'exit');
    const [ready] = await once(child, 'message');
    const url = `http://127.0.0.1:${ready.port}/studio/email/ingest`;
    const pdf = buildPdf(Math.round(pdfMiB * MiB));
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: concurrent }, (_, index) => fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer measurement-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messageId: `gmail:memory-${Date.now()}-${index}`,
            from: 'approved@example.com',
            to: ready.addresses.join(', '),
            subject: 'Memory measurement',
            attachments: [{ mimetype: 'application/pdf', data: pdf.toString('base64') }]
        })
    }).then(async response => ({ status: response.status, body: await response.json() }))
        .catch(error => ({ status: 'no response', body: { error: error.message } }))));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const format = bytes => `${(bytes / MiB).toFixed(1)} MiB`;
    if (child.exitCode !== null || child.signalCode) {
        console.log(JSON.stringify({ serverCrashed: true, exitCode: child.exitCode, signal: child.signalCode, results }, null, 2));
        return;
    }
    child.send({ type: 'report' });
    const [report] = await once(child, 'message');
    await exited;
    console.log(JSON.stringify({
        node: process.version,
        serverHeapLimit: format(report.heapLimit),
        store: process.env.MONGODB_TEST_URI ? 'mongodb' : 'memory',
        pdfSize: format(pdf.length),
        concurrent,
        routesPerEmail,
        statuses: results.map(result => result.status),
        errors: results.filter(result => result.status !== 200).map(result => result.body.error),
        seconds,
        baselineRss: format(report.baselineRss),
        peakRss: format(report.peakRss),
        peakHeapUsed: format(report.peakHeap),
        peakExternalAndArrayBuffers: format(report.peakExternal)
    }, null, 2));
}

(process.argv.includes('--server') ? runServer() : main()).catch(error => {
    console.error(error);
    process.exit(1);
});
