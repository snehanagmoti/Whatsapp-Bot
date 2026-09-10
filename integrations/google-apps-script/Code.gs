/**
 * Free-tier bridge for Looker Studio/Data Studio scheduled PDF emails.
 *
 * Required Script Properties:
 *   BOT_INGEST_URL, BOT_INGEST_TOKEN and ROUTING_MAILBOX
 *
 * Optional Script Properties:
 *   FORWARD_NOT_BEFORE          ISO-8601 cutover timestamp
 *   FORWARD_MAX_THREADS_PER_RUN 50-2000 (default: 500)
 *   FORWARD_LOOKBACK_DAYS       1-30 (default: 7)
 *
 * Run installReportForwarder once. The installer records a cutover timestamp
 * before it creates the trigger, so deploying the bridge never replays an old
 * mailbox backlog by accident.
 */

var REPORT_FORWARDER_CONFIG = {
  version: '1.1.0',
  successLabel: 'Looker Report Bot/Forwarded',
  terminalLabel: 'Looker Report Bot/Rejected',
  ledgerPrefix: 'PROCESSED_MESSAGE_IDS_',
  legacyLedgerKey: 'PROCESSED_MESSAGE_IDS',
  ledgerChunkSize: 100,
  ledgerChunkCount: 20,
  searchPageSize: 50,
  defaultMaxThreads: 500
};

function installReportForwarder() {
  var properties = PropertiesService.getScriptProperties();
  ensureForwardNotBefore_(properties);
  getOrCreateForwarderLabel_(REPORT_FORWARDER_CONFIG.successLabel);
  getOrCreateForwarderLabel_(REPORT_FORWARDER_CONFIG.terminalLabel);

  ScriptApp.getProjectTriggers()
    .filter(function (trigger) { return trigger.getHandlerFunction() === 'forwardUnreadReports'; })
    .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('forwardUnreadReports').timeBased().everyMinutes(5).create();
}

function forwardUnreadReports() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Report forwarder skipped: another execution holds the lock.');
    return;
  }
  var stats = { threads: 0, messages: 0, alreadyProcessed: 0, beforeCutover: 0,
    unrelated: 0, noPdf: 0, forwarded: 0, rejected: 0, retryable: 0 };

  try {
    var properties = PropertiesService.getScriptProperties();
    var config = readForwarderConfig_(properties);
    var cutover = ensureForwardNotBefore_(properties);

    // A direct first run (without running the installer) establishes a safe
    // cutover and deliberately does no work. Only later mail can be forwarded.
    if (cutover.initialized) {
      console.warn('FORWARD_NOT_BEFORE was missing. It was set to %s; existing mail was not forwarded.', cutover.value);
      return;
    }

    var processedIds = loadProcessedMessageIds_(properties);
    var processed = {};
    processedIds.forEach(function (id) { processed[id] = true; });
    var ledgerChanged = false;
    var successLabel = getOrCreateForwarderLabel_(REPORT_FORWARDER_CONFIG.successLabel);
    var terminalLabel = getOrCreateForwarderLabel_(REPORT_FORWARDER_CONFIG.terminalLabel);
    // Include the second immediately before the exact cutover so Gmail's
    // second-resolution search cannot hide a message that arrived milliseconds
    // after it. The precise millisecond check below still rejects old mail.
    var queryAfter = Math.floor(cutover.date.getTime() / 1000) - 1;
    var query = 'has:attachment filename:pdf newer_than:' + config.lookbackDays + 'd after:' + queryAfter;

    for (var start = 0; start < config.maxThreads; start += REPORT_FORWARDER_CONFIG.searchPageSize) {
      var pageSize = Math.min(REPORT_FORWARDER_CONFIG.searchPageSize, config.maxThreads - start);
      var threads = GmailApp.search(query, start, pageSize);
      stats.threads += threads.length;

      threads.forEach(function (thread) {
        thread.getMessages().forEach(function (message) {
          stats.messages += 1;
          var gmailMessageId = message.getId();
          if (processed[gmailMessageId]) { stats.alreadyProcessed += 1; return; }
          if (message.getDate().getTime() < cutover.date.getTime()) { stats.beforeCutover += 1; return; }

          var recipients = [message.getTo(), message.getCc ? message.getCc() : '']
            .filter(function (value) { return Boolean(value); })
            .join(', ');
          if (!hasRoutingRecipient_(recipients, config.mailbox)) { stats.unrelated += 1; return; }

          var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true })
            .filter(function (attachment) { return attachment.getContentType() === 'application/pdf'; })
            .map(function (attachment) {
              return {
                filename: attachment.getName(),
                mimetype: attachment.getContentType(),
                data: Utilities.base64Encode(attachment.getBytes())
              };
            });
          if (!attachments.length) { stats.noPdf += 1; return; }

          try {
            var response = UrlFetchApp.fetch(config.ingestUrl.replace(/\/$/, '') + '/studio/email/ingest', {
              method: 'post',
              contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + config.ingestToken },
              payload: JSON.stringify({
                messageId: 'gmail:' + gmailMessageId,
                from: message.getFrom(),
                to: recipients,
                subject: message.getSubject(),
                attachments: attachments
              }),
              muteHttpExceptions: true
            });

            var status = response.getResponseCode();
            if (status >= 200 && status < 300) {
              stats.forwarded += 1;
              rememberProcessedMessage_(gmailMessageId, processed, processedIds);
              ledgerChanged = true;
              thread.addLabel(successLabel);
              console.log('Forwarded Gmail message %s successfully.', gmailMessageId);
            } else if (isTerminalIngestStatus_(status)) {
              stats.rejected += 1;
              // Retrying malformed/unauthorized/oversized messages forever can
              // starve newer mail. Record and label permanent 4xx failures.
              rememberProcessedMessage_(gmailMessageId, processed, processedIds);
              ledgerChanged = true;
              thread.addLabel(terminalLabel);
              console.error('Permanently rejected Gmail message %s with HTTP %s: %s', gmailMessageId, status, response.getContentText());
            } else {
              stats.retryable += 1;
              // 408, 429 and all 5xx responses remain eligible for a later run.
              console.error('Retryable failure for Gmail message %s with HTTP %s: %s', gmailMessageId, status, response.getContentText());
            }
          } catch (error) {
            stats.retryable += 1;
            // Network and UrlFetch failures are transient unless the next run
            // receives a terminal HTTP response.
            console.error('Could not forward Gmail message %s: %s', gmailMessageId, error && error.message ? error.message : error);
          }
        });
      });

      if (threads.length < pageSize) break;
    }

    if (ledgerChanged) saveProcessedMessageIds_(properties, processedIds);
  } finally {
    console.log('Report forwarder v%s summary: %s', REPORT_FORWARDER_CONFIG.version, JSON.stringify(stats));
    lock.releaseLock();
  }
}

function readForwarderConfig_(properties) {
  var ingestUrl = properties.getProperty('BOT_INGEST_URL');
  var ingestToken = properties.getProperty('BOT_INGEST_TOKEN');
  var mailbox = String(properties.getProperty('ROUTING_MAILBOX') || '').trim().toLowerCase();
  if (!ingestUrl || !ingestToken || !mailbox) {
    throw new Error('BOT_INGEST_URL, BOT_INGEST_TOKEN and ROUTING_MAILBOX are required.');
  }
  if (!/^[^@+\s]+@[^@\s]+$/.test(mailbox)) {
    throw new Error('ROUTING_MAILBOX must be a plain email address without a + tag.');
  }

  var maxThreadsValue = properties.getProperty('FORWARD_MAX_THREADS_PER_RUN');
  var maxThreads = maxThreadsValue ? Number(maxThreadsValue) : REPORT_FORWARDER_CONFIG.defaultMaxThreads;
  if (!Number.isInteger(maxThreads) || maxThreads < 50 || maxThreads > 2000) {
    throw new Error('FORWARD_MAX_THREADS_PER_RUN must be an integer from 50 to 2000.');
  }
  var lookbackValue = properties.getProperty('FORWARD_LOOKBACK_DAYS');
  var lookbackDays = lookbackValue ? Number(lookbackValue) : 7;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 30) {
    throw new Error('FORWARD_LOOKBACK_DAYS must be an integer from 1 to 30.');
  }
  return {
    ingestUrl: ingestUrl,
    ingestToken: ingestToken,
    mailbox: mailbox,
    maxThreads: maxThreads,
    lookbackDays: lookbackDays
  };
}

function ensureForwardNotBefore_(properties) {
  var value = properties.getProperty('FORWARD_NOT_BEFORE');
  var initialized = false;
  if (!value) {
    value = new Date().toISOString();
    properties.setProperty('FORWARD_NOT_BEFORE', value);
    initialized = true;
  }
  var date = new Date(value);
  if (isNaN(date.getTime())) throw new Error('FORWARD_NOT_BEFORE must be a valid ISO-8601 timestamp.');
  return { value: value, date: date, initialized: initialized };
}

function hasRoutingRecipient_(recipients, mailbox) {
  var separator = mailbox.lastIndexOf('@');
  var local = mailbox.slice(0, separator);
  var domain = mailbox.slice(separator + 1);
  var addresses = String(recipients || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) || [];
  return addresses.some(function (address) {
    var at = address.lastIndexOf('@');
    var addressLocal = address.slice(0, at).toLowerCase();
    var addressDomain = address.slice(at + 1).toLowerCase();
    var token = addressLocal.slice(local.length + 1);
    return addressDomain === domain &&
      addressLocal.indexOf(local + '+') === 0 &&
      /^[a-z0-9_-]{20,64}$/.test(token);
  });
}

function isTerminalIngestStatus_(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function getOrCreateForwarderLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function loadProcessedMessageIds_(properties) {
  var ids = [];
  var seen = {};
  var addValues = function (value) {
    var parsed;
    try {
      parsed = JSON.parse(value || '[]');
    } catch (error) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) return;
    parsed.forEach(function (id) {
      id = String(id || '');
      if (id && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    });
  };

  addValues(properties.getProperty(REPORT_FORWARDER_CONFIG.legacyLedgerKey));
  for (var index = 0; index < REPORT_FORWARDER_CONFIG.ledgerChunkCount; index += 1) {
    addValues(properties.getProperty(REPORT_FORWARDER_CONFIG.ledgerPrefix + index));
  }
  return ids.slice(0, REPORT_FORWARDER_CONFIG.ledgerChunkSize * REPORT_FORWARDER_CONFIG.ledgerChunkCount);
}

function rememberProcessedMessage_(id, processed, processedIds) {
  if (processed[id]) return;
  processed[id] = true;
  processedIds.unshift(id);
  var maximum = REPORT_FORWARDER_CONFIG.ledgerChunkSize * REPORT_FORWARDER_CONFIG.ledgerChunkCount;
  if (processedIds.length > maximum) processedIds.length = maximum;
}

function saveProcessedMessageIds_(properties, processedIds) {
  for (var index = 0; index < REPORT_FORWARDER_CONFIG.ledgerChunkCount; index += 1) {
    var start = index * REPORT_FORWARDER_CONFIG.ledgerChunkSize;
    var chunk = processedIds.slice(start, start + REPORT_FORWARDER_CONFIG.ledgerChunkSize);
    var key = REPORT_FORWARDER_CONFIG.ledgerPrefix + index;
    if (chunk.length) properties.setProperty(key, JSON.stringify(chunk));
    else properties.deleteProperty(key);
  }
  properties.deleteProperty(REPORT_FORWARDER_CONFIG.legacyLedgerKey);
}
