# Risks and Limitations

## Looker Studio integration boundary

Looker Studio has no documented private Action Hub mechanism. The bot cannot appear as a custom WhatsApp destination beside its native Slack destination. Users must configure an email delivery to the generated routing address.

## PDF rather than native screenshot

Looker Studio schedules a PDF. Poppler converts its pages to PNG, so the WhatsApp image represents the scheduled PDF layout rather than an interactive browser viewport. Complex reports can time out or contain chart errors before the email reaches the bot.

## Routing address secrecy

A generated routing address is a bearer capability. Anyone who obtains it may attempt to inject a PDF into the destination. Routes are random, hashed at rest, allowlisted, rate-limited operationally, and revocable, but production should additionally validate the genuine Looker Studio sender and use first-delivery approval.

## Email delivery delay and duplication

Email and Apps Script are not real-time. Apps Script may run several minutes late and may retry. MongoDB message-ID claims prevent completed or concurrent duplicate deliveries, while failed deliveries can be retried.

## Free-tier reliability

Render free services sleep and may cold-start during a scheduled delivery. Apps Script and Gmail have execution quotas. MongoDB M0 lacks production guarantees. These components are suitable for demonstration, not an SLA-backed service.

## WhatsApp transport

Baileys is an unofficial WhatsApp Web protocol implementation. WhatsApp changes can break it, and the linked number can be restricted. Use a dedicated prototype number. Production should use the official WhatsApp Business Platform if its recipient and group capabilities satisfy the company requirement; otherwise the residual risk requires formal approval.

## Authorization

Group-administrator checks depend on WhatsApp metadata. Individual-chat route creation must be restricted through `STUDIO_ROUTE_ADMIN_IDS`. Production should connect route management to corporate identity and preserve an audit trail when staff change roles.

## Data exposure

Scheduled PDFs may contain confidential data. The routing mailbox, ingestion service, temporary files, logs and WhatsApp destination must all follow company classification and retention rules. The converter deletes temporary files after processing, but backup, crash-dump and observability configuration also require review.

## Scale

Dynamic routing avoids physical alias limits, but the mailbox, PDF renderer, memory, database and WhatsApp throughput remain finite. Production needs bounded page and file sizes, a durable queue, concurrency controls, rate limits, backpressure and failure alerts.
