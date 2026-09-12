# Looker Studio to WhatsApp Report Bot

Release **1.2.0** delivers scheduled Looker Studio PDFs as images to approved WhatsApp groups or individual chats. Looker Studio generates the PDF; a Gmail/Workspace routing mailbox and Google Apps Script forward it to this Node.js service. The service validates the request, resolves secret routing aliases, converts PDF pages with Poppler, and sends the images through one linked WhatsApp account.

It does not log into Looker Studio, import cookies, visit private report URLs, or capture browser screenshots.

## Delivery flow

```text
!setupreport <name> in the destination chat
  -> secret mailbox+token@domain alias
  -> alias added to a Looker Studio email schedule
  -> PDF arrives in the routing mailbox
  -> Apps Script forwards it over authenticated HTTPS
  -> sender, route, PDF and resource-limit checks
  -> MongoDB claims each message/chat delivery
  -> Poppler renders ordered PNG pages
  -> WhatsApp receives images; page progress is saved
```

One bot number can serve many chats. Use one alias for each destination chat in a particular schedule. An ingested email containing several active aliases fans out to every distinct mapped chat. Deduplication uses the Gmail message ID and destination chat: it does not treat separately generated emails with different IDs as the same delivery.

## Release 1.2.0 changes

- New `/admin/` web dashboard, protected by a dedicated `STUDIO_ADMIN_TOKEN`, for managing report routes and checking WhatsApp/delivery status across every chat without using WhatsApp commands one chat at a time. Backed by a JSON API under `/admin/api/*` covering status, QR linking, route CRUD and recent deliveries — all built on the existing `routeService`/`studioStore`, not a second source of truth.
- `studioStore` gained `listAllRoutes()` and `listRecentDeliveries()` for cross-chat admin views, implemented for both the MongoDB and in-memory stores.
- `!rotatereport` now requires `--confirm`, matching `!removereport`, since rotation immediately invalidates the route's current address.
- New `!help` / `!studiohelp` WhatsApp command listing all commands, usable even when Studio routing isn't configured.
- 12 new automated tests covering the admin API's auth, CRUD flows and the store's new query methods (82 total, up from 69).

## Release 1.1.0 changes

- Independent records for each message/chat pair, stale-claim recovery, ownership checks and saved page progress. Retries resume after confirmed pages and skip completed chats.
- In-progress deliveries remain retryable with HTTP 503 rather than being mistaken for completed duplicates. Claim failures release earlier claims; other available destinations can still complete.
- Active aliases are selected before destination deduplication. A paused alias cannot hide an active alias for the same chat; mail addressed only to paused routes is acknowledged and skipped.
- Gmail polling now paginates 50 threads at a time, up to 500 by default, with a seven-day lookback, explicit cutover timestamp, a chunked 2,000-message ledger and forwarding/rejection logs.
- WhatsApp reconnect backoff, stale-listener protection, message-age checks and MongoDB replay claims survive reconnects and process restarts.
- Optional AES-256-GCM session encryption, a separate production QR setup token, route quotas and confirmed route removal.
- Authenticated request parsing, request-size/rate/concurrency limits, PDF geometry/pixel limits and explicit rejection of reports exceeding the page limit. An HTTP disconnect does not release the concurrency slot while its processing continues.
- Exact dependency pins, Node.js 22-24 support, CI checks and `/versionz` deployment identification.

## Configuration

Use `.env.example` and `render.yaml` as the canonical complete configuration. Core values are:

```text
MONGODB_URI=<database connection string>
MONGODB_DB_NAME=whatsapp_bot
PUBLIC_BASE_URL=https://your-service.example.com
STUDIO_ROUTING_EMAIL=looker-reports@company.com
STUDIO_ROUTE_PEPPER=<stable random secret of at least 24 characters>
STUDIO_INGEST_TOKEN=<random bearer token>
STUDIO_ALLOWED_SENDERS=data-studio-noreply@google.com
QR_SETUP_TOKEN=<separate random setup secret>
STUDIO_ADMIN_TOKEN=<separate random admin-dashboard secret>
WA_AUTH_ENCRYPTION_KEY=<stable random secret of at least 32 characters>
```

The application uses `data-studio-noreply@google.com` if the sender list is empty. Verify the genuine sender for your tenant before changing it. `STUDIO_INGEST_TOKEN_OVERRIDE`, when set, takes precedence over `STUDIO_INGEST_TOKEN`; Apps Script must use the same effective value.

Retain the route pepper and encryption key across deployments. Changing the pepper invalidates existing aliases. Encrypted WhatsApp session records require the original encryption key; losing or replacing it can require clearing the affected session and linking again. Existing plaintext records migrate when read after encryption is enabled. Encryption remains optional in code for compatibility, so verify the deployed environment actually contains the key.

Default values in the supplied deployment configuration:

```text
WA_COMMAND_CLAIM_TTL_MS=604800000
WA_COMMAND_MAX_AGE_MS=86400000
STUDIO_MAX_ROUTES_PER_CHAT=20
STUDIO_DELIVERY_LEASE_MS=600000
STUDIO_MAX_REQUEST_BYTES=23068672
STUDIO_MAX_CONCURRENT_INGESTS=2
STUDIO_RATE_LIMIT_PER_MINUTE=30
STUDIO_MAX_PDF_BYTES=15728640
STUDIO_MAX_PAGES=5
STUDIO_PDF_DPI=144
STUDIO_MAX_IMAGE_BYTES=7340032
STUDIO_MAX_PAGE_POINTS=10000
STUDIO_MAX_PAGE_PIXELS=2400
STUDIO_MAX_TOTAL_PIXELS=20000000
```

The lease is ten minutes in the supplied environment/Blueprint; the store's fallback without that variable is fifteen minutes. The PDF renderer reduces DPI when necessary to stay within the pixel cap and rejects documents beyond configured limits instead of silently dropping pages.

`STUDIO_ROUTE_ADMIN_IDS` optionally grants route management to configured WhatsApp identities. The linked bot account and verified group administrators can also manage routes. `LOOKER_ACTION_TOKEN`, `LOOKER_ALLOWED_CHAT_IDS` and `LOOKER_MAX_IMAGE_BYTES` belong to the separate, optional full-Looker Action Hub path.

## Commands

```text
!setupreport <report name>
!listreportlinks
!pausereport <report name>
!resumereport <report name>
!rotatereport <report name> --confirm
!removereport <report name> --confirm
!chatid
!help
```

Run setup in the intended destination chat. The QR link is a one-time operator task, not a task for every user. Rotation now requires `--confirm`, matching removal, since it immediately invalidates the route's current address. See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for setup, schedules and testing.

## Admin dashboard

Operators managing routes across several chats can use the web dashboard at `/admin/` instead of WhatsApp commands one chat at a time: WhatsApp link status (with the linking QR code inline), create/pause/resume/rotate/remove for every route the bot knows about, and recent delivery outcomes per chat. It is protected by its own `STUDIO_ADMIN_TOKEN` bearer secret, separate from `QR_SETUP_TOKEN` and `STUDIO_INGEST_TOKEN`. See [USAGE_GUIDE.md](./USAGE_GUIDE.md#admin-dashboard) for setup and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md#admin-dashboard) for its security model.

## Verification and release status

The local release suite passed **82 tests with no failures or skips**. Coverage includes route authorization/lifecycle, multiple destinations, failed-page retries, stale/busy claims, pause handling, session encryption, command replay protection, HTTP limits, Apps Script outcomes, the admin dashboard API and real Poppler rendering. Tests use controlled or mocked external services; they do not prove current Gmail, Render or WhatsApp delivery.

Run with Node.js 22-24 and Poppler (`pdfinfo` and `pdftoppm`) installed:

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

The CI workflow runs these checks on Node.js 22. The release preparation's online dependency audit/update lookup encountered registry connection resets, so this document makes no zero-vulnerability or latest-dependency claim. Dependencies are pinned to the lockfile's exact versions, including the Baileys release candidate.

Live deployment and a fresh end-to-end acceptance test must be verified separately: `/versionz` identifies the running version/commit, `/healthz` checks HTTP liveness, and `/readyz` checks WhatsApp readiness. A ready response does not prove a particular report was delivered.

The scheduled-email design does not inherently require Looker Studio Pro. Confirm current scheduling capabilities and quotas for the account in Google's [scheduled delivery documentation](https://docs.cloud.google.com/looker/docs/studio/schedule-automatic-report-delivery). Schedule creators may receive their own PDF copy; use a dedicated reporting account when personal inbox copies are unwanted.

Read [LOOKER_INTEGRATION_HANDOVER.md](./LOOKER_INTEGRATION_HANDOVER.md), [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) before a production rollout.
