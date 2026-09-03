require('dotenv').config();
const { Client, LocalAuth, MessageMedia, RemoteAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { captureScreenshot } = require('./screenshot');
const db = require('./db');
const scheduler = require('./scheduler');
const { startServer } = require('./server');
const { MongoGridFsStore } = require('./mongoAuthStore');

// In-memory state machine to track conversations
// Structure: { "chatId": { state: "AWAITING_URL", tempReport: { url: "..." } } }
const chatStates = {};

const dataDir = path.resolve(process.env.DATA_DIR || __dirname);
const authDataPath = path.join(dataDir, '.wwebjs_auth');
let whatsappReady = false;
let schedulerBooted = false;

const remoteStore = process.env.MONGODB_URI
    ? new MongoGridFsStore({
        uri: process.env.MONGODB_URI,
        dataPath: authDataPath,
        dbName: process.env.MONGODB_DB_NAME || 'whatsapp_bot'
    })
    : null;

const authStrategy = remoteStore
    ? new RemoteAuth({
        clientId: process.env.WWEBJS_CLIENT_ID || 'bot',
        dataPath: authDataPath,
        store: remoteStore,
        backupSyncIntervalMs: Math.max(Number(process.env.WWEBJS_BACKUP_INTERVAL_MS) || 60000, 60000)
    })
    : new LocalAuth({ dataPath: authDataPath });

// whatsapp-web.js bundles its own Puppeteer version, which can expect a
// different Chrome revision than the official Puppeteer Docker image. Prefer
// the browser installed for this application's pinned Puppeteer dependency.
function resolveBrowserExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
        const executablePath = puppeteer.executablePath();
        return typeof executablePath === 'string' && fs.existsSync(executablePath)
            ? executablePath
            : undefined;
    } catch {
        return undefined;
    }
}

const browserExecutable = resolveBrowserExecutable();

const client = new Client({
    authStrategy,
    puppeteer: {
        headless: true,
        ...(browserExecutable ? { executablePath: browserExecutable } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

// Bind the HTTP port immediately so cloud health checks work before WhatsApp login completes.
startServer(client, { isClientReady: () => whatsappReady });

client.on('qr', (qr) => {
    console.log('Please scan the QR code below to link the bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    whatsappReady = true;
    console.log('WhatsApp Bot is ready and connected!');
    // Boot all active schedules from the database
    if (!schedulerBooted) {
        scheduler.bootScheduler(client);
        schedulerBooted = true;
    }
});

client.on('remote_session_saved', () => {
    console.log('WhatsApp session backup saved to MongoDB.');
});

client.on('auth_failure', (message) => {
    whatsappReady = false;
    console.error('WhatsApp authentication failed:', message);
});

client.on('disconnected', (reason) => {
    whatsappReady = false;
    console.warn('WhatsApp disconnected:', reason);
});

client.on('message_create', async (message) => {
    const targetChatId = message.fromMe ? message.to : message.from;
    const text = message.body.trim();

    // 1. Check if the user is currently in the middle of adding a report
    if (chatStates[targetChatId]) {
        await handleAddReportConversation(targetChatId, text);
        return; // Don't process other commands while in setup flow
    }

    // 2. Handle generic commands
    
    // Command: !addreport
    if (text === '!addreport') {
        chatStates[targetChatId] = { state: 'AWAITING_URL', tempReport: {} };
        await client.sendMessage(targetChatId, 'Let\'s add a new report!\n\nPlease reply with the **URL** for the report dashboard.');
        return;
    }

    // Command: !listreports
    if (text === '!listreports') {
        const reports = db.getReportsForChat(targetChatId);
        if (reports.length === 0) {
            await client.sendMessage(targetChatId, 'There are no reports configured for this chat. Use `!addreport` to add one.');
        } else {
            let msg = '*Configured Reports:*\n\n';
            reports.forEach(r => {
                msg += `- *${r.name}*\n  URL: ${r.url}\n  Schedule: ${r.schedule}\n\n`;
            });
            await client.sendMessage(targetChatId, msg);
        }
        return;
    }

    // Command: !chatid (Utility for Looker Integration)
    if (text === '!chatid') {
        await client.sendMessage(targetChatId, `Your WhatsApp Chat ID is:\n\n*${targetChatId}*\n\nUse this ID when scheduling reports in Looker.`);
        return;
    }

    // Command: !removereport [name]
    if (text.startsWith('!removereport ')) {
        const reportName = text.replace('!removereport ', '').trim();
        const success = db.removeReportFromChat(targetChatId, reportName);
        if (success) {
            scheduler.cancelScheduledReport(targetChatId, reportName);
            await client.sendMessage(targetChatId, `Successfully deleted report: *${reportName}*`);
        } else {
            await client.sendMessage(targetChatId, `Could not find a report named *${reportName}*.`);
        }
        return;
    }

    // Command: !auth [name] (Send magic link for authentication)
    if (text.startsWith('!auth ')) {
        const reportName = text.replace('!auth ', '').trim();
        const reports = db.getReportsForChat(targetChatId);
        const report = reports.find(r => r.name.toLowerCase() === reportName.toLowerCase());

        if (!report) {
            await client.sendMessage(targetChatId, `Could not find a report named *${reportName}*. Use \`!listreports\` to see available reports.`);
            return;
        }

        // Generate the magic link
        if (process.env.ENABLE_COOKIE_AUTH_PORTAL !== 'true') {
            await client.sendMessage(targetChatId, 'Cookie-based authentication is disabled. Use the user-controlled login procedure described in the deployment guide.');
            return;
        }
        const serverIp = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
        const magicLink = `${serverIp}/login?chatId=${encodeURIComponent(targetChatId)}&url=${encodeURIComponent(report.url)}`;
        
        await client.sendMessage(targetChatId, `🔐 *Authentication Required*\n\nPlease log in to authenticate the *${report.name}* dashboard.\n\nClick the secure link below to enter your credentials:\n${magicLink}`);
        return;
    }

    // Command: !report [name] (On-Demand screenshot)
    if (text.startsWith('!report ')) {
        const reportName = text.replace('!report ', '').trim();
        const reports = db.getReportsForChat(targetChatId);
        const report = reports.find(r => r.name.toLowerCase() === reportName.toLowerCase());

        if (!report) {
            await client.sendMessage(targetChatId, `Could not find a report named *${reportName}*. Use \`!listreports\` to see available reports.`);
            return;
        }

        try {
            console.log(`Received on-demand request for ${report.name} in chat: ${targetChatId}`);
            await client.sendMessage(targetChatId, `Loading report *${report.name}*... This may take a few seconds.`);
            
            // Pass the targetChatId to captureScreenshot so it uses the correct isolated browser profile
            const imageBuffer = await captureScreenshot(report.url, targetChatId);
            const media = new MessageMedia('image/png', imageBuffer.toString('base64'), `${report.name}.png`);
            
            await client.sendMessage(targetChatId, media, { caption: `Here is your requested report: *${report.name}*` });
        } catch (error) {
            console.error('Failed to send report:', error);
            await client.sendMessage(targetChatId, `Sorry, I encountered an error while trying to fetch the report *${report.name}*.`);
        }
        return;
    }
});

// Helper function to handle the conversational flow for adding a report
async function handleAddReportConversation(chatId, text) {
    // Prevent infinite loop when testing from the bot's own phone
    const botPrompts = [
        "Let's add a new report!\n\nPlease reply with the **URL** for the report dashboard.",
        "That does not look like a valid URL. Please reply with a valid URL starting with http:// or https:// (or type `cancel` to quit).",
        'Great! Now, please reply with a short **Name** for this report (e.g., "Daily Sales" or "Marketing Dashboard").',
        "Got it. When should I send this report automatically?\n\nReply with a number:\n*1* = Daily at 9:00 AM\n*2* = Daily at 5:00 PM\n*3* = No schedule (On-Demand only)\n\n*(Type `cancel` to abort)*",
        "Report setup cancelled."
    ];
    
    if (botPrompts.includes(text)) {
        return; // Ignore the bot's own automated messages
    }

    const currentState = chatStates[chatId].state;

    // Provide a way out if they get stuck
    if (text.toLowerCase() === 'cancel') {
        delete chatStates[chatId];
        await client.sendMessage(chatId, 'Report setup cancelled.');
        return;
    }

    if (currentState === 'AWAITING_URL') {
        if (!text.startsWith('http')) {
            await client.sendMessage(chatId, 'That does not look like a valid URL. Please reply with a valid URL starting with http:// or https:// (or type `cancel` to quit).');
            return;
        }
        chatStates[chatId].tempReport.url = text;
        chatStates[chatId].state = 'AWAITING_NAME';
        await client.sendMessage(chatId, 'Great! Now, please reply with a short **Name** for this report (e.g., "Daily Sales" or "Marketing Dashboard").');
        
    } else if (currentState === 'AWAITING_NAME') {
        chatStates[chatId].tempReport.name = text;
        chatStates[chatId].state = 'AWAITING_SCHEDULE';
        
        const scheduleMsg = `Got it. When should I send this report automatically?\n\nReply with a number:\n*1* = Daily at 9:00 AM\n*2* = Daily at 5:00 PM\n*3* = No schedule (On-Demand only)\n\n*(Type \`cancel\` to abort)*`;
        await client.sendMessage(chatId, scheduleMsg);

    } else if (currentState === 'AWAITING_SCHEDULE') {
        if (!['1', '2', '3'].includes(text)) {
            await client.sendMessage(chatId, 'Invalid choice. Please reply with 1, 2, or 3.');
            return;
        }

        const tempReport = chatStates[chatId].tempReport;
        
        // Save to database
        const savedReport = db.addReportToChat(chatId, tempReport.name, tempReport.url, text);
        
        // Add to dynamic scheduler
        scheduler.scheduleReport(client, chatId, savedReport);

        // Clear conversational state
        delete chatStates[chatId];

        await client.sendMessage(chatId, `🎉 Success! The report *${savedReport.name}* has been configured and scheduled.\n\nYou can use \`!report ${savedReport.name}\` to request it manually anytime.`);
    }
}

// Start the client
console.log('Starting WhatsApp client...');
client.initialize().catch(error => {
    console.error('WhatsApp client failed to initialize:', error);
    process.exitCode = 1;
});

async function shutdown(signal) {
    console.log(`Received ${signal}; shutting down.`);
    whatsappReady = false;
    await client.destroy().catch(() => {});
    if (remoteStore) await remoteStore.close().catch(() => {});
    process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
