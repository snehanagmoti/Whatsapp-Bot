# Looker Studio to WhatsApp Report Bot

Release **1.6.4** delivers scheduled Looker Studio PDFs as images to WhatsApp groups or individual chats. Looker Studio generates the PDF; a Gmail/Workspace routing mailbox and Google Apps Script forward it to this Node.js service. The service validates the request, resolves secret routing aliases, converts PDF pages with Poppler, and sends the images through one linked WhatsApp account.

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

## Release 1.6.4 changes

- **Rate limits work behind Render's proxy.** Render sits behind Cloudflare, so the address the app saw was whichever Cloudflare server forwarded the request, and it changed from request to request. Each request got a fresh bucket and the per-minute limits on the admin and chat dashboards never applied (70 wrong chat IDs in a few seconds were all answered). Limits now use the visitor's own address from `CF-Connecting-IP` (or `True-Client-IP`), falling back to the previous behaviour when it is absent.

## Release 1.6.3 changes

- **`!chatid` gives a clean ID.** The reply used to wrap the ID in `*bold*`. In groups WhatsApp turns `…@g.us` into a link and showed a stray `*` that people copied with the ID. The ID is now sent plain, and the chat dashboard ignores spaces and WhatsApp formatting marks (`* _ ~` and backticks) copied along with it.

## Release 1.6.2 changes

- **Dashboards always show fresh status.** Status, QR and API answers (`/admin/api/*`, `/chat/api/*`, `/studio/*`, `/healthz`, `/readyz`, `/versionz`) are sent with `Cache-Control: no-store`, and both dashboards ask for fresh answers. A browser had reused a broken saved copy of `/admin/api/status`, leaving the admin dashboard on "Could not load status" with no QR code. An empty answer now shows a clear message instead of a script error.

## Release 1.6.1 changes

- **QR linking works on the first scan.** While waiting for a scan, each QR round normally ends after about 2 minutes 40 seconds (WhatsApp code 408). The bot treated this as a failure and waited longer each time (up to 60 seconds) before offering new codes, while the dashboard kept showing the expired one. After a successful scan WhatsApp asks for an immediate reconnect (code 515), and a late reconnect was rejected, so the scan was wasted. Now expired QR rounds restart after the base delay, a successful scan reconnects at once, and the dashboard drops a QR code as soon as its connection closes.

## Release 1.6.0 changes

No data migration; existing routes, WhatsApp credentials, secrets and delivery records keep working. Remove the deleted variables listed below from the hosted environment; they are ignored if left.

- **Open commands.** Anyone in a WhatsApp chat can use every report command (`!setupreport`, `!listreportlinks`, `!pausereport`, `!resumereport`, `!rotatereport --confirm`, `!removereport --confirm`, `!chatid`, `!help`). A command only affects the chat it was sent in. The group-admin check, `STUDIO_ROUTE_ADMIN_IDS` and `STUDIO_ALLOW_PUBLIC_SETUP` are removed.
- **Chat dashboard at `/chat/`.** Log in with a WhatsApp chat ID (from `!chatid`) and manage only that chat's reports and deliveries: create, pause/resume, rotate, remove, and retry deliveries that gave up. A chat ID is not a secret, so anyone who learns it can manage that chat's reports; this is an accepted risk chosen for simplicity (see [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md#chat-dashboard)).
- **WhatsApp linking only in the admin dashboard.** The separate `/setup/qr` page, `/setup/qr.svg` and `QR_SETUP_TOKEN` are removed. `/admin/` reloads the QR code every 4 seconds while WhatsApp is unlinked.
- **Full-Looker Action Hub removed.** `POST /`, `/actions`, `/actions.json`, `/looker/form`, `/looker/execute` and `LOOKER_ACTION_TOKEN`, `LOOKER_ALLOWED_CHAT_IDS`, `LOOKER_MAX_IMAGE_BYTES`, `LOOKER_RATE_LIMIT_PER_MINUTE` and `PUBLIC_BASE_URL` are gone. The company uses Looker Studio / Looker Studio Pro, which has no Action Hub; that belongs to the separate paid Looker product.
- **More memory headroom.** The Node heap limit is 256 MB (was 128 MB) after out-of-memory crashes every few days. It is set in the `start` script (`node --max-old-space-size=256 index.js`) and in `NODE_OPTIONS` in the Dockerfile and `render.yaml`. An hourly `Memory: heap ...` log line shows heap, RSS and external memory.
- **Token mismatch is retried.** A wrong or missing ingest token now gets HTTP 503 with `Retry-After: 300` instead of 401, so the Gmail bridge keeps retrying instead of permanently rejecting reports while the tokens disagree.
- **Bad PDFs give up at once.** A PDF that breaks a limit (more than `STUDIO_MAX_PAGES` pages, too large, bad geometry or pixel count, or not a PDF) is marked permanent: the delivery goes straight to `dead_letter` and ingest answers 422, instead of using six attempts.
- **The waiting chat is told.** When a delivery gives up, the destination chat gets a short note (`⚠️ *Report* could not be delivered to this chat ...`) with the reason and a reminder that it can be retried from the dashboard for 7 days. Notes are limited to 10 per 10 minutes. `STUDIO_ALERT_CHAT_ID` is removed.
- Unchanged on purpose: paused routes skip mail and resuming does not catch up; the retry schedule stays at 6 attempts with 1, 2, 4, 8 and 16-minute waits; `STUDIO_INGEST_TOKEN_OVERRIDE` is still supported.
- 153 tests: 142 pass, 0 fail, 11 skipped (the MongoDB integration tests, which CI runs against `mongo:7`).

## Release 1.5.0 changes

No data migration; existing routes, WhatsApp credentials, secrets and delivery records keep working.

- **Fix: background retries against MongoDB.** Since v1.3.0 the delivery worker received the stored PDF from MongoDB as a BSON `Binary`, which the PDF renderer rejects, so every worker retry failed and only bridge re-sends recovered a delivery. Stored PDFs are now read back as Buffers, and integration tests use a renderer stand-in that rejects anything else.
- **One stored PDF per email.** The source PDF is saved once in `studio_pdfs` and every destination chat's delivery references it, instead of one copy per destination. It is deleted when no delivery needs it (30-day TTL backstop).
- **Retry from the dashboard.** A delivery that gave up keeps its PDF for `STUDIO_DEAD_LETTER_RETENTION_MS` (default 7 days); the dashboard's deliveries table shows a **Retry** button that requeues it with a fresh attempt budget (`POST /admin/api/deliveries/retry`).
- **Dead-letter alerts.** A configured WhatsApp chat received a message whenever a delivery gave up. (Replaced in v1.6.0 by a note to the affected chat.)
- **Keep-awake for Render's free tier (Gmail bridge v1.3.0).** Each five-minute bridge run pings `/healthz` so the service does not spin down after 15 idle minutes, keeping the retry worker and WhatsApp connection running. Controlled by the Script Property `KEEP_SERVICE_AWAKE` (default true). One always-on service uses at most 744 of the 750 free instance hours Render grants per workspace each month.
- Documentation refreshed for v1.3.1-v1.5.0. 141 unit tests and 11 MongoDB integration tests.

## Release 1.4.0 changes

WhatsApp-side hardening and efficiency. No data migration; existing sessions, routes and delivery records keep working without re-linking.

- **Signal key material is kept out of logs.** libsignal (inside Baileys) logged full session objects, including ratchet private keys, on routine events such as "Closing session". `logRedaction.js` is installed before anything else runs: it drops that routine chatter and redacts any logged object carrying Signal/WhatsApp key material. `WA_SIGNAL_DEBUG=true` restores the routine messages (still redacted).
- **Faster key store.** Signal keys are read with one `$in` query and written with one bulk write per update instead of one database round-trip per key, and the store is wrapped with Baileys' write-through key cache.
- **Group metadata cache.** Participant lists needed to encrypt group sends are cached for five minutes, invalidated whenever WhatsApp reports a group or membership change, and shared with admin checks.
- **Re-send support across reconnects.** Sent messages are kept for 24 hours (1,000 at most) so a recipient that asks for a page to be re-sent can still be answered after the socket reconnects.
- **LID identities.** `...@lid` chat IDs and legacy `123-456@g.us` group IDs are accepted by the admin API, and route-management checks matched a sender's phone-number JID or LID (those checks were removed in v1.6.0).
- Report pages are passed to WhatsApp as buffers, avoiding a base64 round-trip per page.
- 126 unit tests and 9 MongoDB integration tests.

## Release 1.3.1 changes

Correctness and hardening fixes; no data migration is required and existing routes, WhatsApp credentials, secrets, delivery history and deduplication records are preserved.

- **Dead letters are terminal at ingest.** A delivery that exhausted its retries used to be reported as "still processing" (HTTP 503), so the Gmail bridge re-uploaded the PDF every five minutes for up to seven days. It now answers HTTP 422 (`DELIVERY_DEAD_LETTER`), which the bridge records as permanently rejected. Other destinations in the same email are still delivered.
- **One retry schedule.** Upstream ingest retries now respect a failed delivery's `nextAttemptAt` backoff, like the background worker. Inside the window they get a retryable 503 without sending or consuming an attempt.
- **WhatsApp outages don't burn attempts.** A send that fails because WhatsApp disconnected mid-delivery is recorded without consuming one of the bounded attempts (capped at 24 such interruptions per delivery).
- **Logout recovery.** When WhatsApp logs the linked device out, the bot clears the dead session, starts fresh credentials and reconnects, so a new QR code appears without a restart (since v1.6.0 only in the admin dashboard).
- **Rate limiting.** Limiters mounted before authentication (admin API and, until v1.6.0, the QR setup image) are keyed by client address, so inventing tokens no longer bypasses them; expired buckets are swept and the table is capped.
- **Leaner admin listing.** The deliveries query excludes stored PDFs instead of loading and discarding them.
- **Gmail bridge v1.2.0** (`integrations/google-apps-script/Code.gs`): checkpoints its processed-message ledger during a run, saves it if a run ends in an error, and stops starting new messages after `FORWARD_MAX_RUNTIME_SECONDS` (default 270) so Apps Script's six-minute limit cannot discard a run's progress. Paste the new source into the Apps Script project; Script Properties and the cutover are unchanged.
- **Tests.** 109 unit tests (up from 88) plus 8 MongoDB integration tests in `test/mongo-integration.test.js`, which run when `MONGODB_TEST_URI` points at a throwaway server (CI starts `mongo:7`). `scripts/measure-ingest-memory.js` measures ingest memory with large PDFs.

## Release 1.3.0 changes

- A durable retry layer for report delivery. Each claimed delivery now stores its own copy of the source PDF, so a delivery that fails - or gets stuck because the process crashed mid-send - no longer depends on Apps Script/Gmail resending the same email to be retried. A background worker (`studioDeliveryWorker.js`) sweeps for retryable deliveries on a fixed interval and resends them.
- Retries use exponential backoff (`STUDIO_DELIVERY_RETRY_BASE_MS`, doubling per attempt, capped at 30 minutes) up to a bounded attempt count (`STUDIO_DELIVERY_MAX_ATTEMPTS`, default 6). A delivery that exhausts its attempts moves to a terminal `dead_letter` status instead of retrying forever - it stays visible with its last error in the admin dashboard and `/admin/api/deliveries`, and releases the stored PDF bytes once it gets there.
- The synchronous HTTP ingest path (`/studio/email/ingest`) is unchanged: it still processes and responds inline for the common case, with the same status codes Apps Script already expects. The worker is strictly additive - a safety net behind it, not a replacement for it.
- 6 new automated tests covering backoff timing, dead-letter transition, crash recovery (reclaiming a stale `processing` lease), a disconnected-WhatsApp no-op, a removed-route failure, and a full ingest-failure-to-worker-recovery path (88 total, up from 82).

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
- Optional AES-256-GCM session encryption, a separate production QR setup token (removed in v1.6.0), route quotas and confirmed route removal.
- Authenticated request parsing, request-size/rate/concurrency limits, PDF geometry/pixel limits and explicit rejection of reports exceeding the page limit. An HTTP disconnect does not release the concurrency slot while its processing continues.
- Exact dependency pins, Node.js 22-24 support, CI checks and `/versionz` deployment identification.

## Configuration

Use `.env.example` and `render.yaml` as the canonical complete configuration. Core values are:

```text
MONGODB_URI=<database connection string>
MONGODB_DB_NAME=whatsapp_bot
STUDIO_ROUTING_EMAIL=looker-reports@company.com
STUDIO_ROUTE_PEPPER=<stable random secret of at least 24 characters>
STUDIO_INGEST_TOKEN=<random bearer token>
STUDIO_ALLOWED_SENDERS=data-studio-noreply@google.com
STUDIO_ADMIN_TOKEN=<separate random admin-dashboard secret>
WA_AUTH_ENCRYPTION_KEY=<stable random secret of at least 32 characters>
```

The application uses `data-studio-noreply@google.com` if the sender list is empty; Looker Studio scheduled emails were verified to come from that address. `STUDIO_INGEST_TOKEN_OVERRIDE`, when set, takes precedence over `STUDIO_INGEST_TOKEN`; Apps Script must use the same effective value.

Retain the route pepper and encryption key across deployments. Changing the pepper invalidates existing aliases. Encrypted WhatsApp session records require the original encryption key; losing or replacing it can require clearing the affected session and linking again. Existing plaintext records migrate when read after encryption is enabled. Encryption remains optional in code for compatibility, so verify the deployed environment actually contains the key.

See [USAGE_GUIDE.md](./USAGE_GUIDE.md#secrets-safe-vs-dangerous-to-change) for which secrets are safe to change.

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
STUDIO_DELIVERY_MAX_ATTEMPTS=6
STUDIO_DELIVERY_RETRY_BASE_MS=60000
STUDIO_DELIVERY_WORKER_INTERVAL_MS=60000
STUDIO_DEAD_LETTER_RETENTION_MS=604800000
STUDIO_ADMIN_RATE_LIMIT_PER_MINUTE=60   (per client address, admin and chat dashboards)
```

The lease is ten minutes in the supplied environment/Blueprint; the store's fallback without that variable is fifteen minutes. The PDF renderer reduces DPI when necessary to stay within the pixel cap and rejects documents beyond configured limits instead of silently dropping pages; such a rejection gives up at once (HTTP 422).

The Node heap limit is 256 MB, set by the `start` script and by `NODE_OPTIONS` in the Dockerfile and `render.yaml`. `MALLOC_ARENA_MAX=2` stays as before.

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

Run setup in the intended destination chat. Anyone in a chat can use every command, and a command only affects that chat. Linking WhatsApp by QR is a one-time operator task in the admin dashboard, not a task for every user. Rotation now requires `--confirm`, matching removal, since it immediately invalidates the route's current address. See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for setup, schedules and testing.

## Admin dashboard

Operators managing routes across several chats can use the web dashboard at `/admin/` instead of WhatsApp commands one chat at a time: WhatsApp link status (with the linking QR code inline, reloaded every 4 seconds while unlinked), create/pause/resume/rotate/remove for every route the bot knows about, and recent delivery outcomes per chat - including any that reached a terminal `dead_letter` state, with a **Retry** button while their PDF is still stored. It is the only place to link WhatsApp. It is protected by its own `STUDIO_ADMIN_TOKEN` bearer secret, separate from `STUDIO_INGEST_TOKEN`. See [USAGE_GUIDE.md](./USAGE_GUIDE.md#admin-dashboard) for setup and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md#admin-dashboard) for its security model.

## Chat dashboard

`/chat/` lets people manage one chat's reports on the web. Log in with the chat's WhatsApp ID (send `!chatid` in the chat); the page sends it as the `X-Chat-Id` header to `/chat/api/...` (`routes`, `routes/status`, `routes/rotate`, `routes/remove`, `deliveries`, `deliveries/retry`). Every request is limited to that one chat and rate-limited per client address (`STUDIO_ADMIN_RATE_LIMIT_PER_MINUTE`). There is no password: anyone who knows a chat ID can manage that chat's reports. The owner accepted this for simplicity; see [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md#chat-dashboard).

## Delivery retries and dead-lettering

Each email's source PDF is stored once and shared by its destination deliveries until they deliver (or, for dead letters, until the retention window ends). A failed attempt - or one where the process crashed mid-send, leaving it stuck past its lease - is automatically picked back up by a background worker running inside the same service, on a fixed interval (`STUDIO_DELIVERY_WORKER_INTERVAL_MS`, default 60s), with exponential backoff between attempts (`STUDIO_DELIVERY_RETRY_BASE_MS`, doubling, capped at 30 minutes) up to `STUDIO_DELIVERY_MAX_ATTEMPTS` (default 6). This does not depend on Apps Script or Gmail resending the email. Once attempts are exhausted - or at once, for a PDF that breaks a limit - the delivery becomes `dead_letter`: it is not retried automatically, the ingest endpoint answers 422 for it, it stays visible with its last error in both dashboards, the destination chat gets a short note saying why, and anyone with dashboard access can press **Retry** within the retention window. See [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md#delivery-retries-and-dead-lettering) for what this does and does not cover.

## Verification and release status

The local release suite ran **153 tests: 142 passed, 0 failed, 11 skipped**; the skipped tests are the MongoDB integration tests, which run only when `MONGODB_TEST_URI` is set (CI runs them against `mongo:7`). Coverage includes route lifecycle, chat-dashboard isolation, multiple destinations, failed-page retries, stale/busy claims, pause handling, session encryption, command replay protection, HTTP limits, Apps Script outcomes, the admin and chat dashboard APIs, delivery retry/backoff/dead-lettering, permanent PDF rejections, delivery-failure notes and real Poppler rendering. Tests use controlled or mocked external services; they do not prove current Gmail, Render or WhatsApp delivery.

Run with Node.js 22-24 and Poppler (`pdfinfo` and `pdftoppm`) installed:

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

The CI workflow runs these checks on Node.js 22. The release preparation's online dependency audit/update lookup encountered registry connection resets, so this document makes no zero-vulnerability or latest-dependency claim. Dependencies are pinned to the lockfile's exact versions, including the Baileys release candidate.

Live deployment and a fresh end-to-end acceptance test must be verified separately: `/versionz` identifies the running version/commit, `/healthz` checks HTTP liveness, and `/readyz` checks WhatsApp readiness. A ready response does not prove a particular report was delivered.

The scheduled-email design does not inherently require Looker Studio Pro; Pro's **Send now** on a schedule is handy for tests. Confirm current scheduling capabilities and quotas for the account in Google's [scheduled delivery documentation](https://docs.cloud.google.com/looker/docs/studio/schedule-automatic-report-delivery). Schedule creators may receive their own PDF copy; use a dedicated reporting account when personal inbox copies are unwanted.

Read [LOOKER_INTEGRATION_HANDOVER.md](./LOOKER_INTEGRATION_HANDOVER.md), [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) before a production rollout.
