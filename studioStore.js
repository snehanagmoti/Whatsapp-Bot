const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const DEFAULT_DELIVERY_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 6;
const DEFAULT_DELIVERY_RETRY_BASE_MS = 60 * 1000;
const MAX_DELIVERY_RETRY_BACKOFF_MS = 30 * 60 * 1000;

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

function asDate(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Studio store clock returned an invalid date.');
    return date;
}

function isReclaimableDelivery(delivery, staleBefore) {
    if (!delivery) return true;
    if (delivery.status === 'failed') return true;
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
    return { status: delivery && delivery.status === 'delivered' ? 'delivered' : 'busy' };
}

function deliveryOwnershipFilter(messageId, chatId, claimToken) {
    const filter = { _id: deliveryKey(messageId, chatId), status: 'processing' };
    if (claimToken) filter.claimToken = claimToken;
    return filter;
}

function reclaimableDeliveryFilter(key, staleBefore) {
    return {
        _id: key,
        $or: [
            { status: 'failed' },
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
        now = () => new Date()
    } = {}) {
        if (!uri) throw new Error('MONGODB_URI is required for Studio routing storage.');
        this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
        this.dbName = dbName;
        this.deliveryLeaseMs = normalizeDeliveryLeaseMs(deliveryLeaseMs);
        this.now = now;
    }

    async connect() {
        await this.client.connect();
        const db = this.client.db(this.dbName);
        this.routes = db.collection('studio_routes');
        this.deliveries = db.collection('studio_deliveries');
        await Promise.all([
            this.routes.createIndex({ tokenHash: 1 }, { unique: true }),
            this.routes.createIndex({ chatId: 1, nameKey: 1 }, { unique: true }),
            this.deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
            this.deliveries.createIndex({ status: 1, attempts: 1, updatedAt: 1 })
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
        return this.deliveries.find(filter).sort({ updatedAt: -1 }).limit(normalizeListLimit(limit)).toArray();
    }

    async beginDelivery({ messageId, routeId, chatId, subject, pdf }) {
        const key = deliveryKey(messageId, chatId);
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const claimToken = crypto.randomUUID();
        const pdfUpdate = Buffer.isBuffer(pdf) ? { pdfData: pdf } : {};

        // Prefer the destination-aware record whenever it exists. This matters
        // after a failed legacy record has already been migrated once.
        const existing = await this.deliveries.findOne({ _id: key });
        if (existing) {
            const claimed = await this.deliveries.findOneAndUpdate(
                reclaimableDeliveryFilter(key, staleBefore),
                {
                    $set: { routeId, chatId, subject, status: 'processing', claimToken, updatedAt: now, ...pdfUpdate },
                    $unset: { error: '', nextAttemptAt: '' },
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
        if (legacy && !isReclaimableDelivery(legacy, staleBefore)) return unclaimedResult(legacy);
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
                $unset: { claimToken: '', error: '', pdfData: '', nextAttemptAt: '' }
            }
        );
        return result.matchedCount === 1;
    }

    async failDelivery(messageId, chatId, error, { claimToken, maxAttempts, retryBaseMs } = {}) {
        const now = asDate(this.now());
        const current = await this.deliveries.findOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            { projection: { attempts: 1 } }
        );
        if (!current) return false;
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);
        const exhausted = Number(current.attempts || 0) >= limit;
        const update = exhausted
            ? {
                $set: { status: 'dead_letter', error: String(error).slice(0, 500), updatedAt: now },
                $unset: { claimToken: '', pdfData: '', nextAttemptAt: '' }
            }
            : {
                $set: {
                    status: 'failed',
                    error: String(error).slice(0, 500),
                    updatedAt: now,
                    nextAttemptAt: new Date(now.getTime() + computeRetryBackoffMs(current.attempts, normalizeRetryBaseMs(retryBaseMs)))
                },
                $unset: { claimToken: '' }
            };
        const result = await this.deliveries.updateOne(
            deliveryOwnershipFilter(messageId, chatId, claimToken),
            update
        );
        return result.matchedCount === 1;
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

        await this.deliveries.updateMany(
            { status: 'processing', updatedAt: { $lte: staleBefore }, attempts: { $gte: limit } },
            { $set: { status: 'dead_letter', updatedAt: now }, $unset: { pdfData: '', claimToken: '', nextAttemptAt: '' } }
        );

        const claimToken = crypto.randomUUID();
        const claimed = await this.deliveries.findOneAndUpdate(
            {
                pdfData: { $exists: true },
                attempts: { $lt: limit },
                $or: [
                    { status: 'failed', $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
                    { status: 'processing', updatedAt: { $lte: staleBefore } }
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
    constructor({ deliveryLeaseMs = DEFAULT_DELIVERY_LEASE_MS, now = () => new Date() } = {}) {
        this.routes = [];
        this.deliveries = new Map();
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
            .slice(0, normalizeListLimit(limit));
    }

    async beginDelivery({ messageId, routeId, chatId, subject, pdf }) {
        const key = deliveryKey(messageId, chatId);
        const existing = this.deliveries.get(key);
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const claimToken = crypto.randomUUID();
        const pdfData = Buffer.isBuffer(pdf) ? pdf : undefined;
        if (existing) {
            if (!isReclaimableDelivery(existing, staleBefore)) return unclaimedResult(existing);
            Object.assign(existing, {
                routeId, chatId, subject, status: 'processing', claimToken,
                attempts: Number(existing.attempts || 0) + 1,
                updatedAt: now,
                ...(pdfData ? { pdfData } : {})
            });
            delete existing.error;
            delete existing.nextAttemptAt;
            return claimResult(existing, claimToken);
        }

        const legacy = this.deliveries.get(messageId);
        const matchingLegacy = legacy && legacy.chatId === chatId ? legacy : null;
        if (matchingLegacy && !isReclaimableDelivery(matchingLegacy, staleBefore)) return unclaimedResult(matchingLegacy);
        const delivery = {
            messageId, routeId, chatId, subject, status: 'processing',
            claimToken,
            deliveredPages: normalizeDeliveredPages(matchingLegacy && matchingLegacy.deliveredPages),
            attempts: Number(matchingLegacy?.attempts || 0) + 1,
            createdAt: now,
            updatedAt: now,
            ...(pdfData ? { pdfData } : {})
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
        delete delivery.nextAttemptAt;
        return true;
    }

    async failDelivery(messageId, chatId, error, { claimToken, maxAttempts, retryBaseMs } = {}) {
        const delivery = this.deliveries.get(deliveryKey(messageId, chatId));
        if (!delivery || delivery.status !== 'processing' || (claimToken && delivery.claimToken !== claimToken)) return false;
        const now = asDate(this.now());
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);
        const exhausted = Number(delivery.attempts || 0) >= limit;
        if (exhausted) {
            Object.assign(delivery, { status: 'dead_letter', error: String(error), updatedAt: now });
            delete delivery.pdfData;
            delete delivery.nextAttemptAt;
        } else {
            Object.assign(delivery, {
                status: 'failed',
                error: String(error),
                updatedAt: now,
                nextAttemptAt: new Date(now.getTime() + computeRetryBackoffMs(delivery.attempts, normalizeRetryBaseMs(retryBaseMs)))
            });
        }
        delete delivery.claimToken;
        return true;
    }

    // See MongoStudioStore.claimRetryableDelivery for the semantics this mirrors.
    async claimRetryableDelivery({ maxAttempts } = {}) {
        const now = asDate(this.now());
        const staleBefore = new Date(now.getTime() - this.deliveryLeaseMs);
        const limit = normalizeMaxDeliveryAttempts(maxAttempts);

        for (const delivery of this.deliveries.values()) {
            if (delivery.status === 'processing' && Number(delivery.attempts || 0) >= limit
                && delivery.updatedAt && delivery.updatedAt.getTime() <= staleBefore.getTime()) {
                delivery.status = 'dead_letter';
                delivery.updatedAt = now;
                delete delivery.pdfData;
                delete delivery.claimToken;
                delete delivery.nextAttemptAt;
            }
        }

        for (const delivery of this.deliveries.values()) {
            if (!delivery.pdfData) continue;
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
    MemoryStudioStore,
    MongoStudioStore,
    computeRetryBackoffMs,
    deliveryKey,
    normalizeMaxDeliveryAttempts,
    normalizeRetryBaseMs,
    normalizeRouteName
};
