const cron = require('node-cron');
const { readDb } = require('./db');

// Track all active jobs so we can stop/restart them dynamically
const activeJobs = {};

/**
 * Creates a unique string ID for a scheduled job based on chat ID and report name
 */
function getJobId(chatId, reportName) {
    return `${chatId}_${reportName.toLowerCase()}`;
}

/**
 * Schedules a single report
 * @param {object} client - The WhatsApp client instance
 * @param {string} chatId - The ID of the chat to send to
 * @param {object} report - The report object containing name, url, schedule
 */
function scheduleReport(client, chatId, report) {
    if (report.schedule === 'none') {
        return; // This report is on-demand only
    }

    const jobId = getJobId(chatId, report.name);

    // If the job already exists, stop it first before recreating it
    if (activeJobs[jobId]) {
        activeJobs[jobId].stop();
    }

    console.log(`Scheduling job [${jobId}] for schedule: ${report.schedule}`);
    
    activeJobs[jobId] = cron.schedule(report.schedule, async () => {
        console.log(`[CRON Triggered] Running scheduled report: ${report.name} for chat ${chatId}`);
        try {
            const { captureScreenshot } = require('./screenshot');
            // Pass the chatId to captureScreenshot so it uses the correct isolated browser profile
            const imageBuffer = await captureScreenshot(report.url, chatId);
            const media = { mimetype: 'image/png', data: imageBuffer.toString('base64'), filename: `${report.name}.png` };
            
            await client.sendMessage(chatId, media, { caption: `Here is your scheduled automated report: ${report.name}` });
            console.log(`Scheduled report ${report.name} sent to ${chatId}.`);
        } catch (error) {
            console.error(`Failed to send scheduled report ${report.name}:`, error);
        }
    });
}

/**
 * Cancels a specific scheduled report
 */
function cancelScheduledReport(chatId, reportName) {
    const jobId = getJobId(chatId, reportName);
    if (activeJobs[jobId]) {
        activeJobs[jobId].stop();
        delete activeJobs[jobId];
        console.log(`Cancelled scheduled job [${jobId}]`);
    }
}

/**
 * Reads the database and schedules all reports on boot
 */
function bootScheduler(client) {
    console.log('Booting dynamic scheduler from database...');
    const db = readDb();
    
    for (const [chatId, chatData] of Object.entries(db.chats)) {
        if (chatData.reports && chatData.reports.length > 0) {
            for (const report of chatData.reports) {
                scheduleReport(client, chatId, report);
            }
        }
    }
}

module.exports = {
    scheduleReport,
    cancelScheduledReport,
    bootScheduler
};
