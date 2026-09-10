const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function commandBeside(command, executable) {
    const directory = path.dirname(command);
    if (directory === '.') return executable;
    const extension = path.extname(command);
    return path.join(directory, `${executable}${extension}`);
}

function parsePdfInfo(output) {
    const text = String(output || '');
    const countMatch = /^Pages:\s+(\d+)\s*$/im.exec(text);
    if (!countMatch) throw new Error('PDF metadata does not contain a page count.');

    const pageCount = Number(countMatch[1]);
    const pageSizes = [];
    const detailedPattern = /^Page\s+\d+\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/im;
    const globalPattern = new RegExp(detailedPattern.source, 'gim');
    let match;
    while ((match = globalPattern.exec(text))) {
        pageSizes.push({ width: Number(match[1]), height: Number(match[2]) });
    }

    if (!pageSizes.length) {
        const firstPageMatch = /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/im.exec(text);
        if (firstPageMatch) {
            pageSizes.push({ width: Number(firstPageMatch[1]), height: Number(firstPageMatch[2]) });
        }
    }
    return { pageCount, pageSizes };
}

function validateInteger(value, name, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
}

function readPngDimensions(image) {
    if (image.length < 24 || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        image.subarray(12, 16).toString('ascii') !== 'IHDR') {
        throw new Error('Rendered output is not a valid PNG.');
    }
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

async function inspectPdf(input, {
    infoCommand,
    maxPages,
    maxPageDimensionPoints,
    runCommand
}) {
    let summary;
    try {
        summary = await runCommand(infoCommand, [input], {
            timeout: 15000,
            windowsHide: true,
            maxBuffer: 256 * 1024
        });
    } catch (error) {
        throw new Error(`PDF metadata inspection failed: ${error.message || error}`);
    }

    const { pageCount } = parsePdfInfo(summary.stdout);
    if (pageCount < 1) throw new Error('PDF does not contain any pages.');
    if (pageCount > maxPages) {
        throw new Error(`PDF has ${pageCount} pages, which exceeds the configured limit of ${maxPages}.`);
    }

    let details;
    try {
        details = await runCommand(infoCommand, ['-f', '1', '-l', String(pageCount), input], {
            timeout: 15000,
            windowsHide: true,
            maxBuffer: 256 * 1024
        });
    } catch (error) {
        throw new Error(`PDF page inspection failed: ${error.message || error}`);
    }

    const metadata = parsePdfInfo(details.stdout);
    if (metadata.pageSizes.length !== pageCount) {
        throw new Error('PDF metadata is missing page dimensions.');
    }
    metadata.pageSizes.forEach((pageSize, index) => {
        if (!Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height) ||
            pageSize.width <= 0 || pageSize.height <= 0) {
            throw new Error(`PDF page ${index + 1} has invalid dimensions.`);
        }
        if (pageSize.width > maxPageDimensionPoints || pageSize.height > maxPageDimensionPoints) {
            throw new Error(`PDF page ${index + 1} exceeds the configured geometry limit.`);
        }
    });
    return metadata;
}

async function convertPdfToPngPages(pdfBuffer, options = {}) {
    const command = options.command || process.env.PDFTOPPM_PATH || 'pdftoppm';
    const infoCommand = options.infoCommand || process.env.PDFINFO_PATH || commandBeside(command, 'pdfinfo');
    const maxPages = options.maxPages ?? Number(process.env.STUDIO_MAX_PAGES || 5);
    const dpi = options.dpi ?? Number(process.env.STUDIO_PDF_DPI || 144);
    const maxPdfBytes = options.maxPdfBytes ?? Number(process.env.STUDIO_MAX_PDF_BYTES || 15 * 1024 * 1024);
    const maxImageBytes = options.maxImageBytes ?? Number(process.env.STUDIO_MAX_IMAGE_BYTES || 7 * 1024 * 1024);
    const maxPageDimensionPoints = options.maxPageDimensionPoints ?? Number(process.env.STUDIO_MAX_PAGE_POINTS || 10000);
    const maxPageDimensionPixels = options.maxPageDimensionPixels ?? Number(process.env.STUDIO_MAX_PAGE_PIXELS || 2400);
    const maxTotalPixels = options.maxTotalPixels ?? Number(process.env.STUDIO_MAX_TOTAL_PIXELS || 20 * 1000 * 1000);
    const runCommand = options.runCommand || execFileAsync;

    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error('Attachment is not a valid PDF.');
    }
    validateInteger(maxPages, 'Maximum page count', 1, 20);
    validateInteger(dpi, 'PDF rendering DPI', 72, 300);
    validateInteger(maxPdfBytes, 'Maximum PDF size', 1024, 50 * 1024 * 1024);
    validateInteger(maxImageBytes, 'Maximum rendered page size', 1024, 20 * 1024 * 1024);
    validateInteger(maxPageDimensionPoints, 'Maximum PDF page dimension', 72, 50000);
    validateInteger(maxPageDimensionPixels, 'Maximum rendered page dimension', 256, 4096);
    validateInteger(maxTotalPixels, 'Maximum total rendered pixels', 1024 * 1024, 50 * 1000 * 1000);
    if (pdfBuffer.length > maxPdfBytes) throw new Error('PDF exceeds the configured attachment size limit.');

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-report-'));
    const input = path.join(directory, 'report.pdf');
    const outputPrefix = path.join(directory, 'page');
    try {
        await fs.writeFile(input, pdfBuffer, { flag: 'wx' });
        const metadata = await inspectPdf(input, {
            infoCommand,
            maxPages,
            maxPageDimensionPoints,
            runCommand
        });

        const largestPointDimension = Math.max(...metadata.pageSizes.flatMap(pageSize => [pageSize.width, pageSize.height]));
        const renderDpi = Math.min(dpi, Math.max(72, Math.floor(maxPageDimensionPixels * 72 / largestPointDimension)));
        let estimatedPixels = 0;
        metadata.pageSizes.forEach(pageSize => {
            const width = Math.ceil(pageSize.width * renderDpi / 72);
            const height = Math.ceil(pageSize.height * renderDpi / 72);
            if (width > maxPageDimensionPixels || height > maxPageDimensionPixels) {
                throw new Error('PDF cannot be rendered within the configured pixel dimensions.');
            }
            estimatedPixels += width * height;
        });
        if (estimatedPixels > maxTotalPixels) {
            throw new Error('PDF exceeds the configured total rendered-pixel limit.');
        }

        try {
            await runCommand(command, [
                '-png', '-r', String(renderDpi), '-f', '1', '-l', String(metadata.pageCount), input, outputPrefix
            ], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
        } catch (error) {
            throw new Error(`PDF rendering failed: ${error.message || error}`);
        }

        const files = (await fs.readdir(directory))
            .filter(file => /^page-\d+\.png$/i.test(file))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        if (files.length !== metadata.pageCount) {
            throw new Error(`The PDF renderer produced ${files.length} of ${metadata.pageCount} expected pages.`);
        }

        const pages = [];
        let actualTotalPixels = 0;
        for (const file of files) {
            const pagePath = path.join(directory, file);
            // Check the filesystem metadata before allocating a Buffer for the
            // rendered page. This prevents a large renderer output from being
            // read into application memory first.
            const stats = await fs.stat(pagePath);
            if (!stats.isFile() || stats.size < PNG_SIGNATURE.length) {
                throw new Error(`Rendered page ${file} is not a valid file.`);
            }
            if (stats.size > maxImageBytes) throw new Error(`Rendered page ${file} is too large for WhatsApp.`);
            const image = await fs.readFile(pagePath);
            let dimensions;
            try {
                dimensions = readPngDimensions(image);
            } catch {
                throw new Error(`Rendered page ${file} is not a valid PNG.`);
            }
            if (!dimensions.width || !dimensions.height ||
                dimensions.width > maxPageDimensionPixels || dimensions.height > maxPageDimensionPixels) {
                throw new Error(`Rendered page ${file} exceeds the configured pixel dimensions.`);
            }
            actualTotalPixels += dimensions.width * dimensions.height;
            if (actualTotalPixels > maxTotalPixels) throw new Error('Rendered pages exceed the configured total-pixel limit.');
            pages.push(image);
        }
        return pages;
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

module.exports = { convertPdfToPngPages, parsePdfInfo };
