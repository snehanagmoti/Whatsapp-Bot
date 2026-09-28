const assert = require('node:assert/strict');
const { test } = require('node:test');
// libsignal only exposes SessionEntry through this factory.
const SessionRecord = require('libsignal/src/session_record');
const { REDACTED, containsKeyMaterial, installLogRedaction } = require('../logRedaction');

function fakeConsole() {
    const lines = [];
    const target = {};
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        target[method] = (...args) => lines.push([method, ...args]);
    }
    return { target, lines };
}

function realSessionEntry() {
    const entry = SessionRecord.createEntry();
    entry.currentRatchet = {
        ephemeralKeyPair: { pubKey: Buffer.alloc(33, 1), privKey: Buffer.alloc(32, 2) },
        rootKey: Buffer.alloc(32, 3)
    };
    entry.indexInfo = { baseKey: Buffer.alloc(33, 4), remoteIdentityKey: Buffer.alloc(33, 5) };
    return entry;
}

test('drops routine libsignal session chatter that carries key material', () => {
    const { target, lines } = fakeConsole();
    installLogRedaction({ target, verboseSignal: false });
    target.info('Closing session:', realSessionEntry());
    target.info('Opening session:', realSessionEntry());
    target.info('Removing old closed session:', realSessionEntry());
    target.warn('Closing open session in favor of incoming prekey bundle');
    assert.deepEqual(lines, []);
});

test('redacts key material wherever it is logged, even in verbose Signal mode', () => {
    const { target, lines } = fakeConsole();
    installLogRedaction({ target, verboseSignal: true });
    target.info('Closing session:', realSessionEntry());
    target.error('Unexpected state', { nested: { creds: { noiseKey: { private: Buffer.alloc(32) } } } });
    assert.deepEqual(lines, [
        ['info', 'Closing session:', REDACTED],
        ['error', 'Unexpected state', REDACTED]
    ]);
    const printed = JSON.stringify(lines);
    assert.equal(printed.includes('"type":"Buffer"'), false);
});

test('leaves ordinary application logs untouched and installs only once', () => {
    const { target, lines } = fakeConsole();
    installLogRedaction({ target });
    installLogRedaction({ target });
    const error = new Error('boom');
    target.log('Looker Studio email delivery completed:', { messageId: 'gmail:1', deliveredPages: 2 });
    target.error('WhatsApp command failed:', error);
    target.warn('WhatsApp disconnected:', 428);
    assert.deepEqual(lines, [
        ['log', 'Looker Studio email delivery completed:', { messageId: 'gmail:1', deliveredPages: 2 }],
        ['error', 'WhatsApp command failed:', error],
        ['warn', 'WhatsApp disconnected:', 428]
    ]);
});

test('key-material detection handles buffers, cycles and deep nesting safely', () => {
    const cyclic = { name: 'route' };
    cyclic.self = cyclic;
    assert.equal(containsKeyMaterial(cyclic), false);
    assert.equal(containsKeyMaterial(Buffer.alloc(64)), false);
    assert.equal(containsKeyMaterial(new Map([['privKey', Buffer.alloc(1)]])), true);
    assert.equal(containsKeyMaterial(realSessionEntry()), true);
});

test('silences the real libsignal closeSession log call', () => {
    const { target, lines } = fakeConsole();
    installLogRedaction({ target, verboseSignal: false });
    const original = globalThis.console;
    globalThis.console = target;
    try {
        const record = new SessionRecord();
        const entry = realSessionEntry();
        entry.indexInfo.closed = -1;
        record.closeSession(entry);
    } finally {
        globalThis.console = original;
    }
    assert.deepEqual(lines, []);
});
