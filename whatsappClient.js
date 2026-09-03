const { EventEmitter } = require('events');
const pino = require('pino');
const { createMongoAuthState } = require('./baileysAuthStore');

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

class WhatsAppClient extends EventEmitter {
    constructor({ mongoUri, dbName = 'whatsapp_bot', sessionId = 'bot' } = {}) {
        super();
        this.mongoUri = mongoUri;
        this.dbName = dbName;
        this.sessionId = sessionId;
        this.ready = false;
        this.socket = null;
        this.authStore = null;
        this.baileys = null;
        this.reconnectTimer = null;
        this.generation = 0;
        this.authenticatedEmitted = false;
        this.destroyed = false;
        this.saveChain = Promise.resolve();
    }

    async initialize() {
        this.baileys = await import('@whiskeysockets/baileys');
        this.authStore = await createMongoAuthState({
            uri: this.mongoUri,
            dbName: this.dbName,
            sessionId: this.sessionId,
            baileys: this.baileys
        });
        this.authenticatedEmitted = Boolean(this.authStore.state.creds.registered);
        await this.connect();
    }

    async connect() {
        if (this.destroyed) return;
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
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            getMessage: async () => undefined
        });
        this.socket = socket;

        socket.ev.on('creds.update', () => {
            this.saveChain = this.saveChain.catch(() => {}).then(async () => {
                await this.authStore.saveCreds();
                if (this.authStore.state.creds.registered && !this.authenticatedEmitted) {
                    this.authenticatedEmitted = true;
                    this.emit('authenticated');
                }
                this.emit('remote_session_saved');
            }).catch(error => {
                console.error('Could not save WhatsApp session:', error.message || error);
            });
        });

        socket.ev.on('connection.update', update => {
            if (generation !== this.generation || this.destroyed) return;
            if (update.qr) this.emit('qr', update.qr);
            if (update.connection === 'connecting') this.emit('change_state', 'CONNECTING');
            if (update.connection === 'open') {
                this.ready = true;
                this.emit('change_state', 'CONNECTED');
                this.emit('ready');
                return;
            }
            if (update.connection !== 'close') return;

            this.ready = false;
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            this.emit('disconnected', statusCode || 'connection closed');
            if (loggedOut) {
                this.authenticatedEmitted = false;
                this.authStore.clear().catch(error => console.error('Could not clear logged-out session:', error.message || error));
                this.emit('auth_failure', 'WhatsApp logged out this linked device.');
                return;
            }
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.connect().catch(error => {
                console.error('WhatsApp reconnect failed:', error.message || error);
            }), 3000);
        });

        socket.ev.on('messages.upsert', event => {
            if (event.type !== 'notify') return;
            for (const message of event.messages || []) {
                const chatId = message.key?.remoteJid;
                const body = messageText(message.message);
                if (!chatId || !body) continue;
                this.emit('message_create', {
                    body,
                    fromMe: Boolean(message.key.fromMe),
                    from: chatId,
                    to: chatId
                });
            }
        });
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
        clearTimeout(this.reconnectTimer);
        this.generation += 1;
        if (this.socket) this.socket.end(undefined);
        await this.saveChain.catch(() => {});
        if (this.authStore) await this.authStore.close();
    }
}

module.exports = { WhatsAppClient, messageText };
