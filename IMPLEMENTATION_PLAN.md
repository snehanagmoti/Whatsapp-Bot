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

### 4. Credential Web Portal Authentication (Implemented via Cookie Injection)
For private dashboards with complex logins (CAPTCHAs, 2FA, Cloudflare), the intended flow is fully user-controlled via a secure web portal hosted by the bot. When a user requests authentication via the `!auth [name]` command, the bot generates a unique Magic Link. The user opens this link and pastes their session cookies (exported from their desktop browser). The bot uses a headless Puppeteer instance on the backend to automatically inject these cookies and permanently save the authenticated session for that specific chat profile, completely bypassing login screens.

### 5. Alternative Plan: Bot Service Account (Future Integration)
For company-wide shared dashboards, an alternative authentication architecture is planned. Instead of user-controlled logins, the bot will act as a dedicated read-only service account (e.g., `screenshot-bot@company.com`). 
* **How it will work:** Global credentials will be securely stored in the `.env` file. Puppeteer will automatically detect login screens and inject these global credentials seamlessly without any user intervention or web portals.

## Official vs. Unofficial WhatsApp Integration

The current architecture utilizes `whatsapp-web.js`, which acts as an unofficial client mimicking WhatsApp Web. 

If this bot is ever migrated to the **Official Meta WhatsApp Business API**, the core engine (Puppeteer, Database, Scheduler) remains identical, but the messaging transport layer must be swapped for Meta's REST API/Webhooks. 

However, there are significant limitations for this specific screenshot use-case if migrating to the Official API:
1. **The 24-Hour Rule:** The Official API prohibits sending free-form messages if the user hasn't messaged the bot in the last 24 hours. This completely breaks "Daily Scheduled Reports" (e.g., a Monday morning report would fail if the user didn't talk to the bot on Sunday). Bypassing this requires paid, pre-approved "Template Messages" which are strict about dynamic imagery.
2. **Group Chats Blocked:** Official bots cannot be added to standard WhatsApp group chats. They are strictly designed for 1-on-1 B2C communication, breaking the ability for internal teams to share a dashboard in a shared group chat.
3. **Cost:** The Official API charges per conversation, making daily internal alerts significantly more expensive compared to the free unofficial integration.

## Data Storage
The bot uses a lightweight, local `database.json` file managed by `db.js`. It maps `chatId` to an array of configured reports. This fulfills prototype requirements without the overhead of a PostgreSQL instance.
