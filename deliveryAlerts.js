// When a report delivery gives up (dead_letter), the WhatsApp chat that was
// waiting for it gets a short note saying why, so a missing report is never
// silent. The note is rate-limited so a burst of failures cannot flood chats.

const DEFAULT_MAX_ALERTS_PER_WINDOW = 10;
const DEFAULT_ALERT_WINDOW_MS = 10 * 60 * 1000;

function formatDeadLetterAlert(info = {}) {
    const name = info.routeName ? `*${info.routeName}*` : 'A report';
    const lines = [`⚠️ ${name} could not be delivered to this chat.`];
    if (info.subject) lines.push(`Email: ${String(info.subject).slice(0, 200)}`);
    if (info.error) lines.push(`Reason: ${String(info.error).slice(0, 300)}`);
    lines.push('', 'It can be retried from the dashboard (Recent deliveries → Retry) for 7 days, or wait for the next scheduled report.');
    return lines.join('\n');
}

function createDeadLetterNotifier({
    client,
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
        log.warn(`Report delivery gave up for ${info.chatId || 'unknown chat'}`
            + `${info.routeName ? ` (${info.routeName})` : ''}: ${info.error || 'unknown error'}`);
        if (!client || !info.chatId) return false;

        const current = now();
        if (current - windowStart >= windowMs) {
            if (suppressed) log.warn(`${suppressed} delivery-failure note(s) were suppressed in the previous window.`);
            windowStart = current;
            sentInWindow = 0;
            suppressed = 0;
        }
        if (sentInWindow >= maxAlertsPerWindow) {
            suppressed += 1;
            return false;
        }
        if (!isClientReady()) {
            log.warn('Delivery-failure note not sent: WhatsApp is not connected.');
            return false;
        }
        sentInWindow += 1;
        await client.sendMessage(info.chatId, formatDeadLetterAlert(info));
        return true;
    };
}

module.exports = { createDeadLetterNotifier, formatDeadLetterAlert };
