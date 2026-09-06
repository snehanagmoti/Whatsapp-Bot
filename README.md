# Looker Studio to WhatsApp Report Bot

This Node.js service routes scheduled Looker Studio PDF reports to approved WhatsApp chats. A chat administrator creates a unique delivery address with `!setupreport`; Looker Studio emails its scheduled PDF to that address; the service validates and converts the PDF to PNG pages and sends them to the mapped chat.

The implementation does not log into Looker Studio, collect cookies, open report URLs, or schedule browser screenshots.

## Main components

- `index.js`: application startup, WhatsApp events, and authorization for chat commands.
- `studioRouting.js`: secure, revocable plus-address generation and lookup.
- `studioStore.js`: MongoDB route and delivery-deduplication records.
- `studioEmailService.js`: inbound email validation, routing, and WhatsApp delivery.
- `pdfProcessor.js`: PDF-to-PNG conversion through Poppler.
- `server.js`: protected email-ingestion endpoint, health checks, QR setup, and retained full-Looker Action Hub endpoints.
- `integrations/google-apps-script/Code.gs`: free Gmail-to-bot bridge for testing.
- `scratch/test_studio_email_delivery.js`: simulated Looker Studio delivery for testing without Pro.

## Environment variables

Required for WhatsApp and Studio routing:

```text
MONGODB_URI=
MONGODB_DB_NAME=whatsapp_bot
PUBLIC_BASE_URL=https://your-service.example.com
STUDIO_ROUTING_EMAIL=looker-reports@your-domain.com
STUDIO_ROUTE_PEPPER=<random secret of at least 24 characters>
STUDIO_INGEST_TOKEN=<random bearer token>
```

Recommended:

```text
STUDIO_ALLOWED_SENDERS=<comma-separated exact sender addresses after observing a genuine delivery>
STUDIO_ROUTE_ADMIN_IDS=<comma-separated WhatsApp user IDs allowed to manage routes>
STUDIO_MAX_PDF_BYTES=15728640
STUDIO_MAX_PAGES=5
```

The existing `LOOKER_ACTION_TOKEN` and `LOOKER_ALLOWED_CHAT_IDS` variables apply only to the retained full-Looker Action Hub path.

## Verification

```bash
npm test
npm run check
```

See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for the no-Pro test procedure and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) before production use.
