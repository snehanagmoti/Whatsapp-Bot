const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isValidWhatsAppChatId } = require('../validation');
const { normalizeJid } = require('../whatsappClient');
const { TtlCache } = require('../ttlCache');

test('accepts phone-number, LID and group chat IDs, including legacy group IDs', () => {
    for (const id of ['919800000001@s.whatsapp.net', '919800000001@c.us', '123456789012345@lid',
        '120363000000000000@g.us', '919800000001-1600000000@g.us', ' 120363000000000000@g.us ']) {
        assert.equal(isValidWhatsAppChatId(id), true, id);
    }
    for (const id of ['', 'abc@g.us', '123@lid.evil', '123@broadcast', 'status@broadcast', '1-2-3@g.us',
        '123-456@lid', '123:4@s.whatsapp.net', null, 42]) {
        assert.equal(isValidWhatsAppChatId(id), false, String(id));
    }
});

test('normalizes JIDs for identity comparison', () => {
    assert.equal(normalizeJid('919800000001:12@s.whatsapp.net'), '919800000001@s.whatsapp.net');
    assert.equal(normalizeJid('919800000001@c.us'), '919800000001@s.whatsapp.net');
    assert.equal(normalizeJid(' 111@LID '), '111@lid');
    assert.equal(normalizeJid(''), '');
});

test('TTL cache expires entries and evicts the least recently used', () => {
    const clock = { now: 0 };
    const cache = new TtlCache({ max: 2, ttlMs: 100, now: () => clock.now });
    cache.set('a', 1).set('b', 2);
    assert.equal(cache.get('a'), 1);
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined, 'least recently used entry evicted');
    assert.equal(cache.get('a'), 1);
    clock.now = 101;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 1);
});
