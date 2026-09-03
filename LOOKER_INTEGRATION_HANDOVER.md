# Looker to WhatsApp Integration - Handover Document

## Goal
To extend the existing WhatsApp Screenshot Bot to explicitly support capturing and sharing Looker dashboards into WhatsApp groups, mimicking how the official Looker Slack integration works.

## What Was Completed (Implemented by Antigravity)

I have fully implemented the Looker Action Hub architecture (Option A) and provided an enhanced Puppeteer scraping fallback (Option B). 

### 1. Looker Action Hub Webhook (Option A - Primary)
The bot's Express server now functions as a native Looker Action Hub. Looker will push screenshots directly to the bot.
* **`server.js` modifications:**
  * Added `express.json({ limit: '50mb' })` to handle large image payloads.
  * `GET /actions.json`: Exposes the Action Hub manifest to Looker.
  * `POST /looker/form`: Requests the required "WhatsApp Chat ID" when a user schedules a report in Looker.
  * `POST /looker/execute`: The webhook endpoint that receives the base64 PNG from Looker, converts it to a `MessageMedia` object, and sends it to the target WhatsApp group.
* **`index.js` modifications:**
  * Added the `!chatid` conversational command so users can easily retrieve their WhatsApp Group IDs to paste into the Looker scheduling form.
* **Verification:** I created a local script (`scratch/test_looker_webhook.js`) that simulated Looker's POST payload. The bot successfully parsed the mock payload and sent a test message to a saved WhatsApp group. 

### 2. Enhanced Puppeteer Fallback (Option B)
In case the webhook approach cannot be used, I enhanced the existing web-scraping logic explicitly for Looker.
* **`screenshot.js` modifications:**
  * Added URL detection. If the URL contains `looker`, the headless browser applies an explicit 8-second delay and waits for `.lk-dashboard-layout` selectors to ensure heavy BI charts are fully painted before snapping the screenshot.

### 3. Deployment Preparation
* **`package.json`**: Added a `"start": "node index.js"` script.
* **`Dockerfile`**: Created a Dockerfile based on `ghcr.io/puppeteer/puppeteer:latest`. This is critical because `whatsapp-web.js` uses a headless Chromium browser under the hood. Cloud platforms like Render require this Dockerfile to provide the necessary Linux shared libraries (like libnss3, libX11) so the browser doesn't crash on startup.

---

## What Needs to be Done Next (For Codex / The User)

Because the user's local network/firewall blocked all tunneling tools (`ngrok`, `localtunnel`, VS Code port forwarding), the bot currently lacks a public URL. Looker **cannot** reach the webhook until the bot is deployed.

### Step 1: Deploy to a Cloud Provider (e.g., Render)
1. Commit all files and push this repository to GitHub.
2. Log into Render (or a similar PaaS).
3. Create a new "Web Service" and connect the GitHub repository.
4. Ensure Render builds using the provided `Dockerfile`.

### Step 2: Handle Free-Tier Ephemeral Storage (Crucial)
If deploying to a free tier, the server will sleep after 15 minutes of inactivity. When it wakes up, the ephemeral hard drive is wiped, meaning the `.wwebjs_auth` folder (which holds the WhatsApp login session) will be deleted.
* **Task for Codex**: Either upgrade the deployment to a paid tier with a persistent disk, OR implement a `RemoteAuth` strategy for `whatsapp-web.js` (e.g., using MongoDB or AWS S3) so the WhatsApp session persists across server restarts.

### Step 3: Configure Looker
1. Once deployed, get the public URL (e.g., `https://my-whatsapp-bot.onrender.com`).
2. Go to your Looker Admin panel -> Platform -> Actions.
3. Click **Add Action Hub** and input the public URL. Looker will automatically fetch `/actions.json` and enable the "WhatsApp Bot" destination.

### Step 4: End-to-End Test
1. Go to any WhatsApp group and type `!chatid`. Copy the ID.
2. Go to a dashboard in Looker -> Schedule Delivery.
3. Choose "WhatsApp Bot" as the destination, paste the Chat ID, and click Send!

---

## Codex Continuation

The production-critical local work is now implemented on `codex/looker-hardening`:

- Corrected the Action Hub contract: Looker can POST to `/actions` (or the configured root/list endpoint), the manifest uses `wysiwyg_png`, `push`, and the required hub metadata.
- Added Action Hub token verification using Looker's `Authorization: Token token="..."` format.
- Added a WhatsApp destination allowlist, strict chat-ID/PNG validation, payload limits, and clear failure responses.
- Started the HTTP server before WhatsApp authentication so Render health checks succeed; added `/healthz` and `/readyz`.
- Added `DATA_DIR` support and a paid Render persistent disk Blueprint so WhatsApp auth, report configuration, and browser profiles survive restarts.
- Added `.dockerignore`, pinned the Puppeteer image, changed Docker installation to `npm ci`, and disabled the unsafe cookie-import portal by default.
- Added automated tests for manifest authentication, readiness, successful delivery, and destination authorization.

Remaining work requires external accounts: push the branch, create the Render Blueprint/service, configure its environment values, scan the WhatsApp QR code, add the authenticated `/actions` endpoint in Looker, and run a real scheduled dashboard delivery.
