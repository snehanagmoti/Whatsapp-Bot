// Accepts phone-number chats (…@s.whatsapp.net / legacy …@c.us), LID chats
// (…@lid, used by WhatsApp for privacy-preserving identities), and groups,
// including legacy "creator-timestamp" group IDs such as 123-456@g.us.
function isValidWhatsAppChatId(value) {
    if (typeof value !== 'string') return false;
    const id = value.trim();
    return /^\d+@(?:c\.us|s\.whatsapp\.net|lid)$/.test(id) || /^\d+(?:-\d+)?@g\.us$/.test(id);
}

function parseCsvSet(value = '') {
    return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

module.exports = { isValidWhatsAppChatId, parseCsvSet };
