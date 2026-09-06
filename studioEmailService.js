class StudioEmailError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'StudioEmailError';
        this.statusCode = statusCode;
    }
}

function decodePdf(value, maxBytes) {
    if (typeof value !== 'string') throw new StudioEmailError('PDF attachment data must be base64.');
    const normalized = value.replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '');
    if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        throw new StudioEmailError('PDF attachment is not valid base64.');
    }
    const pdf = Buffer.from(normalized, 'base64');
    if (!pdf.length || pdf.length > maxBytes) throw new StudioEmailError('PDF attachment exceeds the allowed size.');
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new StudioEmailError('Attachment is not a valid PDF.');
    return pdf;
}

class StudioEmailService {
    constructor({
        routeService,
        store,
        client,
        isClientReady = () => true,
        convertPdf,
        allowedSenders = new Set(),
        maxPdfBytes = Number(process.env.STUDIO_MAX_PDF_BYTES) || 15 * 1024 * 1024
    } = {}) {
        if (!routeService || !store || !client || !convertPdf) throw new Error('Studio email service dependencies are required.');
        this.routeService = routeService;
        this.store = store;
        this.client = client;
        this.isClientReady = isClientReady;
        this.convertPdf = convertPdf;
        this.allowedSenders = new Set([...allowedSenders].map(value => String(value).trim().toLowerCase()));
        this.maxPdfBytes = maxPdfBytes;
    }

    async process(payload = {}) {
        const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
        if (!/^[A-Za-z0-9._:@/-]{6,250}$/.test(messageId)) throw new StudioEmailError('A valid messageId is required.');
        if (!this.isClientReady()) throw new StudioEmailError('WhatsApp is not connected.', 503);
        const sender = (String(payload.from || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i) || [])[0];
        if (this.allowedSenders.size && (!sender || !this.allowedSenders.has(sender.toLowerCase()))) {
            throw new StudioEmailError('Email sender is not approved.', 403);
        }

        const route = await this.routeService.resolveRecipient(payload.to);
        if (!route) throw new StudioEmailError('No active report route matches the recipient.', 404);
        if (route.status !== 'active') throw new StudioEmailError('This report route is paused.', 409);

        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachment = attachments.find(item => item && /^application\/pdf(?:;|$)/i.test(item.mimetype || ''));
        if (!attachment) throw new StudioEmailError('A PDF attachment is required.');
        const pdf = decodePdf(attachment.data, this.maxPdfBytes);
        const subject = typeof payload.subject === 'string' ? payload.subject.trim().slice(0, 200) : '';

        const claimed = await this.store.beginDelivery({
            messageId,
            routeId: route._id,
            chatId: route.chatId,
            subject
        });
        if (!claimed) return { duplicate: true, deliveredPages: 0, routeName: route.name };

        try {
            const pages = await this.convertPdf(pdf);
            for (let index = 0; index < pages.length; index += 1) {
                const captionParts = [route.name];
                if (subject) captionParts.push(subject);
                if (pages.length > 1) captionParts.push(`Page ${index + 1} of ${pages.length}`);
                await this.client.sendMessage(route.chatId, {
                    mimetype: 'image/png',
                    data: pages[index].toString('base64'),
                    filename: `studio-report-page-${index + 1}.png`
                }, { caption: captionParts.join(' — ').slice(0, 1024) });
            }
            await this.store.completeDelivery(messageId, { deliveredPages: pages.length });
            return { duplicate: false, deliveredPages: pages.length, routeName: route.name };
        } catch (error) {
            await this.store.failDelivery(messageId, error.message || error);
            throw new StudioEmailError(`Report delivery failed: ${error.message || error}`, 502);
        }
    }
}

module.exports = { StudioEmailError, StudioEmailService, decodePdf };
