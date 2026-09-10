const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    DEFAULT_MESSAGE_CLAIM_TTL_MS,
    createMongoAuthState,
    parseEncryptionKey
} = require('../baileysAuthStore');

class FakeCollection {
    constructor() {
        this.documents = new Map();
        this.indexes = [];
    }

    async createIndex(keys, options) {
        this.indexes.push({ keys, options });
        return options.name || 'index';
    }

    async findOne(filter) {
        return this.documents.get(filter._id) || null;
    }

    async insertOne(document) {
        if (this.documents.has(document._id)) {
            const error = new Error('duplicate key');
            error.code = 11000;
            throw error;
        }
        this.documents.set(document._id, { ...document });
        return { insertedId: document._id };
    }

    async updateOne(filter, update, options = {}) {
        let document = this.documents.get(filter._id);
        if (!document && options.upsert) document = { _id: filter._id };
        if (!document) return { matchedCount: 0 };
        Object.assign(document, update.$set || {});
        Object.keys(update.$unset || {}).forEach(key => { delete document[key]; });
        this.documents.set(filter._id, document);
        return { matchedCount: 1 };
    }

    async deleteOne(filter) {
        return { deletedCount: this.documents.delete(filter._id) ? 1 : 0 };
    }

    async deleteMany(filter) {
        let deletedCount = 0;
        for (const [id, document] of this.documents) {
            if (document.sessionId === filter.sessionId) {
                this.documents.delete(id);
                deletedCount += 1;
            }
        }
        return { deletedCount };
    }
}

function fakeMongo() {
    const collections = new Map();
    const getCollection = name => {
        if (!collections.has(name)) collections.set(name, new FakeCollection());
        return collections.get(name);
    };
    class FakeMongoClient {
        async connect() {}
        db() { return { collection: getCollection }; }
        async close() {}
    }
    return { collections, getCollection, MongoClientClass: FakeMongoClient };
}

const baileys = {
    BufferJSON: { replacer: undefined, reviver: undefined },
    initAuthCreds: () => ({ registered: false, secret: 'initial-secret' }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } }
};

function createState(database, options = {}) {
    return createMongoAuthState({
        uri: 'mongodb://unit-test',
        baileys,
        MongoClientClass: database.MongoClientClass,
        ...options
    });
}

test('encrypts new WhatsApp auth records with AES-256-GCM', async () => {
    const database = fakeMongo();
    const auth = await createState(database, { encryptionKey: 'a'.repeat(32) });
    auth.state.creds.registered = true;
    auth.state.creds.secret = 'credential-plaintext-marker';
    await auth.saveCreds();

    const record = database.getCollection('baileys_auth').documents.get('bot:creds');
    assert.equal(record.value, undefined);
    assert.equal(record.encryptedValue.algorithm, 'aes-256-gcm');
    assert.equal(JSON.stringify(record).includes('credential-plaintext-marker'), false);

    const reopened = await createState(database, { encryptionKey: 'a'.repeat(32) });
    assert.equal(reopened.state.creds.registered, true);
    assert.equal(reopened.state.creds.secret, 'credential-plaintext-marker');
});

test('migrates a valid plaintext auth record after encryption is enabled', async () => {
    const database = fakeMongo();
    database.getCollection('baileys_auth').documents.set('bot:creds', {
        _id: 'bot:creds',
        sessionId: 'bot',
        value: JSON.stringify({ registered: true, secret: 'legacy-secret' })
    });

    const auth = await createState(database, { encryptionKey: 'b'.repeat(32) });
    assert.equal(auth.state.creds.secret, 'legacy-secret');
    const migrated = database.getCollection('baileys_auth').documents.get('bot:creds');
    assert.equal(migrated.value, undefined);
    assert.ok(migrated.encryptedValue);
    assert.equal(JSON.stringify(migrated).includes('legacy-secret'), false);
});

test('keeps plaintext compatibility when encryption is not configured', async () => {
    const database = fakeMongo();
    const auth = await createState(database, { encryptionKey: '' });
    await auth.saveCreds();
    const record = database.getCollection('baileys_auth').documents.get('bot:creds');
    assert.equal(typeof record.value, 'string');
    assert.equal(record.encryptedValue, undefined);
});

test('refuses to open encrypted auth data without the matching key', async () => {
    const database = fakeMongo();
    const auth = await createState(database, { encryptionKey: 'c'.repeat(32) });
    await auth.saveCreds();
    await assert.rejects(
        () => createState(database, { encryptionKey: '' }),
        /WA_AUTH_ENCRYPTION_KEY is required/
    );
    await assert.rejects(
        () => createState(database, { encryptionKey: 'd'.repeat(32) }),
        /Could not decrypt.*WA_AUTH_ENCRYPTION_KEY/
    );
});

test('validates encryption keys before connecting to MongoDB', async () => {
    assert.equal(parseEncryptionKey('e'.repeat(64)).length, 32);
    assert.equal(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64')).length, 32);
    assert.throws(() => parseEncryptionKey('short'), /at least 32 characters/);
});

test('claims command messages once with a TTL-backed hashed identity', async () => {
    const database = fakeMongo();
    const now = 1_800_000_000_000;
    const auth = await createState(database, { encryptionKey: '', now: () => now });
    const identity = '123@g.us:admin@s.whatsapp.net:message-1';
    assert.equal(await auth.claimMessage(identity, now - 1000), true);
    assert.equal(await auth.claimMessage(identity, now - 1000), false);

    const claims = database.getCollection('baileys_message_claims');
    assert.deepEqual(claims.indexes, [{
        keys: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, name: 'message_claim_expiry' }
    }]);
    const [claim] = [...claims.documents.values()];
    assert.equal(claim._id.includes(identity), false);
    assert.equal(claim.expiresAt.getTime(), now + DEFAULT_MESSAGE_CLAIM_TTL_MS);
    assert.equal(claim.messageTimestamp.getTime(), now - 1000);
});
