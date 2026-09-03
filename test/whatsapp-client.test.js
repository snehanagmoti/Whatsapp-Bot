const assert = require('node:assert/strict');
const { test } = require('node:test');
const { messageText } = require('../whatsappClient');

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
