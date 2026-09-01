# WhatsApp Screenshot Bot: Usage Guide

This guide explains how to run, configure, and authenticate your WhatsApp bot.

## 1. Starting the Bot
To start the bot, run the following command in your terminal:
```bash
node index.js
```
*   **First time run:** A QR code will appear in the terminal. Open WhatsApp on the phone you want to use as the bot, go to Linked Devices, and scan the QR code.
*   **Subsequent runs:** The session is saved in `.wwebjs_auth/`. The bot will automatically log in.

## 2. Setting up Reports (Conversational Flow)
Open a WhatsApp chat with the bot (or add the bot to a Group Chat). Type the following commands:

*   `!addreport` - Starts the setup wizard. The bot will ask you for:
    1.  The URL of the dashboard.
    2.  A short name for the report (e.g., `Sales`).
    3.  A schedule option (Daily at 9 AM, Daily at 5 PM, or On-Demand).
*   `!listreports` - Shows all reports configured for this specific chat.
*   `!removereport [name]` - Deletes a report and cancels its schedule.
*   `!report [name]` - Forces the bot to take a screenshot and send it immediately.

## 3. Authenticating Private Dashboards (Cookie Injection)
For private dashboards that have complex logins (like Google, 2FA, or CAPTCHAs), we use a highly reliable Cookie Injection method. This allows you to solve the login challenges yourself, and seamlessly pass the authenticated session to the bot.

**Step-by-step:**
1.  On your computer's browser, install a cookie export extension (e.g., **EditThisCookie** for Chrome).
2.  Log into your dashboard normally (e.g., log into Google, solve the CAPTCHAs, do the 2FA).
3.  Click the "EditThisCookie" extension icon and click the "Export" button. This copies your session cookies to your clipboard.
4.  Type `!auth [reportName]` in your WhatsApp chat (e.g., `!auth Sales`).
5.  The bot will reply with a secure Magic Link. Click it to open the Credential Web Portal.
6.  Paste the cookies you copied into the text box and click "Inject Session Securely".
7.  The bot will invisibly load your cookies in the background and permanently save your session.
8.  You will receive a WhatsApp message confirming success! You can now type `!report [name]` and the bot will capture your dashboard using your exact session.

## Troubleshooting
*   **Infinite Loop / Bot talking to itself:** If you type `!addreport` from the exact same phone that is hosting the bot, and the bot gets stuck looping, type `cancel` to abort the state. (Note: A patch has been applied to prevent this, but `cancel` is always the manual override).
*   **Missing Data:** If the screenshot shows a loading spinner, the BI tool is rendering too slowly. You will need to edit `screenshot.js` and add an artificial delay before `page.screenshot()`.
