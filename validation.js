function isValidWhatsAppChatId(value) {
    return typeof value === 'string' && /^\d+@(c|g)\.us$/.test(value.trim());
}

function parseCsvSet(value = '') {
    return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

module.exports = { isValidWhatsAppChatId, parseCsvSet };
