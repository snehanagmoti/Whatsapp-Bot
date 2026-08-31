# Risks, Limitations, and Mitigation Strategies

While this bot architecture is highly capable, utilizing reverse-engineered APIs (`whatsapp-web.js`) and headless browsers (`Puppeteer`) introduces several risks.

## 1. WhatsApp Account Bans
**Risk:** Meta strictly prohibits automated bots on standard personal or standard business WhatsApp accounts. Sending hundreds of automated messages, especially to users who have not saved the bot's number, can trigger spam algorithms resulting in a permanent phone number ban.
**Mitigation:** 
*   Use a dedicated phone number (do not use your personal primary number).
*   Limit outbound messages to groups where the bot is invited, rather than cold DM-ing users.
*   If volume becomes enterprise-scale, migrate from `whatsapp-web.js` to the Official Meta Cloud API (though this loses the ability to join generic groups easily).

## 2. Puppeteer & Authentication Roadblocks (CAPTCHAs & 2FA)
**Risk:** Major providers (Google, Microsoft) can detect automated browsers and may randomly throw CAPTCHAs or block logins. Furthermore, Multi-Factor Authentication (OTP codes) prevents the bot from logging in automatically.
**Mitigation:**
*   **The Service Account Model**: Never have the bot ask for passwords over chat. Instead, create a generic `reports-bot@company.com` account.
*   **Manual Login Script**: Use the included `login.js` script to manually open the browser, type the password, click the CAPTCHA, and save the session cookies permanently. 
*   **Long-Lived Sessions**: Ensure the dashboards being scraped have long-lived session timeouts (e.g., 90 days) so the admin rarely has to re-authenticate.

## 3. Asynchronous Dashboard Rendering
**Risk:** BI tools (Looker, Metabase, Tableau) load the webpage instantly but take 5-10 seconds to fetch data. Puppeteer might capture a screenshot of "loading spinners."
**Mitigation:**
*   Add a hardcoded `await new Promise(r => setTimeout(r, 5000));` delay before taking the screenshot in `screenshot.js`.
*   Alternatively, use `page.waitForSelector('.chart-loaded')` to dynamically wait for the specific dashboard element to render.

## 4. PDFs vs Screenshots
**Risk:** The initial concept was to download PDFs, but generating authentic PDFs of dynamic, authenticated dashboards via headless Chrome often strips CSS, requires massive compute power, and breaks authentication states during the print-to-pdf conversion.
**Mitigation:**
*   We exclusively rely on high-resolution `.png` screenshots. This perfectly mimics what a human sees on their monitor, guarantees CSS preservation, and works flawlessly with the existing auth cookies.
