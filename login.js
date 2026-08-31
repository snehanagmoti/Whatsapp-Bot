const puppeteer = require('puppeteer');

const args = process.argv.slice(2);
const chatId = args[0];
const url = args[1];

if (!chatId || !url) {
    console.error('Usage: node login.js <ChatID> <URL>');
    console.error('Example: node login.js 1234567890@c.us https://leetcode.com/login');
    process.exit(1);
}

(async () => {
    console.log(`Launching manual login browser for Profile: ${chatId}`);
    console.log(`Navigating to: ${url}`);

    const browser = await puppeteer.launch({
        headless: false, // VISIBLE mode for manual login
        userDataDir: `./user_data_profiles/${chatId}`,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Set a normal desktop viewport
    await page.setViewport({ width: 1280, height: 800 });
    
    await page.goto(url, { waitUntil: 'networkidle2' });

    console.log('\n======================================================');
    console.log('BROWSER OPENED!');
    console.log('Please log in manually inside the Chrome window.');
    console.log('Once you have successfully logged in and the dashboard loads,');
    console.log('close the Chrome window to save the session permanently.');
    console.log('======================================================\n');

    // Wait until the user manually closes the browser
    browser.on('disconnected', () => {
        console.log('Browser closed. Session saved successfully for this chat profile!');
        process.exit(0);
    });
})();
