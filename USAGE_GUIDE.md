# Usage and No-Pro Testing Guide

## Create a destination from WhatsApp

Add the bot to the intended group and, as a group administrator, send:

```text
!setupreport Daily Sales
```

The bot returns a private routing address similar to:

```text
looker-reports+random-token@company.com
```

Available management commands:

```text
!listreportlinks
!pausereport Daily Sales
!resumereport Daily Sales
!rotatereport Daily Sales
!removereport Daily Sales
```

Only an authorized user, a WhatsApp group administrator, or the linked bot account can manage routes. Treat each routing address as a secret.

## Use it with Looker Studio

Open the report and select **Share → Schedule delivery → Email**. Add the generated routing address, choose the pages and filters, and save the schedule. Looker Studio emails a PDF; the bridge converts up to `STUDIO_MAX_PAGES` pages to PNG and delivers them in order.

The free Looker Studio tier supports a single scheduled email per report, so Looker Studio Pro is not required for this path. Pro is required for multiple schedules and the immediate **Send now** scheduling feature.

## Test without Looker Studio Pro

### Test 1: automated tests

Run `npm test`. The suite verifies route creation and authorization, sender and attachment validation, pausing and rotation, ordered delivery, duplicate suppression, retries, the Apps Script bridge, and HTTP error handling. When Poppler is available it also performs a real generated-PDF-to-PNG conversion and an end-to-end HTTP ingestion test with a mocked WhatsApp destination.

### Test 2: deployed simulator

1. Create a route with `!setupreport Test Report`.
2. Copy the returned routing address.
3. On the machine running the test script, set `PUBLIC_BASE_URL`, `STUDIO_INGEST_TOKEN`, and `STUDIO_TEST_ROUTING_EMAIL`.
4. Run `node scratch/test_studio_email_delivery.js`.

The script creates a valid one-page test PDF and submits the same payload that the Gmail bridge sends. Successful delivery proves the deployed endpoint, token, route lookup, Poppler conversion, MongoDB deduplication and WhatsApp send path.

### Test 3: free Gmail bridge

1. Create a standalone Google Apps Script project while signed into the routing mailbox.
2. Paste `integrations/google-apps-script/Code.gs` into the project.
3. In **Project Settings → Script Properties**, add:
   - `BOT_INGEST_URL`: the Render service base URL.
   - `BOT_INGEST_TOKEN`: the same value as `STUDIO_INGEST_TOKEN` in Render.
   - `ROUTING_MAILBOX`: the base mailbox without a plus token.
4. Run `installReportForwarder` once and approve Gmail and external-request access.
5. Email any small PDF manually to the routing address returned by `!setupreport`.

The script checks unread PDF messages every five minutes. It leaves a message unread when delivery fails so it can retry; the backend uses the Gmail message ID to prevent duplicate WhatsApp sends.

### Test 4: real free Looker Studio email

If you own or can copy a test report, create its one allowed scheduled email delivery to the generated route. Set the nearest available daily time. This tests a genuine Looker Studio-generated PDF without a Pro subscription. If you only have Viewer access to the mentor's public report, ask for scheduling permission or make an authorized copy. Do not claim full acceptance until this real delivery succeeds; local fixtures cannot prove the sender headers or company sharing policies used by the real service.

## Operational checks

- `/healthz` confirms that the server is running.
- `/readyz` returns HTTP 200 only when WhatsApp is connected.
- Rotate a route immediately if its address is posted publicly.
- Leave `STUDIO_ALLOWED_SENDERS` empty only during controlled testing. Configure the exact genuine Looker Studio sender address before production.
