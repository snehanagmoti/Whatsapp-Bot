const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { GridFSBucket, MongoClient } = require('mongodb');

class MongoGridFsStore {
    constructor({ uri, dataPath, dbName = 'whatsapp_bot' }) {
        if (!uri) throw new Error('MONGODB_URI is required for MongoDB session storage.');
        this.uri = uri;
        this.dataPath = dataPath;
        this.dbName = dbName;
        this.connectPromise = null;
    }

    async connect() {
        if (!this.connectPromise) {
            this.connectPromise = (async () => {
                this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000 });
                await this.client.connect();
                this.bucket = new GridFSBucket(this.client.db(this.dbName), { bucketName: 'whatsapp_sessions' });
                return this.bucket;
            })();
        }
        return this.connectPromise;
    }

    filename(session) {
        return `${session}.zip`;
    }

    async sessionExists({ session }) {
        const bucket = await this.connect();
        return bucket.find({ filename: this.filename(session) }).limit(1).hasNext();
    }

    async save({ session }) {
        const bucket = await this.connect();
        await this.delete({ session });
        const archivePath = path.join(this.dataPath, this.filename(session));
        await pipeline(
            fs.createReadStream(archivePath),
            bucket.openUploadStream(this.filename(session), { metadata: { updatedAt: new Date() } })
        );
    }

    async extract({ session, path: destination }) {
        const bucket = await this.connect();
        const files = await bucket.find({ filename: this.filename(session) }).sort({ uploadDate: -1 }).limit(1).toArray();
        if (!files.length) throw new Error(`Remote WhatsApp session ${session} was not found.`);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await pipeline(bucket.openDownloadStream(files[0]._id), fs.createWriteStream(destination));
    }

    async delete({ session }) {
        const bucket = await this.connect();
        const files = await bucket.find({ filename: this.filename(session) }).toArray();
        await Promise.all(files.map(file => bucket.delete(file._id)));
    }

    async close() {
        if (this.client) await this.client.close();
    }
}

module.exports = { MongoGridFsStore };
