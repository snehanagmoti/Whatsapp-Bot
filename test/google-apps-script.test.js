const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'google-apps-script', 'Code.gs'), 'utf8');

function runBridge({ status = 200, recipient = 'reports+abc123@example.com' } = {}) {
    let markedRead = false;
    let request = null;
    const attachment = {
        getContentType: () => 'application/pdf',
        getName: () => 'report.pdf',
        getBytes: () => [37, 80, 68, 70, 45]
    };
    const message = {
        isUnread: () => true,
        getTo: () => recipient,
        getAttachments: () => [attachment],
        getId: () => 'message-123',
        getFrom: () => 'Looker Studio <approved@example.com>',
        getSubject: () => 'Daily report',
        markRead: () => { markedRead = true; }
    };
    const context = {
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({
            BOT_INGEST_URL: 'https://bot.example.com/',
            BOT_INGEST_TOKEN: 'secret-token',
            ROUTING_MAILBOX: 'reports@example.com'
        })[key] }) },
        GmailApp: { search: () => [{ getMessages: () => [message] }] },
        Utilities: { base64Encode: bytes => Buffer.from(bytes).toString('base64') },
        UrlFetchApp: { fetch: (url, options) => {
            request = { url, options };
            return { getResponseCode: () => status, getContentText: () => 'response' };
        } },
        console
    };
    vm.runInNewContext(source, context);
    context.forwardUnreadReports();
    return { markedRead, request };
}

test('Apps Script bridge forwards a matching PDF with bearer authentication', () => {
    const { markedRead, request } = runBridge();
    assert.equal(markedRead, true);
    assert.equal(request.url, 'https://bot.example.com/studio/email/ingest');
    assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
    const payload = JSON.parse(request.options.payload);
    assert.equal(payload.messageId, 'gmail:message-123');
    assert.equal(payload.to, 'reports+abc123@example.com');
    assert.equal(payload.attachments[0].data, 'JVBERi0=');
});

test('Apps Script bridge keeps failed deliveries unread and ignores unrelated recipients', () => {
    const failed = runBridge({ status: 502 });
    assert.equal(failed.markedRead, false);
    assert.ok(failed.request);
    const unrelated = runBridge({ recipient: 'someone@example.com' });
    assert.equal(unrelated.markedRead, false);
    assert.equal(unrelated.request, null);
});
