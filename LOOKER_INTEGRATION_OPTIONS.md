# Looker to WhatsApp Integration Options

This document outlines the two architectural approaches considered for explicitly supporting Looker dashboards in the WhatsApp Screenshot Bot. 

We are currently proceeding with **Option A**. This document serves as a fallback reference in case Option A encounters insurmountable issues (e.g., lack of Looker Admin privileges).

---

## Option A: The Looker Action Hub Approach (Currently Implemented)

This approach mirrors how the official Looker Slack integration works. Instead of using a headless browser to scrape the page, Looker itself renders the screenshot and pushes it to our bot via a Webhook.

**How it works:**
1. Our Node.js server acts as a Looker Action Hub.
2. It exposes an `/actions.json` endpoint defining the "WhatsApp" action.
3. It exposes a `/looker/execute` endpoint to receive POST requests.
4. Users schedule reports *inside the Looker UI*, selecting "WhatsApp" as the destination and entering the target WhatsApp Group ID.
5. Looker POSTs the generated PNG image and the Group ID to our server, which forwards it to the chat using `whatsapp-web.js`.

**Pros**: Highly reliable (Looker takes the screenshot itself), no Puppeteer required for Looker, no cookie/login injection needed.
**Cons**: Requires Looker Admin privileges to add our Action Hub URL. Our bot server must be publicly accessible (e.g., via ngrok or hosted on a public domain).

---

## Option B: Enhanced Puppeteer Approach (Fallback)

If Option A fails, we can fall back to the Enhanced Puppeteer approach. This approach keeps the current bot architecture (pull-based) but optimizes it specifically for Looker.

**How it works:**
1. Users continue to schedule reports inside WhatsApp using the `!addreport` command, providing the Looker dashboard URL.
2. We modify `screenshot.js` to include Looker-specific wait conditions (e.g., `await page.waitForSelector('.looker-dashboard-loaded')`) to ensure the heavy BI charts finish rendering before capturing the screenshot.
3. We may need to explicitly handle Looker API tokens or specialized login flows if standard injected cookies expire too quickly.

**Pros**: Doesn't require Looker Admin permissions; scheduling stays within the conversational interface.
**Cons**: Looker dashboards can be heavy and Puppeteer might struggle or time out. Auth cookies might expire, requiring users to repeatedly re-inject them.
