# Supported Integration Paths

## Looker Studio

Use scheduled PDF email delivery and the Gmail-to-bot bridge described in `IMPLEMENTATION_PLAN.md`. This does not require Looker Studio Pro for a single schedule on a report, although the user must own the report or have permission to schedule it.

## Full Looker instance

Use the authenticated Action Hub endpoints when a Looker administrator can register the bot. Looker renders the PNG and pushes it directly to the bot.

## Not supported

The project does not capture report URLs with a browser and does not accept login cookies. Those approaches are deliberately excluded because they are unreliable for BI rendering and unsafe for private user sessions.
