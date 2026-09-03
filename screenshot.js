const puppeteer = require('puppeteer');
const path = require('path');
const { isValidWhatsAppChatId } = require('./validation');
require('dotenv').config();

const dataDir = path.resolve(process.env.DATA_DIR || __dirname);

function getProfilePath(chatId) {
    if (!isValidWhatsAppChatId(chatId)) throw new Error('Invalid WhatsApp chat ID.');
    return path.join(dataDir, 'user_data_profiles', chatId);
}

function validateDashboardUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid dashboard URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Dashboard URL must use HTTP(S) and must not contain credentials.');
    }
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blocked.includes(url.hostname.toLowerCase()) && process.env.ALLOW_PRIVATE_NETWORKS !== 'true') {
        throw new Error('Local or private dashboard URLs are disabled.');
    }
    return url.toString();
}

/**
 * Launches Puppeteer, navigates to the URL, and captures a screenshot.
 * Uses a unique user_data folder per chatId to maintain separate authenticated sessions.
 * @param {string} url - The URL to capture.
 * @param {string} chatId - The ID of the WhatsApp chat to scope the browser profile.
 * @returns {Buffer} - The screenshot image buffer.
 */
async function captureScreenshot(url, chatId) {
    url = validateDashboardUrl(url);
    console.log(`Starting screenshot capture for: ${url} (Profile: ${chatId})`);
    
    // Launch a headless browser instance with an isolated profile directory
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir: getProfilePath(chatId),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();
    // Spoof a normal desktop User-Agent to bypass basic Cloudflare/WAF bot detection (ERR_CONNECTION_RESET)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
    });
    
    // Set a phone-like viewport to make the dashboard more readable on mobile
    await page.setViewport({ width: 600, height: 1200, deviceScaleFactor: 2 });

    try {
        console.log('Navigating to page...');
        // Go to URL and wait until there are no more than 2 network connections for at least 500 ms.
        // This helps ensure charts and data are fully loaded.
        await page.goto(url, { waitUntil: 'networkidle2', timeout: Number(process.env.PUPPETEER_TIMEOUT) || 60000 });
        
        // Looker-Specific Waiting Logic (Option B Implementation)
        if (url.toLowerCase().includes('looker')) {
            console.log('Looker URL detected. Applying Looker-specific wait conditions...');
            // Wait an additional 8 seconds to allow Looker's internal JS to render the Canvas/SVG charts
            await new Promise(r => setTimeout(r, 8000));
            
            // Optionally wait for Looker specific selectors to ensure it's not a loading screen
            try {
                // Wait for either the dashboard layout or explore layout to be present
                await page.waitForSelector('.lk-dashboard-layout, .explore-container, .vis-container', { timeout: 10000 });
                console.log('Looker specific elements detected.');
                // Another small buffer after the DOM elements appear for final chart paint
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.log('Could not find standard Looker selectors, but proceeding with screenshot anyway.');
            }
        }

        
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
    url = validateDashboardUrl(url);
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
        userDataDir: getProfilePath(chatId),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();
    // Spoof a normal desktop User-Agent to bypass basic Cloudflare/WAF bot detection (ERR_CONNECTION_RESET)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
    });
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log('Injecting cookies into browser session...');
        await page.setCookie(...parsedCookies);
        
        console.log('Navigating to verify session (Fail-safe)...');
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: Number(process.env.PUPPETEER_TIMEOUT) || 60000 });
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
    authenticateSession,
    validateDashboardUrl
};
