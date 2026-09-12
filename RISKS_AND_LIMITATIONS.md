# Risks, Controls and Remaining Limits - v1.3.0

## Release scope

This release repairs the reviewed routing, retry, command-replay, session-storage and PDF-resource issues, adds the admin dashboard, and adds a durable delivery retry/dead-letter layer (see below). The local suite passed 88 tests with no failures or skips, including real Poppler conversion and HTTP ingestion. Tests use controlled external-service substitutes; they do not certify delivery through the user's live Gmail, Render, MongoDB and WhatsApp accounts.

The online dependency audit/update lookup encountered npm registry connection resets during preparation. Exact package pins and a lockfile are committed, and CI runs a production audit. No claim of zero vulnerabilities or latest upstream dependencies is made without a successful registry check.

## Delivery reliability controls

- Delivery identity includes the Gmail message ID and destination chat. One ingested email may reach several distinct chats, with independent completion records.
- Active routes are selected before destination deduplication. A paused alias cannot conceal an active alias for the same chat.
- MongoDB uses leased claims with ownership tokens. Only a confirmed delivered record receives a duplicate acknowledgement; a busy lease remains retryable with HTTP 503.
- Failed or abandoned processing can be reclaimed. The supplied deployment lease is ten minutes; the code fallback without configuration is fifteen minutes.
- Accepted pages are checkpointed. A later-page retry resumes at the first unsaved page, and completed destinations are skipped.
- A failed destination does not prevent other available destinations from completing. Claim-lookup errors release earlier acquired claims.
- HTTP disconnects keep their processing slot until work ends, preventing callers from bypassing concurrency limits by closing the connection.

WhatsApp sending and MongoDB progress cannot be committed as one transaction. If WhatsApp accepts a page but its acknowledgement or database checkpoint is lost, retry can repeat that page. The bot does not verify recipient delivery/read receipts. The count saved means the send call completed, not that a person opened the image.

A failed or abandoned delivery is no longer solely dependent on the upstream Gmail bridge resending the source email; see "Delivery retries and dead-lettering" below for the background worker that retries it directly.

Deduplication does not merge separate Gmail message IDs. If a schedule sends separate copies to multiple aliases for the same chat, repeated-looking images can be expected. Use one alias per chat per schedule. Delivery records expire after ninety days; replay protection is bounded by retention.

## Gmail and scheduling limits

The bridge polls every five minutes. A configured cutoff prevents historical backlog replay, and a missing cutoff is initialized to now. Preserve the cutoff on upgrades. Mail earlier than the cutoff is intentionally excluded.

The default query has a seven-day lookback and scans up to five hundred threads in pages of fifty. The cap is configurable from fifty to two thousand; the lookback can be one to thirty days. Extremely busy mailboxes can hide older eligible threads beyond the configured cap. Apps Script execution and service quotas can also interrupt large runs.

The bridge retains two thousand processed IDs in twenty Script Properties. Gmail labels are informational at the thread level and are not used as an exclusion filter. The MongoDB ledger provides additional duplicate protection when an older Gmail ID leaves the script's bounded ledger.

Network errors, HTTP 408/429 and 5xx are retryable. Other 4xx responses are recorded as terminal rejections. Correcting a token, sender or route after a terminal rejection does not automatically replay that email. Likewise, paused-only mail is acknowledged and skipped; resuming a route does not replay paused mail. Use a fresh controlled scheduled delivery after correcting configuration.

Looker Studio controls PDF contents, selected pages, filters, data freshness and schedule timezone. A bot route name does not create or select a Looker report. Schedule creators may receive their own email copy. A dedicated reporting account is the appropriate operational arrangement when personal inbox copies are unwanted.

## Access and session security

The ingestion endpoint requires a bearer token and checks the approved sender list, defaulting in application startup to `data-studio-noreply@google.com`. A forwarded `From` field is metadata, not independent cryptographic proof of the sender. Security depends on the trusted mailbox/bridge, ingestion token and secret alias as well as the allowlist.

Route tokens are random and stored as HMACs with a stable pepper. Exposing an alias can allow report injection through the mailbox path if other controls are compromised. Treat aliases as secrets, rotate exposed routes and replace the old schedule recipients. A changed pepper invalidates all existing aliases; never regenerate it on routine deployment.

The linked bot account, verified group administrators and configured explicit administrators can manage routes. Default route quota is twenty per chat, with serialized creation inside one process. Multiple application instances would need a database-level quota mechanism. Deletion requires an explicit `--confirm` command.

WhatsApp commands have ID/timestamp checks, stale-socket guards, in-memory deduplication and a persistent MongoDB claim ledger. The default maximum command age is twenty-four hours; persistent claims expire after seven days. A durable claim is made before executing the command, so an interrupted command can require the operator to send a fresh command with a new message ID.

Session records can be encrypted with AES-256-GCM using `WA_AUTH_ENCRYPTION_KEY`. Existing plaintext records migrate on read after the key is configured. Encryption is optional for backward compatibility, so deploying the code alone does not prove the hosted key is set. Preserve and back up the original key securely. Wrong or missing keys fail to decrypt encrypted records and can require controlled session recovery/relinking.

The production QR endpoint requires its separate `QR_SETUP_TOKEN`; the full-Looker action token is not a production fallback. QR codes are sensitive, short-lived link credentials. They must not be committed to GitHub or copied into shared reports. The current runtime can still print linking QR codes in private operator logs, so access to logs must be restricted.

## Admin dashboard

The `/admin/` dashboard and its `/admin/api/*` endpoints require a third, independent bearer token (`STUDIO_ADMIN_TOKEN`), rate-limited and compared with the same timing-safe check used elsewhere. It is deliberately separate from `QR_SETUP_TOKEN` and `STUDIO_INGEST_TOKEN` so an operator credential for full route management is never the same secret handed to someone who only needs to complete the WhatsApp link, or the one Apps Script uses to post reports.

The dashboard is a thin client over the existing `routeService`/`studioStore` methods used by the WhatsApp commands — it does not add a second source of truth, a database session, or server-side cookies. The token lives only in the browser (`sessionStorage`, or `localStorage` if the operator opts in) and is sent as a bearer header; it is never logged or persisted server-side. As with the WhatsApp flow, route addresses are returned once at creation/rotation time and are never stored or re-displayed in plaintext — the dashboard cannot show an existing route's address, only issue a new one via rotation.

This is still a shared-secret model, not per-operator accounts: anyone with the token has full route management for every chat the bot serves, and the token cannot be scoped or individually revoked without rotating it for all operators. A company rollout wanting per-person audit trails or scoped access needs real authentication (e.g. OIDC/SSO) in front of `/admin/`, which is out of scope for this release.

## Delivery retries and dead-lettering

Report processing still happens inline in the HTTP ingest request for the common case - this keeps latency low and leaves the Apps Script response contract (the documented 401/403/404/413/429/502/503 meanings) unchanged. What changed is what happens when that inline attempt does not finish cleanly.

Every claimed delivery now stores its own copy of the source PDF (as MongoDB binary data on its delivery record) at claim time, before rendering or sending starts. A background worker inside the same process (`studioDeliveryWorker.js`) runs on a fixed interval (`STUDIO_DELIVERY_WORKER_INTERVAL_MS`, default 60 seconds) and picks up: deliveries left in `failed` status once their backoff has elapsed, and deliveries stuck in `processing` past their lease - the signature of a process that crashed or was redeployed mid-send. Neither case depends on Apps Script or the Gmail bridge resending the source email; the stored PDF is enough to retry independently.

Retries use exponential backoff from `STUDIO_DELIVERY_RETRY_BASE_MS` (default 60 seconds, doubling each attempt, capped at 30 minutes) and are bounded by `STUDIO_DELIVERY_MAX_ATTEMPTS` (default 6, counting the original attempt). A delivery that exhausts its attempts moves to a terminal `dead_letter` status: it stops being retried, releases its stored PDF bytes, and remains visible with its last error in `/admin/api/deliveries` and the admin dashboard for manual follow-up. There is currently no automated alert when a delivery reaches `dead_letter` - an operator has to check the dashboard to notice one.

What this still does not provide: a separate worker process or dyno (it runs in the same Node process as the HTTP server and the WhatsApp client, so a full service crash pauses both the API and the retry sweep until Render restarts it, at which point the worker resumes from MongoDB's persisted state), true concurrent workers (Render's free/starter tier runs one instance, and the design assumes that), a dead-letter *queue* in the message-broker sense (it is a status on the existing delivery record, not a separate durable queue with its own consumers), or delivery ordering guarantees across retries.

## PDF and resource controls

The supplied defaults limit PDF input to 15 MiB, reports to five pages, rendered images to 7 MiB each, each image dimension to 2,400 pixels and total output to twenty million pixels. PDF metadata is checked before conversion. Documents beyond page or geometry limits are rejected rather than truncated. DPI is reduced within supported bounds when necessary.

Poppler inspection/conversion has timeouts and bounded command output. PNG signature, dimensions and file size are checked before use; temporary files are removed after processing. These controls reduce resource abuse but do not provide antivirus scanning, content moderation or an independent sandbox for malicious PDFs. Keep the operating system and Poppler patched.

Authenticated Studio requests are limited to thirty per minute and two concurrent requests in the supplied configuration. The HTTP body cap is 22 MiB. Base64 expansion means the HTTP cap must be considered alongside the PDF cap. Large or slow reports can still exhaust a small free-tier service; increasing limits needs capacity testing.

Only the first PDF attachment is processed by the current email service. The supported workflow is one scheduled report PDF per email. The renderer sends images, not interactive dashboards, clickable charts or the original PDF attachment.

## Platform and production limits

Baileys is an unofficial WhatsApp integration and its pinned package is a release candidate. WhatsApp protocol or account changes can interrupt service. Reconnect backoff and persisted sessions reduce disruption, but do not establish a service guarantee. Official Business Platform suitability must be evaluated against the actual chat/destination requirements.

The Render free-tier Blueprint, Apps Script polling and MongoDB availability form a pilot arrangement. Cold starts, platform outages, resource limits, revoked account access and disconnected linked devices can delay reports. `/healthz` only proves HTTP liveness; `/readyz` proves current WhatsApp connection state; `/versionz` identifies the running code. None proves an individual report was delivered.

Report processing still starts inline inside the HTTP request, but a failed or interrupted delivery is now retried by an in-process background worker with backoff and a bounded attempt count, ending in a terminal `dead_letter` status rather than being lost or retried forever - see "Delivery retries and dead-lettering" above. This is not the same as an independent worker process, a message-broker-style queue, or horizontally scaled workers: it is one worker loop inside the same Node process as the HTTP server, backed by MongoDB for durability across restarts. The Gmail bridge separately supplies its own retries within its cutoff/lookback/scan bounds for cases the delivery worker cannot help with (for example, a route that did not exist yet when the email first arrived). Production volume at real scale still benefits from a dedicated queueing system, always-on multi-instance capacity, monitoring/alerting on `dead_letter` deliveries, and tested recovery drills - none of which this release adds.

Company rollout also needs owned service identities, secret management, backup/restore exercises, account recovery, destination/access reviews, confidential-data handling, retention rules and incident response. No paid infrastructure, new company accounts or official WhatsApp migration is silently included in this release.

## Acceptance and recovery

Verify the live version/commit, deployed secrets/configuration and preserved Apps Script source/cutoff. Schedule a fresh small report after the cutoff to a controlled chat, then verify the PDF email, forwarding log and every WhatsApp page. Test a second chat, busy/stale claims, later-page retry, pause/resume and restart recovery before broader use.

When diagnosing missing delivery, correlate the Gmail message ID across Apps Script and service logs. Do not delete all routes, aliases or the entire processed ledger as a general recovery step. Correct the specific error, preserve valid aliases for other chats and use a new controlled delivery where appropriate.

The regenerated PDF is a readable companion to this file. The source code, configuration files and recorded release checks remain the implementation evidence. See [USAGE_GUIDE.md](./USAGE_GUIDE.md) and [LOOKER_INTEGRATION_HANDOVER.md](./LOOKER_INTEGRATION_HANDOVER.md) for operator steps.
