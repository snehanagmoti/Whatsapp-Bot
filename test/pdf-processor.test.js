const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { convertPdfToPngPages, parsePdfInfo } = require('../pdfProcessor');
const { createTestPdf } = require('./helpers/pdf');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const configuredRenderer = process.env.PDFTOPPM_PATH;
const configuredInspector = process.env.PDFINFO_PATH;
const rendererCommand = configuredRenderer || 'pdftoppm';
const inspectorCommand = configuredInspector || (configuredRenderer
    ? require('node:path').join(require('node:path').dirname(configuredRenderer), `pdfinfo${require('node:path').extname(configuredRenderer)}`)
    : 'pdfinfo');
const hasPoppler = (configuredRenderer ? fs.existsSync(configuredRenderer) : !spawnSync(rendererCommand, ['-h'], { windowsHide: true }).error) &&
    (configuredInspector ? fs.existsSync(configuredInspector) : !spawnSync(inspectorCommand, ['-v'], { windowsHide: true }).error);

test('parses Poppler page count and per-page geometry', () => {
    const metadata = parsePdfInfo('Pages:          2\nPage    1 size:  612 x 792 pts\nPage    2 size:  700 x 800 pts\n');
    assert.equal(metadata.pageCount, 2);
    assert.deepEqual(metadata.pageSizes, [
        { width: 612, height: 792 },
        { width: 700, height: 800 }
    ]);
});

test('rejects invalid PDF input and unsafe rendering limits', async () => {
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('not-pdf')), /not a valid PDF/i);
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('%PDF-test'), { maxPages: 0 }), /maximum page count/i);
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('%PDF-test'), { dpi: 400 }), /rendering DPI/i);
    await assert.rejects(() => convertPdfToPngPages(Buffer.alloc(2048, '%PDF-'), { maxPdfBytes: 1024 }), /attachment size limit/i);
});

test('Poppler rejects PDFs that exceed page, geometry or total-pixel limits before rendering', {
    skip: hasPoppler ? false : 'Poppler is unavailable on this host'
}, async () => {
    await assert.rejects(() => convertPdfToPngPages(createTestPdf({ pageCount: 2 }), {
        command: rendererCommand,
        infoCommand: inspectorCommand,
        maxPages: 1
    }), /2 pages.*limit of 1/i);

    await assert.rejects(() => convertPdfToPngPages(createTestPdf(), {
        command: rendererCommand,
        infoCommand: inspectorCommand,
        maxPageDimensionPoints: 700
    }), /geometry limit/i);

    await assert.rejects(() => convertPdfToPngPages(createTestPdf(), {
        command: rendererCommand,
        infoCommand: inspectorCommand,
        dpi: 300,
        maxTotalPixels: 1024 * 1024
    }), /total rendered-pixel limit/i);
});

test('Poppler renders every accepted PDF page into a genuine PNG', {
    skip: hasPoppler ? false : 'Poppler is unavailable on this host'
}, async () => {
    const pages = await convertPdfToPngPages(createTestPdf({ pageCount: 2 }), {
        command: rendererCommand,
        infoCommand: inspectorCommand,
        maxPages: 2,
        dpi: 96
    });
    assert.equal(pages.length, 2);
    assert.equal(pages.every(page => page.subarray(0, 8).equals(pngSignature)), true);
});

test('limit breaks are marked permanent, renderer crashes stay retryable', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% fake\n');
    const info = pages => async (command, args) => ({
        stdout: [`Pages: ${pages}`, ...Array.from({ length: pages }, (_, i) => `Page ${i + 1} size: 595 x 842 pts`)].join('\n')
    });
    await assert.rejects(
        () => convertPdfToPngPages(pdf, { command: 'pdftoppm', infoCommand: 'pdfinfo', runCommand: info(8) }),
        error => /exceeds the configured limit of 5/.test(error.message) && error.permanent === true
    );
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('not a pdf')), error => error.permanent === true);
    const crashing = async (command, args) => {
        if (command === 'pdftoppm') throw new Error('renderer killed');
        return info(1)(command, args);
    };
    await assert.rejects(
        () => convertPdfToPngPages(pdf, { command: 'pdftoppm', infoCommand: 'pdfinfo', runCommand: crashing }),
        error => /PDF rendering failed/.test(error.message) && !error.permanent
    );
});
