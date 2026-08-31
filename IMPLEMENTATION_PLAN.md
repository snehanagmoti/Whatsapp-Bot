# WhatsApp Screenshot Bot: Implementation Plan

## Architecture Overview
This project is an automated WhatsApp bot designed to fetch and distribute authenticated reporting dashboards (like Looker, Metabase, and personal accounts) via scheduled and on-demand screenshots.

### Tech Stack
*   **Node.js**: Backend runtime.
*   **whatsapp-web.js**: Interacts with the WhatsApp Web API to send/receive messages without requiring Official Meta Business templates or costs.
*   **Puppeteer**: A headless Chrome browser used to navigate to URLs, render JavaScript dashboards, and capture screenshot buffers.
*   **node-cron**: Handles background scheduling of daily reports.

## Core Features Implemented

### 1. Conversational State Machine
Rather than relying on static `.env` configurations, the bot uses a conversational interface. Users can type `!addreport` to interactively set up a URL, a display name, and select a daily schedule (e.g., 9 AM, 5 PM, or On-Demand).

### 2. Multi-Profile Browser Architecture (Tenant Isolation)
A major architectural challenge is handling multiple teams or users wanting private screenshots of the same underlying website (e.g., LeetCode).
*   **Solution**: The bot uses dynamic `userDataDir` paths mapped to the WhatsApp `chatId`. 
*   **Result**: When Group A asks for a report, Puppeteer launches using `./user_data_profiles/GroupA_ID/`. When User B asks for a report, it uses `./user_data_profiles/UserB_ID/`. Cookies, sessions, and cache are strictly isolated. User A cannot see User B's private dashboards.

### 3. Dynamic Scheduler
Schedules are not hardcoded at boot. The `scheduler.js` module tracks active `node-cron` jobs in memory by `chatId_reportName`. When a user adds or deletes a report via chat, the scheduler instantly starts or stops the background job without requiring a server restart.

### 4. Admin Authentication Utility
Because turning off headless mode on a production server disrupts the bot, a standalone `login.js` script was created. The bot admin can run `node login.js [chatId] [URL]` to spawn a physical browser explicitly tied to that chat's isolated folder, allowing the admin to manually bypass 2FA and CAPTCHAs and permanently save the session for that team.

## Data Storage
The bot uses a lightweight, local `database.json` file managed by `db.js`. It maps `chatId` to an array of configured reports. This fulfills prototype requirements without the overhead of a PostgreSQL instance.
