const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'google-apps-script', 'Code.gs'), 'utf8');
const routingAddress = 'reports+abcdef0123456789abcdef01@example.com';

function runBridge({
    status = 200,
    recipient = routingAddress,
    cc = '',
    processedIds = [],
    includeCutover = true,
    messageDate = new Date('2026-09-10T01:00:00.000Z'),
    threadCount = 1,
    fetchError = null,
    maxThreads = 500,
    maxRuntimeSeconds = null,
    clock = null,
    onFetch = null,
    attachmentError = null
} = {}) {
    const requests = [];
    const logs = [];
    const searchCalls = [];
    const labelsApplied = [];
    const values = {
        BOT_INGEST_URL: 'https://bot.example.com/',
        BOT_INGEST_TOKEN: 'secret-token',
        ROUTING_MAILBOX: 'reports@example.com',
        FORWARD_MAX_THREADS_PER_RUN: String(maxThreads),
        ...(maxRuntimeSeconds ? { FORWARD_MAX_RUNTIME_SECONDS: String(maxRuntimeSeconds) } : {}),
        PROCESSED_MESSAGE_IDS: JSON.stringify(processedIds)
    };
    if (includeCutover) values.FORWARD_NOT_BEFORE = '2026-09-10T00:00:00.000Z';

    const attachment = {
        getContentType: () => 'application/pdf',
        getName: () => 'report.pdf',
        getBytes: () => [37, 80, 68, 70, 45]
    };
    const threads = Array.from({ length: threadCount }, (_, index) => {
        const message = {
            getTo: () => recipient,
            getAttachments: () => {
                if (attachmentError && index === attachmentError.index) throw attachmentError.error;
                return [attachment];
            },
            getCc: () => cc,
            getDate: () => messageDate,
            getId: () => `message-${index + 123}`,
            getFrom: () => 'Looker Studio <approved@example.com>',
            getSubject: () => 'Daily report'
        };
        return {
            getMessages: () => [message],
            addLabel: label => labelsApplied.push({ index, label: label.name })
        };
    });
    const labelByName = {};
    const context = {
        PropertiesService: { getScriptProperties: () => ({
            getProperty: key => values[key],
            setProperty: (key, value) => { values[key] = value; },
            deleteProperty: key => { delete values[key]; }
        }) },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
        GmailApp: {
            search: (query, start, pageSize) => {
                searchCalls.push([query, start, pageSize]);
                return threads.slice(start, start + pageSize);
            },
            getUserLabelByName: name => labelByName[name] || null,
            createLabel: name => {
                const label = { name };
                labelByName[name] = label;
                return label;
            }
        },
        Utilities: { base64Encode: bytes => Buffer.from(bytes).toString('base64') },
        UrlFetchApp: { fetch: (url, options) => {
            if (fetchError) throw fetchError;
            requests.push({ url, options });
            if (onFetch) onFetch({ values, requestCount: requests.length });
            return { getResponseCode: () => status, getContentText: () => 'response' };
        } },
        console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
    };
    vm.runInNewContext(source, context);
    if (clock) context.forwarderNow_ = () => clock.now;
    let runError = null;
    try {
        context.forwardUnreadReports();
    } catch (error) {
        runError = error;
    }

    const ledger = Object.keys(values)
        .filter(key => /^PROCESSED_MESSAGE_IDS_\d+$/.test(key))
        .sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]))
        .flatMap(key => JSON.parse(values[key]));
    const summaryArgs = logs.find(args => String(args[0]).includes('summary'));
    const summary = summaryArgs ? JSON.parse(summaryArgs[2]) : null;
    return { requests, searchCalls, labelsApplied, values, ledger, logs, summary, runError };
}

test('Apps Script bridge forwards matching To/Cc aliases with bearer authentication', () => {
    const { requests, searchCalls, labelsApplied, ledger } = runBridge({
        recipient: 'Sneha <sneha@example.com>',
        cc: `Bot <${routingAddress}>`
    });
    assert.equal(searchCalls.length, 1);
    assert.match(searchCalls[0][0], /^has:attachment filename:pdf newer_than:7d after:\d+$/);
    assert.deepEqual(searchCalls[0].slice(1), [0, 50]);
    assert.equal(requests[0].url, 'https://bot.example.com/studio/email/ingest');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
    const payload = JSON.parse(requests[0].options.payload);
    assert.equal(payload.messageId, 'gmail:message-123');
    assert.equal(payload.to, `Sneha <sneha@example.com>, Bot <${routingAddress}>`);
    assert.equal(payload.attachments[0].data, 'JVBERi0=');
    assert.deepEqual(ledger, ['message-123']);
    assert.equal(labelsApplied[0].label, 'Looker Report Bot/Forwarded');
});

test('Apps Script bridge establishes a cutover without replaying existing mail', () => {
    const result = runBridge({ includeCutover: false });
    assert.equal(result.requests.length, 0);
    assert.equal(result.searchCalls.length, 0);
    assert.match(result.values.FORWARD_NOT_BEFORE, /^\d{4}-\d{2}-\d{2}T/);
});

test('Apps Script bridge skips mail older than the configured cutover', () => {
    const result = runBridge({ messageDate: new Date('2026-09-09T23:59:59.999Z') });
    assert.equal(result.requests.length, 0);
    assert.deepEqual(result.ledger, []);
});

test('Apps Script bridge records terminal 4xx responses but retries 408, 429, 5xx and network failures', () => {
    const terminal = runBridge({ status: 422 });
    assert.deepEqual(terminal.ledger, ['message-123']);
    assert.equal(terminal.labelsApplied[0].label, 'Looker Report Bot/Rejected');

    for (const status of [408, 429, 502]) {
        const retryable = runBridge({ status });
        assert.equal(retryable.requests.length, 1);
        assert.deepEqual(retryable.ledger, []);
        assert.deepEqual(retryable.labelsApplied, []);
    }
    const networkFailure = runBridge({ fetchError: new Error('temporary network error') });
    assert.deepEqual(networkFailure.ledger, []);
    assert.deepEqual(networkFailure.labelsApplied, []);
});

test('Apps Script bridge ignores unrelated and already processed messages', () => {
    const unrelated = runBridge({ recipient: 'someone@example.com' });
    assert.equal(unrelated.requests.length, 0);
    const summary = unrelated.logs.find(args => args[0].includes('summary'));
    assert.equal(summary[1], '1.2.0');
    assert.equal(JSON.parse(summary[2]).unrelated, 1);
    const lookalike = runBridge({ recipient: 'reports+abcdef0123456789abcdef01@evil.example.com, x@example.com' });
    assert.equal(lookalike.requests.length, 0);
    const duplicate = runBridge({ processedIds: ['message-123'] });
    assert.equal(duplicate.requests.length, 0);
});

test('Apps Script bridge paginates busy mailboxes and persists a chunked ledger', () => {
    const result = runBridge({ threadCount: 151, maxThreads: 200 });
    assert.equal(result.requests.length, 151);
    assert.deepEqual(result.searchCalls.map(call => call.slice(1)), [
        [0, 50], [50, 50], [100, 50], [150, 50]
    ]);
    assert.equal(result.ledger.length, 151);
    assert.ok(result.values.PROCESSED_MESSAGE_IDS_1);
    assert.equal(result.values.PROCESSED_MESSAGE_IDS, undefined);
});


function persistedLedger(values) {
    return Object.keys(values)
        .filter(key => /^PROCESSED_MESSAGE_IDS_\d+$/.test(key))
        .flatMap(key => JSON.parse(values[key]));
}

test('Apps Script bridge stops starting new messages once its runtime budget is spent', () => {
    const clock = { now: Date.parse('2026-09-10T02:00:00.000Z') };
    const result = runBridge({
        threadCount: 5,
        maxRuntimeSeconds: 270,
        clock,
        onFetch: () => { clock.now += 100_000; }
    });
    assert.equal(result.requests.length, 3);
    assert.equal(result.ledger.length, 3);
    assert.equal(result.summary.timeBudgetReached, true);
});

test('Apps Script bridge checkpoints its ledger during a long run', () => {
    const clock = { now: Date.parse('2026-09-10T02:00:00.000Z') };
    const persistedAtFetch = [];
    const result = runBridge({
        threadCount: 4,
        clock,
        onFetch: ({ values }) => {
            persistedAtFetch.push(persistedLedger(values).length);
            clock.now += 40_000;
        }
    });
    assert.equal(result.requests.length, 4);
    // Every 30s+ of work the ledger is saved, so a run killed by Apps Script's
    // execution limit keeps the messages it already forwarded.
    assert.deepEqual(persistedAtFetch, [0, 1, 2, 3]);
    assert.equal(result.ledger.length, 4);
    assert.ok(result.summary.checkpoints >= 4);
});

test('Apps Script bridge saves forwarded messages even when an unexpected error ends the run', () => {
    const result = runBridge({
        threadCount: 3,
        attachmentError: { index: 2, error: new Error('Gmail service unavailable') }
    });
    assert.match(String(result.runError && result.runError.message), /Gmail service unavailable/);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.ledger, ['message-124', 'message-123']);
});

test('Apps Script bridge validates the runtime budget property', () => {
    const result = runBridge({ maxRuntimeSeconds: 900 });
    assert.match(String(result.runError && result.runError.message), /FORWARD_MAX_RUNTIME_SECONDS/);
    assert.equal(result.requests.length, 0);
});
