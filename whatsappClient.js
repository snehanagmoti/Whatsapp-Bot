const { EventEmitter } = require('events');
const pino = require('pino');
const { createMongoAuthState } = require('./baileysAuthStore');
const { TtlCache } = require('./ttlCache');

const DEFAULT_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_SEEN_MESSAGE_LIMIT = 5000;
const DEFAULT_RECONNECT_BASE_MS = 3000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_GROUP_METADATA_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GROUP_METADATA_LIMIT = 500;
const DEFAULT_SENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SENT_MESSAGE_LIMIT = 1000;

// Baileys v7 may identify a person by phone-number JID (…@s.whatsapp.net) or
// by LID (…@lid), optionally with a device suffix (…:12@…). Compare people by
// their device-less JID.
function normalizeJid(jid) {
    const value = String(jid || '').trim().toLowerCase();
    const at = value.lastIndexOf('@');
    if (at <= 0) return value;
    const user = value.slice(0, at).split(':')[0];
    const server = value.slice(at + 1) === 'c.us' ? 's.whatsapp.net' : value.slice(at + 1);
    return `${user}@${server}`;
}

function sameIdentity(candidates, participant) {
    const wanted = new Set(candidates.filter(Boolean).map(normalizeJid));
    return [participant.id, participant.phoneNumber, participant.lid, participant.jid]
        .filter(Boolean)
        .some(jid => wanted.has(normalizeJid(jid)));
}

function unwrapMessage(message) {
    let current = message;
    while (current && (current.ephemeralMessage || current.viewOnceMessage || current.viewOnceMessageV2)) {
        current = current.ephemeralMessage?.message
            || current.viewOnceMessage?.message
            || current.viewOnceMessageV2?.message;
    }
    return current || {};
}

function messageText(message) {
    const content = unwrapMessage(message);
    return content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || '';
}

function shouldProcessMessageUpsert(type) {
    // `notify` is a live message. `append` is used for messages queued while
    // this free-tier service was asleep, and for own events emitted by Baileys.
    // Other types can represent history replacement and must not run commands.
    return type === 'notify' || type === 'append';
}

function messageTimestampMs(value) {
    let normalized = value;
    if (normalized && typeof normalized === 'object') {
        if (typeof normalized.toNumber === 'function') normalized = normalized.toNumber();
        else if (typeof normalized.toString === 'function') normalized = normalized.toString();
    }
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    // WhatsApp/Baileys normally reports seconds, but accepting milliseconds
    // makes this guard resilient to future protocol representation changes.
    return Math.trunc(numeric < 1e12 ? numeric * 1000 : numeric);
}

function messageIdentity(message) {
    const id = String(message?.key?.id || '').trim();
    if (!id) return '';
    return `${message.key?.remoteJid || ''}:${message.key?.participant || ''}:${id}`;
}

function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

class WhatsAppClient extends EventEmitter {
    constructor({
        mongoUri,
        dbName = 'whatsapp_bot',
        sessionId = 'bot',
        baileysLoader = () => import('@whiskeysockets/baileys'),
        authStateFactory = createMongoAuthState,
        now = () => Date.now(),
        random = Math.random,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
        reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
        messageMaxAgeMs = finitePositive(process.env.WA_COMMAND_MAX_AGE_MS, DEFAULT_MESSAGE_MAX_AGE_MS),
        messageFutureToleranceMs = DEFAULT_MESSAGE_FUTURE_TOLERANCE_MS,
        seenMessageLimit = DEFAULT_SEEN_MESSAGE_LIMIT,
        groupMetadataTtlMs = DEFAULT_GROUP_METADATA_TTL_MS,
        sentMessageTtlMs = DEFAULT_SENT_MESSAGE_TTL_MS,
        sentMessageLimit = DEFAULT_SENT_MESSAGE_LIMIT
    } = {}) {
        super();
        this.mongoUri = mongoUri;
        this.dbName = dbName;
        this.sessionId = sessionId;
        this.baileysLoader = baileysLoader;
        this.authStateFactory = authStateFactory;
        this.now = now;
        this.random = random;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.reconnectBaseMs = finitePositive(reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS);
        this.reconnectMaxMs = Math.max(this.reconnectBaseMs, finitePositive(reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS));
        this.messageMaxAgeMs = finitePositive(messageMaxAgeMs, DEFAULT_MESSAGE_MAX_AGE_MS);
        this.messageFutureToleranceMs = finitePositive(messageFutureToleranceMs, DEFAULT_MESSAGE_FUTURE_TOLERANCE_MS);
        this.seenMessageLimit = Math.max(1, Math.trunc(finitePositive(seenMessageLimit, DEFAULT_SEEN_MESSAGE_LIMIT)));
        this.ready = false;
        this.socket = null;
        this.socketListeners = null;
        this.authStore = null;
        this.baileys = null;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.seenMessageIds = new Map();
        this.generation = 0;
        this.authenticatedEmitted = false;
        this.destroyed = false;
        this.saveChain = Promise.resolve();
        this.messageChain = Promise.resolve();
        this.logoutRecovery = null;
        // Group participant lists are needed to encrypt every group send.
        // Serving them from a short-lived cache (invalidated on group change
        // events) avoids a metadata query per report page.
        this.groupMetadata = new TtlCache({
            max: DEFAULT_GROUP_METADATA_LIMIT, ttlMs: finitePositive(groupMetadataTtlMs, DEFAULT_GROUP_METADATA_TTL_MS), now
        });
        // Baileys keeps its own resend cache for five minutes per socket. This
        // cache survives reconnects so a recipient that asks for a re-send
        // later (it could not decrypt a page) can still be answered.
        this.sentMessages = new TtlCache({
            max: finitePositive(sentMessageLimit, DEFAULT_SENT_MESSAGE_LIMIT),
            ttlMs: finitePositive(sentMessageTtlMs, DEFAULT_SENT_MESSAGE_TTL_MS),
            now
        });
    }

    async initialize() {
        this.baileys = await this.baileysLoader();
        this.authStore = await this.authStateFactory({
            uri: this.mongoUri,
            dbName: this.dbName,
            sessionId: this.sessionId,
            baileys: this.baileys
        });
        this.authenticatedEmitted = Boolean(this.authStore.state.creds.registered);
        await this.connect();
    }

    detachSocketListeners() {
        const registration = this.socketListeners;
        if (!registration) return;
        for (const [event, handler] of registration.handlers) {
            if (typeof registration.emitter.off === 'function') registration.emitter.off(event, handler);
            else if (typeof registration.emitter.removeListener === 'function') registration.emitter.removeListener(event, handler);
        }
        this.socketListeners = null;
    }

    clearReconnectTimer() {
        if (this.reconnectTimer !== null) this.clearTimeoutFn(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    scheduleReconnect() {
        if (this.destroyed || this.reconnectTimer !== null) return;
        const delay = this.nextBackoffDelay();
        this.reconnectTimer = this.setTimeoutFn(async () => {
            this.reconnectTimer = null;
            if (this.destroyed) return;
            try {
                await this.connect();
            } catch (error) {
                console.error('WhatsApp reconnect failed:', error.message || error);
                this.scheduleReconnect();
            }
        }, delay);
    }

    nextBackoffDelay() {
        const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
        const jitter = 0.8 + (Math.max(0, Math.min(1, Number(this.random()) || 0)) * 0.4);
        this.reconnectAttempt += 1;
        return Math.max(1, Math.round(exponential * jitter));
    }

    async resetAuthState() {
        if (typeof this.authStore.reset === 'function') {
            await this.authStore.reset();
            return;
        }
        await this.authStore.clear();
        if (typeof this.baileys.initAuthCreds !== 'function') {
            throw new Error('Baileys does not expose initAuthCreds; cannot create a fresh session.');
        }
        this.authStore.state.creds = this.baileys.initAuthCreds();
    }

    // After WhatsApp logs this linked device out, the stored session is dead.
    // Clear it, start from fresh credentials and reconnect so a new QR code is
    // offered without restarting the process. The old in-memory credentials
    // must not be reused: they would only be logged out again. If clearing
    // fails (for example MongoDB is briefly unreachable) the recovery is
    // retried with backoff instead of reconnecting on the dead session.
    recoverFromLogout() {
        if (this.logoutRecovery || this.destroyed) return this.logoutRecovery;
        this.clearReconnectTimer();
        this.logoutRecovery = (async () => {
            // A credential save queued by the old socket must not rewrite the
            // session after it has been cleared.
            await this.saveChain.catch(() => {});
            if (this.destroyed) return;
            await this.resetAuthState();
            if (this.destroyed) return;
            this.reconnectAttempt = 0;
            this.emit('session_reset');
            this.scheduleReconnect();
        })().catch(error => {
            console.error('Could not reset the logged-out WhatsApp session:', error.message || error);
            if (this.destroyed || this.reconnectTimer !== null) return;
            this.reconnectTimer = this.setTimeoutFn(() => {
                this.reconnectTimer = null;
                this.recoverFromLogout();
            }, this.nextBackoffDelay());
        }).finally(() => {
            this.logoutRecovery = null;
        });
        return this.logoutRecovery;
    }

    rememberMessage(message, nowMs) {
        const identity = messageIdentity(message);
        const timestamp = messageTimestampMs(message?.messageTimestamp);
        // Baileys supplies both values for real messages. Requiring them keeps
        // history replays and malformed synthetic events from executing
        // route-management commands.
        if (!identity || timestamp === null) return null;
        if (timestamp < nowMs - this.messageMaxAgeMs) return null;
        if (timestamp > nowMs + this.messageFutureToleranceMs) return null;
        if (this.seenMessageIds.has(identity)) return null;

        this.seenMessageIds.set(identity, timestamp);
        while (this.seenMessageIds.size > this.seenMessageLimit) {
            this.seenMessageIds.delete(this.seenMessageIds.keys().next().value);
        }
        return { id: String(message.key.id), timestamp };
    }

    async connect() {
        if (this.destroyed) return;
        this.clearReconnectTimer();
        this.detachSocketListeners();
        const generation = ++this.generation;
        const makeWASocket = this.baileys.default;
        const { DisconnectReason } = this.baileys;
        const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

        const keys = typeof this.baileys.makeCacheableSignalKeyStore === 'function'
            ? this.baileys.makeCacheableSignalKeyStore(this.authStore.state.keys, logger)
            : this.authStore.state.keys;
        const socket = makeWASocket({
            // creds is the same object the auth store saves; only the key
            // store gets Baileys' in-memory read/write-through cache.
            auth: { creds: this.authStore.state.creds, keys },
            logger,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            // Route-management commands are also allowed from the dedicated
            // bot account. Baileys must therefore emit messages sent by the
            // linked account, otherwise commands typed by the bot operator
            // (for example `!setupreport`) never reach `message_create`.
            emitOwnEvents: true,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            getMessage: async key => this.sentMessages.get(String(key?.id || '')),
            cachedGroupMetadata: async jid => this.groupMetadata.get(jid)
        });
        this.socket = socket;

        const onCredsUpdate = () => {
            if (generation !== this.generation || this.destroyed) return;
            this.saveChain = this.saveChain.catch(() => {}).then(async () => {
                await this.authStore.saveCreds();
                if (generation !== this.generation || this.destroyed) return;
                if (this.authStore.state.creds.registered && !this.authenticatedEmitted) {
                    this.authenticatedEmitted = true;
                    this.emit('authenticated');
                }
                this.emit('remote_session_saved');
            }).catch(error => {
                console.error('Could not save WhatsApp session:', error.message || error);
            });
        };

        const onConnectionUpdate = update => {
            if (generation !== this.generation || this.destroyed) return;
            if (update.qr) this.emit('qr', update.qr);
            if (update.connection === 'connecting') this.emit('change_state', 'CONNECTING');
            if (update.connection === 'open') {
                this.ready = true;
                this.reconnectAttempt = 0;
                this.clearReconnectTimer();
                this.emit('change_state', 'CONNECTED');
                this.emit('ready');
                return;
            }
            if (update.connection !== 'close') return;

            this.ready = false;
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            this.emit('disconnected', statusCode || 'connection closed');
            this.detachSocketListeners();
            if (loggedOut) {
                this.authenticatedEmitted = false;
                this.emit('auth_failure', 'WhatsApp logged out this linked device.');
                this.recoverFromLogout();
                return;
            }
            this.scheduleReconnect();
        };

        const onMessagesUpsert = event => {
            if (generation !== this.generation || this.destroyed || !shouldProcessMessageUpsert(event.type)) return;
            const nowMs = this.now();
            for (const message of event.messages || []) {
                const chatId = message.key?.remoteJid;
                const body = messageText(message.message);
                if (!chatId || !body) continue;
                const accepted = this.rememberMessage(message, nowMs);
                if (!accepted) continue;
                const identity = messageIdentity(message);
                const payload = {
                    id: accepted.id,
                    timestamp: accepted.timestamp,
                    body,
                    fromMe: Boolean(message.key.fromMe),
                    from: chatId,
                    to: chatId,
                    senderId: message.key?.participant || message.key?.remoteJid,
                    // The same person under their other identity (LID vs phone
                    // number), when WhatsApp supplies it.
                    senderAltId: message.key?.participantAlt || message.key?.remoteJidAlt || null
                };

                // MongoDB keeps the replay guard across process restarts. The
                // in-memory check above still suppresses duplicates arriving
                // together and preserves synchronous behavior for test/local
                // auth stores that do not implement a persistent claim.
                if (typeof this.authStore.claimMessage !== 'function') {
                    this.emit('message_create', payload);
                    continue;
                }
                this.messageChain = this.messageChain.catch(() => {}).then(async () => {
                    const claimed = await this.authStore.claimMessage(identity, accepted.timestamp);
                    if (claimed && !this.destroyed) this.emit('message_create', payload);
                }).catch(error => {
                    // A temporary database failure must not permanently poison
                    // this process's in-memory replay cache. A later Baileys
                    // delivery can safely retry the durable claim.
                    this.seenMessageIds.delete(identity);
                    console.error('Could not claim WhatsApp command message:', error.message || error);
                });
            }
        };

        const forgetGroups = updates => {
            if (generation !== this.generation) return;
            for (const update of [].concat(updates || [])) {
                if (update && update.id) this.groupMetadata.delete(update.id);
            }
        };

        const handlers = [
            ['creds.update', onCredsUpdate],
            ['connection.update', onConnectionUpdate],
            ['messages.upsert', onMessagesUpsert],
            ['groups.update', forgetGroups],
            ['groups.upsert', forgetGroups],
            ['group-participants.update', forgetGroups]
        ];
        handlers.forEach(([event, handler]) => socket.ev.on(event, handler));
        this.socketListeners = { emitter: socket.ev, handlers };
    }

    async groupMetadataFor(chatId) {
        const cached = this.groupMetadata.get(chatId);
        if (cached) return cached;
        const metadata = await this.socket.groupMetadata(chatId);
        if (metadata) this.groupMetadata.set(chatId, metadata);
        return metadata;
    }

    // `senderIds` may list one person under several identities (LID and
    // phone-number JID); any match counts.
    async isGroupAdmin(chatId, senderIds) {
        const candidates = [].concat(senderIds || []).filter(Boolean);
        if (!this.ready || !this.socket || !chatId.endsWith('@g.us') || !candidates.length) return false;
        const metadata = await this.groupMetadataFor(chatId);
        const participant = ((metadata && metadata.participants) || []).find(item => sameIdentity(candidates, item));
        return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
    }

    rememberSent(result) {
        const id = result && result.key && result.key.id;
        if (id && result.message) this.sentMessages.set(String(id), result.message);
        return result;
    }

    async sendMessage(chatId, content, options = {}) {
        if (!this.ready || !this.socket) throw new Error('WhatsApp is not connected.');
        if (chatId.endsWith('@g.us') && !this.groupMetadata.get(chatId)) {
            // Warm the cache Baileys reads through cachedGroupMetadata. On
            // failure Baileys simply fetches the metadata itself.
            await this.groupMetadataFor(chatId).catch(() => {});
        }
        if (typeof content === 'string') {
            return this.rememberSent(await this.socket.sendMessage(chatId, { text: content }));
        }
        if (content && content.mimetype && (content.buffer || content.data)) {
            return this.rememberSent(await this.socket.sendMessage(chatId, {
                image: Buffer.isBuffer(content.buffer) ? content.buffer : Buffer.from(content.data, 'base64'),
                mimetype: content.mimetype,
                fileName: content.filename,
                caption: options.caption || ''
            }));
        }
        return this.rememberSent(await this.socket.sendMessage(chatId, content));
    }

    async destroy() {
        this.destroyed = true;
        this.ready = false;
        this.clearReconnectTimer();
        this.generation += 1;
        this.detachSocketListeners();
        if (this.socket) this.socket.end(undefined);
        await this.saveChain.catch(() => {});
        await this.messageChain.catch(() => {});
        if (this.logoutRecovery) await this.logoutRecovery;
        if (this.authStore) await this.authStore.close();
    }
}

module.exports = {
    WhatsAppClient,
    normalizeJid,
    messageIdentity,
    messageText,
    messageTimestampMs,
    shouldProcessMessageUpsert
};
