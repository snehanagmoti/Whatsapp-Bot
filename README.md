# WhatsApp Screenshot & Reporting Bot

An automated, multi-tenant WhatsApp bot built with Node.js, `whatsapp-web.js`, and Puppeteer. It allows teams to dynamically schedule and request on-demand screenshots of authenticated BI dashboards (Looker, Metabase) and private web portals directly through WhatsApp chats.

## Features
* **Conversational Interface**: Setup your reports interactively by chatting with the bot (`!addreport`). No need to edit `.env` files or write Cron expressions.
* **Multi-Profile Isolation**: Built with tenant security in mind. Every WhatsApp chat (group or personal DM) gets its own isolated Chrome browser profile. Team A cannot see Team B's private dashboards, and cookies are never mixed.
* **Dynamic Background Scheduler**: Built-in background scheduling allows users to set daily delivery times (e.g. 9:00 AM) that are triggered automatically.
* **Cookie Injection Portal**: The bot hosts a lightweight Express server, providing a secure web portal. Users can click a magic link in WhatsApp (`!auth`) to inject their exact session cookies directly into the bot's headless browser, completely bypassing all CAPTCHAs, 2FA, and complex login forms.

## Documentation
For full details on how this project works and how to use it, please see the included markdown guides:

1. **[Implementation Plan](./IMPLEMENTATION_PLAN.md)** - Details the architectural decisions, the Tech Stack, the Conversational State Machine, and how the Multi-Profile (Tenant Isolation) system was built.
2. **[Usage Guide](./USAGE_GUIDE.md)** - A step-by-step guide for both end-users (how to use chat commands) and bot administrators (how to authenticate a specific team's chat profile via the server).
3. **[Risks and Limitations](./RISKS_AND_LIMITATIONS.md)** - Details the risks of WhatsApp account bans, the limitations of Puppeteer with 2FA/CAPTCHAs, and solutions for dealing with slow-loading BI tools.

## Quick Start
1. Clone the repository.
2. Run `npm install` to install dependencies (`whatsapp-web.js`, `puppeteer`, `node-cron`, `qrcode-terminal`, `dotenv`).
3. Run `node index.js`.
4. Scan the QR code with your WhatsApp app (Linked Devices).
5. Send `!addreport` to the bot in WhatsApp to configure your first dashboard!
