# Payments decision

Locked by the owner. Do not reopen without a new decision.

| Item | Decision |
|---|---|
| Event tickets & trips | **SuperProfile** hosted checkout. Buyers pay on a SuperProfile page; this site links out and never sees card or UPI details. |
| Memberships | SuperProfile Telegram-community products on the website (checkout link hidden inside Telegram); **Telegram Stars** inside Telegram, because Telegram requires Stars for digital goods sold in-app. |
| Other gateways | None. No card gateway code, keys or webhooks exist in this app. |
| Pricing | On hold. Products are created as SuperProfile **drafts**; the owner sets prices and approves every publish. |

## How a ticket sale works

1. **Admin links a product.** Admin → Events → Edit: *Checkout* = `superprofile`, *SuperProfile product link* (https, `superprofile.bio` host only, enforced in the app and by a database check) and *product id / name* (the value the automation sends). Linking is audited.
2. **Guest clicks Book Tickets.** The link is `GET /checkout/:slug`. It records a `checkout_intent` (8-char random `ref`, 72 h, optional user, optional ticket tier and quantity), logs a `checkout_click` funnel event and 302s to the SuperProfile URL with `ref` and UTM parameters. It works signed out: paying is never gated on signing in. Hidden inside the Telegram Mini App (the bot may link to the website event page, never to a purchase).
3. **SuperProfile notifies us.** SuperProfile has no signed webhooks; Zapier/Pabbly (or a native webhook if the dashboard offers one) POSTs to `/api/webhooks/superprofile` with the shared secret in `X-Webhook-Secret`. See `docs/SUPERPROFILE_OPS.md` for the field mapping.
4. **We match and confirm.** The order is stored in `external_orders` (idempotent on `order_id`). A booking is confirmed only when the order maps to a published event **and** the amount equals the configured price × quantity (when a price is set) **and** we can tie it to a person: by the `ref` we attached, or by a buyer email a user previously proved. Otherwise the order is `unmatched` (waiting for a claim) or `flagged` (amount/currency mismatch, unpublished event, duplicate booking, refund after check-in) and finance is alerted by Telegram DM and the Integrations tab. Nothing is dropped.
5. **Unmatched buyers claim in the bot.** `t.me/<bot>?start=claim` (or `/claim <order id> [email]`): one claim per order, five attempts an hour per Telegram user, generic failure message, numeric/guessable order ids also require the buyer's email. A claim creates the booking and sends the single-use 24 h invite.
6. **Refunds happen on SuperProfile.** The app never refunds a ticket (`refund()` throws `NOT_SUPPORTED_IN_APP`). A `refund`/`cancelled` notification marks the order, sets the booking `refunded`/`cancelled`, revokes an unused invite and removes a guest who already joined. After check-in the check-in record is kept and the order is flagged for finance.

## Capacity

SuperProfile sells independently of our capacity, so for a linked event **SuperProfile is the source of truth for stock**. Set the SuperProfile quantity equal to the event capacity when creating the product. The event page never shows "Sold out" from our own booking counts for these events; a paid order is always honoured.

## Telegram

Digital goods sold inside Telegram apps must use Stars; tickets are in-person services sold on the website. Purchase links are therefore web-only (`data-web-only`) and absent from the Mini App and the bot.

## Risks and open items

- **Category wording.** Keep "dating" out of SuperProfile product titles and descriptions; default naming is *StrangersMeetup — <City> Social Meetup Ticket*. Re-read SuperProfile's prohibited categories before each new product type.
- **`ref` carry-through.** Whether SuperProfile echoes `ref`/UTM parameters into notifications must be verified on a draft product; until then buyers are matched by the claim flow.
- **Notification path.** Zapier/Pabbly is a third party in the loop; the daily reconciliation (Claude Code scheduled task, needs the owner's SuperProfile OAuth) catches anything missed.
- **Legacy.** Migration 004 created an enum with labels for retired gateways; Postgres cannot drop enum labels, so they remain unused in the database.

Telegram Stars references: core.telegram.org/bots/payments-stars.
