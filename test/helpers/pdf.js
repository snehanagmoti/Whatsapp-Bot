// Builds a small valid PDF for tests (no external files needed).

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

module.exports = { createTestPdf };
