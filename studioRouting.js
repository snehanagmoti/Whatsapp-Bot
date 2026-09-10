const crypto = require('crypto');

const DEFAULT_MAX_ROUTES_PER_CHAT = 20;

function normalizeMaxRoutesPerChat(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_MAX_ROUTES_PER_CHAT;
    const maximum = Number(value);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
        throw new Error('STUDIO_MAX_ROUTES_PER_CHAT must be an integer between 1 and 1000.');
    }
    return maximum;
}

function parseMailbox(value) {
    const match = /^([^@+\s]+)@([^@\s]+)$/.exec(String(value || '').trim());
    if (!match) throw new Error('STUDIO_ROUTING_EMAIL must be a plain email address.');
    return { local: match[1].toLowerCase(), domain: match[2].toLowerCase() };
}

function hashRouteToken(token, pepper) {
    if (!pepper || pepper.length < 24) throw new Error('STUDIO_ROUTE_PEPPER must contain at least 24 characters.');
    return crypto.createHmac('sha256', pepper).update(token).digest('hex');
}

function findEmailAddresses(value) {
    return String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) || [];
}

class StudioRouteService {
    constructor({
        store,
        routingEmail,
        pepper,
        randomBytes = crypto.randomBytes,
        maxRoutesPerChat = process.env.STUDIO_MAX_ROUTES_PER_CHAT
    } = {}) {
        if (!store) throw new Error('A Studio route store is required.');
        this.store = store;
        this.mailbox = parseMailbox(routingEmail);
        this.pepper = pepper;
        hashRouteToken('configuration-check', pepper);
        this.randomBytes = randomBytes;
        this.maxRoutesPerChat = normalizeMaxRoutesPerChat(maxRoutesPerChat);
        this.createLocks = new Map();
    }

    createToken() {
        // Lowercase hex survives email systems that normalize the local part.
        return this.randomBytes(18).toString('hex');
    }

    routingAddress(token) {
        return `${this.mailbox.local}+${token}@${this.mailbox.domain}`;
    }

    async createRoute({ chatId, name, createdBy }) {
        const lockKey = String(chatId);
        const previous = this.createLocks.get(lockKey) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        this.createLocks.set(lockKey, tail);
        await previous;
        try {
            const routes = await this.store.listRoutes(chatId);
            if (routes.length >= this.maxRoutesPerChat) {
                const error = new Error(`This chat already has the maximum of ${this.maxRoutesPerChat} report routes.`);
                error.code = 'ROUTE_QUOTA_EXCEEDED';
                error.statusCode = 409;
                throw error;
            }
            const token = this.createToken();
            const route = await this.store.createRoute({
                chatId,
                name,
                createdBy,
                tokenHash: hashRouteToken(token, this.pepper)
            });
            return { route, address: this.routingAddress(token) };
        } finally {
            release();
            if (this.createLocks.get(lockKey) === tail) this.createLocks.delete(lockKey);
        }
    }

    async rotateRoute(chatId, name) {
        const token = this.createToken();
        const route = await this.store.rotateRoute(chatId, name, hashRouteToken(token, this.pepper));
        return route ? { route, address: this.routingAddress(token) } : null;
    }

    listRoutes(chatId) {
        return this.store.listRoutes(chatId);
    }

    setRouteStatus(chatId, name, status) {
        return this.store.setRouteStatus(chatId, name, status);
    }

    removeRoute(chatId, name) {
        return this.store.removeRoute(chatId, name);
    }

    async resolveRecipients(value) {
        const routes = [];
        const seenRouteIds = new Set();
        for (const email of findEmailAddresses(Array.isArray(value) ? value.join(',') : value)) {
            const separator = email.lastIndexOf('@');
            const local = email.slice(0, separator);
            const domain = email.slice(separator + 1).toLowerCase();
            const prefix = `${this.mailbox.local}+`;
            if (domain !== this.mailbox.domain || !local.toLowerCase().startsWith(prefix)) continue;
            const token = local.slice(prefix.length);
            if (!/^[a-z0-9_-]{20,64}$/i.test(token)) continue;
            const route = await this.store.findRouteByTokenHash(hashRouteToken(token.toLowerCase(), this.pepper));
            if (!route) continue;
            const routeId = String(route._id);
            if (seenRouteIds.has(routeId)) continue;
            seenRouteIds.add(routeId);
            routes.push(route);
        }
        return routes;
    }

    async resolveRecipient(value) {
        const routes = await this.resolveRecipients(value);
        return routes[0] || null;
    }
}

module.exports = {
    DEFAULT_MAX_ROUTES_PER_CHAT,
    StudioRouteService,
    findEmailAddresses,
    hashRouteToken,
    normalizeMaxRoutesPerChat,
    parseMailbox
};
