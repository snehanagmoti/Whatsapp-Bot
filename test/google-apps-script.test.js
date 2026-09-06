const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'google-apps-script', 'Code.gs'), 'utf8');

function runBridge({ status = 200, recipient = 'reports+abc123@example.com', processedIds = [] } = {}) {
    let request = null;
    let query = null;
    const values = {
        BOT_INGEST_URL: 'https://bot.example.com/',
        BOT_INGEST_TOKEN: 'secret-token',
        ROUTING_MAILBOX: 'reports@example.com',
        PROCESSED_MESSAGE_IDS: JSON.stringify(processedIds)
    };
    const attachment = {
        getContentType: () => 'application/pdf',
        getName: () => 'report.pdf',
        getBytes: () => [37, 80, 68, 70, 45]
    };
    const message = {
        getTo: () => recipient,
        getAttachments: () => [attachment],
        getId: () => 'message-123',
        getFrom: () => 'Looker Studio <approved@example.com>',
        getSubject: () => 'Daily report'
    };
    const context = {
        PropertiesService: { getScriptProperties: () => ({
            getProperty: key => values[key],
            setProperty: (key, value) => { values[key] = value; }
        }) },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
        GmailApp: { search: value => { query = value; return [{ getMessages: () => [message] }]; } },
        Utilities: { base64Encode: bytes => Buffer.from(bytes).toString('base64') },
        UrlFetchApp: { fetch: (url, options) => {
            request = { url, options };
            return { getResponseCode: () => status, getContentText: () => 'response' };
        } },
        console
    };
    vm.runInNewContext(source, context);
    context.forwardUnreadReports();
    return { request, query, processedIds: JSON.parse(values.PROCESSED_MESSAGE_IDS) };
}

test('Apps Script bridge forwards a matching PDF with bearer authentication', () => {
    const { request, query, processedIds } = runBridge();
    assert.doesNotMatch(query, /is:unread/);
    assert.equal(request.url, 'https://bot.example.com/studio/email/ingest');
    assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
    const payload = JSON.parse(request.options.payload);
    assert.equal(payload.messageId, 'gmail:message-123');
    assert.equal(payload.to, 'reports+abc123@example.com');
    assert.equal(payload.attachments[0].data, 'JVBERi0=');
    assert.deepEqual(processedIds, ['message-123']);
});

test('Apps Script bridge retries failures and ignores unrelated or already processed messages', () => {
    const failed = runBridge({ status: 502 });
    assert.ok(failed.request);
    assert.deepEqual(failed.processedIds, []);
    const unrelated = runBridge({ recipient: 'someone@example.com' });
    assert.equal(unrelated.request, null);
    const duplicate = runBridge({ processedIds: ['message-123'] });
    assert.equal(duplicate.request, null);
});
