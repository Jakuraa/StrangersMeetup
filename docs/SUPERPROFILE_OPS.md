# SuperProfile operations

How tickets and memberships are sold through SuperProfile, what the SuperProfile MCP can and cannot do, and how the app stays in sync. The runtime path never touches the MCP.

## Two separate things called "SuperProfile integration"

| | Runtime sync | Agent-time ops |
|---|---|---|
| What | SuperProfile notification → Zapier/Pabbly (or a native webhook) → `POST /api/webhooks/superprofile` | Claude Code with the SuperProfile MCP (`https://mcp.superprofile.bio/mcp`) |
| Runs | In production, on every sale/refund | When the owner asks, and in the daily reconciliation task |
| Auth | Shared secret in `X-Webhook-Secret` (`SUPERPROFILE_WEBHOOK_SECRET`) | OAuth with the owner's approval; publishing needs owner approval |
| Called from Vercel? | Yes (inbound only) | **Never.** The MCP needs the owner's OAuth session; the app must not hold it. |

## What the MCP can do (and the limits)

Status: **UNVERIFIED in this repo.** The MCP was not connected to the session that wrote this document, so none of the capability claims below were checked against `get_*_context` output. Treat them as the owner's description until the checklist in "First connection" is completed.

Owner-described permissions on account `Meetup_Host`: Payment Pages, Webinars & events (including check-in), Bookings, Telegram communities (manage members), Digital products, Customers, Analytics.

Known constraints:
- OAuth with owner approval; **publishing a product needs the owner's explicit approval**. Agents create **drafts only**, using the prepare → commit flow and polling `get_operation`.
- No webhooks are documented for the MCP. Sales therefore reach the app through Zapier/Pabbly (below), not through the MCP.
- Agents never publish, delete, or change payout/KYC/bank details without the owner approving that specific action in the session.

### First connection (run once, report the answers here)
Call the context tools first and record the real answers; never guess tool names.
1. `get_webinar_context`, `get_product_context`, `get_booking_context`, `get_telegram_community_context` (and the payment-page context if one exists).
2. Record: which product type supports an **in-person** event with quantity, capacity and check-in; whether a product can connect to a Telegram group; whether purchase notifications/webhooks exist natively (then drop Zapier/Pabbly) or the zap is required.
3. Read SuperProfile's prohibited/restricted categories. Keep "dating"/"matchmaking" out of titles and descriptions. Default naming: **StrangersMeetup — \<City\> Social Meetup Ticket**.
4. Verify on one draft product whether `?ref=` / UTM parameters appear in the purchase notification. If they do, matching is automatic; if not, buyers use the bot claim flow.

## Creating a product (drafts only)

1. Create the draft through the MCP (prepare → commit; poll `get_operation`). Leave the price as a placeholder until the owner sets it; the owner approves publishing.
2. Set SuperProfile quantity = the event capacity. **SuperProfile is the source of truth for stock**; the app does not decrement it.
3. In the app: Admin → Events → Edit → *Checkout* `superprofile`, *SuperProfile product link*, and *product id / name* exactly as the zap will send it. (The link host must be `superprofile.bio` or a subdomain; anything else is rejected by the app and the database.)
4. For a membership: Admin → Membership tiers → *SuperProfile (web checkout)*, link and *product reference*. Prefer SuperProfile's own Telegram-community access for tiers; use the bot claim flow only for event coordination groups.

## Webhook contract

`POST /api/webhooks/superprofile` (alias `/api/membership/superprofile/webhook`), header `X-Webhook-Secret: <SUPERPROFILE_WEBHOOK_SECRET>`, JSON body:

| Field | Required | Zap field to map | Notes |
|---|---|---|---|
| `event` | yes | constant per zap: `purchase`, `refund`, `cancelled`, `subscription_expired`, `purchase_abandoned` | One zap per SuperProfile trigger. |
| `id` | yes | SuperProfile order / payment id | Idempotency key. Duplicates are a no-op. |
| `product_id` | recommended | product id | Matched against `events.superprofile_product_id` first. |
| `product` | recommended | product name | Matched case-insensitively if `product_id` is absent (also matches membership tier product refs). |
| `amount` | for amount check | order total in rupees | If the event has a price set, `amount` must equal price × qty or the order is flagged and **not** confirmed. |
| `currency` | optional | currency | Anything but `INR` is flagged. |
| `qty` | optional | ticket quantity | Inferred from amount ÷ price when omitted. |
| `ref` | optional | the `ref`/UTM value SuperProfile echoes, if it does | 8 characters; ties the order to the person who clicked Book Tickets. |
| `email`, `phone` | optional | buyer email / phone | Hashed immediately (keyed HMAC); never stored in clear. |
| `occurred_at` | optional | order time | ISO timestamp. |

Responses: `401` bad/missing secret (nothing is read or written), `503` secret not configured, `400` malformed (field names listed), `200` processed or duplicate, `5xx` processing error (the zap retries; safe because the endpoint is idempotent).

Outcomes in the response `result`: `confirmed`, `unmatched`, `flagged`, `duplicate`, `refunded`, `cancelled`, `*_after_check_in`, `refunded_before_purchase`.

## What happens to an order

1. Stored in `external_orders` (never dropped, even with an unknown product).
2. Confirmed automatically only if: product maps to a published event, amount is as configured, currency is INR, and the buyer is known (by `ref` from a click, or by an email a user proved earlier by claiming).
3. Otherwise **unmatched** (paid, nobody identified) or **flagged** (needs a human). Finance/super_admin are alerted by Telegram DM; both states are listed in Admin → Orders.
4. Unmatched buyers send `/claim <order id>` (optionally followed by their email) to the bot. Finance can link by hand (audited) from Admin → Orders.

## Refunds

Done on SuperProfile. The refund/cancel notification then: marks the order, sets the booking `refunded`/`cancelled`, revokes an unused invite and removes a guest who already joined. After check-in the check-in record is kept and the order is flagged for finance. The app itself refuses to refund a ticket.

## Daily reconciliation

A Claude Code **scheduled task** (not a Vercel cron: the MCP needs the owner's OAuth) that:
1. Reads the last 48 hours of sales through the MCP.
2. `POST`s them to `https://<site>/api/reconcile/superprofile` with `Authorization: Bearer $CRON_SECRET` and body
   `{ "since": "<iso>", "until": "<iso>", "sales": [{ "id": "...", "amount": "499", "status": "paid|refunded|cancelled" }] }`.
3. The app diffs them against `external_orders` (missing in the app, missing on SuperProfile, amount drift, status drift), records an integration error, and sends the admins one Telegram alert per distinct finding per day. A clean window sends nothing.

The task is created only with the owner's approval. It needs `CRON_SECRET` on the machine that runs it; the owner supplies it at that point and it is never written to the repo.

## Going wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Zap shows 401 | `X-Webhook-Secret` differs from `SUPERPROFILE_WEBHOOK_SECRET` | Fix the header or the env var, redeploy, replay. |
| Zap shows 503 | Secret unset or shorter than 24 chars | Set it in Vercel Production, redeploy. |
| Orders land `unmatched` with `unknown_product` | Product id/name in the zap differs from the event's *product id* | Edit the event; then Admin → Orders → link each order. |
| Orders land `flagged` `amount_mismatch` | Price on SuperProfile differs from the price set on the event, or a coupon was applied | Correct the event price (or clear it to skip the check), then link the order by hand. |
| Everything is `unmatched` | SuperProfile does not echo `ref` | Expected until verified; buyers use `/claim`. |
