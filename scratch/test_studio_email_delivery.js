function createTestPdf() {
    const objects = [];
    const stream = 'BT /F1 24 Tf 72 720 Td (Simulated Looker Studio report) Tj ET';
    objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
    objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
    objects.push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`);
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

async function main() {
    const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const token = process.env.STUDIO_INGEST_TOKEN_OVERRIDE || process.env.STUDIO_INGEST_TOKEN;
    const routingEmail = process.env.STUDIO_TEST_ROUTING_EMAIL;
    const sender = process.env.STUDIO_TEST_SENDER;
    if (!baseUrl || !token || !routingEmail || !sender) {
        throw new Error('Set PUBLIC_BASE_URL, STUDIO_INGEST_TOKEN, STUDIO_TEST_ROUTING_EMAIL and an approved STUDIO_TEST_SENDER.');
    }
    const response = await fetch(`${baseUrl}/studio/email/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messageId: `simulated:${Date.now()}`,
            from: sender,
            to: routingEmail,
            subject: 'TEST: Simulated Looker Studio scheduled delivery',
            attachments: [{
                filename: 'simulated-looker-studio-report.pdf',
                mimetype: 'application/pdf',
                data: createTestPdf().toString('base64')
            }]
        })
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
    console.log(body);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = { createTestPdf };
