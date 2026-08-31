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

## 3. Authenticating Private Dashboards (Admin Only)
If a user adds a URL that requires a login (like Looker, LeetCode, or a company portal), the bot will just send a screenshot of the login screen. You (the Admin) must log the bot in manually.

Because the bot uses isolated profiles per-chat, you must log in specifically for the chat that requested the report.

**Step-by-step:**
1.  Ask the user to type `!chatid` in their WhatsApp chat. They will get an ID (e.g., `12345678@c.us`).
2.  Leave `node index.js` running. Open a *new* terminal window.
3.  Run the standalone admin login script:
    ```bash
    node login.js 12345678@c.us https://company.com/login
    ```
4.  A physical Chrome window will pop up.
5.  Type in the username, password, and pass any 2FA/CAPTCHAs.
6.  Once you see the dashboard load successfully, simply close the Chrome window!
7.  The session is now permanently saved. The user can type `!report [name]` again and the bot will bypass the login screen.

## Troubleshooting
*   **Infinite Loop / Bot talking to itself:** If you type `!addreport` from the exact same phone that is hosting the bot, and the bot gets stuck looping, type `cancel` to abort the state. (Note: A patch has been applied to prevent this, but `cancel` is always the manual override).
*   **Missing Data:** If the screenshot shows a loading spinner, the BI tool is rendering too slowly. You will need to edit `screenshot.js` and add an artificial delay before `page.screenshot()`.
