const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDeadLetterNotifier, formatDeadLetterAlert } = require('../deliveryAlerts');

const quiet = { warn() {} };

test('formats a readable alert with the route, chat, subject and error', () => {
    const text = formatDeadLetterAlert({ routeName: 'Sales', chatId: '111@g.us', subject: 'Weekly', error: 'boom' });
    assert.match(text, /^Report delivery gave up/);
    assert.match(text, /Report: Sales/);
    assert.match(text, /Chat: 111@g\.us/);
    assert.match(text, /Subject: Weekly/);
    assert.match(text, /Last error: boom/);
    assert.match(text, /Retry/);
});

test('sends alerts to the configured chat', async () => {
    const sends = [];
    const notify = createDeadLetterNotifier({ client: { sendMessage: async (...args) => sends.push(args) }, alertChatId: '999@g.us', log: quiet });
    assert.equal(await notify({ routeName: 'Sales', chatId: '111@g.us', error: 'x' }), true);
    assert.equal(sends[0][0], '999@g.us');
    assert.match(sends[0][1], /Sales/);
});

test('only logs when no alert chat is configured or WhatsApp is down', async () => {
    const sends = [];
    const warnings = [];
    const log = { warn: message => warnings.push(message) };
    const client = { sendMessage: async (...args) => sends.push(args) };
    assert.equal(await createDeadLetterNotifier({ client, alertChatId: null, log })({ chatId: '1@g.us', error: 'x' }), false);
    assert.equal(await createDeadLetterNotifier({ client, alertChatId: '9@g.us', isClientReady: () => false, log })({ chatId: '1@g.us' }), false);
    assert.equal(sends.length, 0);
    assert.ok(warnings.some(message => /gave up for 1@g\.us/.test(message)));
});

test('rate-limits bursts of alerts per window', async () => {
    const sends = [];
    const clock = { now: 0 };
    const notify = createDeadLetterNotifier({
        client: { sendMessage: async (...args) => sends.push(args) },
        alertChatId: '9@g.us', maxAlertsPerWindow: 2, windowMs: 1000, now: () => clock.now, log: quiet
    });
    for (let index = 0; index < 5; index += 1) await notify({ chatId: `${index}@g.us` });
    assert.equal(sends.length, 2);
    clock.now = 1000;
    await notify({ chatId: 'later@g.us' });
    assert.equal(sends.length, 3);
});
