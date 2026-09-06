# Looker Studio to WhatsApp Implementation Plan

## Target workflow

1. A WhatsApp group administrator runs `!setupreport <name>`.
2. The bot generates a random route token, stores only its HMAC hash, and returns a Gmail plus-address.
3. The user adds that address to a Looker Studio email schedule.
4. Looker Studio renders the selected pages as a PDF and sends it to the routing mailbox.
5. Gmail or Apps Script submits the message metadata and PDF to `POST /studio/email/ingest` using a bearer token.
6. The service validates the sender, recipient route, PDF signature, size and message ID.
7. MongoDB atomically claims the message ID to prevent duplicates.
8. Poppler renders the permitted PDF pages as PNG images.
9. The WhatsApp transport sends each page to the mapped chat in order.
10. MongoDB records delivery success or failure. Failed submissions may be retried with the same message ID; completed submissions are suppressed.

## Prototype architecture

- Render free web service.
- MongoDB Atlas M0 for Baileys credentials, route mappings, and deduplication.
- Baileys linked-device WhatsApp transport.
- Gmail plus-address routing.
- Google Apps Script polling every five minutes.
- Poppler PDF rendering in the Docker container.

## Production replacements

- Always-on managed container service with autoscaling and health monitoring.
- Dedicated Google Workspace routing mailbox or inbound-email subdomain.
- Gmail API push notifications through Pub/Sub instead of Apps Script polling.
- Secret Manager for bearer tokens and route pepper.
- Durable queue and dead-letter processing for burst traffic.
- Production database with backup, audit retention and encryption controls.
- Malware scanning and a documented report-retention policy.
- Official WhatsApp Business Platform where the required group or recipient model is supported; otherwise obtain explicit risk approval for Baileys.
- Administrative portal or corporate identity integration for route ownership at scale.

## Delivery phases

1. Unit-test route creation, validation, deduplication and message ordering.
2. Test the deployed service using the simulated PDF sender.
3. Test Gmail ingestion with a manually emailed PDF.
4. Test one genuine scheduled email from free Looker Studio.
5. Observe and allowlist the exact Looker Studio sender identity.
6. Run failure tests: invalid token, unknown route, paused route, duplicate message, oversized PDF, malformed PDF, WhatsApp offline and renderer failure.
7. Conduct a limited internal pilot with a dedicated WhatsApp number.
8. Complete security, privacy, compliance and WhatsApp-platform review before production.

The previous browser-login, cookie-import, Puppeteer screenshot and bot-owned cron scheduler implementation has been removed. Scheduling and rendering now belong to Looker Studio.
