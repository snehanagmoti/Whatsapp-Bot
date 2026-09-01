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
*(In simple terms: You set up everything by chatting with the bot, no coding required!)*

Forget manually editing configuration files or writing complex server code. The bot features an interactive chat menu. By simply sending the message `!addreport` to the bot on WhatsApp, you are guided through a step-by-step wizard. You just reply to the bot to tell it what URL to capture, what to name the report, and when you want it delivered. The bot saves all of this dynamically.

### 2. Strict Tenant Isolation (Multi-Profile Architecture)
*(In simple terms: Every user and group chat gets its own private, isolated web browser.)*

To securely support multiple different teams or friends using the bot for private dashboards, the bot completely isolates browser sessions. 
*   **The Architecture:** The bot uses the unique WhatsApp Phone Number or Group ID (the `chatId`) to create separate physical folders on the server (e.g., `./user_data_profiles/TeamA_ID/`). 
*   **The Benefit:** Zero cross-contamination. Team A's logged-in sessions and cookies are strictly locked away from Team B. A user can never accidentally capture a screenshot of another user's private dashboard, ensuring absolute privacy.

### 3. Hot-Swappable Background Scheduler
*(In simple terms: The bot updates its alarm clock instantly without needing to be restarted.)*

The background scheduling engine utilizes in-memory tracking. This means that the moment a user types `!addreport` to schedule a 9:00 AM daily alert, or `!removereport` to cancel one, the bot instantly spins up or tears down that specific background job. It requires zero downtime or server restarts to apply schedule changes.

### 4. Bypassing Security Walls via Cookie Injection
*(In simple terms: We skip login screens completely to avoid CAPTCHAs and 2FA.)*

Getting an automated bot to log into a website is notoriously difficult because of modern Security Walls (like Cloudflare) and Two-Factor Authentication (2FA). To solve this, the bot hosts a lightweight, secure Web Portal.
*   **The Flow:** When a user types `!auth`, they receive a secure Magic Link. The user logs into the dashboard on their own personal computer, copies their "Session Cookies" (the digital proof that they are logged in), and pastes them into the bot's Web Portal.
*   **The Result:** The bot's headless browser directly absorbs this proof of login. It completely bypasses all CAPTCHAs, multi-step logins, and security challenges because the website believes the bot is already authenticated!

### 5. Future Integration: Bot Service Account
For massive company-wide dashboards where everyone shares the same view, a centralized flow is planned. Rather than individual users injecting cookies, the bot will act as a dedicated "Robot Employee" (e.g., `reporter@company.com`). The bot's server will hold the master password and automatically log in to take screenshots for everyone, requiring zero user intervention.

## How It Works (Code Flow)

If you are a developer looking to understand how the codebase is structured, here is a quick breakdown of the main files and how they interact:

1. **`index.js` (The Brain):** This is the main entry point. It boots up the WhatsApp client, listens for incoming messages, and handles all the conversational logic (the `!addreport`, `!report`, and `!auth` commands).
2. **`screenshot.js` (The Engine):** This file controls the headless Chrome browser using Puppeteer. It is responsible for injecting the saved cookies, navigating to the target URLs, taking the screenshot, and returning the image back to WhatsApp.
3. **`server.js` (The Web Portal):** This runs a lightweight Express.js web server. It listens for users clicking their Magic Links and accepts the pasted cookies to pass them securely into the backend.
4. **`scheduler.js` (The Alarm Clock):** This module uses `node-cron` to manage all the background jobs. When a report is scheduled for 9:00 AM, this file makes sure the screenshot engine is triggered at exactly that time.
5. **`db.js` (The Memory):** A simple JSON-based database manager that reads and writes your configured reports to `database.json`, ensuring your settings survive a server restart.

## Official vs. Unofficial WhatsApp Integration

The current architecture utilizes `whatsapp-web.js`, which acts as an unofficial client mimicking WhatsApp Web. 

If this bot is ever migrated to the **Official Meta WhatsApp Business API**, the core engine (Puppeteer, Database, Scheduler) remains identical, but the messaging transport layer must be swapped for Meta's REST API/Webhooks. 

However, there are significant limitations for this specific screenshot use-case if migrating to the Official API:
1. **The 24-Hour Rule:** The Official API prohibits sending free-form messages if the user hasn't messaged the bot in the last 24 hours. This completely breaks "Daily Scheduled Reports" (e.g., a Monday morning report would fail if the user didn't talk to the bot on Sunday). Bypassing this requires paid, pre-approved "Template Messages" which are strict about dynamic imagery.
2. **Group Chats Blocked:** Official bots cannot be added to standard WhatsApp group chats. They are strictly designed for 1-on-1 B2C communication, breaking the ability for internal teams to share a dashboard in a shared group chat.
3. **Cost:** The Official API charges per conversation, making daily internal alerts significantly more expensive compared to the free unofficial integration.

## Data Storage
The bot uses a lightweight, local `database.json` file managed by `db.js`. It maps `chatId` to an array of configured reports. This fulfills prototype requirements without the overhead of a PostgreSQL instance.
