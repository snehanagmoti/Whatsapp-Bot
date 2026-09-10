const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { convertPdfToPngPages, parsePdfInfo } = require('../pdfProcessor');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const configuredRenderer = process.env.PDFTOPPM_PATH;
const configuredInspector = process.env.PDFINFO_PATH;
const rendererCommand = configuredRenderer || 'pdftoppm';
const inspectorCommand = configuredInspector || (configuredRenderer
    ? require('node:path').join(require('node:path').dirname(configuredRenderer), `pdfinfo${require('node:path').extname(configuredRenderer)}`)
    : 'pdfinfo');
const hasPoppler = (configuredRenderer ? fs.existsSync(configuredRenderer) : !spawnSync(rendererCommand, ['-h'], { windowsHide: true }).error) &&
    (configuredInspector ? fs.existsSync(configuredInspector) : !spawnSync(inspectorCommand, ['-v'], { windowsHide: true }).error);

function createTestPdf({ pageCount = 1, width = 612, height = 792 } = {}) {
    const objects = [];
    const pageStart = 3;
    const fontObject = pageStart + pageCount;
    const contentStart = fontObject + 1;
    const kids = Array.from({ length: pageCount }, (_, index) => `${pageStart + index} 0 R`).join(' ');
    objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
    for (let index = 0; index < pageCount; index += 1) {
        objects.push(`${pageStart + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentStart + index} 0 R >>\nendobj\n`);
    }
    objects.push(`${fontObject} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
    for (let index = 0; index < pageCount; index += 1) {
        const stream = `BT /F1 24 Tf 72 720 Td (Test page ${index + 1}) Tj ET`;
        objects.push(`${contentStart + index} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`);
    }

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += object;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index <= objects.length; index += 1) {
        pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

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
