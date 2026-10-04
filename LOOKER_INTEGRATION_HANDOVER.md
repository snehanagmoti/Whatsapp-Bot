# Looker Studio to WhatsApp Handover - v1.6.0

## Release status

The repository contains v1.6.0 with regression coverage for the routing, delivery, Gmail bridge, session, request, PDF and dashboard behaviour: 153 tests, of which 142 passed, 0 failed and 11 were skipped locally; the skipped ones are MongoDB integration tests that CI runs against a real MongoDB server. Confirm the running commit (`/versionz`) and a fresh scheduled-delivery outcome at release time; this document does not certify that the hosted service or live Apps Script has already been updated.

Dependencies are exact pins in `package.json`/`package-lock.json`, not a claim that every package is the latest upstream release. CI runs a production dependency audit on every pull request.

## How the implementation works

1. The operator links the bot's WhatsApp number once by scanning the QR code in the admin dashboard (`/admin/`, `STUDIO_ADMIN_TOKEN`).
2. Anyone in the destination chat sends `!setupreport <name>` there, or creates the route in the chat dashboard (`/chat/`) with that chat's ID.
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
- Anyone in a chat can use every report command for that chat; there is no group-admin check. The chat dashboard (`/chat/`) logs in with a chat ID only and is limited to that chat; anyone who knows a chat ID can manage its reports (accepted risk).
- Route deletion requires `!removereport <name> --confirm`. The default quota is twenty routes per chat.
- Request rate/concurrency/body limits and PDF page/geometry/pixel limits are enforced. A PDF that breaks a limit gives up at once (HTTP 422, `dead_letter`). A disconnected HTTP client does not release its processing slot prematurely.
- A wrong or missing ingest token answers HTTP 503 with `Retry-After: 300`, so the bridge retries until the tokens match.
- `/versionz` reports version/commit; `/healthz` reports liveness; `/readyz` returns 200 only while WhatsApp is connected.
- Dead-lettered deliveries are terminal at ingest (HTTP 422), keep their PDF for seven days, can be retried from either dashboard and send a short note with the reason to the chat that was waiting (10 per 10 minutes at most).
- Background retries work against MongoDB (v1.5.0 fixed stored PDFs being returned as BSON Binary) and share one backoff schedule with bridge retries; mid-send WhatsApp disconnects do not use up attempts.
- Each email's PDF is stored once for all destination chats.
- Signal key material is redacted from logs; logout recovery offers a fresh QR in the admin dashboard without a restart; LID chat IDs are accepted.
- The Node heap limit is 256 MB (start script and `NODE_OPTIONS`), with an hourly `Memory: heap ...` log line.
- The Gmail bridge (v1.3.0) checkpoints its ledger, bounds its runtime and, by default, pings `/healthz` so Render's free tier does not sleep.

## Configuration owners must preserve

- `MONGODB_URI`, `MONGODB_DB_NAME` and `WWEBJS_CLIENT_ID` identify stored state.
- `STUDIO_ROUTING_EMAIL` must match Apps Script `ROUTING_MAILBOX` without a plus tag.
- `STUDIO_ROUTE_PEPPER` must remain stable for existing aliases.
- Apps Script `BOT_INGEST_TOKEN` must equal `STUDIO_INGEST_TOKEN_OVERRIDE` when set, otherwise `STUDIO_INGEST_TOKEN`.
- `STUDIO_ADMIN_TOKEN` protects the admin dashboard, the only place to link WhatsApp. It is safe to change; log in again afterwards.
- `WA_AUTH_ENCRYPTION_KEY` must remain stable once records are encrypted; changing it or `WWEBJS_CLIENT_ID` forces a WhatsApp relink. Retain it securely with recovery procedures; do not regenerate it on normal deploys.
- `STUDIO_ALLOWED_SENDERS` defaults in application startup to `data-studio-noreply@google.com`, the verified sender of Looker Studio scheduled emails.
- Preserve the existing `FORWARD_NOT_BEFORE` cutover during bridge upgrades; missing values initialize to now and avoid historical replay.
- Remove from the hosted environment if present (no longer used): `QR_SETUP_TOKEN`, `PUBLIC_BASE_URL`, `LOOKER_ACTION_TOKEN`, `LOOKER_ALLOWED_CHAT_IDS`, `LOOKER_MAX_IMAGE_BYTES`, `LOOKER_RATE_LIMIT_PER_MINUTE`, `STUDIO_ROUTE_ADMIN_IDS`, `STUDIO_ALLOW_PUBLIC_SETUP`, `STUDIO_ALERT_CHAT_ID`.
- Optional: `STUDIO_DEAD_LETTER_RETENTION_MS` (retry window, default 7 days), `STUDIO_ADMIN_RATE_LIMIT_PER_MINUTE` (admin and chat dashboards, default 60), and the bridge's `KEEP_SERVICE_AWAKE` (default true; mind Render's 750 free hours per workspace).

See `.env.example`, `render.yaml` and [README.md](./README.md) for all limits/defaults. A Blueprint source change does not prove an existing hosted environment received every new variable.

## Release and test checklist

1. Run `npm run check`, `npm test` and `npm audit --omit=dev` with Node.js 22-24 and Poppler installed. Review CI and audit findings.
2. Commit/push the release and verify the deployed version/commit at `/versionz`.
3. Confirm required deployed variables and `/readyz`; relink only if WhatsApp needs it. Render deploys are manual unless Auto-Deploy is enabled for the service.
4. Save the canonical Apps Script source with a preserved cutoff and matching secrets. Keep one five-minute forwarding trigger.
5. Schedule a fresh small report in a controlled chat after the cutoff (Looker Studio Pro's **Send now** is handy); inspect the Gmail receipt, forwarding log and WhatsApp pages.
6. Test two destinations, replay of the same message ID, busy claims, pauses, a later-page failure, a PDF over the page limit (expect 422 and a note in the chat), the chat dashboard and reconnect recovery before broader use.

## Boundaries and handoff

The implemented controls support a controlled pilot. Production still requires approved WhatsApp transport, dedicated identities, reliable infrastructure, backup/restore, managed secrets, privacy/retention decisions, malware scanning where required, monitoring and company-tenant acceptance. Failed or stuck deliveries retry automatically with backoff, dead-letter after exhausting their attempts, tell the affected chat and can be retried from either dashboard (see RISKS_AND_LIMITATIONS.md); a separate worker process and message-broker-style queueing are still needed for workloads that exceed one instance's synchronous request capacity.

The full-Looker Action Hub endpoints were removed in v1.6.0: the company uses Looker Studio / Looker Studio Pro, which has no Action Hub (that belongs to the separate paid Looker product). Browser cookies, passwords, private-report login and Puppeteer screenshots are outside this implementation.

The operator owns cloud/session recovery; the reporting administrator owns Gmail, Apps Script and schedules; the members of each chat manage that chat's routes. [USAGE_GUIDE.md](./USAGE_GUIDE.md) provides user steps, and [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) records the remaining limits.
