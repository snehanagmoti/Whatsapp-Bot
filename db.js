const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Initialize database if it doesn't exist
function initDb() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ chats: {} }, null, 2));
    }
}

// Read the entire database
function readDb() {
    initDb();
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
}

// Write to the database
function writeDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Get all reports for a specific chat
function getReportsForChat(chatId) {
    const db = readDb();
    if (!db.chats[chatId]) {
        return [];
    }
    return db.chats[chatId].reports || [];
}

// Add a report to a specific chat
function addReportToChat(chatId, reportName, reportUrl, scheduleOption) {
    const db = readDb();
    
    if (!db.chats[chatId]) {
        db.chats[chatId] = { reports: [] };
    }
    
    if (!db.chats[chatId].reports) {
         db.chats[chatId].reports = [];
    }

    // Convert simple schedule options to cron expressions
    let cronExpression = '';
    if (scheduleOption === '1') cronExpression = '0 9 * * *'; // Daily 9am
    else if (scheduleOption === '2') cronExpression = '0 17 * * *'; // Daily 5pm
    else cronExpression = 'none'; // On-Demand

    db.chats[chatId].reports.push({
        name: reportName,
        url: reportUrl,
        schedule: cronExpression
    });

    writeDb(db);
    return { name: reportName, url: reportUrl, schedule: cronExpression };
}

// Remove a report from a specific chat
function removeReportFromChat(chatId, reportName) {
    const db = readDb();
    
    if (!db.chats[chatId] || !db.chats[chatId].reports) {
        return false; // Chat or reports don't exist
    }

    const initialLength = db.chats[chatId].reports.length;
    db.chats[chatId].reports = db.chats[chatId].reports.filter(r => r.name.toLowerCase() !== reportName.toLowerCase());
    
    if (db.chats[chatId].reports.length < initialLength) {
        writeDb(db);
        return true;
    }
    return false;
}

module.exports = {
    readDb,
    getReportsForChat,
    addReportToChat,
    removeReportFromChat
};
