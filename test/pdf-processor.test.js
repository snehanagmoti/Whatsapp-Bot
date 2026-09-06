const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { convertPdfToPngPages } = require('../pdfProcessor');
const { createTestPdf } = require('../scratch/test_studio_email_delivery');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const configuredCommand = process.env.PDFTOPPM_PATH;
const hasRenderer = configuredCommand
    ? fs.existsSync(configuredCommand)
    : !spawnSync('pdftoppm', ['-h'], { windowsHide: true }).error;

test('rejects invalid PDF input and unsafe rendering limits', async () => {
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('not-pdf')), /not a valid PDF/i);
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('%PDF-test'), { maxPages: 0 }), /maximum page count/i);
    await assert.rejects(() => convertPdfToPngPages(Buffer.from('%PDF-test'), { dpi: 400 }), /rendering DPI/i);
});

test('Poppler renders a generated PDF into a genuine PNG page', {
    skip: hasRenderer ? false : 'Poppler is unavailable on this host'
}, async () => {
    const pages = await convertPdfToPngPages(createTestPdf(), {
        command: process.env.PDFTOPPM_PATH || 'pdftoppm',
        maxPages: 2,
        dpi: 96
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].subarray(0, 8).equals(pngSignature), true);
});
