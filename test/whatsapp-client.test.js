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

function createHarness({ now = 1_800_000_000_000, random = 0.5, claimMessage, authOverrides = {} } = {}) {
    const sockets = [];
    const timers = [];
    const clearedTimers = [];
    let authClosed = false;
    const authStore = {
        state: { creds: { registered: true } },
        saveCreds: async () => {},
        clear: async () => {},
        close: async () => { authClosed = true; },
        ...authOverrides
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
        DisconnectReason: { loggedOut: 401 },
        initAuthCreds: () => ({ registered: false, fresh: true })
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
    return { authClosed: () => authClosed, authStore, client, sockets, timers, clearedTimers };
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


const flush = () => new Promise(resolve => setImmediate(resolve));
const loggedOutUpdate = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } };

test('a logout clears the dead session, starts fresh credentials and reconnects for a new QR', async () => {
    const order = [];
    let releaseSave;
    const { authStore, client, sockets, timers } = createHarness({
        authOverrides: {
            saveCreds: () => new Promise(resolve => { releaseSave = () => { order.push('save'); resolve(); }; }),
            clear: async () => { order.push('clear'); }
        }
    });
    const events = [];
    ['auth_failure', 'session_reset', 'qr'].forEach(name => client.on(name, value => events.push([name, value])));
    await client.initialize();
    sockets[0].ev.emit('connection.update', { connection: 'open' });
    sockets[0].ev.emit('creds.update', {});
    sockets[0].ev.emit('connection.update', loggedOutUpdate);
    await flush();
    assert.deepEqual(order, [], 'the clear waits for the in-flight credential save');
    releaseSave();
    await client.logoutRecovery;

    assert.deepEqual(order, ['save', 'clear']);
    assert.deepEqual(authStore.state.creds, { registered: false, fresh: true });
    assert.deepEqual(events.map(([name]) => name), ['auth_failure', 'session_reset']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3000, 'backoff restarts from the base delay');

    await timers[0].callback();
    assert.equal(sockets.length, 2);
    sockets[1].ev.emit('connection.update', { qr: 'fresh-qr' });
    assert.deepEqual(events.at(-1), ['qr', 'fresh-qr']);
});

test('a failed session clear is retried with backoff instead of reconnecting on the dead session', async () => {
    let clearCalls = 0;
    const { authStore, client, sockets, timers } = createHarness({
        authOverrides: {
            clear: async () => {
                clearCalls += 1;
                if (clearCalls === 1) throw new Error('database unavailable');
            }
        }
    });
    await client.initialize();
    sockets[0].ev.emit('connection.update', loggedOutUpdate);
    await flush(); await flush();
    assert.equal(clearCalls, 1);
    assert.equal(sockets.length, 1, 'no reconnect with the logged-out credentials');
    assert.deepEqual(authStore.state.creds, { registered: true });
    assert.equal(timers.length, 1);

    timers[0].callback();
    await flush(); await flush();
    assert.equal(clearCalls, 2);
    assert.deepEqual(authStore.state.creds, { registered: false, fresh: true });
    assert.equal(timers.length, 2, 'reconnect scheduled after the successful reset');
});

test('destroying the client during logout recovery does not reconnect', async () => {
    let releaseClear;
    const { client, sockets, timers } = createHarness({
        authOverrides: { clear: () => new Promise(resolve => { releaseClear = resolve; }) }
    });
    await client.initialize();
    sockets[0].ev.emit('connection.update', loggedOutUpdate);
    await flush();
    const destroyed = client.destroy();
    releaseClear();
    await destroyed;
    assert.equal(timers.length, 0);
    assert.equal(sockets.length, 1);
});
