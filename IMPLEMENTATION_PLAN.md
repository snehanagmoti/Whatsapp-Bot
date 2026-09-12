# Implementation and Rollout Plan - v1.1.0

## Objective

Deliver scheduled Looker Studio PDF pages to the correct WhatsApp chats using secret routing aliases, recoverable delivery state and bounded resource consumption.

## Implemented pipeline

```text
Operator links one dedicated WhatsApp number by protected QR
  -> MongoDB persists the session and command replay claims

Reporting account owns a routing mailbox and Apps Script trigger
  -> administrator creates a route in each destination chat
  -> alias is added to the Looker Studio email schedule

Looker Studio sends PDF email
  -> bridge checks recipient and cutover, then authenticates to the service
  -> service validates sender, alias, attachment and request limits
  -> active aliases resolve to distinct WhatsApp chats
  -> each Gmail-message/chat pair gets a leased MongoDB claim
  -> Poppler preflights and renders the PDF once
  -> each page is sent and its progress recorded
  -> completed chats are skipped on replay; failed chats resume
```

## Completed code controls

- Message/chat delivery identity, legacy-record compatibility, stale lease recovery, claim ownership and per-page checkpoints.
- Explicit claimed, delivered and busy states: in-progress work receives retryable HTTP 503, not a false completed acknowledgement. Claim failures release earlier claims.
- Multiple active destinations; paused aliases do not suppress active aliases for the same chat.
- Required ingestion token and an application default sender allowlist.
- Bounded authenticated HTTP bodies, 30 requests/minute and two concurrent Studio requests in the supplied configuration. Processing retains its slot after a client disconnect until work ends.
- Twenty routes/chat by default, authorized management and `--confirm` for removal.
- Dedicated production QR credential; no production fallback to the full-Looker token.
- Optional AES-256-GCM encryption of MongoDB WhatsApp credentials, plaintext migration on read and durable seven-day message replay claims by default.
- WhatsApp command freshness validation, stale socket-listener guards and reconnect backoff.
- PDF page-count/geometry/pixel checks, renderer timeouts, image-size/signature validation and temporary-directory cleanup.
- A five-minute Gmail bridge with 50-thread pagination, default 500-thread cap, seven-day lookback, 2,000-ID ledger, cutover control, outcome logging and retryable/permanent HTTP classification.
- Exact package versions, Node.js 22-24 engine range, CI and a version/commit endpoint.

The local release suite passed 69 tests without failures or skips. These checks do not substitute for deployment verification or the user's fresh scheduled-delivery test.

## Synchronize the release

1. Run syntax checks and the regression suite with Poppler installed. Run the production dependency audit when registry access is available; the preparation attempt hit connection resets.
2. Review the diff, commit v1.1.0 and push the intended deployment branch without overwriting unrelated changes.
3. Verify the deployed environment against `.env.example` and `render.yaml`. Preserve the effective ingestion token, route pepper, database/session identity and encryption key.
4. Confirm the live `/versionz` version and commit match the release; confirm `/readyz` returns HTTP 200. `/healthz` alone is insufficient.
5. Preserve the existing bridge cutover in Script Property `FORWARD_NOT_BEFORE` when upgrading. A missing property initializes to now; a direct first run deliberately does no forwarding.
6. Replace Apps Script source with `integrations/google-apps-script/Code.gs`, save, and confirm the existing five-minute trigger. Existing secrets and a valid cutover remain in Script Properties. Run the installer when installing/recreating the trigger.
7. Perform the acceptance tests below and record actual outcomes. Do not infer successful delivery from an Apps Script execution marked only "Completed".

## Acceptance tests

1. Create a fresh route in a controlled chat and schedule a small genuine Looker Studio PDF after the configured cutover.
2. Verify the PDF arrived at its exact alias, the bridge logged an outcome, and the intended WhatsApp chat received every page in order.
3. Create one alias in a second test chat and add both aliases to a schedule. Confirm both destinations receive the report. Use only one alias per chat per schedule to avoid separately generated copies.
4. Re-submit the same Gmail message ID through a controlled test and confirm completed destinations are skipped while still-processing destinations return a retryable result.
5. Exercise a later-page failure and a single-destination failure; verify retry resumes after saved pages and does not repeat a completed chat.
6. Verify paused-only mail is skipped, an active alias remains effective alongside a paused alias for the same chat, and resuming affects future eligible mail.
7. Exercise stale processing recovery, rejected tokens/senders, unknown aliases, oversized/invalid PDFs, request limits and WhatsApp disconnection in a test environment.
8. Restart the service; confirm session restoration and command replay suppression without executing old management commands again.

## Production work requiring infrastructure or organizational choices

- Decide whether the official WhatsApp Business Platform supports the required destination model; otherwise approve the residual Baileys risk before company use.
- Assign a company-owned WhatsApp number, reporting mailbox, administrators and recovery ownership.
- Use always-on compute and production database backups, restore testing and monitored capacity.
- ~~Introduce a durable queue and workers for workloads that cannot fit synchronous HTTP requests.~~ Partially addressed in v1.3.0: a background worker now retries failed/stuck deliveries with backoff and moves exhausted ones to a terminal `dead_letter` status (see RISKS_AND_LIMITATIONS.md). Still missing: a separate worker process/dyno, horizontally scaled workers, and true message-broker-style queueing for workloads that exceed one instance's synchronous request capacity.
- Add malware/content scanning, centralized alerts, delivery visibility and audited administration as required by company reports.
- Apply managed secret storage, access review and documented key/pepper rotation and account-recovery procedures.
- Define confidential-data, destination, retention and incident-response policies.
- Replace polling with Gmail API notifications or supported inbound email when volume or latency requires it.
- Verify the company's current Looker Studio schedule, frequency, recipient and sharing constraints before purchasing upgrades.

## Remaining practical limits

WhatsApp sends and database checkpoints cannot be committed as one transaction. If WhatsApp accepts a page and the acknowledgement or checkpoint is lost, a retry may repeat that page. Deduplication is bounded by record retention and does not merge separate Gmail message IDs.

Route quotas are serialized within one application process; scaling to multiple instances needs a database-level quota mechanism. The supplied setup assumes one bot instance. A permanent rejection is recorded by the bridge, and paused mail is acknowledged; correcting configuration does not automatically replay those emails. Use a fresh controlled delivery for recovery testing.

The removed cookie-import, private-login and browser-screenshot designs are not fallback modes.
