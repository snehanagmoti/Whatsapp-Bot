/**
 * Free-tier test bridge for Looker Studio/Data Studio scheduled PDF emails.
 * Set BOT_INGEST_URL, BOT_INGEST_TOKEN and ROUTING_MAILBOX in Script Properties,
 * then run installReportForwarder once.
 */
function installReportForwarder() {
  ScriptApp.getProjectTriggers()
    .filter(function (trigger) { return trigger.getHandlerFunction() === 'forwardUnreadReports'; })
    .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('forwardUnreadReports').timeBased().everyMinutes(5).create();
}

function forwardUnreadReports() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
  var properties = PropertiesService.getScriptProperties();
  var ingestUrl = properties.getProperty('BOT_INGEST_URL');
  var ingestToken = properties.getProperty('BOT_INGEST_TOKEN');
  var mailbox = properties.getProperty('ROUTING_MAILBOX');
  if (!ingestUrl || !ingestToken || !mailbox) {
    throw new Error('BOT_INGEST_URL, BOT_INGEST_TOKEN and ROUTING_MAILBOX are required.');
  }

  var mailboxParts = mailbox.toLowerCase().split('@');
  var routingPrefix = mailboxParts[0] + '+';
  var routingDomain = '@' + mailboxParts[1];
  var processedKey = 'PROCESSED_MESSAGE_IDS';
  var processedIds;
  try {
    processedIds = JSON.parse(properties.getProperty(processedKey) || '[]');
  } catch (error) {
    processedIds = [];
  }
  if (!Array.isArray(processedIds)) processedIds = [];
  var processed = {};
  processedIds.forEach(function (id) { processed[id] = true; });
  var threads = GmailApp.search('has:attachment filename:pdf newer_than:2d', 0, 20);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      var gmailMessageId = message.getId();
      if (processed[gmailMessageId]) return;
      var recipients = message.getTo();
      var normalizedRecipients = recipients.toLowerCase();
      if (normalizedRecipients.indexOf(routingPrefix) < 0 || normalizedRecipients.indexOf(routingDomain) < 0) return;

      var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(function (attachment) { return attachment.getContentType() === 'application/pdf'; })
        .map(function (attachment) {
          return {
            filename: attachment.getName(),
            mimetype: attachment.getContentType(),
            data: Utilities.base64Encode(attachment.getBytes())
          };
        });
      if (!attachments.length) return;

      var response = UrlFetchApp.fetch(ingestUrl.replace(/\/$/, '') + '/studio/email/ingest', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ingestToken },
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
        processed[gmailMessageId] = true;
        processedIds.unshift(gmailMessageId);
        processedIds = processedIds.slice(0, 200);
        properties.setProperty(processedKey, JSON.stringify(processedIds));
        console.log('Forwarded Gmail message %s successfully.', gmailMessageId);
      } else {
        console.error('Bot rejected Gmail message %s with HTTP %s: %s', gmailMessageId, status, response.getContentText());
      }
    });
  });
  } finally {
    lock.releaseLock();
  }
}
