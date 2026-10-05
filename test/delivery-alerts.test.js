const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDeadLetterNotifier, formatDeadLetterAlert } = require('../deliveryAlerts');

const quiet = { warn() {} };

test('formats a readable note with the report, email subject and reason', () => {
    const text = formatDeadLetterAlert({ routeName: 'Sales', chatId: '111@g.us', subject: 'Weekly', error: 'boom' });
    assert.match(text, /\*Sales\* could not be delivered to this chat/);
    assert.match(text, /Email: Weekly/);
    assert.match(text, /Reason: boom/);
    assert.match(text, /Retry/);
});

test('tells the chat whose report gave up', async () => {
    const sends = [];
    const notify = createDeadLetterNotifier({ client: { sendMessage: async (...args) => sends.push(args) }, log: quiet });
    assert.equal(await notify({ routeName: 'Sales', chatId: '111@g.us', error: 'x' }), true);
    assert.equal(sends[0][0], '111@g.us');
    assert.match(sends[0][1], /Sales/);
});

test('only logs when the chat is unknown or WhatsApp is down', async () => {
    const sends = [];
    const warnings = [];
    const log = { warn: message => warnings.push(message) };
    const client = { sendMessage: async (...args) => sends.push(args) };
    assert.equal(await createDeadLetterNotifier({ client, log })({ error: 'x' }), false);
    assert.equal(await createDeadLetterNotifier({ client, isClientReady: () => false, log })({ chatId: '1@g.us' }), false);
    assert.equal(sends.length, 0);
    assert.ok(warnings.some(message => /gave up for 1@g\.us/.test(message)));
});

test('rate-limits bursts of notes per window', async () => {
    const sends = [];
    const clock = { now: 0 };
    const notify = createDeadLetterNotifier({
        client: { sendMessage: async (...args) => sends.push(args) },
        maxAlertsPerWindow: 2, windowMs: 1000, now: () => clock.now, log: quiet
    });
    for (let index = 0; index < 5; index += 1) await notify({ chatId: `${index}@g.us` });
    assert.equal(sends.length, 2);
    clock.now = 1000;
    await notify({ chatId: 'later@g.us' });
    assert.equal(sends.length, 3);
});
