# Using the Report Bot - v1.1.0

## One-time operator setup

1. Deploy the service with the database, routing mailbox, route pepper and ingestion token configured. Preserve these values when upgrading.
2. Set a separate `QR_SETUP_TOKEN`. Open the service's `/setup/qr#<QR_SETUP_TOKEN>` page privately and link the dedicated bot number from WhatsApp > Linked devices > Link a device.
3. Check `/readyz`. HTTP 200 and `status: ready` mean the WhatsApp connection is available. `/versionz` identifies the application version and commit. These checks do not prove an individual report was sent.
4. Add the linked number to each destination group. For an individual conversation, use the actual conversation with the intended recipient.
5. In the Google account that owns the routing mailbox, open the existing Apps Script project, save `integrations/google-apps-script/Code.gs`, and configure its Script Properties:

```text
BOT_INGEST_URL=https://your-service.example.com
BOT_INGEST_TOKEN=<the service's effective Studio ingestion token>
ROUTING_MAILBOX=looker-reports@company.com
FORWARD_NOT_BEFORE=<ISO timestamp from which reports may be forwarded>
```

`BOT_INGEST_URL` is the base URL, without `/studio/email/ingest`. The bridge appends that path. The effective token is `STUDIO_INGEST_TOKEN_OVERRIDE` if populated, otherwise `STUDIO_INGEST_TOKEN`.

For a new installation, select and run `installReportForwarder` once to create one five-minute trigger. It sets a missing cutover to now. When upgrading an existing installation, preserve its cutover and existing trigger. A direct first run of `forwardUnreadReports` with no cutover sets it to now and intentionally skips the existing backlog.

Optional Script Properties are `FORWARD_MAX_THREADS_PER_RUN` (50-2000, default 500) and `FORWARD_LOOKBACK_DAYS` (1-30, default 7). Source changes must be saved in Apps Script; a GitHub push alone does not update that separate project.

## Set up a report for one chat

1. In the destination WhatsApp chat, send `!setupreport Daily Sales`.
2. Copy the complete secret email address returned by the bot.
3. In the actual Looker Studio report, open Share > Schedule delivery > Email.
4. Add that address as a recipient. Set the date, time, timezone, repeat frequency and report pages, then save.
5. At the scheduled time, Looker Studio emails a PDF to the routing mailbox. The next successful bridge run forwards it, and the bot sends each accepted PDF page as an image to the mapped chat.

`Daily Sales` is the bot's route label and image-caption prefix. It does not create a new Looker report or change the report's data. The PDF content comes from the Looker Studio report whose schedule contains the address.

## Send the same report to several chats

Run `!setupreport <name>` separately in each destination chat and add each returned alias to the same Looker Studio schedule. Keep one alias per destination chat for that schedule. Do not remove a valid address merely because it belongs to another chat.

One received email with several aliases can fan out to multiple chats. Aliases in the same received email that map to the same chat are deduplicated. Separate email copies have different Gmail message IDs and remain separate deliveries, even if their PDFs look identical. Keeping several aliases for the same chat on one schedule can therefore produce repeated images.

## What the email address means

`looker-reports+random-token@company.com` is an alias of the configured routing mailbox, not a new mailbox for every chat. The token tells the bot which chat should receive the report; it must be treated as a secret.

The pilot used `@iitbhilai.ac.in` because its configured routing mailbox belonged to that domain. The bot does not require IIT Bhilai's domain. A different mailbox that supports the required alias delivery can be configured for a company deployment. The mailbox's base address must match in the service and Apps Script.

Group members do not need to receive the PDF in their email inboxes. Looker Studio may still send a copy to the account creating the schedule. Use a dedicated reporting account if that personal inbox copy is unwanted. An alias does not prevent mail arriving in its underlying mailbox.

## Commands

```text
!setupreport <name>             Create a route in the current chat
!listreportlinks               List route names/statuses in the current chat
!pausereport <name>             Skip future mail for that route
!resumereport <name>            Accept future eligible mail again
!rotatereport <name> --confirm  Replace a route's secret email address
!removereport <name> --confirm  Permanently remove that route
!chatid                        Show the current WhatsApp chat ID
!help                          Show this command list
```

The linked bot account, verified group administrators and identities in `STUDIO_ROUTE_ADMIN_IDS` can manage routes. Other users cannot configure an individual chat unless explicitly authorized. The default quota is twenty routes per chat. Removal and rotation without `--confirm` only return confirmation instructions — rotation immediately invalidates the current address, so any Looker Studio schedule still using it stops delivering until it is updated with the new one.

## Admin dashboard

The same route management is also available as a web dashboard at `/admin/` on the deployed service, for operators who manage several chats and would rather not do it one WhatsApp command at a time.

1. Set `STUDIO_ADMIN_TOKEN` (a separate secret from `QR_SETUP_TOKEN` and `STUDIO_INGEST_TOKEN`) and open `https://your-service.example.com/admin/`.
2. Paste the token into the unlock screen. It is kept only in the browser (session storage by default, or local storage if "Remember on this device" is checked) and sent as a bearer token to `/admin/api/*` — it is never written to any log or database.
3. The dashboard shows WhatsApp link status (with the linking QR code inline when not connected), lets you create/pause/resume/rotate/remove report routes across every chat the bot knows about, and shows recent delivery outcomes per chat.
4. As with the WhatsApp commands, a route's address is shown once, right after creation or rotation — treat it as a secret and add it straight to the Looker Studio schedule. The server never stores or re-displays the plaintext address.

The dashboard calls the same `routeService` used by WhatsApp commands, so routes created one way are immediately visible and manageable the other way.

The bot stores an HMAC of each token, so the list command cannot recover the original alias. If the alias is lost or exposed, rotate it and replace the old schedule recipient with the new address. Rotation invalidates the previous address. `!chatid` is useful for diagnostics and the optional full-Looker Action Hub; alias-based Studio setup already captures the destination automatically.

Pausing intentionally acknowledges and skips that mail. Resuming does not automatically send the PDFs missed while paused. Schedule a fresh delivery to test resumed routing.

## Before your acceptance test

Use a controlled chat and a small report: the supplied limits are five pages, 15 MiB PDF input, 7 MiB per rendered image, a maximum rendered dimension of 2,400 pixels and 20 million total pixels. Documents beyond the limits are rejected, not silently truncated.

Confirm the deployed version and readiness, the saved Apps Script source, the mailbox account, matching ingestion token, preserved cutover and the exact active alias. Then schedule one new delivery after the cutover. Check the mail receipt, bridge outcome and WhatsApp images in that order. Repeat with a second chat and a multi-page report.

The local suite passed 69 tests without failures or skips during release preparation. Real email receipt, hosting availability and WhatsApp delivery still need this end-to-end acceptance test.

## If the email arrives but the images do not

1. Open the existing Apps Script project in the routing mailbox's Google account. If the project is missing, check the selected account before creating anything new.
2. Open Executions. Confirm the five-minute trigger runs. An execution marked `Completed` only means the function finished; it may have skipped all messages.
3. Expand the latest execution and inspect its forwarding/rejection log. A manual `forwardUnreadReports` run can retry eligible mail; it cannot bypass the cutover or processed-message ledger.
4. Check `/readyz` and `/versionz`, then the service logs for the matching Gmail message ID. Never publish the bearer token or secret routing address in a shared log.
5. Interpret the response: 401 means token mismatch; 403 means sender rejection; 404 means no matching route; 413 means an oversized HTTP body; 429 means rate limiting; 503 means disconnected, unavailable or busy processing; 502 usually means conversion or sending failed.
6. Network failures, 408, 429 and 5xx remain eligible for retry. Other 4xx responses are recorded as terminal. Correct the cause and use a fresh scheduled delivery; do not erase the whole processed ledger to force a resend.

The bridge searches read and unread mail. It scans recent threads in pages of fifty, up to five hundred by default. Gmail thread labels `Looker Report Bot/Forwarded` and `Looker Report Bot/Rejected` are informational; a conversation may contain several messages with different outcomes. The labels are not used to exclude whole conversations.

An active processing lease receives a retryable response. If the service dies, a subsequent bridge attempt can reclaim it after the lease expires (ten minutes in the supplied deployment configuration). Saved successful pages and completed chats are skipped on retry. An ambiguous WhatsApp acknowledgement can still cause one repeated page.

## Optional simulator

`scratch/test_studio_email_delivery.js` sends a synthetic PDF to the configured real destination, so only run it for a controlled test. Configure `PUBLIC_BASE_URL`, `STUDIO_INGEST_TOKEN`, `STUDIO_TEST_ROUTING_EMAIL` and `STUDIO_TEST_SENDER`. The sender must match the service's approved sender list. It tests the HTTP/PDF/WhatsApp path, not Gmail or Looker scheduling.

See [RISKS_AND_LIMITATIONS.md](./RISKS_AND_LIMITATIONS.md) for operational limits and [LOOKER_INTEGRATION_HANDOVER.md](./LOOKER_INTEGRATION_HANDOVER.md) for release ownership.
