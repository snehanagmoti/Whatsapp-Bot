# WhatsApp Screenshot Bot: Implementation Plan

## Architecture Overview
This project is an automated WhatsApp bot designed to fetch and distribute authenticated reporting dashboards (like Looker, Metabase, and personal accounts) via scheduled and on-demand screenshots.

### Tech Stack
*   **Node.js**: Backend runtime.
*   **whatsapp-web.js**: Interacts with the WhatsApp Web API to send/receive messages without requiring Official Meta Business templates or costs.
*   **Puppeteer**: A headless Chrome browser used to navigate to URLs, render JavaScript dashboards, and capture screenshot buffers.
*   **node-cron**: Handles background scheduling of daily reports.

## Core Features Implemented

### 1. Conversational UI & Dynamic Provisioning
Forget manually editing `.env` files or hardcoding Cron expressions. The bot features an interactive state machine that allows users to seamlessly provision new dashboards directly through WhatsApp. By sending `!addreport`, users are guided through a simple chat wizard to define the target URL, report name, and delivery schedule.

### 2. Strict Tenant Isolation (Multi-Profile Architecture)
To securely support multiple users and teams querying private platforms (e.g., LeetCode, Looker, Metabase), the bot completely isolates browser sessions.
*   **The Architecture:** Puppeteer dynamically routes physical browser data to isolated directories based on the WhatsApp `chatId` (e.g., `./user_data_profiles/TeamA_ID/`). 
*   **The Benefit:** Zero cross-contamination. Team A's cookies, cache, and active sessions are strictly sandboxed from Team B. A user can never accidentally capture a screenshot of another user's private dashboard.

### 3. Hot-Swappable Background Scheduler
The scheduling engine (`scheduler.js`) utilizes in-memory `node-cron` tracking bound to specific `chatId_reportName` keys. This allows the bot to instantly spin up, modify, or tear down background jobs the moment a user types `!addreport` or `!removereport`, requiring zero downtime or server restarts.

### 4. Bypassing WAFs via Cookie Injection (Web Portal)
Authenticating headless browsers against modern Web Application Firewalls (Cloudflare) and 2FA is notoriously brittle. To solve this, the bot hosts a lightweight, secure Express.js Web Portal.
*   **The Flow:** When a user types `!auth`, they receive a Magic Link. They export their live session cookies from their own desktop browser and securely inject them into the portal.
*   **The Result:** The bot's headless Puppeteer engine directly absorbs the user's validated session, completely bypassing all CAPTCHAs, multi-step logins, and Cloudflare challenges.

### 5. Future Integration: Bot Service Account
For enterprise environments sharing a single global dashboard, a centralized authentication flow is planned. Rather than user-controlled cookie injection, the bot will act as a dedicated read-only service account (e.g., `reporter@company.com`). Global credentials will be securely injected from the `.env` file upon detecting a login screen, requiring zero user intervention.

## Official vs. Unofficial WhatsApp Integration

The current architecture utilizes `whatsapp-web.js`, which acts as an unofficial client mimicking WhatsApp Web. 

If this bot is ever migrated to the **Official Meta WhatsApp Business API**, the core engine (Puppeteer, Database, Scheduler) remains identical, but the messaging transport layer must be swapped for Meta's REST API/Webhooks. 

However, there are significant limitations for this specific screenshot use-case if migrating to the Official API:
1. **The 24-Hour Rule:** The Official API prohibits sending free-form messages if the user hasn't messaged the bot in the last 24 hours. This completely breaks "Daily Scheduled Reports" (e.g., a Monday morning report would fail if the user didn't talk to the bot on Sunday). Bypassing this requires paid, pre-approved "Template Messages" which are strict about dynamic imagery.
2. **Group Chats Blocked:** Official bots cannot be added to standard WhatsApp group chats. They are strictly designed for 1-on-1 B2C communication, breaking the ability for internal teams to share a dashboard in a shared group chat.
3. **Cost:** The Official API charges per conversation, making daily internal alerts significantly more expensive compared to the free unofficial integration.

## Data Storage
The bot uses a lightweight, local `database.json` file managed by `db.js`. It maps `chatId` to an array of configured reports. This fulfills prototype requirements without the overhead of a PostgreSQL instance.
