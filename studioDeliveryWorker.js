const { DEFAULT_MAX_DELIVERY_ATTEMPTS, DEFAULT_DELIVERY_RETRY_BASE_MS } = require('./studioStore');
const { sendPdfPages, assertClaimOwnership } = require('./studioEmailService');

const DEFAULT_WORKER_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_CLAIMS_PER_TICK = 5;

function normalizeIntervalMs(value) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 5000 ? Math.floor(ms) : DEFAULT_WORKER_INTERVAL_MS;
}

// Durable retry/dead-letter layer for report deliveries. Report processing
// still happens inline in the HTTP ingest request for the common case (see
// StudioEmailService.process), which keeps latency low and the Apps Script
// response contract unchanged. This worker is the safety net: it does not
// depend on the ingest request completing, and it does not depend on the
// upstream Gmail bridge resending an email. Every claimed route stores its
// own copy of the source PDF up front (see StudioStore#beginDelivery), so a
// delivery that failed - or whose worker process crashed mid-send, leaving
// it stuck in "processing" past its lease - can always be picked back up
// from here on a fixed interval, with exponential backoff between attempts
// and a bounded attempt count. A delivery that exhausts its attempts moves
// to a terminal "dead_letter" status instead of retrying forever; it stays
// visible (with its last error) in the admin dashboard and the delivery
// list, and stops holding onto the stored PDF bytes once it gets there.
class StudioDeliveryWorker {
    constructor({
        store,
        client,
        convertPdf,
        isClientReady = () => true,
        maxAttempts = Number(process.env.STUDIO_DELIVERY_MAX_ATTEMPTS) || DEFAULT_MAX_DELIVERY_ATTEMPTS,
        retryBaseMs = Number(process.env.STUDIO_DELIVERY_RETRY_BASE_MS) || DEFAULT_DELIVERY_RETRY_BASE_MS,
        intervalMs = process.env.STUDIO_DELIVERY_WORKER_INTERVAL_MS,
        maxClaimsPerTick = DEFAULT_MAX_CLAIMS_PER_TICK,
        onDeadLetter = null,
        log = console
    } = {}) {
        if (!store || !client || !convertPdf) throw new Error('Studio delivery worker dependencies are required.');
        this.store = store;
        this.client = client;
        this.convertPdf = convertPdf;
        this.isClientReady = isClientReady;
        this.maxAttempts = maxAttempts;
        this.retryBaseMs = retryBaseMs;
        this.intervalMs = normalizeIntervalMs(intervalMs);
        this.maxClaimsPerTick = maxClaimsPerTick;
        this.log = log;
        this.onDeadLetter = onDeadLetter;
        this.timer = null;
        this.ticking = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.tick().catch(error => this.log.error('Studio delivery worker tick failed:', error.message || error));
        }, this.intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
            // Housekeeping runs even while WhatsApp is disconnected.
            if (typeof this.store.releaseExpiredDeadLetterPdfs === 'function') {
                await this.store.releaseExpiredDeadLetterPdfs().catch(error =>
                    this.log.error('Could not release expired dead-letter PDFs:', error.message || error));
            }
            if (!this.isClientReady()) return;
            if (typeof this.store.sweepAbandonedDeliveries === 'function') {
                const swept = await this.store.sweepAbandonedDeliveries({ maxAttempts: this.maxAttempts });
                for (const delivery of swept) await this.notifyDeadLetter(delivery, delivery.error);
            }
            for (let claimCount = 0; claimCount < this.maxClaimsPerTick; claimCount += 1) {
                const claimed = await this.store.claimRetryableDelivery({
                    maxAttempts: this.maxAttempts,
                    retryBaseMs: this.retryBaseMs
                });
                if (!claimed) break;
                await this.processClaimed(claimed);
            }
        } finally {
            this.ticking = false;
        }
    }

    async notifyDeadLetter(delivery, error) {
        if (typeof this.onDeadLetter !== 'function') return;
        try {
            const route = delivery.routeId ? await this.store.getRouteById(delivery.routeId).catch(() => null) : null;
            await this.onDeadLetter({ ...delivery, routeName: route ? route.name : null, error: error || delivery.error });
        } catch (alertError) {
            this.log.error('Dead-letter alert failed:', alertError.message || alertError);
        }
    }

    async processClaimed(delivery) {
        const { messageId, chatId, claimToken, routeId, subject } = delivery;
        const nextPage = Number.isSafeInteger(delivery.deliveredPages) && delivery.deliveredPages >= 0
            ? delivery.deliveredPages
            : 0;
        try {
            const pdf = typeof this.store.loadDeliveryPdf === 'function'
                ? await this.store.loadDeliveryPdf(delivery)
                : delivery.pdfData;
            if (!pdf) throw new Error('No stored PDF is available to retry this delivery.');
            const route = await this.store.getRouteById(routeId);
            if (!route) throw new Error('The report route for this delivery no longer exists.');
            const pages = await this.convertPdf(pdf);
            if (typeof this.store.renewDeliveryLease === 'function') {
                assertClaimOwnership(await this.store.renewDeliveryLease(messageId, chatId, claimToken));
            }
            await sendPdfPages({
                store: this.store, client: this.client, messageId, chatId,
                routeName: route.name, subject, claimToken, nextPage, pages
            });
            assertClaimOwnership(await this.store.completeDelivery(messageId, chatId, {
                deliveredPages: pages.length,
                totalPages: pages.length,
                claimToken
            }));
            this.log.log(`Studio delivery worker: retry succeeded for ${chatId} (message ${messageId}).`);
        } catch (error) {
            // Readiness is checked before claiming, but WhatsApp can still drop
            // mid-send. Such an interruption does not consume an attempt.
            const outcome = await this.store.failDelivery(messageId, chatId, error.message || error, {
                claimToken, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs,
                countAttempt: Boolean(this.isClientReady())
            });
            this.log.warn(`Studio delivery worker: retry failed for ${chatId} (message ${messageId}): ${error.message || error}`);
            if (outcome === 'dead_letter') await this.notifyDeadLetter(delivery, error.message || String(error));
        }
    }
}

module.exports = { StudioDeliveryWorker, DEFAULT_WORKER_INTERVAL_MS };
