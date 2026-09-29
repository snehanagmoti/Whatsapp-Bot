// Tells an operator when a report delivery has given up (dead_letter), so a
// missing report is noticed without watching the dashboard.
//
// STUDIO_ALERT_CHAT_ID names the WhatsApp chat (for example an admin group)
// that receives the alerts. Without it, alerts are only logged.

const DEFAULT_MAX_ALERTS_PER_WINDOW = 10;
const DEFAULT_ALERT_WINDOW_MS = 10 * 60 * 1000;

function formatDeadLetterAlert(info = {}) {
    const lines = ['Report delivery gave up'];
    if (info.routeName) lines.push(`Report: ${info.routeName}`);
    if (info.chatId) lines.push(`Chat: ${info.chatId}`);
    if (info.subject) lines.push(`Subject: ${String(info.subject).slice(0, 200)}`);
    if (info.error) lines.push(`Last error: ${String(info.error).slice(0, 300)}`);
    lines.push('', 'Retry it from the admin dashboard (Recent deliveries → Retry) within the retention window, or send the report again.');
    return lines.join('\n');
}

function createDeadLetterNotifier({
    client,
    alertChatId,
    isClientReady = () => true,
    maxAlertsPerWindow = DEFAULT_MAX_ALERTS_PER_WINDOW,
    windowMs = DEFAULT_ALERT_WINDOW_MS,
    now = () => Date.now(),
    log = console
} = {}) {
    let windowStart = 0;
    let sentInWindow = 0;
    let suppressed = 0;

    return async function notifyDeadLetter(info = {}) {
        const summary = `Report delivery gave up for ${info.chatId || 'unknown chat'}`
            + `${info.routeName ? ` (${info.routeName})` : ''}: ${info.error || 'unknown error'}`;
        log.warn(summary);
        if (!alertChatId || !client) return false;

        // A failing WhatsApp account or a burst of failing routes must not turn
        // into a flood of alert messages.
        const current = now();
        if (current - windowStart >= windowMs) {
            if (suppressed) log.warn(`${suppressed} dead-letter alert(s) were suppressed in the previous window.`);
            windowStart = current;
            sentInWindow = 0;
            suppressed = 0;
        }
        if (sentInWindow >= maxAlertsPerWindow) {
            suppressed += 1;
            return false;
        }
        if (!isClientReady()) {
            log.warn('Dead-letter alert not sent: WhatsApp is not connected.');
            return false;
        }
        sentInWindow += 1;
        await client.sendMessage(alertChatId, formatDeadLetterAlert(info));
        return true;
    };
}

module.exports = { createDeadLetterNotifier, formatDeadLetterAlert };
