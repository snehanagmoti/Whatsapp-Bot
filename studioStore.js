const { MongoClient } = require('mongodb');

function normalizeRouteName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

class MongoStudioStore {
    constructor({ uri, dbName = 'whatsapp_bot' } = {}) {
        if (!uri) throw new Error('MONGODB_URI is required for Studio routing storage.');
        this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
        this.dbName = dbName;
    }

    async connect() {
        await this.client.connect();
        const db = this.client.db(this.dbName);
        this.routes = db.collection('studio_routes');
        this.deliveries = db.collection('studio_deliveries');
        await Promise.all([
            this.routes.createIndex({ tokenHash: 1 }, { unique: true }),
            this.routes.createIndex({ chatId: 1, nameKey: 1 }, { unique: true }),
            this.deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 })
        ]);
        return this;
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

    async beginDelivery({ messageId, routeId, chatId, subject }) {
        try {
            await this.deliveries.insertOne({
                _id: messageId,
                routeId,
                chatId,
                subject,
                status: 'processing',
                attempts: 1,
                createdAt: new Date(),
                updatedAt: new Date()
            });
            return true;
        } catch (error) {
            if (error && error.code === 11000) {
                const retry = await this.deliveries.updateOne(
                    { _id: messageId, status: 'failed' },
                    { $set: { status: 'processing', updatedAt: new Date() }, $inc: { attempts: 1 } }
                );
                return retry.modifiedCount === 1;
            }
            throw error;
        }
    }

    async completeDelivery(messageId, details = {}) {
        await this.deliveries.updateOne(
            { _id: messageId },
            { $set: { status: 'delivered', ...details, updatedAt: new Date() } }
        );
    }

    async failDelivery(messageId, error) {
        await this.deliveries.updateOne(
            { _id: messageId },
            { $set: { status: 'failed', error: String(error).slice(0, 500), updatedAt: new Date() } }
        );
    }

    close() {
        return this.client.close();
    }
}

class MemoryStudioStore {
    constructor() {
        this.routes = [];
        this.deliveries = new Map();
        this.nextId = 1;
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

    async beginDelivery({ messageId, routeId, chatId, subject }) {
        const existing = this.deliveries.get(messageId);
        if (existing && existing.status !== 'failed') return false;
        this.deliveries.set(messageId, {
            messageId, routeId, chatId, subject, status: 'processing', attempts: (existing?.attempts || 0) + 1
        });
        return true;
    }

    async completeDelivery(messageId, details = {}) {
        Object.assign(this.deliveries.get(messageId), { status: 'delivered', ...details });
    }

    async failDelivery(messageId, error) {
        Object.assign(this.deliveries.get(messageId), { status: 'failed', error: String(error) });
    }

    async close() {}
}

module.exports = { MemoryStudioStore, MongoStudioStore, normalizeRouteName };
