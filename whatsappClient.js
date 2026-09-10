const { EventEmitter } = require('events');
const pino = require('pino');
const { createMongoAuthState } = require('./baileysAuthStore');

const DEFAULT_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_SEEN_MESSAGE_LIMIT = 5000;
const DEFAULT_RECONNECT_BASE_MS = 3000;
const DEFAULT_RECONNECT_MAX_MS = 60000;

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
        seenMessageLimit = DEFAULT_SEEN_MESSAGE_LIMIT
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
        const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
        const jitter = 0.8 + (Math.max(0, Math.min(1, Number(this.random()) || 0)) * 0.4);
        const delay = Math.max(1, Math.round(exponential * jitter));
        this.reconnectAttempt += 1;
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

        const socket = makeWASocket({
            auth: this.authStore.state,
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
            getMessage: async () => undefined
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
                this.authStore.clear().catch(error => console.error('Could not clear logged-out session:', error.message || error));
                this.emit('auth_failure', 'WhatsApp logged out this linked device.');
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
                    senderId: message.key?.participant || message.key?.remoteJid
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

        const handlers = [
            ['creds.update', onCredsUpdate],
            ['connection.update', onConnectionUpdate],
            ['messages.upsert', onMessagesUpsert]
        ];
        handlers.forEach(([event, handler]) => socket.ev.on(event, handler));
        this.socketListeners = { emitter: socket.ev, handlers };
    }

    async isGroupAdmin(chatId, senderId) {
        if (!this.ready || !this.socket || !chatId.endsWith('@g.us') || !senderId) return false;
        const metadata = await this.socket.groupMetadata(chatId);
        const participant = (metadata.participants || []).find(item => item.id === senderId || item.phoneNumber === senderId);
        return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
    }

    async sendMessage(chatId, content, options = {}) {
        if (!this.ready || !this.socket) throw new Error('WhatsApp is not connected.');
        if (typeof content === 'string') {
            return this.socket.sendMessage(chatId, { text: content });
        }
        if (content && content.mimetype && content.data) {
            return this.socket.sendMessage(chatId, {
                image: Buffer.from(content.data, 'base64'),
                mimetype: content.mimetype,
                fileName: content.filename,
                caption: options.caption || ''
            });
        }
        return this.socket.sendMessage(chatId, content);
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
        if (this.authStore) await this.authStore.close();
    }
}

module.exports = {
    WhatsAppClient,
    messageIdentity,
    messageText,
    messageTimestampMs,
    shouldProcessMessageUpsert
};
