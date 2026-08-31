const puppeteer = require('puppeteer');
require('dotenv').config();

/**
 * Launches Puppeteer, navigates to the URL, and captures a screenshot.
 * Uses a unique user_data folder per chatId to maintain separate authenticated sessions.
 * @param {string} url - The URL to capture.
 * @param {string} chatId - The ID of the WhatsApp chat to scope the browser profile.
 * @returns {Buffer} - The screenshot image buffer.
 */
async function captureScreenshot(url, chatId) {
    console.log(`Starting screenshot capture for: ${url} (Profile: ${chatId})`);
    
    // Launch a headless browser instance with an isolated profile directory
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir: `./user_data_profiles/${chatId}`, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Set a phone-like viewport to make the dashboard more readable on mobile
    await page.setViewport({ width: 600, height: 1200, deviceScaleFactor: 2 });

    try {
        console.log('Navigating to page...');
        // Go to URL and wait until there are no more than 2 network connections for at least 500 ms.
        // This helps ensure charts and data are fully loaded.
        await page.goto(url, { waitUntil: 'networkidle2', timeout: process.env.PUPPETEER_TIMEOUT || 60000 });
        
        // Additional explicit wait for a common selector can be added here if needed
        // await page.waitForSelector('.dashboard-loaded-marker', { timeout: 10000 });
        
        console.log('Taking screenshot...');
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        
        console.log('Screenshot captured successfully.');
        return screenshotBuffer;
    } catch (error) {
        console.error('Error capturing screenshot:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

module.exports = {
    captureScreenshot
};
