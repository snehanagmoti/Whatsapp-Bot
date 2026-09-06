# Looker and Looker Studio Integration Handover

This project supports two separate Google BI products without browser scraping.

## Primary prototype: Looker Studio

Looker Studio schedules a PDF report to a secret Gmail plus-address created from the destination WhatsApp chat. A Google Apps Script polling bridge forwards the email metadata and PDF to the protected bot endpoint. The bot verifies the request, resolves the address to the stored chat route, converts the PDF pages to PNG with Poppler, and sends the pages to WhatsApp.

Users create and manage routes inside WhatsApp with `!setupreport`, `!listreportlinks`, `!pausereport`, `!resumereport`, `!rotatereport`, and `!removereport`. Route tokens are random and only HMAC hashes are stored in MongoDB. Gmail messages are deduplicated by message ID.

The free prototype uses Render Free, MongoDB Atlas Free, Gmail plus-addressing, and Google Apps Script. See `USAGE_GUIDE.md` for setup and `RISKS_AND_LIMITATIONS.md` for production replacements.

## Secondary integration: full Looker instance

The authenticated Action Hub endpoints remain available for organizations that own a full Looker instance and whose Looker administrator can register a custom Action Hub. Full Looker can push its rendered PNG directly to the bot.

## Intentionally removed

Puppeteer URL capture, shared browser cookies, the remote login portal, and the in-bot URL scheduler were removed. They are not fallback modes. Private-dashboard credentials must never be copied into this service.

## Remaining live acceptance test

Before release, deploy this branch with the Studio environment variables, install the Apps Script bridge in the routing mailbox, create a route from the destination chat, and process one PDF produced by a real Looker Studio scheduled delivery. That test is required to determine the exact sender address for `STUDIO_ALLOWED_SENDERS` and to verify the company's outbound-sharing rules.
