const { DEFAULT_MAX_DELIVERY_ATTEMPTS, DEFAULT_DELIVERY_RETRY_BASE_MS } = require('./studioStore');

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

// Dead-lettered destinations have exhausted their retry attempts. This is a
// terminal outcome, so it uses a 4xx status that the Gmail bridge records as
// permanently rejected instead of re-uploading the same PDF on every run.
function deadLetterError(routes, deliveredRoutes) {
    const names = routes.map(route => route.name).join(', ');
    const delivered = deliveredRoutes ? ` ${deliveredRoutes} other destination(s) were delivered.` : '';
    const error = new StudioEmailError(
        `Report delivery was permanently abandoned after exhausting its retries for ${routes.length} destination(s): ${names}.`
        + `${delivered} Check the admin dashboard for the last error.`,
        422
    );
    error.code = 'DELIVERY_DEAD_LETTER';
    return error;
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

// Sends the not-yet-delivered pages of an already-rendered report to one
// chat, checkpointing progress after each page. Shared by the synchronous
// ingest path and the background retry worker so both honor the same
// resume-from-last-page and claim-ownership behavior.
async function sendPdfPages({ store, client, messageId, chatId, routeName, subject, claimToken, nextPage, pages }) {
    if (nextPage > pages.length) {
        throw new Error('Saved delivery progress exceeds the rendered PDF page count.');
    }
    for (let index = nextPage; index < pages.length; index += 1) {
        const captionParts = [routeName];
        if (subject) captionParts.push(subject);
        if (pages.length > 1) captionParts.push(`Page ${index + 1} of ${pages.length}`);
        await client.sendMessage(chatId, {
            mimetype: 'image/png',
            // Hand the rendered Buffer straight through; no base64 round-trip.
            buffer: pages[index],
            filename: `studio-report-page-${index + 1}.png`
        }, { caption: captionParts.join(' — ').slice(0, 1024) });
        if (typeof store.recordDeliveryProgress === 'function') {
            assertClaimOwnership(await store.recordDeliveryProgress(
                messageId,
                chatId,
                index + 1,
                { totalPages: pages.length, claimToken }
            ));
        }
    }
}

class StudioEmailService {
    constructor({
        routeService,
        store,
        client,
        isClientReady = () => true,
        convertPdf,
        allowedSenders = new Set(),
        maxPdfBytes = Number(process.env.STUDIO_MAX_PDF_BYTES) || 15 * 1024 * 1024,
        maxAttempts = Number(process.env.STUDIO_DELIVERY_MAX_ATTEMPTS) || DEFAULT_MAX_DELIVERY_ATTEMPTS,
        retryBaseMs = Number(process.env.STUDIO_DELIVERY_RETRY_BASE_MS) || DEFAULT_DELIVERY_RETRY_BASE_MS,
        onDeadLetter = null
    } = {}) {
        if (!routeService || !store || !client || !convertPdf) throw new Error('Studio email service dependencies are required.');
        this.routeService = routeService;
        this.store = store;
        this.client = client;
        this.isClientReady = isClientReady;
        this.convertPdf = convertPdf;
        this.allowedSenders = new Set([...allowedSenders].map(value => String(value).trim().toLowerCase()));
        this.maxPdfBytes = maxPdfBytes;
        this.maxAttempts = maxAttempts;
        this.retryBaseMs = retryBaseMs;
        this.onDeadLetter = onDeadLetter;
    }

    async notifyDeadLetter(details) {
        if (typeof this.onDeadLetter !== 'function') return;
        try {
            await this.onDeadLetter(details);
        } catch (error) {
            console.error('Dead-letter alert failed:', error.message || error);
        }
    }

    async failRoute({ messageId, route, subject, claimToken, error, countAttempt }) {
        const message = error.message || String(error);
        const outcome = await this.store.failDelivery(messageId, route.chatId, message, {
            claimToken, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs, countAttempt,
            terminal: Boolean(error && error.permanent)
        });
        if (outcome === 'dead_letter') {
            await this.notifyDeadLetter({
                messageId, chatId: route.chatId, routeId: route._id, routeName: route.name,
                subject, error: message, attempts: this.maxAttempts
            });
        }
        return outcome;
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

        // Store the source PDF once for all destination chats; each delivery
        // references it. Stores without shared PDF support get it inline.
        let pdfRef = null;
        if (typeof this.store.savePdf === 'function') {
            try {
                pdfRef = await this.store.savePdf(messageId, pdf);
            } catch (error) {
                console.error('Could not store the report PDF:', error.message || error);
                throw new StudioEmailError('Could not store the report for delivery. Retry the request.', 503);
            }
        }

        const claimedRoutes = [];
        const busyRoutes = [];
        const deadLetterRoutes = [];
        let duplicateRoutes = 0;
        try {
            for (const route of activeRoutes) {
                const claim = await this.store.beginDelivery({
                    messageId,
                    routeId: route._id,
                    chatId: route.chatId,
                    subject,
                    ...(pdfRef ? { pdfRef } : { pdf })
                });
                if (claim && claim.status === 'claimed') {
                    claimedRoutes.push({ route, claimToken: claim.claimToken, nextPage: claimPageOffset(claim) });
                } else if (claim && claim.status === 'delivered') {
                    duplicateRoutes += 1;
                } else if (claim && claim.status === 'dead_letter') {
                    deadLetterRoutes.push(route);
                } else {
                    busyRoutes.push(route);
                }
            }
        } catch (error) {
            // Nothing was sent for these claims, so release them for an immediate
            // retry without consuming an attempt or imposing a backoff.
            await Promise.allSettled(claimedRoutes.map(({ route, claimToken }) =>
                this.store.failDelivery(messageId, route.chatId, error.message || error, {
                    claimToken, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs,
                    countAttempt: false, retryDelayMs: 0
                })
            ));
            throw new StudioEmailError('Could not claim report delivery. Retry the request.', 503);
        }
        if (!claimedRoutes.length) {
            // Nothing to send now: drop the stored copy unless a busy, failed or
            // dead-lettered delivery of this email still needs it.
            if (pdfRef) await this.store.releasePdf(pdfRef).catch(() => {});
            if (busyRoutes.length) {
                throw new StudioEmailError(
                    'Report delivery is still processing or waiting for its scheduled retry. Retry the request later.',
                    503
                );
            }
            if (deadLetterRoutes.length) throw deadLetterError(deadLetterRoutes, 0);
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
                this.failRoute({ messageId, route, subject, claimToken, error, countAttempt: true })
            ));
            // A PDF that breaks a limit will never convert: answer with a
            // permanent 4xx so the Gmail bridge does not resend it either.
            throw new StudioEmailError(`Report delivery failed: ${error.message || error}`, error && error.permanent ? 422 : 502);
        }

        const failures = [];
        let deliveredRoutes = 0;
        for (const claim of claimedRoutes) {
            const { route, claimToken, nextPage } = claim;
            try {
                if (typeof this.store.renewDeliveryLease === 'function') {
                    assertClaimOwnership(await this.store.renewDeliveryLease(messageId, route.chatId, claimToken));
                }
                await sendPdfPages({
                    store: this.store, client: this.client, messageId, chatId: route.chatId,
                    routeName: route.name, subject, claimToken, nextPage, pages
                });
                assertClaimOwnership(await this.store.completeDelivery(messageId, route.chatId, {
                    deliveredPages: pages.length,
                    totalPages: pages.length,
                    claimToken
                }));
                deliveredRoutes += 1;
            } catch (error) {
                // A WhatsApp disconnect during the send is an outage, not a failed
                // report: do not let it use up the delivery's bounded attempts.
                await this.failRoute({
                    messageId, route, subject, claimToken, error, countAttempt: Boolean(this.isClientReady())
                });
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
        if (deadLetterRoutes.length) throw deadLetterError(deadLetterRoutes, deliveredRoutes);

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

module.exports = { StudioEmailError, StudioEmailService, decodePdf, sendPdfPages, assertClaimOwnership };
