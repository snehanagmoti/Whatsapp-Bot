const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const AUTH_ENCRYPTION_VERSION = 1;
const AUTH_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const DEFAULT_MESSAGE_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeMessageClaimTtlMs(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_MESSAGE_CLAIM_TTL_MS;
    const ttlMs = Number(value);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60 * 60 * 1000 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
        throw new Error('WA_COMMAND_CLAIM_TTL_MS must be an integer from 1 hour through 30 days.');
    }
    return ttlMs;
}

function parseEncryptionKey(value) {
    const configured = String(value || '').trim();
    if (!configured) return null;

    if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');

    if (/^[A-Za-z0-9+/]+={0,2}$/.test(configured)) {
        const decoded = Buffer.from(configured, 'base64');
        if (decoded.length === 32) return decoded;
    }

    if (Buffer.byteLength(configured, 'utf8') < 32) {
        throw new Error('WA_AUTH_ENCRYPTION_KEY must be a 32-byte base64 value, 64-character hex value, or random secret of at least 32 characters.');
    }
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
}

function encryptValue(value, key, documentId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(AUTH_ENCRYPTION_ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(documentId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
        version: AUTH_ENCRYPTION_VERSION,
        algorithm: AUTH_ENCRYPTION_ALGORITHM,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptValue(envelope, key, documentId) {
    if (!key) throw new Error('WA_AUTH_ENCRYPTION_KEY is required to read the encrypted WhatsApp session.');
    if (!envelope || envelope.version !== AUTH_ENCRYPTION_VERSION
        || envelope.algorithm !== AUTH_ENCRYPTION_ALGORITHM
        || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
        throw new Error('The stored WhatsApp session has an unsupported or invalid encryption format.');
    }
    try {
        const decipher = crypto.createDecipheriv(
            AUTH_ENCRYPTION_ALGORITHM,
            key,
            Buffer.from(envelope.iv, 'base64')
        );
        decipher.setAAD(Buffer.from(documentId, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch (error) {
        throw new Error('Could not decrypt the stored WhatsApp session. Check WA_AUTH_ENCRYPTION_KEY.');
    }
}

function safeSessionId(value = 'bot') {
    if (!/^[-_A-Za-z0-9]+$/.test(value)) throw new Error('Invalid WhatsApp session ID.');
    return value;
}

async function createMongoAuthState({
    uri,
    dbName = 'whatsapp_bot',
    sessionId = 'bot',
    baileys,
    encryptionKey = process.env.WA_AUTH_ENCRYPTION_KEY,
    messageClaimTtlMs = process.env.WA_COMMAND_CLAIM_TTL_MS,
    now = () => Date.now(),
    MongoClientClass = MongoClient
}) {
    if (!uri) throw new Error('MONGODB_URI is required for WhatsApp session storage.');
    const { BufferJSON, initAuthCreds, proto } = baileys;
    const authKey = parseEncryptionKey(encryptionKey);
    const claimTtlMs = normalizeMessageClaimTtlMs(messageClaimTtlMs);
    const normalizedSessionId = safeSessionId(sessionId);
    const client = new MongoClientClass(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();

    const db = client.db(dbName);
    const collection = db.collection('baileys_auth');
    const messageClaims = db.collection('baileys_message_claims');
    await messageClaims.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'message_claim_expiry' });
    const documentId = id => `${normalizedSessionId}:${id}`;

    async function claimMessage(identity, timestamp) {
        const normalizedIdentity = String(identity || '').trim();
        if (!normalizedIdentity || normalizedIdentity.length > 512) {
            throw new Error('A valid WhatsApp message identity is required.');
        }
        const timestampMs = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
        if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
            throw new Error('A valid WhatsApp message timestamp is required.');
        }
        const nowValue = now();
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
        if (!Number.isFinite(nowMs)) throw new Error('The WhatsApp message-claim clock is invalid.');
        const identityHash = crypto.createHash('sha256').update(normalizedIdentity).digest('hex');
        try {
            await messageClaims.insertOne({
                _id: `${normalizedSessionId}:message:${identityHash}`,
                sessionId: normalizedSessionId,
                identityHash,
                messageTimestamp: new Date(timestampMs),
                expiresAt: new Date(Math.max(nowMs, timestampMs) + claimTtlMs),
                createdAt: new Date(nowMs)
            });
            return true;
        } catch (error) {
            if (error && error.code === 11000) return false;
            throw error;
        }
    }

    async function writeSerializedValue(value, id) {
        const idValue = documentId(id);
        const set = {
            sessionId: normalizedSessionId,
            updatedAt: new Date()
        };
        const unset = {};
        if (authKey) {
            set.encryptedValue = encryptValue(value, authKey, idValue);
            unset.value = '';
        } else {
            set.value = value;
            unset.encryptedValue = '';
        }
        await collection.updateOne(
            { _id: idValue },
            { $set: set, $unset: unset },
            { upsert: true }
        );
    }

    async function readData(id) {
        const idValue = documentId(id);
        const record = await collection.findOne({ _id: idValue });
        if (!record) return null;

        const serialized = record.encryptedValue
            ? decryptValue(record.encryptedValue, authKey, idValue)
            : record.value;
        if (typeof serialized !== 'string') {
            throw new Error('The stored WhatsApp session record is invalid.');
        }
        const value = JSON.parse(serialized, BufferJSON.reviver);

        // Existing plaintext records are upgraded in place on their first
        // successful read after WA_AUTH_ENCRYPTION_KEY is configured.
        if (authKey && !record.encryptedValue) await writeSerializedValue(serialized, id);
        return value;
    }

    async function writeData(data, id) {
        await writeSerializedValue(JSON.stringify(data, BufferJSON.replacer), id);
    }

    async function removeData(id) {
        await collection.deleteOne({ _id: documentId(id) });
    }

    const creds = await readData('creds') || initAuthCreds();
    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const result = {};
                await Promise.all(ids.map(async id => {
                    let value = await readData(`${type}-${id}`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    if (value) result[id] = value;
                }));
                return result;
            },
            set: async data => {
                const writes = [];
                for (const [type, entries] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(entries || {})) {
                        writes.push(value ? writeData(value, `${type}-${id}`) : removeData(`${type}-${id}`));
                    }
                }
                await Promise.all(writes);
            },
            clear: async () => {
                await collection.deleteMany({ sessionId: normalizedSessionId });
            }
        }
    };

    return {
        state,
        claimMessage,
        saveCreds: () => writeData(state.creds, 'creds'),
        clear: () => collection.deleteMany({ sessionId: normalizedSessionId }),
        close: () => client.close()
    };
}

module.exports = {
    AUTH_ENCRYPTION_ALGORITHM,
    AUTH_ENCRYPTION_VERSION,
    DEFAULT_MESSAGE_CLAIM_TTL_MS,
    createMongoAuthState,
    decryptValue,
    encryptValue,
    normalizeMessageClaimTtlMs,
    parseEncryptionKey
};
