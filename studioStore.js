const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const DEFAULT_DELIVERY_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 6;
const DEFAULT_DELIVERY_RETRY_BASE_MS = 60 * 1000;
const MAX_DELIVERY_RETRY_BACKOFF_MS = 30 * 60 * 1000;
// Upper bound on failures that may be recorded without consuming an attempt
// (see failurePlan). Beyond it they count normally, so a delivery that keeps
// being interrupted still reaches dead_letter eventually.
const MAX_UNCOUNTED_FAILURES = 24;

const LISTING_EXCLUDED_FIELDS = Object.freeze({ pdfData: 0, claimToken: 0 });
// Stored report PDFs are a safety net for retries, not an archive.
const PDF_RETENTION_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_DEAD_LETTER_PDF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Delivery states that may still need the source PDF.
const PDF_NEEDED_STATUSES = ['processing', 'failed', 'dead_letter'];

// One stored copy per source email, shared by every destination chat.
function pdfKeyFor(messageId) {
    return crypto.createHash('sha256').update(`pdf\0${messageId}`).digest('hex');
}

function normalizeRetentionMs(value, fallback) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 60 * 1000 ? Math.floor(ms) : fallback;
}

function normalizeRouteName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function deliveryKey(messageId, chatId) {
    return crypto.createHash('sha256').update(`${messageId}\0${chatId}`).digest('hex');
}

function normalizeDeliveryLeaseMs(value) {
    const leaseMs = Number(value);
    return Number.isFinite(leaseMs) && leaseMs >= 1000 ? Math.floor(leaseMs) : DEFAULT_DELIVERY_LEASE_MS;
}

function normalizeDeliveredPages(value) {
    const pages = Number(value);
    return Number.isSafeInteger(pages) && pages >= 0 ? pages : 0;
}

function normalizeListLimit(value, fallback = 50) {
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 ? limit : fallback;
}

function normalizeMaxDeliveryAttempts(value) {
    const attempts = Number(value);
    return Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 100
        ? attempts
        : DEFAULT_MAX_DELIVERY_ATTEMPTS;
}

function normalizeRetryBaseMs(value) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 1000 ? Math.floor(ms) : DEFAULT_DELIVERY_RETRY_BASE_MS;
}

// Exponential backoff from the attempt count already recorded on the
// delivery (1 after the first claim). Capped so a long-failing route does
// not push its next retry hours into the future.
function computeRetryBackoffMs(attempts, retryBaseMs) {
    const exponent = Math.max(0, Number(attempts) - 1);
    const backoff = retryBaseMs * Math.pow(2, exponent);
    return Math.min(Number.isFinite(backoff) ? backoff : MAX_DELIVERY_RETRY_BACKOFF_MS, MAX_DELIVERY_RETRY_BACKOFF_MS);
}

// Decides how a failed attempt is recorded. `countAttempt: false` is for a
// failure that was not a real delivery attempt (for example releasing a claim
// that never sent anything): the attempt is refunded and can never
// dead-letter the delivery. `retryDelayMs` overrides the exponential backoff.
function failurePlan(attempts, now, { maxAttempts, retryBaseMs, countAttempt = true, retryDelayMs } = {}, uncountedFailures = 0) {
    const used = Number(attempts || 0);
    const counted = countAttempt || Number(uncountedFailures || 0) >= MAX_UNCOUNTED_FAILURES;
    const exhausted = counted && used >= normalizeMaxDeliveryAttempts(maxAttempts);
    const refund = !counted && used > 0;
    const delayMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0
        ? Math.floor(retryDelayMs)
        : computeRetryBackoffMs(refund ? used - 1 : used, normalizeRetryBaseMs(retryBaseMs));
    return { exhausted, refund, uncounted: !counted, nextAttemptAt: new Date(now.getTime() + delayMs) };
}

function asDate(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Studio store clock returned an invalid date.');
    return date;
}

// A failed delivery waits out its backoff (nextAttemptAt) before any path -
// the background worker or an upstream ingest retry - may claim it again.
function retryWindowOpen(delivery, now) {
    if (!delivery.nextAttemptAt || !now) return true;
    const nextMs = new Date(delivery.nextAttemptAt).getTime();
    return !Number.isFinite(nextMs) || nextMs <= now.getTime();
}

function isReclaimableDelivery(delivery, staleBefore, now) {
    if (!delivery) return true;
    if (delivery.status === 'failed') return retryWindowOpen(delivery, now);
    if (delivery.status !== 'processing') return false;
    const timestamp = delivery.updatedAt || delivery.createdAt;
    if (!timestamp) return true;
    const timestampMs = new Date(timestamp).getTime();
    return !Number.isFinite(timestampMs) || timestampMs <= staleBefore.getTime();
}

function claimResult(delivery, claimToken) {
    return {
        status: 'claimed',
        claimToken,
        nextPage: normalizeDeliveredPages(delivery && delivery.deliveredPages)
    };
}

function unclaimedResult(delivery) {
    // Only a confirmed completed record is safe to acknowledge as a duplicate.
    // A live lease (or a record changing underneath us) must remain retryable so
    // an upstream forwarder does not forget a report whose worker later crashes.
    if (delivery && delivery.status === 'delivered') return { status: 'delivered' };
    // A dead-lettered delivery exhausted its attempts. It is terminal: reporting
    // it as busy would make the Gmail bridge re-upload the PDF on every run.
    if (delivery && delivery.status === 'dead_letter') {
        return { status: 'dead_letter', error: delivery.error || null };
    }
    return { status: 'busy' };
}

function deliveryOwnershipFilter(messageId, chatId, claimToken) {
    const filter = { _id: deliveryKey(messageId, chatId), status: 'processing' };
    if (claimToken) filter.claimToken = claimToken;
    return filter;
}

function reclaimableDeliveryFilter(key, staleBefore, now) {
    return {
        _id: key,
        $or: [
            { status: 'failed', nextAttemptAt: { $exists: false } },
            { status: 'failed', nextAttemptAt: { $lte: now } },
            { status: 'processing', updatedAt: { $lte: staleBefore } },
            { status: 'processing', updatedAt: { $exists: false }, createdAt: { $lte: staleBefore } },
            { status: 'processing', updatedAt: { $exists: false }, createdAt: { $exists: false } }
        ]
    };
}

class MongoStudioStore {
    constructor({
        uri,
        dbName = 'whatsapp_bot',
        deliveryLeaseMs = process.env.STUDIO_DELIVERY_LEASE_MS,
        deadLetterPdfRetentionMs = process.env.STUDIO_DEAD_LETTER_RETENTION_MS,
        now = () => new Date()
    } = {}) {
        if (!uri) throw new Error('MONGODB_URI is required for Studio routing storage.');
        this.deadLetterPdfRetentionMs = normalizeRetentionMs(deadLetterPdfRetentionMs, DEFAULT_DEAD_LETTER_PDF_RETENTION_MS);
        // promoteBuffers: stored PDFs must come back as Node Buffers. Without
        // it the driver returns BSON Binary objects, which the PDF renderer
        // rejects, so every background retry failed.
        this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, promoteBuffers: true });
        this.dbName = dbName;
        this.deliveryLeaseMs = normalizeDeliveryLeaseMs(deliveryLeaseMs);
        this.now = now;
    }

    async connect() {
        await this.client.connect();
        const db = this.client.db(this.dbName);
        this.routes = db.collection('studio_routes');
        this.deliveries = db.collection('studio_deliveries');
        this.pdfs = db.collection('studio_pdfs');
        await Promise.all([
            this.routes.createIndex({ tokenHash: 1 }, { unique: true }),
            this.routes.createIndex({ chatId: 1, nameKey: 1 }, { unique: true }),
            this.deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
            this.deliveries.createIndex({ status: 1, attempts: 1, updatedAt: 1 }),
            this.deliveries.createIndex({ pdfRef: 1, status: 1 }),
            this.pdfs.createIndex({ createdAt: 1 }, { expireAfterSeconds: PDF_RETENTION_SECONDS })
        ]);
        return this;
    }

    getRouteById(routeId) {
        return this.routes.findOne({ _id: routeId });
    }

    async createRoute({ chatId, name, tokenHash, createdBy }) {
        const route = {
            chatId,
            name: String(name).trim(),
            nameKey: normalizeRouteName(name),
            tokenHash,
            createdBy,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        await this.routes.insertOne(route);
        return route;
    }

    findRouteByTokenHash(tokenHash) {
        return this.routes.findOne({ tokenHash });
    }

    listRoutes(chatId) {
        return this.routes.find({ chatId }).sort({ nameKey: 1 }).toArray();
    }

    async setRouteStatus(chatId, name, status) {
        const result = await this.routes.findOneAndUpdate(
            { chatId, nameKey: normalizeRouteName(name) },
            { $set: { status, updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        return result || null;
    }

    async rotateRoute(chatId, name, tokenHash) {
        const result = await this.routes.findOneAndUpdate(
            { chatId, nameKey: normalizeRouteName(name) },
            { $set: { tokenHash, status: 'active', updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        return result || null;
    }

    async removeRoute(chatId, name) {
        const result = await this.routes.deleteOne({ chatId, nameKey: normalizeRouteName(name) });
        return result.deletedCount === 1;
    }

    listAllRoutes({ limit = 500 } = {}) {
        return this.routes.find({}).sort({ updatedAt: -1 }).limit(normalizeListLimit(limit)).toArray();
    }

    listRecentDeliveries({ chatId, limit = 50 } = {}) {
        const filter = chatId ? { chatId } : {};
        // Pending and failed deliveries carry their source PDF (up to the
        // configured PDF size each). Exclude it in the query so a listing never
        // pulls those blobs from MongoDB just to discard them.
        return this.deliveries.find(filter, { projection: LISTING_EXCLUDED_FIELDS })
            .sort({ updatedAt: -1 }).limit(normalizeListLimit(limit)).toArray();
    }

    // Stores the source PDF once per email. Deliveries reference it by
    // pdfRef, so N destination chats no longer mean N copies.
    async savePdf(messageId, pdf) {
        const ref = pdfKeyFor(messageId);
        const now = asDate(this.now());
        await this.pdfs.updateOne(
            { _id: ref },
            { $set: { messageId, data: pdf, updatedAt: now }, $setOnInsert: { createdAt: now } },
            { upsert: true }
        );
        return ref;
    }

    async loadPdf(ref) {
        if (!ref) return null;
        const record = await this.pdfs.findOne({ _id: ref });
        return record && Buffer.isBuffer(record.data) ? record.data : null;
    }

    // Deletes a stored PDF once no delivery that could still need it
    // references it. The collection's TTL index is the backstop.
    async releasePdf(ref) {
        if (!ref) return false;
        const stillNeeded = await this.deliveries.countDocuments({ pdfRef: ref, status: { $in: PDF_NEEDED_STATUSES } }, { limit: 1 });
        if (stillNeeded) return false;
        const result = await this.pdfs.deleteOne({ _id: ref });
        return result.deletedCount === 1;
    }

    async loadDeliveryPdf(delivery) {
        if (!delivery) return null;
        if (Buffer.isBuffer(delivery.pdfData)) return delivery.pdfData;
        return this.loadPdf(delivery.pdfRef);
    }

    async beginDelivery({ messageId, routeId, chatId, subject, pdf, pdfRef }) {
        const key = deliveryKey(messageId, chatId);
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const claimToken = crypto.randomUUID();
        // A shared pdfRef is preferred; an inline PDF buffer is still accepted
        // (and older records may still carry one in pdfData).
        const pdfUpdate = pdfRef ? { pdfRef } : (Buffer.isBuffer(pdf) ? { pdfData: pdf } : {});

        // Prefer the destination-aware record whenever it exists. This matters
        // after a failed legacy record has already been migrated once.
        const existing = await this.deliveries.findOne({ _id: key });
        if (existing) {
            const claimed = await this.deliveries.findOneAndUpdate(
                reclaimableDeliveryFilter(key, staleBefore, now),
                {
                    $set: { routeId, chatId, subject, status: 'processing', claimToken, updatedAt: now, ...pdfUpdate },
                    $unset: { error: '', nextAttemptAt: '', ...(pdfRef ? { pdfData: '' } : {}) },
                    $inc: { attempts: 1 }
                },
                { returnDocument: 'after' }
            );
            if (claimed) return claimResult(claimed, claimToken);
            return unclaimedResult(await this.deliveries.findOne({ _id: key }));
        }

        // Releases before multi-destination routing used the raw message ID as
        // the document key. Honor a successful legacy record so a replay after
        // upgrade cannot resend an already delivered report, while allowing a
        // failed or abandoned record to migrate with its page progress intact.
        const legacy = await this.deliveries.findOne({ _id: messageId, chatId });
        if (legacy && !isReclaimableDelivery(legacy, staleBefore, now)) return unclaimedResult(legacy);
        const deliveredPages = normalizeDeliveredPages(legacy && legacy.deliveredPages);
        try {
            const delivery = {
                _id: key,
                messageId,
                routeId,
                chatId,
                subject,
                status: 'processing',
                claimToken,
                deliveredPages,
                attempts: legacy ? Number(legacy.attempts || 1) + 1 : 1,
                createdAt: now,
                updatedAt: now,
                ...pdfUpdate
            };
            if (legacy && Number.isSafeInteger(legacy.totalPages) && legacy.totalPages >= deliveredPages) {
                delivery.totalPages = legacy.totalPages;
            }
            await this.deliveries.insertOne(delivery);
            return claimResult(delivery, claimToken);
        } catch (error) {
            if (error && error.code === 11000) {
                // Another worker won the insert race. Do not acknowledge its
                // work until its record actually confirms completed delivery.
                return unclaimedResult(await this.deliveries.findOne({ _id: key }));
            }
            throw error;
        }
    }

    async renewDeliveryLease(messageId, chatId, claimToken) {
        const result = await this.deliveries.updateOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            { $set: { updatedAt: asDate(this.now()) } }
        );
        return result.matchedCount === 1;
    }

    async recordDeliveryProgress(messageId, chatId, deliveredPages, { totalPages, claimToken } = {}) {
        const pages = normalizeDeliveredPages(deliveredPages);
        if (pages !== deliveredPages) throw new Error('Delivered page progress must be a non-negative integer.');
        const maximums = { deliveredPages: pages };
        if (Number.isSafeInteger(totalPages) && totalPages >= pages) maximums.totalPages = totalPages;
        const result = await this.deliveries.updateOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            {
                $max: maximums,
                $set: { updatedAt: asDate(this.now()) }
            }
        );
        return result.matchedCount === 1;
    }

    async completeDelivery(messageId, chatId, details = {}) {
        const { claimToken, ...deliveryDetails } = details;
        const result = await this.deliveries.updateOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            {
                $set: { ...deliveryDetails, status: 'delivered', updatedAt: asDate(this.now()) },
                $unset: { claimToken: '', error: '', pdfData: '', pdfRef: '', nextAttemptAt: '' }
            }
        );
        if (result.matchedCount === 1) await this.releasePdf(pdfKeyFor(messageId)).catch(() => {});
        return result.matchedCount === 1;
    }

    // Returns 'failed' (will be retried), 'dead_letter' (attempts exhausted)
    // or false when the caller no longer owns the claim.
    async failDelivery(messageId, chatId, error, options = {}) {
        const { claimToken, maxAttempts } = options;
        const now = asDate(this.now());
        const current = await this.deliveries.findOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            { projection: { attempts: 1, uncountedFailures: 1 } }
        );
        if (!current) return false;
        const { exhausted, refund, uncounted, nextAttemptAt } = failurePlan(current.attempts, now, options, current.uncountedFailures);
        const update = exhausted
            ? {
                // The PDF is kept (for STUDIO_DEAD_LETTER_RETENTION_MS) so an
                // operator can retry the delivery from the dashboard.
                $set: { status: 'dead_letter', error: String(error).slice(0, 500), updatedAt: now, deadLetteredAt: now },
                $unset: { claimToken: '', nextAttemptAt: '' }
            }
            : {
                $set: { status: 'failed', error: String(error).slice(0, 500), updatedAt: now, nextAttemptAt },
                $unset: { claimToken: '' },
                ...(uncounted ? { $inc: { uncountedFailures: 1, ...(refund ? { attempts: -1 } : {}) } } : {})
            };
        const result = await this.deliveries.updateOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            update
        );
        if (result.matchedCount !== 1) return false;
        return exhausted ? 'dead_letter' : 'failed';
    }

    // Moves processing leases that were abandoned at the attempt cap to
    // dead_letter and returns them (for alerting).
    async sweepAbandonedDeliveries({ maxAttempts } = {}) {
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);
        const filter = { status: 'processing', updatedAt: { $lte: staleBefore }, attempts: { $gte: limit } };
        const abandoned = await this.deliveries.find(filter, { projection: LISTING_EXCLUDED_FIELDS }).limit(100).toArray();
        if (!abandoned.length) return [];
        await this.deliveries.updateMany(
            { _id: { $in: abandoned.map(item => item._id) }, ...filter },
            {
                $set: { status: 'dead_letter', updatedAt: now, deadLetteredAt: now, error: 'Delivery lease expired at the attempt limit.' },
                $unset: { claimToken: '', nextAttemptAt: '' }
            }
        );
        return abandoned;
    }

    // Dead letters keep their PDF only for a limited time.
    async releaseExpiredDeadLetterPdfs() {
        const cutoff = new Date(asDate(this.now()).getTime() - this.deadLetterPdfRetentionMs);
        const expired = await this.deliveries.find(
            { status: 'dead_letter', deadLetteredAt: { $lte: cutoff }, $or: [{ pdfRef: { $exists: true } }, { pdfData: { $exists: true } }] },
            { projection: { pdfRef: 1 } }
        ).limit(200).toArray();
        if (!expired.length) return 0;
        await this.deliveries.updateMany(
            { _id: { $in: expired.map(item => item._id) } },
            { $unset: { pdfRef: '', pdfData: '' } }
        );
        for (const ref of new Set(expired.map(item => item.pdfRef).filter(Boolean))) {
            await this.releasePdf(ref).catch(() => {});
        }
        return expired.length;
    }

    // Puts a dead-lettered delivery back in the retry queue with a fresh
    // attempt budget, provided its source PDF is still stored.
    async requeueDelivery(messageId, chatId) {
        const key = deliveryKey(messageId, chatId);
        const delivery = await this.deliveries.findOne({ _id: key }, { projection: { pdfData: 0 } });
        if (!delivery) return { status: 'not_found' };
        if (delivery.status !== 'dead_letter') return { status: 'not_dead_letter', current: delivery.status };
        const hasInlinePdf = await this.deliveries.countDocuments({ _id: key, pdfData: { $exists: true } }, { limit: 1 });
        const hasSharedPdf = delivery.pdfRef ? await this.pdfs.countDocuments({ _id: delivery.pdfRef }, { limit: 1 }) : 0;
        if (!hasInlinePdf && !hasSharedPdf) return { status: 'pdf_missing' };
        const now = asDate(this.now());
        const result = await this.deliveries.updateOne(
            { _id: key, status: 'dead_letter' },
            {
                $set: { status: 'failed', attempts: 0, uncountedFailures: 0, nextAttemptAt: now, requeuedAt: now, updatedAt: now },
                $unset: { deadLetteredAt: '' }
            }
        );
        return { status: result.matchedCount === 1 ? 'requeued' : 'not_dead_letter' };
    }

    // Picks up one retryable delivery for the background worker: a failed
    // attempt whose backoff has elapsed, or a processing lease abandoned by a
    // crashed worker. Only deliveries with a stored PDF (and attempts still
    // under the cap) are eligible; anything beyond the cap is swept to a
    // terminal dead_letter state first so it stops being reclaimed forever.
    async claimRetryableDelivery({ maxAttempts } = {}) {
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);

        await this.sweepAbandonedDeliveries({ maxAttempts: limit });

        const claimToken = crypto.randomUUID();
        const claimed = await this.deliveries.findOneAndUpdate(
            {
                attempts: { $lt: limit },
                $and: [
                    { $or: [{ pdfData: { $exists: true } }, { pdfRef: { $exists: true } }] },
                    {
                        $or: [
                            { status: 'failed', nextAttemptAt: { $exists: false } },
                            { status: 'failed', nextAttemptAt: { $lte: now } },
                            { status: 'processing', updatedAt: { $lte: staleBefore } }
                        ]
                    }
                ]
            },
            {
                $set: { status: 'processing', claimToken, updatedAt: now },
                $unset: { error: '', nextAttemptAt: '' },
                $inc: { attempts: 1 }
            },
            { returnDocument: 'after' }
        );
        return claimed || null;
    }

    close() {
        return this.client.close();
    }
}

class MemoryStudioStore {
    constructor({
        deliveryLeaseMs = DEFAULT_DELIVERY_LEASE_MS,
        deadLetterPdfRetentionMs = DEFAULT_DEAD_LETTER_PDF_RETENTION_MS,
        now = () => new Date()
    } = {}) {
        this.routes = [];
        this.deliveries = new Map();
        this.pdfs = new Map();
        this.deadLetterPdfRetentionMs = normalizeRetentionMs(deadLetterPdfRetentionMs, DEFAULT_DEAD_LETTER_PDF_RETENTION_MS);
        this.nextId = 1;
        this.deliveryLeaseMs = normalizeDeliveryLeaseMs(deliveryLeaseMs);
        this.now = now;
    }

    async connect() { return this; }

    async createRoute({ chatId, name, tokenHash, createdBy }) {
        const nameKey = normalizeRouteName(name);
        if (this.routes.some(route => route.chatId === chatId && route.nameKey === nameKey)) {
            const error = new Error('A route with that name already exists.');
            error.code = 11000;
            throw error;
        }
        if (this.routes.some(route => route.tokenHash === tokenHash)) {
            const error = new Error('Duplicate route token.');
            error.code = 11000;
            throw error;
        }
        const route = {
            _id: String(this.nextId++), chatId, name: String(name).trim(), nameKey,
            tokenHash, createdBy, status: 'active', createdAt: new Date(), updatedAt: new Date()
        };
        this.routes.push(route);
        return route;
    }

    async findRouteByTokenHash(tokenHash) {
        return this.routes.find(route => route.tokenHash === tokenHash) || null;
    }

    async listRoutes(chatId) {
        return this.routes.filter(route => route.chatId === chatId)
            .sort((a, b) => a.nameKey.localeCompare(b.nameKey));
    }

    async setRouteStatus(chatId, name, status) {
        const route = this.routes.find(item => item.chatId === chatId && item.nameKey === normalizeRouteName(name));
        if (!route) return null;
        route.status = status;
        route.updatedAt = new Date();
        return route;
    }

    async rotateRoute(chatId, name, tokenHash) {
        const route = this.routes.find(item => item.chatId === chatId && item.nameKey === normalizeRouteName(name));
        if (!route) return null;
        route.tokenHash = tokenHash;
        route.status = 'active';
        route.updatedAt = new Date();
        return route;
    }

    async removeRoute(chatId, name) {
        const index = this.routes.findIndex(item => item.chatId === chatId && item.nameKey === normalizeRouteName(name));
        if (index < 0) return false;
        this.routes.splice(index, 1);
        return true;
    }

    async listAllRoutes({ limit = 500 } = {}) {
        return [...this.routes]
            .sort((a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0))
            .slice(0, normalizeListLimit(limit));
    }

    async getRouteById(routeId) {
        return this.routes.find(route => route._id === routeId) || null;
    }

    async listRecentDeliveries({ chatId, limit = 50 } = {}) {
        return [...this.deliveries.values()]
            .filter(delivery => !chatId || delivery.chatId === chatId)
            .sort((a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0))
            .slice(0, normalizeListLimit(limit))
            .map(({ pdfData, claimToken, ...listed }) => listed);
    }

    async savePdf(messageId, pdf) {
        const ref = pdfKeyFor(messageId);
        const existing = this.pdfs.get(ref);
        this.pdfs.set(ref, { messageId, data: pdf, createdAt: existing ? existing.createdAt : asDate(this.now()) });
        return ref;
    }

    async loadPdf(ref) {
        const record = ref && this.pdfs.get(ref);
        return record ? record.data : null;
    }

    async releasePdf(ref) {
        if (!ref) return false;
        for (const delivery of this.deliveries.values()) {
            if (delivery.pdfRef === ref && PDF_NEEDED_STATUSES.includes(delivery.status)) return false;
        }
        return this.pdfs.delete(ref);
    }

    async loadDeliveryPdf(delivery) {
        if (!delivery) return null;
        if (Buffer.isBuffer(delivery.pdfData)) return delivery.pdfData;
        return this.loadPdf(delivery.pdfRef);
    }

    async beginDelivery({ messageId, routeId, chatId, subject, pdf, pdfRef }) {
        const key = deliveryKey(messageId, chatId);
        const existing = this.deliveries.get(key);
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const claimToken = crypto.randomUUID();
        const pdfFields = pdfRef ? { pdfRef } : (Buffer.isBuffer(pdf) ? { pdfData: pdf } : {});
        if (existing) {
            if (!isReclaimableDelivery(existing, staleBefore, now)) return unclaimedResult(existing);
            Object.assign(existing, {
                routeId, chatId, subject, status: 'processing', claimToken,
                attempts: Number(existing.attempts || 0) + 1,
                updatedAt: now,
                ...pdfFields
            });
            if (pdfRef) delete existing.pdfData;
            delete existing.error;
            delete existing.nextAttemptAt;
            return claimResult(existing, claimToken);
        }

        const legacy = this.deliveries.get(messageId);
        const matchingLegacy = legacy && legacy.chatId === chatId ? legacy : null;
        if (matchingLegacy && !isReclaimableDelivery(matchingLegacy, staleBefore, now)) return unclaimedResult(matchingLegacy);
        const delivery = {
            messageId, routeId, chatId, subject, status: 'processing',
            claimToken,
            deliveredPages: normalizeDeliveredPages(matchingLegacy && matchingLegacy.deliveredPages),
            attempts: Number(matchingLegacy?.attempts || 0) + 1,
            createdAt: now,
            updatedAt: now,
            ...pdfFields
        };
        if (matchingLegacy && Number.isSafeInteger(matchingLegacy.totalPages)
            && matchingLegacy.totalPages >= delivery.deliveredPages) {
            delivery.totalPages = matchingLegacy.totalPages;
        }
        this.deliveries.set(key, delivery);
        return claimResult(delivery, claimToken);
    }

    async renewDeliveryLease(messageId, chatId, claimToken) {
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery || delivery.status !== 'processing' || (claimToken && delivery.claimToken !== claimToken)) return false;
        delivery.updatedAt = asDate(this.now());
        return true;
    }

    async recordDeliveryProgress(messageId, chatId, deliveredPages, { totalPages, claimToken } = {}) {
        const pages = normalizeDeliveredPages(deliveredPages);
        if (pages !== deliveredPages) throw new Error('Delivered page progress must be a non-negative integer.');
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery || delivery.status !== 'processing' || (claimToken && delivery.claimToken !== claimToken)) return false;
        delivery.deliveredPages = Math.max(normalizeDeliveredPages(delivery.deliveredPages), pages);
        if (Number.isSafeInteger(totalPages) && totalPages >= pages) {
            delivery.totalPages = Math.max(normalizeDeliveredPages(delivery.totalPages), totalPages);
        }
        delivery.updatedAt = asDate(this.now());
        return true;
    }

    async completeDelivery(messageId, chatId, details = {}) {
        const { claimToken, ...deliveryDetails } = details;
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery || delivery.status !== 'processing' || (claimToken && delivery.claimToken !== claimToken)) return false;
        Object.assign(delivery, deliveryDetails, { status: 'delivered', updatedAt: asDate(this.now()) });
        delete delivery.claimToken;
        delete delivery.error;
        delete delivery.pdfData;
        delete delivery.pdfRef;
        delete delivery.nextAttemptAt;
        await this.releasePdf(pdfKeyFor(messageId));
        return true;
    }

    // See MongoStudioStore.failDelivery for the return values.
    async failDelivery(messageId, chatId, error, options = {}) {
        const { claimToken } = options;
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery || delivery.status !== 'processing' || (claimToken && delivery.claimToken !== claimToken)) return false;
        const now = asDate(this.now());
        const { exhausted, refund, uncounted, nextAttemptAt } = failurePlan(delivery.attempts, now, options, delivery.uncountedFailures);
        if (exhausted) {
            Object.assign(delivery, { status: 'dead_letter', error: String(error), updatedAt: now, deadLetteredAt: now });
            delete delivery.nextAttemptAt;
        } else {
            Object.assign(delivery, { status: 'failed', error: String(error), updatedAt: now, nextAttemptAt });
            if (refund) delivery.attempts = Number(delivery.attempts) - 1;
            if (uncounted) delivery.uncountedFailures = Number(delivery.uncountedFailures || 0) + 1;
        }
        delete delivery.claimToken;
        return exhausted ? 'dead_letter' : 'failed';
    }

    async sweepAbandonedDeliveries({ maxAttempts } = {}) {
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);
        const swept = [];
        for (const delivery of this.deliveries.values()) {
            if (delivery.status === 'processing' && Number(delivery.attempts || 0) >= limit
                && delivery.updatedAt && delivery.updatedAt.getTime() <= staleBefore.getTime()) {
                const { pdfData, claimToken, ...listed } = delivery;
                swept.push(listed);
                Object.assign(delivery, {
                    status: 'dead_letter', updatedAt: now, deadLetteredAt: now,
                    error: 'Delivery lease expired at the attempt limit.'
                });
                delete delivery.claimToken;
                delete delivery.nextAttemptAt;
            }
        }
        return swept;
    }

    async releaseExpiredDeadLetterPdfs() {
        const cutoff = asDate(this.now()).getTime() - this.deadLetterPdfRetentionMs;
        let released = 0;
        const refs = new Set();
        for (const delivery of this.deliveries.values()) {
            if (delivery.status !== 'dead_letter' || !delivery.deadLetteredAt) continue;
            if (delivery.deadLetteredAt.getTime() > cutoff) continue;
            if (!delivery.pdfRef && !delivery.pdfData) continue;
            if (delivery.pdfRef) refs.add(delivery.pdfRef);
            delete delivery.pdfRef;
            delete delivery.pdfData;
            released += 1;
        }
        for (const ref of refs) await this.releasePdf(ref);
        return released;
    }

    async requeueDelivery(messageId, chatId) {
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery) return { status: 'not_found' };
        if (delivery.status !== 'dead_letter') return { status: 'not_dead_letter', current: delivery.status };
        if (!delivery.pdfData && !(delivery.pdfRef && this.pdfs.has(delivery.pdfRef))) return { status: 'pdf_missing' };
        const now = asDate(this.now());
        Object.assign(delivery, {
            status: 'failed', attempts: 0, uncountedFailures: 0, nextAttemptAt: now, requeuedAt: now, updatedAt: now
        });
        delete delivery.deadLetteredAt;
        return { status: 'requeued' };
    }

    // See MongoStudioStore.claimRetryableDelivery for the semantics this mirrors.
    async claimRetryableDelivery({ maxAttempts } = {}) {
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);

        await this.sweepAbandonedDeliveries({ maxAttempts: limit });

        for (const delivery of this.deliveries.values()) {
            if (!delivery.pdfData && !delivery.pdfRef) continue;
            if (Number(delivery.attempts || 0) >= limit) continue;
            const retryableFailed = delivery.status === 'failed'
                && (!delivery.nextAttemptAt || delivery.nextAttemptAt.getTime() <= now.getTime());
            const retryableStaleProcessing = delivery.status === 'processing'
                && delivery.updatedAt && delivery.updatedAt.getTime() <= staleBefore.getTime();
            if (!retryableFailed && !retryableStaleProcessing) continue;
            const claimToken = crypto.randomUUID();
            delivery.status = 'processing';
            delivery.claimToken = claimToken;
            delivery.attempts = Number(delivery.attempts || 0) + 1;
            delivery.updatedAt = now;
            delete delivery.nextAttemptAt;
            delete delivery.error;
            return delivery;
        }
        return null;
    }

    async close() {}
}

module.exports = {
    DEFAULT_DELIVERY_LEASE_MS,
    DEFAULT_MAX_DELIVERY_ATTEMPTS,
    DEFAULT_DELIVERY_RETRY_BASE_MS,
    MAX_DELIVERY_RETRY_BACKOFF_MS,
    MAX_UNCOUNTED_FAILURES,
    DEFAULT_DEAD_LETTER_PDF_RETENTION_MS,
    MemoryStudioStore,
    MongoStudioStore,
    pdfKeyFor,
    computeRetryBackoffMs,
    deliveryKey,
    normalizeMaxDeliveryAttempts,
    normalizeRetryBaseMs,
    normalizeRouteName
};
