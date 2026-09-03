const { MongoClient } = require('mongodb');

function safeSessionId(value = 'bot') {
    if (!/^[-_A-Za-z0-9]+$/.test(value)) throw new Error('Invalid WhatsApp session ID.');
    return value;
}

async function createMongoAuthState({ uri, dbName = 'whatsapp_bot', sessionId = 'bot', baileys }) {
    if (!uri) throw new Error('MONGODB_URI is required for WhatsApp session storage.');
    const { BufferJSON, initAuthCreds, proto } = baileys;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();

    const normalizedSessionId = safeSessionId(sessionId);
    const collection = client.db(dbName).collection('baileys_auth');
    const documentId = id => `${normalizedSessionId}:${id}`;

    async function readData(id) {
        const record = await collection.findOne({ _id: documentId(id) });
        return record ? JSON.parse(record.value, BufferJSON.reviver) : null;
    }

    async function writeData(data, id) {
        await collection.updateOne(
            { _id: documentId(id) },
            {
                $set: {
                    sessionId: normalizedSessionId,
                    value: JSON.stringify(data, BufferJSON.replacer),
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
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
        saveCreds: () => writeData(state.creds, 'creds'),
        clear: () => collection.deleteMany({ sessionId: normalizedSessionId }),
        close: () => client.close()
    };
}

module.exports = { createMongoAuthState };
