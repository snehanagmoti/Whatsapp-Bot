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

function claimPageOffset(claim) {
    if (!claim || typeof claim !== 'object') return 0;
    const nextPage = Number(claim.nextPage);
    return Number.isSafeInteger(nextPage) && nextPage >= 0 ? nextPage : 0;
}

function assertClaimOwnership(updated) {
    if (updated !== false) return;
    const error = new Error('Delivery lease expired while the report was being processed.');
    error.code = 'DELIVERY_LEASE_LOST';
    throw error;
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

        const resolvedRoutes = await this.routeService.resolveRecipients(payload.to);
        if (!resolvedRoutes.length) throw new StudioEmailError('No active report route matches the recipient.', 404);

        // A paused alias must never hide an active alias for the same chat. Apply
        // status first, then deduplicate active destinations by chat.
        const pausedRoutes = resolvedRoutes.filter(route => route.status !== 'active');
        const activeRoutes = [];
        const seenChatIds = new Set();
        for (const route of resolvedRoutes) {
            if (route.status !== 'active') continue;
            if (seenChatIds.has(route.chatId)) continue;
            seenChatIds.add(route.chatId);
            activeRoutes.push(route);
        }
        if (!activeRoutes.length) {
            return {
                duplicate: false,
                deliveredPages: 0,
                deliveredRoutes: 0,
                duplicateRoutes: 0,
                skippedPausedRoutes: pausedRoutes.length,
                routeNames: pausedRoutes.map(route => route.name),
                skippedReason: 'paused'
            };
        }

        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachment = attachments.find(item => item && /^application\/pdf(?:;|$)/i.test(item.mimetype || ''));
        if (!attachment) throw new StudioEmailError('A PDF attachment is required.');
        const pdf = decodePdf(attachment.data, this.maxPdfBytes);
        const subject = typeof payload.subject === 'string' ? payload.subject.trim().slice(0, 200) : '';

        const claimedRoutes = [];
        const busyRoutes = [];
        let duplicateRoutes = 0;
        try {
            for (const route of activeRoutes) {
                const claim = await this.store.beginDelivery({
                    messageId,
                    routeId: route._id,
                    chatId: route.chatId,
                    subject
                });
                if (claim && claim.status === 'claimed') {
                    claimedRoutes.push({ route, claimToken: claim.claimToken, nextPage: claimPageOffset(claim) });
                } else if (claim && claim.status === 'delivered') {
                    duplicateRoutes += 1;
                } else {
                    busyRoutes.push(route);
                }
            }
        } catch (error) {
            await Promise.allSettled(claimedRoutes.map(({ route, claimToken }) =>
                this.store.failDelivery(messageId, route.chatId, error.message || error, { claimToken })
            ));
            throw new StudioEmailError('Could not claim report delivery. Retry the request.', 503);
        }
        if (!claimedRoutes.length) {
            if (busyRoutes.length) {
                throw new StudioEmailError('Report delivery is still processing for another request. Retry the request.', 503);
            }
            return {
                duplicate: true,
                deliveredPages: 0,
                deliveredRoutes: 0,
                duplicateRoutes,
                skippedPausedRoutes: pausedRoutes.length,
                routeNames: activeRoutes.map(route => route.name)
            };
        }

        let pages;
        try {
            pages = await this.convertPdf(pdf);
        } catch (error) {
            await Promise.all(claimedRoutes.map(({ route, claimToken }) =>
                this.store.failDelivery(messageId, route.chatId, error.message || error, { claimToken })
            ));
            throw new StudioEmailError(`Report delivery failed: ${error.message || error}`, 502);
        }

        const failures = [];
        let deliveredRoutes = 0;
        for (const claim of claimedRoutes) {
            const { route, claimToken, nextPage } = claim;
            try {
                if (typeof this.store.renewDeliveryLease === 'function') {
                    assertClaimOwnership(await this.store.renewDeliveryLease(messageId, route.chatId, claimToken));
                }
                if (nextPage > pages.length) {
                    throw new Error('Saved delivery progress exceeds the rendered PDF page count.');
                }
                for (let index = nextPage; index < pages.length; index += 1) {
                    const captionParts = [route.name];
                    if (subject) captionParts.push(subject);
                    if (pages.length > 1) captionParts.push(`Page ${index + 1} of ${pages.length}`);
                    await this.client.sendMessage(route.chatId, {
                        mimetype: 'image/png',
                        data: pages[index].toString('base64'),
                        filename: `studio-report-page-${index + 1}.png`
                    }, { caption: captionParts.join(' — ').slice(0, 1024) });
                    if (typeof this.store.recordDeliveryProgress === 'function') {
                        assertClaimOwnership(await this.store.recordDeliveryProgress(
                            messageId,
                            route.chatId,
                            index + 1,
                            { totalPages: pages.length, claimToken }
                        ));
                    }
                }
                assertClaimOwnership(await this.store.completeDelivery(messageId, route.chatId, {
                    deliveredPages: pages.length,
                    totalPages: pages.length,
                    claimToken
                }));
                deliveredRoutes += 1;
            } catch (error) {
                await this.store.failDelivery(messageId, route.chatId, error.message || error, { claimToken });
                failures.push({ routeName: route.name, error: error.message || String(error) });
            }
        }

        if (failures.length || busyRoutes.length) {
            const incompleteNames = [...failures.map(item => item.routeName), ...busyRoutes.map(route => route.name)];
            throw new StudioEmailError(
                `Report delivery failed or is still processing for ${incompleteNames.length} destination(s): ${incompleteNames.join(', ')}. Retry the request.`,
                busyRoutes.length ? 503 : 502
            );
        }

        return {
            duplicate: false,
            deliveredPages: pages.length * deliveredRoutes,
            pagesPerRoute: pages.length,
            deliveredRoutes,
            duplicateRoutes,
            skippedPausedRoutes: pausedRoutes.length,
            routeNames: claimedRoutes.map(({ route }) => route.name)
        };
    }
}

module.exports = { StudioEmailError, StudioEmailService, decodePdf };
