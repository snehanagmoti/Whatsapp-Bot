function isValidWhatsAppChatId(value) {
    return typeof value === 'string' && /^\d+@(?:c\.us|g\.us|s\.whatsapp\.net)$/.test(value.trim());
}

function parseCsvSet(value = '') {
    return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

module.exports = { isValidWhatsAppChatId, parseCsvSet };
