const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const {
    WhatsAppClient,
    messageIdentity,
    messageText,
    messageTimestampMs,
    shouldProcessMessageUpsert
} = require('../whatsappClient');

function createHarness({ now = 1_800_000_000_000, random = 0.5, claimMessage } = {}) {
    const sockets = [];
    const timers = [];
    const clearedTimers = [];
    let authClosed = false;
    const authStore = {
        state: { creds: { registered: true } },
        saveCreds: async () => {},
        clear: async () => {},
        close: async () => { authClosed = true; }
    };
    if (claimMessage) authStore.claimMessage = claimMessage;
    const baileys = {
        default: () => {
            const socket = {
                ev: new EventEmitter(),
                ended: false,
                end: () => { socket.ended = true; },
                sendMessage: async () => ({}),
                groupMetadata: async () => ({ participants: [] })
            };
            sockets.push(socket);
            return socket;
        },
        DisconnectReason: { loggedOut: 401 }
    };
    const client = new WhatsAppClient({
        mongoUri: 'mongodb://unused',
        baileysLoader: async () => baileys,
        authStateFactory: async () => authStore,
        now: () => now,
        random: () => random,
        setTimeoutFn: (callback, delay) => {
            const timer = { callback, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn: timer => clearedTimers.push(timer),
        reconnectBaseMs: 3000,
        reconnectMaxMs: 12000,
        messageMaxAgeMs: 60_000,
        messageFutureToleranceMs: 5000,
        seenMessageLimit: 2
    });
    return { authClosed: () => authClosed, client, sockets, timers, clearedTimers };
}

function commandMessage({ id = 'message-1', timestamp = 1_800_000_000, chatId = '123@g.us' } = {}) {
    return {
        key: { id, remoteJid: chatId, participant: 'admin@s.whatsapp.net', fromMe: false },
        messageTimestamp: timestamp,
        message: { conversation: '!rotatereport Sales' }
    };
}

test('extracts commands from plain and wrapped WhatsApp messages', () => {
    assert.equal(messageText({ conversation: '!chatid' }), '!chatid');
    assert.equal(messageText({
        ephemeralMessage: {
            message: { extendedTextMessage: { text: '!report Sales' } }
        }
    }), '!report Sales');
});

test('returns an empty string for non-text messages', () => {
    assert.equal(messageText({ protocolMessage: {} }), '');
});

test('accepts live and queued command events but rejects history replacement', () => {
    assert.equal(shouldProcessMessageUpsert('notify'), true);
    assert.equal(shouldProcessMessageUpsert('append'), true);
    assert.equal(shouldProcessMessageUpsert('replace'), false);
});

test('normalizes Baileys timestamps and builds a chat-scoped message identity', () => {
    assert.equal(messageTimestampMs(1_800_000_000), 1_800_000_000_000);
    assert.equal(messageTimestampMs(1_800_000_000_123), 1_800_000_000_123);
    assert.equal(messageTimestampMs({ toNumber: () => 1_800_000_001 }), 1_800_000_001_000);
    assert.equal(messageTimestampMs('invalid'), null);
    assert.equal(messageIdentity(commandMessage()), '123@g.us:admin@s.whatsapp.net:message-1');
});

test('suppresses duplicate, stale, future and malformed command messages', async () => {
    const { client, sockets } = createHarness();
    const received = [];
    client.on('message_create', message => received.push(message));
    await client.initialize();

    const fresh = commandMessage();
    sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [fresh, fresh] });
    sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [fresh] });
    sockets[0].ev.emit('messages.upsert', {
        type: 'append',
        messages: [
            commandMessage({ id: 'too-old', timestamp: 1_799_999_939 }),
            commandMessage({ id: 'future', timestamp: 1_800_000_006 }),
            commandMessage({ id: '', timestamp: 1_800_000_000 }),
            { ...commandMessage({ id: 'no-time' }), messageTimestamp: undefined }
        ]
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'message-1');
    assert.equal(received[0].timestamp, 1_800_000_000_000);
    assert.equal(received[0].body, '!rotatereport Sales');
    await client.destroy();
});

test('uses the persistent auth-store claim before emitting a command', async () => {
    const claimed = new Set();
    const claimMessage = async identity => {
        if (claimed.has(identity)) return false;
        claimed.add(identity);
        return true;
    };
    const first = createHarness({ claimMessage });
    const second = createHarness({ claimMessage });
    const received = [];
    first.client.on('message_create', message => received.push(message));
    second.client.on('message_create', message => received.push(message));
    await first.client.initialize();
    await second.client.initialize();

    first.sockets[0].ev.emit('messages.upsert', {
        type: 'notify',
        messages: [commandMessage({ id: 'durable-message' })]
    });
    second.sockets[0].ev.emit('messages.upsert', {
        type: 'append',
        messages: [commandMessage({ id: 'durable-message' })]
    });
    await Promise.all([first.client.messageChain, second.client.messageChain]);

    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'durable-message');
    await first.client.destroy();
    await second.client.destroy();
});

test('retires stale socket listeners and reconnects with capped exponential backoff', async () => {
    const { authClosed, client, sockets, timers } = createHarness();
    const received = [];
    client.on('message_create', message => received.push(message));
    await client.initialize();
    const staleMessageHandler = sockets[0].ev.listeners('messages.upsert')[0];

    sockets[0].ev.emit('connection.update', { connection: 'close' });
    assert.equal(timers[0].delay, 3000);
    assert.equal(sockets[0].ev.listenerCount('messages.upsert'), 0);
    await timers[0].callback();
    assert.equal(sockets.length, 2);

    staleMessageHandler({ type: 'notify', messages: [commandMessage({ id: 'stale-socket' })] });
    assert.equal(received.length, 0);

    sockets[1].ev.emit('connection.update', { connection: 'close' });
    assert.equal(timers[1].delay, 6000);
    await timers[1].callback();
    sockets[2].ev.emit('connection.update', { connection: 'close' });
    assert.equal(timers[2].delay, 12000);
    await timers[2].callback();

    sockets[3].ev.emit('connection.update', { connection: 'open' });
    sockets[3].ev.emit('connection.update', { connection: 'close' });
    assert.equal(timers[3].delay, 3000);

    await client.destroy();
    assert.equal(sockets[3].ended, true);
    assert.equal(authClosed(), true);
});
