const crypto = require('crypto');

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
    constructor({ store, routingEmail, pepper, randomBytes = crypto.randomBytes } = {}) {
        if (!store) throw new Error('A Studio route store is required.');
        this.store = store;
        this.mailbox = parseMailbox(routingEmail);
        this.pepper = pepper;
        hashRouteToken('configuration-check', pepper);
        this.randomBytes = randomBytes;
    }

    createToken() {
        // Lowercase hex survives email systems that normalize the local part.
        return this.randomBytes(18).toString('hex');
    }

    routingAddress(token) {
        return `${this.mailbox.local}+${token}@${this.mailbox.domain}`;
    }

    async createRoute({ chatId, name, createdBy }) {
        const token = this.createToken();
        const route = await this.store.createRoute({
            chatId,
            name,
            createdBy,
            tokenHash: hashRouteToken(token, this.pepper)
        });
        return { route, address: this.routingAddress(token) };
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

    async resolveRecipient(value) {
        for (const email of findEmailAddresses(Array.isArray(value) ? value.join(',') : value)) {
            const separator = email.lastIndexOf('@');
            const local = email.slice(0, separator);
            const domain = email.slice(separator + 1).toLowerCase();
            const prefix = `${this.mailbox.local}+`;
            if (domain !== this.mailbox.domain || !local.toLowerCase().startsWith(prefix)) continue;
            const token = local.slice(prefix.length);
            if (!/^[a-z0-9_-]{20,64}$/i.test(token)) continue;
            const route = await this.store.findRouteByTokenHash(hashRouteToken(token.toLowerCase(), this.pepper));
            if (route) return route;
        }
        return null;
    }
}

module.exports = { StudioRouteService, findEmailAddresses, hashRouteToken, parseMailbox };
