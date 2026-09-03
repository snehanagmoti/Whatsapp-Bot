# WhatsApp Screenshot & Reporting Bot

An automated, multi-tenant WhatsApp bot built with Node.js, `whatsapp-web.js`, and Puppeteer. It allows teams to dynamically schedule and request on-demand screenshots of authenticated BI dashboards (Looker, Metabase) and private web portals directly through WhatsApp chats.

## Features
* **Conversational Interface**: Setup your reports interactively by chatting with the bot (`!addreport`). No need to edit `.env` files or write Cron expressions.
* **Multi-Profile Isolation**: Built with tenant security in mind. Every WhatsApp chat (group or personal DM) gets its own isolated Chrome browser profile. Team A cannot see Team B's private dashboards, and cookies are never mixed.
* **Dynamic Background Scheduler**: Built-in background scheduling allows users to set daily delivery times (e.g. 9:00 AM) that are triggered automatically.
* **Looker Action Hub**: Looker can push rendered PNG dashboards to an authenticated webhook, which forwards them only to approved WhatsApp destinations.
* **Restart-safe WhatsApp login**: When `MONGODB_URI` is configured, the linked-device session is backed up to MongoDB GridFS and restored after ephemeral-host restarts.

## Documentation
For full details on how this project works and how to use it, please see the included markdown guides:

1. **[Implementation Plan](./IMPLEMENTATION_PLAN.md)** - Details the architectural decisions, the Tech Stack, the Conversational State Machine, and how the Multi-Profile (Tenant Isolation) system was built.
2. **[Usage Guide](./USAGE_GUIDE.md)** - A step-by-step guide for both end-users (how to use chat commands) and bot administrators (how to authenticate a specific team's chat profile via the server).
3. **[Risks and Limitations](./RISKS_AND_LIMITATIONS.md)** - Details the risks of WhatsApp account bans, the limitations of Puppeteer with 2FA/CAPTCHAs, and solutions for dealing with slow-loading BI tools.

## Quick Start
1. Clone the repository.
2. Run `npm install` to install the dependencies.
3. Run `node index.js`.
4. Scan the QR code with your WhatsApp app (Linked Devices).
5. Send `!addreport` to the bot in WhatsApp to configure your first dashboard!

## Looker / Render Deployment

1. Copy `.env.example` values into Render environment variables. Set `PUBLIC_BASE_URL` to the final HTTPS service URL.
2. Keep the generated `LOOKER_ACTION_TOKEN` secret and enter the same value as the Action Hub authentication token in Looker.
3. Add only approved IDs to `LOOKER_ALLOWED_CHAT_IDS` (comma-separated). Obtain each ID with `!chatid`.
4. Create a free MongoDB Atlas cluster and set its connection string as `MONGODB_URI`. The custom GridFS store backs up the WhatsApp linked-device session every minute so it can be restored after Render restarts.
5. Deploy with `render.yaml`, which uses the Render Free plan. Local files remain temporary; the WhatsApp session is the part persisted in MongoDB.
6. In Looker Admin -> Platform -> Actions, add `https://your-service.onrender.com/actions` as the Action Hub URL and supply the authentication token.
7. Watch the first deploy logs and scan the WhatsApp QR code. Wait for the `WhatsApp session backup saved to MongoDB` log before restarting.

`/healthz` confirms the web service is running. `/readyz` returns HTTP 200 only after WhatsApp is connected. The optional cookie-import portal is disabled by default because pasted session cookies are credentials; enabling it is not recommended for production.

### Important Limitations

- `whatsapp-web.js` is an unofficial client and can break when WhatsApp Web changes or can trigger account restrictions. Use a dedicated bot number.
- Render Free spins down after inactivity and can take about a minute to wake. MongoDB restores the WhatsApp login, but scheduled Looker deliveries can still fail during the cold-start window. This zero-cost setup is suitable only for a prototype.
- The bot's local `database.json` schedules and private-dashboard browser profiles are not persisted on Render Free. Use Looker's own scheduling (Option A); the Puppeteer scheduling fallback is local-machine-only in the free deployment.
- Private dashboards still require a user-controlled authentication design. The local `login.js` flow is acceptable for a prototype on a trusted machine, but it is not a secure remote multi-user login service.
