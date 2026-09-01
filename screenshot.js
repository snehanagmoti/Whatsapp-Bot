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
    // Spoof a normal desktop User-Agent to bypass basic Cloudflare/WAF bot detection (ERR_CONNECTION_RESET)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
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

/**
 * Headless session injection function used by the Credential Web Portal.
 * Parses the provided JSON cookies and injects them directly into the browser session.
 */
async function authenticateSession(url, chatId, cookieString) {
    console.log(`Starting headless session injection for: ${url} (Profile: ${chatId})`);
    
    let parsedCookies;
    try {
        parsedCookies = JSON.parse(cookieString);
        if (!Array.isArray(parsedCookies)) {
            throw new Error("Cookies must be a JSON array.");
        }
    } catch (e) {
        throw new Error("Invalid cookie JSON format.");
    }

    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir: `./user_data_profiles/${chatId}`, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    // Spoof a normal desktop User-Agent to bypass basic Cloudflare/WAF bot detection (ERR_CONNECTION_RESET)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log('Injecting cookies into browser session...');
        await page.setCookie(...parsedCookies);
        
        console.log('Navigating to verify session (Fail-safe)...');
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: process.env.PUPPETEER_TIMEOUT || 60000 });
        } catch (navError) {
            console.log(`Navigation error during verification (common for Cloudflare), but cookies are injected. Proceeding. Error: ${navError.message}`);
        }
        
        console.log('Cookie injection successful! Session saved.');
    } catch (error) {
        console.error('Error during headless cookie injection:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

module.exports = {
    captureScreenshot,
    authenticateSession
};
