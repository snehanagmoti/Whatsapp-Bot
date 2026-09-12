require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { convertPdfToPngPages } = require('./pdfProcessor');
const { startServer } = require('./server');
const { handleStudioCommand } = require('./studioCommands');
const { StudioEmailService } = require('./studioEmailService');
const { StudioDeliveryWorker } = require('./studioDeliveryWorker');
const { StudioRouteService } = require('./studioRouting');
const { MongoStudioStore } = require('./studioStore');
const { parseCsvSet } = require('./validation');
const { WhatsAppClient } = require('./whatsappClient');

const DEFAULT_STUDIO_ALLOWED_SENDERS = 'data-studio-noreply@google.com';

let whatsappReady = false;
let latestQr = null;
let latestQrAt = 0;
let server = null;
let studioStore = null;
let deliveryWorker = null;

const client = new WhatsAppClient({
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB_NAME || 'whatsapp_bot',
    sessionId: process.env.WWEBJS_CLIENT_ID || 'bot'
});

function studioConfigurationPresent() {
    return Boolean(
        process.env.STUDIO_ROUTING_EMAIL
        && process.env.STUDIO_ROUTE_PEPPER
        && (process.env.STUDIO_INGEST_TOKEN_OVERRIDE || process.env.STUDIO_INGEST_TOKEN)
    );
}

async function canManageRoutes({ chatId, senderId, message }) {
    if (message.fromMe) return true;
    const explicitAdmins = parseCsvSet(process.env.STUDIO_ROUTE_ADMIN_IDS);
    if (explicitAdmins.has(senderId)) return true;
    if (chatId.endsWith('@g.us')) return client.isGroupAdmin(chatId, senderId).catch(() => false);
    return process.env.NODE_ENV !== 'production' && process.env.STUDIO_ALLOW_TEST_SETUP === 'true';
}

async function canSetupRoutes(context) {
    // Public setup is intentionally limited to creating a new route. Existing
    // routes still require an administrator to pause, resume, rotate or remove.
    if (String(process.env.STUDIO_ALLOW_PUBLIC_SETUP || '').toLowerCase() === 'true') return true;
    return canManageRoutes(context);
}

async function main() {
    let routeService = null;
    let studioEmailService = null;
    if (studioConfigurationPresent()) {
        studioStore = await new MongoStudioStore({
            uri: process.env.MONGODB_URI,
            dbName: process.env.MONGODB_DB_NAME || 'whatsapp_bot'
        }).connect();
        routeService = new StudioRouteService({
            store: studioStore,
            routingEmail: process.env.STUDIO_ROUTING_EMAIL,
            pepper: process.env.STUDIO_ROUTE_PEPPER
        });
        const configuredSenders = parseCsvSet(process.env.STUDIO_ALLOWED_SENDERS);
        const allowedSenders = configuredSenders.size
            ? configuredSenders
            : parseCsvSet(DEFAULT_STUDIO_ALLOWED_SENDERS);
        studioEmailService = new StudioEmailService({
            routeService,
            store: studioStore,
            client,
            isClientReady: () => whatsappReady,
            convertPdf: convertPdfToPngPages,
            allowedSenders
        });
        console.log(`Looker Studio email routing is enabled with ${allowedSenders.size} approved sender(s).`);

        // Safety net for the synchronous ingest path above: retries deliveries
        // that failed or got stuck (e.g. the process crashed mid-send) without
        // depending on Apps Script/Gmail resending the report. See
        // studioDeliveryWorker.js for why this doesn't change the ingest
        // request/response contract.
        deliveryWorker = new StudioDeliveryWorker({
            store: studioStore,
            client,
            isClientReady: () => whatsappReady,
            convertPdf: convertPdfToPngPages
        });
        deliveryWorker.start();
        console.log(`Studio delivery retry worker started (max ${deliveryWorker.maxAttempts} attempts, checking every ${Math.round(deliveryWorker.intervalMs / 1000)}s).`);
    } else {
        console.warn('Looker Studio email routing is disabled because its environment variables are incomplete.');
    }

    server = startServer(client, {
        isClientReady: () => whatsappReady,
        getLatestQr: () => latestQr && Date.now() - latestQrAt < 60000 ? latestQr : null,
        studioEmailService,
        routeService,
        studioStore
    });
    if (process.env.NODE_ENV === 'production' && !process.env.QR_SETUP_TOKEN) {
        console.warn('QR setup is disabled until QR_SETUP_TOKEN is configured.');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.STUDIO_ADMIN_TOKEN) {
        console.warn('Admin dashboard is disabled until STUDIO_ADMIN_TOKEN is configured.');
    }

    client.on('qr', qr => {
        latestQr = qr;
        latestQrAt = Date.now();
        console.log('Please scan the QR code below to link the bot:');
        qrcode.generate(qr, { small: true });
    });
    client.on('authenticated', () => {
        latestQr = null;
        latestQrAt = 0;
        console.log('WhatsApp authentication completed; waiting for the client to become ready...');
    });
    client.on('change_state', state => console.log(`WhatsApp connection state: ${state}`));
    client.on('ready', () => {
        whatsappReady = true;
        latestQr = null;
        latestQrAt = 0;
        console.log('WhatsApp Bot is ready and connected!');
    });
    client.on('remote_session_saved', () => console.log('WhatsApp session backup saved to MongoDB.'));
    client.on('auth_failure', message => {
        whatsappReady = false;
        latestQr = null;
        latestQrAt = 0;
        console.error('WhatsApp authentication failed:', message);
    });
    client.on('disconnected', reason => {
        whatsappReady = false;
        console.warn('WhatsApp disconnected:', reason);
    });
    client.on('message_create', async message => {
        try {
            if (await handleStudioCommand({
                message,
                client,
                routeService,
                canManage: canManageRoutes,
                canSetup: canSetupRoutes
            })) return;
            const chatId = message.fromMe ? message.to : message.from;
            if (String(message.body || '').trim() === '!chatid') {
                await client.sendMessage(chatId, `Your WhatsApp Chat ID is:\n\n*${chatId}*`);
            }
        } catch (error) {
            console.error('WhatsApp command failed:', error.message || error);
        }
    });

    console.log('Starting WhatsApp client...');
    await client.initialize();
}

async function shutdown(signal) {
    console.log(`Received ${signal}; shutting down.`);
    whatsappReady = false;
    if (deliveryWorker) deliveryWorker.stop();
    if (server) await new Promise(resolve => server.close(resolve));
    await client.destroy().catch(() => {});
    if (studioStore) await studioStore.close().catch(() => {});
    process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

main().catch(error => {
    console.error('Bot failed to start:', error);
    setTimeout(() => process.exit(1), 1000);
});
