# StrangersMeetup — Launch MVP Spec

Status: locked for launch build · 2026-10-26 · Source of scope: owner brief (sections 1–8)

## Problem
StrangersMeetup today looks like a SaaS template, displays invented events and scarcity, and has no way to take money for a real event. Adults (21+) in Tamil Nadu, Puducherry, Karnataka and Kerala who want to meet new people have no credible way to discover, pay for, and get into a StrangersMeetup event. Until one honest money loop works, the brand cannot launch.

## Goals (launch)
1. **One working, verifiable money loop**: real event → Book Tickets → verified (sandbox) payment → booking `confirmed` → bot DM → single-use invite → visible in admin. Target: 100% of webhook-verified payments produce exactly one confirmed booking and one invite attempt; 0 bookings confirmed from client redirects.
2. **Zero fabricated numbers**: every count on the site is a DB query; empty DB renders empty states, not filler.
3. **Credible brand**: warm editorial public site, crawlable, Lighthouse mobile performance ≥ 85.
4. **Operable by a small team**: admin can publish events, see bookings/payments, refund (finance), read leads, manage media, without touching the DB.

## Non-goals (explicitly deferred)
| Deferred | Why |
|---|---|
| Feed aggregator / scraping | Legal + quality risk; no launch value. |
| Vibe Match radar, compatibility scores | Unbuilt; would be fabricated signal. |
| Intro double opt-in flow | Needs moderation design; "Coming soon" label only. |
| Streaks, badges, auto forum topics, live poll FOMO edits | Engagement features before there is an audience. |
| International / out-of-region trips inventory | Region is TN/PY/KA/KL. |
| Analytics beyond basic funnel events | Basic funnel only (view → book click → checkout → paid). |
| Final pricing | Pricing session pending — all prices `tbd`/NULL. |

## Personas
- **Visitor** (anonymous, 21+): browses events, reads FAQ.
- **Member** (Telegram-signed-in user): books tickets, buys membership, receives invites.
- **Partner / host / venue lead**: submits a form.
- **Admin roles**: `super_admin`, `event_manager`, `moderator`, `finance`, `support`.

## User stories (priority order)
1. As a visitor, I can see upcoming events with city/date/category filters and honest price/status ("Price to be announced"), so I can decide without signing in.
2. As a visitor, I can open an event page with inclusions, refund policy and venue-privacy note, and press **Book Tickets**.
3. As a member, I sign in with Telegram (Mini App initData or Login Widget) only when I book or buy membership.
4. As a member, after paying in the provider's hosted checkout, I receive a Telegram DM confirming my booking and a single-use invite (valid 24h) to the event group — even if I closed the browser.
5. As a member, if payment fails or I abandon checkout, nothing is granted and my hold is released after 15 min.
6. As a member, I can buy a membership tier with Telegram Stars (once priced), get an invite to that tier's private chat, get a reminder 3 days before expiry, and am removed when it expires.
7. As a partner/host/venue, I submit a native form and get a clear confirmation.
8. As an event manager, I create/publish/cancel events and see the check-in list.
9. As finance, I see payments with provider txn ids and can issue a refund (which updates the booking).
10. As super_admin, I edit membership tiers (prices stay NULL until the owner sets them) and authorise media.

Edge cases: sold-out (capacity reached incl. live holds) → "Sold out"; price `tbd` → button shows "Bookings open soon", checkout refused server-side; duplicate webhooks → no-op; payment arrives after hold expired and event is full → booking marked for refund, admin alerted; user already has an active booking for the event → returned existing booking, no second charge; bot not configured → booking still confirmed, invite marked failed and retried by cron, visible as "invite failures" in admin.

## Requirements

### P0 — must ship
| Area | Requirement | Acceptance |
|---|---|---|
| Data | Postgres schema per brief (users, events, bookings, payments, webhook_events, membership_tiers, entitlements, invite_links, leads, media, admin_users, audit_log) + sessions/nonces/rate limits/notifications support tables. | Migrations run idempotently via tracked runner; no SQLite in prod. |
| Events | List + detail from DB; demo rows labelled "Sample"; badges only when true; JSON-LD only for real published non-demo events. | Empty DB → empty state + "Get event alerts on Telegram". |
| Auth | initData HMAC (secret = HMAC_SHA256("WebAppData", token)), constant-time, `auth_date` ≤ 300s, replay rejected; Login Widget (secret = SHA256(token)); httpOnly Secure SameSite=Lax session. | Bad hash / stale / replay → 401. No user id ever accepted from client body. |
| Booking | Hold `pending_payment` 15 min; capacity checked in tx with `SELECT … FOR UPDATE`; one active booking per user per event. | N concurrent checkouts never exceed capacity. |
| Payments | `PaymentProvider {createCheckout, verifyWebhook, refund, fetchStatus}`; Razorpay adapter (decision in `PAYMENTS_DECISION.md`), Cashfree adapter behind same interface; test keys only while `ENABLE_LIVE_PAYMENTS=false`; UI shows "Test mode". | Bad signature → 401; duplicate → 200 no-op; failed payment grants nothing; paid → one confirmed booking. |
| Membership | Stars `createInvoiceLink` (XTR, `subscription_period`), pre-checkout validation (tier active, price set, user eligible), `successful_payment` idempotent on `telegram_payment_charge_id`. | Tier → correct chat; expiry → removed (ban+unban). |
| Bot | Webhook with secret header; `/start` (incl. `event_<slug>` deep link), `/events`, `/mybookings`, `/membership`, `/help`, `/report`; Mini App button; confirmation DM + `createChatInviteLink(member_limit 1, expire 24h)`. | Without token: everything built, health shows `NOT CONFIGURED`. |
| Cron | `/api/cron/*` with `CRON_SECRET`, idempotent: expire holds, revoke expired entitlements, reminders, retry failed notifications/invites, reconcile pending payments via `fetchStatus`. | Re-running a cron changes nothing the second time. |
| Forms | Partner / Host / Venue → `leads`; zod validation, honeypot, rate limit. | 6th submission/hour from same IP → 429. |
| Admin | Telegram login + `admin_users` allowlist (bootstrap via `ADMIN_BOOTSTRAP_TELEGRAM_ID`); role checks per API; CSRF on mutations; `audit_log` on every write. Screens: Overview KPIs, Events, Bookings & Payments, Memberships, Leads, Media, Tiers. | Non-admin → 403; wrong role → 403; KPIs show "No data yet" when empty. |
| Site | Homepage order per brief; pages `/events/[slug]`, `/trips/[slug]`, `/partner-with-us`, `/become-a-host`, `/list-your-venue`, `/faq`, `/trust-safety`, `/privacy`, `/terms`, `/refunds`, city pages; sitemap/robots/canonical/OG. | Homepage public & crawlable (no age-gate overlay); 21+ confirmed at sign-in/booking. |
| Ops | `/api/health` (DB ping + config status), structured JSON logs with request id, no secrets/initData/payment payloads logged. | Grep of public assets finds no secret names' values. |

### P1 — fast follow
- Social proof widget (real confirmed bookings ≥ `SOCIAL_PROOF_MIN`) — built in launch but hidden until threshold.
- Gender policy display ("gender-balanced tables") per event; aggregate counts only when each bucket ≥ 5 (shipped as policy text only at launch; counts not displayed).
- Event alerts opt-in via bot `/start alerts`.

### P2 — design for, don't build
- Waitlists, multi-ticket bookings (schema keeps `quantity` out for now; one ticket per user per event).
- BookMyShow / external payment as alternate pay source: field + outbound link only, no sync.
- Intro double opt-in (users table has no profile fields beyond alias/city to keep it possible later).

## Membership & pricing rules
- Tier rows: `tier_1`, `tier_2`, `tier_3` (names editable), `stars_amount NULL`, `period_seconds 2592000`. Public shows "Announcing soon"; checkout returns 409 until super_admin sets an amount. No "most popular"/decoy labels.

## FAQ (12) — DRAFT, replace with owner's list
The owner brief references "12 questions from my spec doc" which is not in the repo. Drafted from implemented features only:
1. What is StrangersMeetup? 2. Who can join? (21+, TN/PY/KA/KL) 3. How do I book a ticket? 4. Why do I need Telegram? 5. When do I get the venue address? 6. What is included in the ticket? 7. Can I cancel or get a refund? 8. How does membership work? 9. How are payments processed? 10. Is my data private? 11. How do you keep events safe? 12. How do I report someone or something?

## Success metrics
- Leading (first 2 weeks after first real event): checkout-start → paid conversion ≥ 40%; webhook-to-DM latency p95 < 30s; invite failure rate < 2%; 0 double bookings; 0 unreconciled payments > 24h.
- Lagging (first 3 months): ≥ 1 repeat booking per 4 attendees; refund rate < 10%; membership activations (once priced).
Measured from DB (`bookings`, `payments`, `notifications`, `analytics_events`).

## Open questions
| Question | Owner | Blocking? |
|---|---|---|
| Final ticket prices and Stars amounts | Owner (pricing session) | Blocks live, not build |
| First real event details + authorised media | Owner | Blocks launch content |
| Bot token, webhook secret, chat IDs; rename `Telegram_HTTP_API` → `TELEGRAM_BOT_TOKEN` | Owner | Blocks live bot test |
| Payment provider test keys | Owner | Blocks sandbox E2E |
| Legal entity name, grievance officer, support email for legal pages | Owner/legal | Blocks go-live |
| Vercel Pro upgrade (Hobby is non-commercial) | Owner | Blocks live payments |
| The 12 FAQ questions from owner's doc | Owner | Non-blocking |

## Timeline / phasing
Phase 2 data → 3 site → 4 Telegram → 5 payments → 6 admin → 7 tests/review/preview → 8 go-live checklist (owner-executed).
