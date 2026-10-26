# Membership (SuperProfile), discovery feeds, insights

Date: 2026-10-27 · Live payments: **off** (`ENABLE_LIVE_PAYMENTS=false`) · Prices: **not approved** — none are set or shown by this code.

## SuperProfile membership

SuperProfile runs checkout **and** private-Telegram-group access ("Integrated groups": adds members on purchase, removes them when a subscription expires). SuperProfile has no public API; it exposes Zapier / Pabbly Connect triggers: **New Purchase**, **Subscription Expired**, **Purchase Abandon**. We receive those via a webhook to keep lifecycle numbers for `/admin` — we do not grant or revoke group access for SuperProfile tiers.

### Owner setup (cannot be verified from code — needs the SuperProfile account)
1. In SuperProfile: create the membership product(s) and connect the private Telegram group(s) to them. Confirm the SuperProfile bot is admin in each group.
2. In Vercel (Preview first): add `SUPERPROFILE_WEBHOOK_SECRET` — a random string of 24+ characters.
3. In `/admin → Membership tiers` (super_admin): set *Sold via* = SuperProfile, the product's https URL, and the *product reference* exactly as the automation sends it (matching is case-insensitive).
4. In Zapier (or Pabbly): trigger *SuperProfile → New Purchase* → action *Webhooks → POST* to `https://<deployment>/api/membership/superprofile/webhook`, header `X-Webhook-Secret: <secret>`, JSON body:
   ```json
   { "event": "purchase", "id": "<order/payment id>", "product": "<product name>", "email": "<buyer email>", "amount": "<amount in rupees>", "currency": "INR", "occurred_at": "<date>" }
   ```
   Repeat with *Subscription Expired* → `"event": "subscription_expired"` and *Purchase Abandon* → `"event": "purchase_abandoned"`.
5. Check `/admin → Integrations → SuperProfile`: events appear, tier shows as mapped.

Behaviour: idempotent on `(event, id)`; duplicates return 200 `duplicate`; bad/missing secret 401; unset secret 503; failures return 500 (automation retries) and are logged in `integration_errors` without the payload. The buyer email is stored only as an HMAC (keyed with `SESSION_SECRET`).

### Telegram rule (checked against core.telegram.org/bots/payments-stars, 2026-10-27)
"Your bot or mini app must use Telegram Stars for the sale of digital goods and services inside Telegram apps, regardless of any other web portals… you may have set up outside the Telegram ecosystem." Therefore:
- The SuperProfile checkout link is shown on the **website only**. Inside the Telegram Mini App it is hidden (`data-web-only`), and the bot's `/membership` lists only Stars tiers — it never mentions or links SuperProfile.
- A tier sold via SuperProfile cannot also get a Stars invoice from our bot (two systems would fight over group membership).
- **Event tickets / trips** are in-person services: they are sold on the website through Razorpay (sandbox), never with Stars. Telegram's docs do not classify offline-event tickets explicitly; we do not sell them inside Telegram at all.

## Event discovery

- **Feeds** (`/admin → Discovery`): RSS 2.0, RSS 1.0 (incl. the `ev:` event module) and Atom. Every feed requires a recorded *permission basis*. Each fetch checks robots.txt (our UA `StrangersMeetupBot`), uses https only, refuses private/internal addresses (also after redirects), caps size (2 MB) and time (10 s), and sends conditional-GET headers. Runs daily via `/api/cron/daily` (job `feeds`) or on demand ("Fetch now", rate-limited).
- **Nothing is auto-published.** Items enter the moderation queue. `pubDate`/`updated` are publication dates, never used as event dates — most feed items arrive with *no date* and the moderator must confirm it on the source page.
- **Submissions**: `/submit-event` (rate-limited 5/hour/IP, honeypot, consent). Contact details are visible to admins only.
- **Dedupe**: same https link, or same normalised title + IST calendar day + city, against live events and queued items; a unique index enforces it for events.
- **External listings**: attributed ("Via <source>", "Listed from …"), link to the organiser's https page, never bookable through our checkout (server-enforced), no capacity/price/availability claims, no Event JSON-LD.
- Formats: nightlife, strangers trips, meetups, dinners, weekend parties, dating mixers, matchmaking (in-person). Pages: `/events`, `/nightlife`, `/trips`, `/meetups`, `/dinners`, `/weekend-parties`, `/dating`.

## Insights (`/admin → Insights`, roles: super_admin, finance, event_manager)

Computed only from our Postgres. Each metric is either a value (zero is a real zero) or **Unavailable** with the reason (e.g. no page views recorded yet, SuperProfile not connected, nobody has shared age). Visitors come from a first-party, cookie-less page-view beacon (path only, referrer host only, `utm_source`), counted per browser id in localStorage. Demographics/interests are voluntary (`/me`) and buckets under 5 people are hidden.
