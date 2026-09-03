const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../server');

process.env.NODE_ENV = 'test';
const servers = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function serve(options) {
    const server = createApp(options).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('Action Hub list uses the Looker Action API contract and requires its token', async () => {
    const base = await serve({ client: {}, lookerToken: 'secret', publicBaseUrl: 'https://bot.example.com' });
    const denied = await fetch(`${base}/actions`, { method: 'POST' });
    assert.equal(denied.status, 401);

    const response = await fetch(`${base}/actions`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"' }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.label, 'WhatsApp Screenshot Bot');
    assert.equal(body.integrations[0].supported_formats[0], 'wysiwyg_png');
    assert.equal(body.integrations[0].supported_download_settings[0], 'push');
    assert.equal(body.integrations[0].url, 'https://bot.example.com/looker/execute');
});

test('execute returns retryable failure while WhatsApp is disconnected', async () => {
    const base = await serve({ client: {}, isClientReady: () => false, lookerToken: 'secret' });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(response.status, 503);
});

test('execute delivers a valid PNG only to an approved chat', async () => {
    const deliveries = [];
    const client = { sendMessage: async (...args) => deliveries.push(args) };
    const chatId = '120363000000000000@g.us';
    const base = await serve({
        client,
        isClientReady: () => true,
        lookerToken: 'secret',
        allowedChatIds: new Set([chatId])
    });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scheduled_plan: { title: 'Sales' },
            attachment: { mimetype: 'image/png;base64', data: png },
            form_params: { chatId }
        })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).looker.success, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0][0], chatId);
    assert.equal(deliveries[0][2].caption, 'Looker dashboard: Sales');
});

test('execute rejects an unapproved destination', async () => {
    const base = await serve({
        client: { sendMessage: async () => assert.fail('must not send') },
        isClientReady: () => true,
        lookerToken: 'secret',
        allowedChatIds: new Set(['120363000000000000@g.us'])
    });
    const response = await fetch(`${base}/looker/execute`, {
        method: 'POST',
        headers: { Authorization: 'Token token="secret"', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            attachment: { mimetype: 'image/png', data: png },
            form_params: { chatId: '120363999999999999@g.us' }
        })
    });
    assert.equal(response.status, 403);
});
