// Keeps WhatsApp end-to-end encryption material out of application logs.
//
// libsignal (used by Baileys) writes routine session lifecycle messages with
// console.info/warn and passes the whole SessionEntry object, e.g.
//   console.info('Closing session:', session)
// That object contains ratchet private keys, root keys and chain keys, which
// then land in Render's log viewer. This module wraps the console once at
// startup: routine libsignal session chatter is dropped, and any logged
// object that carries Signal key material is replaced by a placeholder.
// Set WA_SIGNAL_DEBUG=true to keep the routine messages (objects are still
// redacted).

const REDACTED = '[redacted: Signal key material]';
const INSTALLED = Symbol.for('whatsapp-bot.logRedaction.installed');

const ROUTINE_SIGNAL_MESSAGES = [
    /^Closing session:?$/,
    /^Opening session:?$/,
    /^Removing old closed session:?$/,
    /^Session already (?:closed|open)$/,
    /^Closing open session in favor of incoming prekey bundle$/,
    /^Migrating session to:?$/,
    /^Decrypted message with closed session\.?$/
];

// Property names that only appear on Signal/WhatsApp key structures.
const SENSITIVE_KEYS = new Set([
    '_chains', 'chainKey', 'messageKeys', 'currentRatchet', 'rootKey', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'privKey', 'privateKey', 'noiseKey', 'pairingEphemeralKeyPair',
    'signedIdentityKey', 'signedPreKey', 'advSecretKey', 'identityKey', 'baseKey',
    'remoteIdentityKey', 'macKey', 'cipherKey'
]);

const MAX_DEPTH = 5;

function isBinary(value) {
    return Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function containsKeyMaterial(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || isBinary(value) || depth > MAX_DEPTH) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const name = value.constructor && value.constructor.name;
    if (name === 'SessionEntry' || name === 'SessionRecord') return true;
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    for (const [key, child] of entries) {
        if (SENSITIVE_KEYS.has(String(key))) return true;
        if (containsKeyMaterial(child, depth + 1, seen)) return true;
    }
    return false;
}

function redactArgs(args) {
    return args.map(arg => (arg && typeof arg === 'object' && !(arg instanceof Error) && containsKeyMaterial(arg))
        ? REDACTED
        : arg);
}

function isRoutineSignalMessage(args) {
    return typeof args[0] === 'string' && ROUTINE_SIGNAL_MESSAGES.some(pattern => pattern.test(args[0].trim()));
}

function installLogRedaction({
    target = console,
    verboseSignal = String(process.env.WA_SIGNAL_DEBUG || '').toLowerCase() === 'true'
} = {}) {
    if (target[INSTALLED]) return target;
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        if (typeof target[method] !== 'function') continue;
        const original = target[method].bind(target);
        target[method] = (...args) => {
            if (!verboseSignal && isRoutineSignalMessage(args)) return;
            original(...redactArgs(args));
        };
    }
    Object.defineProperty(target, INSTALLED, { value: true });
    return target;
}

module.exports = { REDACTED, containsKeyMaterial, installLogRedaction, redactArgs };
