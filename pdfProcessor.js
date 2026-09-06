const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function convertPdfToPngPages(pdfBuffer, {
    command = process.env.PDFTOPPM_PATH || 'pdftoppm',
    maxPages = Number(process.env.STUDIO_MAX_PAGES) || 5,
    dpi = Number(process.env.STUDIO_PDF_DPI) || 144,
    maxImageBytes = Number(process.env.STUDIO_MAX_IMAGE_BYTES) || 7 * 1024 * 1024
} = {}) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error('Attachment is not a valid PDF.');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('Invalid maximum page count.');
    if (!Number.isInteger(dpi) || dpi < 72 || dpi > 300) throw new Error('Invalid PDF rendering DPI.');

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-report-'));
    const input = path.join(directory, 'report.pdf');
    const outputPrefix = path.join(directory, 'page');
    try {
        await fs.writeFile(input, pdfBuffer, { flag: 'wx' });
        await execFileAsync(command, [
            '-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), input, outputPrefix
        ], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
        const files = (await fs.readdir(directory))
            .filter(file => /^page-\d+\.png$/i.test(file))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        if (!files.length) throw new Error('The PDF renderer did not produce any pages.');
        const pages = [];
        for (const file of files) {
            const image = await fs.readFile(path.join(directory, file));
            if (image.length > maxImageBytes) throw new Error(`Rendered page ${file} is too large for WhatsApp.`);
            pages.push(image);
        }
        return pages;
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

module.exports = { convertPdfToPngPages };
