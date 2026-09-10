const assert = require('node:assert/strict');
const { test } = require('node:test');
const { messageText, shouldProcessMessageUpsert } = require('../whatsappClient');

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
