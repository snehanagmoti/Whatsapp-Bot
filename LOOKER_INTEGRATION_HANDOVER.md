# Looker Studio to WhatsApp Handover - v1.1.0

## Release status

The repository contains v1.1.0 and regression coverage for the routing, delivery, Gmail bridge, session, request and PDF issues found during review. The local suite passed 69 tests with no failures or skips. Confirm the running commit and fresh scheduled-delivery outcome at release time; this document does not certify that the hosted service or live Apps Script has already been updated.

Dependencies are exact pins in `package.json`/`package-lock.json`, not a claim that every package is the latest upstream release. The online audit/update lookup encountered registry connection resets during preparation. A clean dependency audit remains a separate release check.

## How the implementation works

1. The operator links the bot's WhatsApp number once through the protected QR page.
2. An authorized person sends `!setupreport <name>` inside the destination chat.
3. The bot returns a plus-address. MongoDB stores the report name, chat ID and HMAC of the random token, not the recoverable alias secret.
4. The reporting account adds that alias to the Looker Studio schedule.
5. Apps Script finds qualifying PDFs after the cutover and forwards metadata/PDF bytes to `/studio/email/ingest` using the effective bearer token.
6. The server checks the token, sender, active aliases and attachment/resource limits.
7. MongoDB grants a leased delivery claim for each message/chat pair. Poppler renders the PDF once.
8. WhatsApp receives ordered images. Progress is saved after each accepted send; retries skip completed pages/chats, and stale claims can recover after their lease.

The same ingested email may reach multiple active chats. Separate copies with different Gmail IDs are independent deliveries. Use one route alias per destination chat in a schedule.

## Important corrected behavior

- Busy delivery claims return retryable HTTP 503 instead of being treated as completed duplicates. Available fan-out destinations can finish while busy ones remain eligible for retry, and claim errors release earlier claims.
- A paused alias cannot conceal an active alias for the same chat. Paused-only mail is acknowledged without sending and is not replayed automatically on resume.
- Successfully completed chats and saved pages are skipped on retries. An ambiguous WhatsApp acknowledgement or failed database checkpoint can still cause a duplicate page.
- Gmail read/unread status is irrelevant despite the historical `forwardUnreadReports` name.
- Gmail scans 500 threads by default, in pages of 50, with a seven-day lookback and `FORWARD_NOT_BEFORE` cutoff. The ledger holds 2,000 IDs in separate Script Properties.
- `Looker Report Bot/Forwarded` and `Looker Report Bot/Rejected` are informational Gmail thread labels; they do not exclude whole conversations from searches.
- HTTP 408/429/5xx and network failures remain retryable. Other 4xx responses are recorded as terminal rejections and logged.
- Session encryption is available through `WA_AUTH_ENCRYPTION_KEY`; verify it is deployed. Durable MongoDB claims, message-age checks and reconnect guards protect against replayed commands.
- Route deletion requires `!removereport <name> --confirm`. The default quota is twenty routes per chat.
- Request rate/concurrency/body limits and PDF page/geometry/pixel limits are enforced. A disconnected HTTP client does not release its processing slot prematurely.
- `/versionz` reports version/commit; `/healthz` reports liveness; `/readyz` returns 200 only while WhatsApp is connected.

## Configuration owners must preserve

- `MONGODB_URI`, `MONGODB_DB_NAME` and `WWEBJS_CLIENT_ID` identify stored state.
- `STUDIO_ROUTING_EMAIL` must match Apps Script `ROUTING_MAILBOX` without a plus tag.
- `STUDIO_ROUTE_PEPPER` must remain stable for existing aliases.
- Apps Script `BOT_INGEST_TOKEN` must equal `STUDIO_INGEST_TOKEN_OVERRIDE` when set, otherwise `STUDIO_INGEST_TOKEN`.
- `QR_SETUP_TOKEN` is separate from the optional full-Looker token and required for production QR access.
- `WA_AUTH_ENCRYPTION_KEY` must remain stable once records are encrypted. Retain it securely with recovery procedures; do not regenerate it on normal deploys.
- `STUDIO_ALLOWED_SENDERS` defaults in application startup to `data-studio-noreply@google.com`. Verify tenant senders before modifying it.
- Preserve the existing `FORWARD_NOT_BEFORE` cutover during bridge upgrades; missing values initialize to now and avoid historical replay.

See `.env.example`, `render.yaml` and [README.md](./README.md) for all limits/defaults. A Blueprint source change does not prove an existing hosted environment received every new variable.

## Release and test checklist

1. Run `npm run check`, `npm test` and `npm audit --omit=dev` with Node.js 22-24 and Poppler installed. Review CI and audit findings.
2. Commit/push the release and verify the deployed version/commit at `/versionz`.
3. Confirm required deployed variables and `/readyz`; relink only if WhatsApp needs it.
4. Save the canonical Apps Script source with a preserved cutoff and matching secrets. Keep one five-minute forwarding trigger.
5. Schedule a fresh small report in a controlled chat after the cutoff; inspect the Gmail receipt, forwarding log and WhatsApp pages.
6. Test two destinations, replay of the same message ID, busy claims, pauses, a later-page failure and reconnect recovery before broader use.

## Boundaries and handoff

The implemented controls support a controlled pilot. Production still requires approved WhatsApp transport, dedicated identities, reliable infrastructure, backup/restore, managed secrets, privacy/retention decisions, malware scanning where required, monitoring and company-tenant acceptance. A durable queue is still needed for workloads that exceed synchronous request limits.

The optional authenticated Action Hub endpoints support a separate full-Looker path; Looker Studio scheduled emails do not use them. Browser cookies, passwords, private-report login and Puppeteer screenshots are outside this implementation.

The operator owns cloud/session recovery; the reporting administrator owns Gmail, Apps Script and schedules; group administrators own their destination routes. [USAGE_GUIDE.md](./USAGE_GUIDE.md) provides user steps, and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) records the remaining limits.
