# Payments decision

Date: 2026-10-26 · Status: **sandbox only** (`ENABLE_LIVE_PAYMENTS=false`) · Prices: **TBD** (owner pricing session pending)

## Decision
| Purchase | Provider | Why |
|---|---|---|
| Event tickets & trips (in-person service) | **Razorpay Payment Links** (hosted page) | No customer phone/email required (we don't collect them); plain redirect URL, no client SDK; simple, documented webhook HMAC; idempotent refunds; test mode works before KYC. |
| Membership (digital access to private Telegram groups) | **Telegram Stars** (`XTR`) subscriptions | Telegram requires digital goods/services sold inside Telegram to use Stars. Never used for physical tickets or trips. |
| Alternate ticket sources | `bookmyshow_url`, `external_payment_url` per event | Owner-configured outbound links only; we do not reconcile them. |

Cashfree is implemented behind the same `PaymentProvider` interface (webhook verification, refunds, status) but **checkout is disabled**: Cashfree requires `customer_phone` on both Orders and Payment Links, and its hosted checkout opens only via its JS SDK. Switching to it means deciding to collect phone numbers.

## How it works (built)
`PaymentProvider { createCheckout, verifyWebhook, refund, fetchStatus }` — `lib/payments/`.

1. `POST /api/bookings` (signed-in, CSRF) → transaction with `SELECT … FOR UPDATE` on the event → capacity check (paid + live holds) → 15-minute `pending_payment` hold → commit → Razorpay `POST /v1/payment_links` (`amount` in paise, `reference_id`, `notes.booking_id`, `expire_by` ≥ 16 min, notifications off, `callback_url` = booking status page) → `payments` row (`is_test=true`).
2. User pays on Razorpay's page and is redirected to `/bookings/<id>`, which **only polls**; redirect parameters are ignored.
3. `POST /api/payments/webhook/razorpay`: `X-Razorpay-Signature` = hex HMAC-SHA256(raw body, webhook secret), constant-time compare → `webhook_events (provider, X-Razorpay-Event-Id)` unique insert → one transaction: payment `paid` (amount + currency must match) → booking `confirmed` (or, if the hold lapsed and the event is full/cancelled, `refund_due` + finance alert) → outbox row → 200. DM + single-use invite are sent after the response (`waitUntil`) to stay inside Razorpay's 5-second window; failures retry via cron.
4. Daily cron reconciles `created` payments older than 10 minutes with `GET /v1/payment_links/:id` (missed webhooks) and releases stale holds.
5. Refunds: `/admin` → finance role → `POST /v1/payments/:id/refund` with a stable `receipt` (Razorpay treats a duplicate receipt as already processed) → payment/booking `refunded`, invites revoked, DM.

Stars: `createInvoiceLink` with `currency: "XTR"`, `provider_token: ""`, one price item, `subscription_period: 2592000` (the only allowed value; ≤ 10,000 Stars), signed ≤128-byte payload → `pre_checkout_query` checks payload signature, tier active and priced, amount, payer = invoice user, 21+ confirmed → `successful_payment` idempotent on `telegram_payment_charge_id` (renewals carry new charge ids and extend `expires_at`). Refunds via `refundStarPayment`. Bot answers `/paysupport` and `/terms` as Telegram requires.

## Onboarding blockers (owner)
1. **Category risk — highest priority.** Razorpay's prohibited list includes "friend finders", "adult material / mature content" and "websites that promise online matchmaking"; Cashfree prohibits "sexually suggestive materials… escort" services. Neither explicitly lists in-person event ticketing, but "21+", "dating mixers" and "strangers meetup" wording can trigger an automated misclassification.
   - Apply under **Events / ticketing / hospitality experiences**, describe the business as hosted in-person social events and trips, and ask Razorpay's activation team to **confirm the category in writing before going live**.
   - Keep dating features framed as in-person hosted events; no online matchmaking is offered (intro features are "Coming soon" and not built).
2. **KYC documents:** PAN, GST or Udyam, a business proof (Shop & Establishment / IEC / utility bill), bank account. Activation: minutes (CKYC) to ~8 business hours (assisted); manual review varies.
3. **Website requirements:** About, Contact (with email + phone), Pricing, Terms, Privacy, Refund policy pages — all exist except a published legal entity name, support email/phone and grievance officer (set `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `GRIEVANCE_*` env vars). Live API keys require a verified website.
4. **Trips:** "Tours and travel" is a higher-risk category for some gateways (reserves, IATA/IRCTC questions). Launch with day events first; add trips after activation.
5. **Vercel Hobby plan** prohibits commercial use — upgrade to Pro before live payments.
6. **Fees / settlement (verify at signup):** Razorpay ~2% + 18% GST domestic; settlement T+2 (some pages say T+1). Cashfree 1.95% + GST, T+2; may hold funds for services delivered far in the future.

## Sandbox test plan (needs owner's test keys)
Env (Preview): `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ENABLE_LIVE_PAYMENTS=false`.
Razorpay Dashboard (Test mode) → Webhooks → URL `https://<preview>/api/payments/webhook/razorpay`, events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.failed`, `refund.processed`. Pay with UPI `success@razorpay` / `failure@razorpay` or card 4100 2800 0000 1007.
The code refuses `rzp_live_` keys while `ENABLE_LIVE_PAYMENTS=false`, and `rzp_test_` keys when it is `true`.

## Unverified (re-check during onboarding)
Whether `payment.failed` fires for payment-link attempts (handled via `notes.booking_id` if it does); Razorpay webhook IP list and exact retry schedule; Razorpay's treatment of singles/meetup merchants; Cashfree link expiry limits; Stars test-environment behaviour for subscriptions.

Sources: razorpay.com/docs (payment links, webhooks, refunds, test mode), razorpay.com/s/terms; cashfree.com/docs (PG orders, links, webhooks, refunds), cashfree.com/tnc; core.telegram.org/bots/api (Bot API 10.3, createInvoiceLink, SuccessfulPayment, refundStarPayment), core.telegram.org/bots/payments-stars. Research notes: `research_notes/` (not committed).
