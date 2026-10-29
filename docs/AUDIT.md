# StrangersMeetup — Phase 0 Audit

Audit date: 2026-10-26 · Auditor: engineering (Claude) · Base commit: `b13d927` (origin/main)

Scope: live site `https://strangersmeetup-virid.vercel.app/`, repo `Jakuraa/StrangersMeetup`, Vercel project `strangersmeetup` (team `satelinkinternet-collabs-projects`).

---

## 1. Stack as found

| Layer | Found | Verdict |
|---|---|---|
| Frontend | Static HTML in `public/` (10 pages), vanilla JS `public/js/app.js`, one CSS file. Open Sans. | Keep approach (zero-build, fast). Rewrite markup/visuals. |
| API | Vercel Node functions `api/*.js` (9 files), plus a local `server.js` that mimics routing. Written for a "Hatchable" platform (`hatchable.toml`). | Keep Node functions; consolidate into one router function (Hobby plan limits, shared code). |
| DB | `lib/db.js` → **SQLite at `/tmp/strangersmeetup.db` on Vercel** (Hatchable Postgres import always fails on Vercel). | **Broken for production.** `/tmp` is per-instance and wiped on cold start: bookings, payments and entitlements are silently lost. Replace with managed Postgres. |
| Migrations | `001`–`003` in SQLite dialect (`INSERT OR IGNORE`, `BOOLEAN DEFAULT 0`), re-run on every cold start, errors swallowed. | Replace with Postgres migrations + tracked runner. |
| Bot | No bot. `api/webhook.js` only handles `pre_checkout_query` + `successful_payment`. No commands, no `/start`, no DMs. | Build. |
| Payments | Telegram Stars membership only (`createInvoiceLink` with `subscription_period`). No ticket payments at all. | Build ticket provider; harden Stars. |
| Auth | `validateTelegramInitData` exists, no session issued, 24h freshness, no replay protection. | Rebuild. |
| Tests | `node --test`, 6 files, all against SQLite + "mock Telegram" mode. | Rewrite against Postgres. |
| Deps | Zero runtime deps except `@vercel/analytics` (added by PR #1). | Add `pg`, `zod`. |

## 2. Vercel

- Linked to GitHub, production branch `main` (domain `strangersmeetup-git-main-…` present). Framework preset "Other", output dir `public`, Node 24.x.
- Latest deployment `dpl_6pByBy2iTNaSXi4bpcVt6eveB3UT` — READY, production.
- Runtime errors (7d): none recorded.
- Deployment protection: Vercel SSO on all deployments except custom domains (previews require Vercel login to view; `strangersmeetup-virid.vercel.app` production alias is public).
- **Env vars (names only): `Telegram_HTTP_API` (Production only).** Nothing else. Code expects `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, channel IDs, `APP_SECRET` — none set. This one var is most likely the bot token under a non-standard name; it is not read by any code and not available to Preview.
- No database integration installed.
- **Plan: Hobby.** Consequences: (a) cron jobs run at most once per day; (b) Hobby is for non-commercial use per Vercel terms — **upgrade to Pro before live payments** (added to GO_LIVE).

## 3. Live site walkthrough (desktop 1280 + mobile 390)

| Route | Status | Notes |
|---|---|---|
| `/` | 200 | Full-screen **age gate overlay on landing** (blocks content; Rule 8 wants landing public). No horizontal overflow at 390px. |
| `/venue`, `/partner`, `/host` | 200 | Forms post to `/api/inquiries` → stored in ephemeral SQLite (**leads lost**). Collect email + phone (not needed). No rate limit, no honeypot. |
| `/safety`, `/terms`, `/privacy`, `/billing`, `/community`, `/grievance` | 200 | Placeholder entity "StrangersMeetup Regional Network", grievance email `@strangersmeetup.example.com`. |
| `/faq`, `/events`, `/trips`, `/events/<slug>`, `/admin` | **404** | No event detail pages, no FAQ page, no admin. |
| `/api/health` | 404 | Missing. |
| `/favicon.ico` | 404 | Console error on every page. |
| `/api/analytics` | **400 on every page load** | Front-end sends an event name not in the server allowlist. |
| `/sitemap.xml`, `robots.txt` | 200 | Point at `strangersmeetup.example.com` (wrong host). Static. |
| Canonical / OG | — | Canonical `https://strangersmeetup.example.com/`; OG image is an Unsplash stock photo. |

- Video embeds: none found (no dead embeds).
- `a[href="#"]`: "Open Telegram ↗" in checkout modal.
- Links to `https://t.me/StrangersMeetupBot` ×4 — **bot not verified to exist / not owned-confirmed.**

## 4. Fabricated / hardcoded data (Rule 1 violations)

| Where | What | Severity |
|---|---|---|
| `migrations/002`, `003` seed | **All 15 events invented.** 7 claim to be "Real Events" with `is_demo=0`. | P0 |
| Event seeds | Pre-filled `tickets_sold` (e.g. 14/24, 17/20, 22/28) → site renders "10 slots remaining", "5 SLOTS LEFT" — **fake scarcity**. | P0 |
| Event seeds | Invented prices (₹199–₹42,500) while pricing is on hold. | P0 |
| Event seeds | 6 international/North-East trips (Bali, Vietnam, Sri Lanka, Meghalaya) outside launch region. | P1 |
| `api/events.js` | Default Unsplash image + "Exact venue disclosed 24 hours prior" privacy copy applied to every event regardless of policy. | P1 |
| `index.html` + `config/tiers.json` | Hardcoded tier prices (₹149/₹499/₹999, 75/250/500 Stars) and **"Most Popular" decoy badge**. | P0 (pricing) / P1 (decoy) |
| `config/tiers.json` | Benefits marked "active" that don't exist (priority RSVP, concierge, VIP salons). | P1 |
| `lib/entitlements.js` | On payment, writes `age_declared=21`, `date_of_birth='2000-01-01'`, `state_code='TN'` for every user — fabricated identity data. | P1 |

## 5. Security findings

| # | Finding | Severity |
|---|---|---|
| S1 | **Mock-mode auth bypass**: if `TELEGRAM_BOT_TOKEN` is unset (current state in prod), `validateTelegramInitData` returns `ok:true` for *any* string and invents user `12345678`. | P0 |
| S2 | **IDOR**: `GET /api/entitlements?telegramUserId=N` returns any user's subscription and private channel invite link, unauthenticated. | P0 |
| S3 | `POST /api/cancel` cancels any user's subscription by `telegramUserId`, unauthenticated. | P0 |
| S4 | `POST /api/events` "books" a ticket with no payment and increments `tickets_sold` (read-modify-write race, no lock). | P0 |
| S5 | Hardcoded fallback HMAC secret `fallback-dev-secret-salt-2026` for invoice payloads when `APP_SECRET` unset (it is unset). Payload HMAC truncated to 64 bits. | P0 |
| S6 | initData freshness 24h, no replay protection; no session cookie. | P1 |
| S7 | Webhook stores full raw payloads (`raw_payload_json`) incl. invoice payloads. Error responses echo `err.message`. | P1 |
| S8 | Webhook always returns 200 on unhandled errors → Telegram won't retry; processing not transactional (member → subscription → payment → entitlement as separate statements). | P0 |
| S9 | No rate limiting anywhere. No CSRF concept (no sessions). | P1 |
| S10 | Invite link fallback `https://t.me/StrangersMeetupBot?start=pending_channel_config` is stored as if it were a real invite. | P1 |
| S11 | `.env.local` holds a `VERCEL_OIDC_TOKEN` (gitignored, not committed — OK). No secrets found in tracked files. | info |

## 6. Event record classification

| id | city | Claimed | Actual classification |
|---|---|---|---|
| evt_blr_boardgames_01 | Bengaluru | real (is_demo=0) | **demo (fabricated)** |
| evt_blr_coffee_02 | Bengaluru | real | **demo (fabricated)** |
| evt_chn_retro_cinema_03 | Chennai | real | **demo (fabricated)** |
| evt_chn_neon_mixer_04 | Chennai | real | **demo (fabricated)** |
| evt_cbe_acoustic_05 | Coimbatore | real | **demo (fabricated)** |
| evt_koc_sunset_cruise_06 | Kochi | real | **demo (fabricated)** |
| evt_pdy_coastal_resort_07 | Puducherry | real | **demo (fabricated)** |
| evt_blr_cubbon_walk_08 | Bengaluru | demo | demo |
| evt_chn_mylapore_walk_09 | Chennai | demo | demo |
| evt_trip_meghalaya_10 | Meghalaya | demo | demo, out of region |
| evt_trip_gokarna_11 | Gokarna (KA) | demo | demo |
| evt_trip_wayanad_12 | Wayanad (KL) | demo | demo |
| evt_trip_vietnam_13 / bali_14 / srilanka_15 | International | demo | demo, deferred (international trips out of scope) |

**Real events: 0. Imported: 0. Demo: 15.** No owner-supplied event exists yet (Owner input #4).

## 7. Prioritized issue list

### P0 — blocks the money loop
1. No persistent database in production (SQLite in `/tmp`). → Managed Postgres + migration runner.
2. No ticket payment path at all; "booking" is free and unverified. → `PaymentProvider` + Razorpay/Cashfree sandbox + webhook-driven confirmation.
3. Auth bypass when bot token missing (S1); no sessions. → Strict initData/Login Widget validation, signed httpOnly session.
4. IDOR on entitlements/invite links and cancel (S2, S3). → Session-scoped endpoints only.
5. Webhook processing non-transactional, non-retryable (S8); hardcoded fallback secret (S5).
6. Fabricated events, sold counts, prices, decoy tier (Section 4). → DB-driven, `is_demo` labelled "Sample", prices `tbd`.
7. No bot: no `/start`, no DMs, no single-use invite delivery for bookings.
8. Required env vars missing on Vercel; bot token stored under unread name `Telegram_HTTP_API`.
9. No event detail pages / Book Tickets flow.

### P1 — trust / brand
10. Neon/teal SaaS look; age-gate overlay on landing; copy over-promises unbuilt features.
11. Placeholder legal entity / `example.com` emails, canonical, sitemap.
12. No rate limits, honeypot, validation library; forms collect unnecessary PII (phone, email for leads is acceptable but optional).
13. Missing `/faq`, `/trust-safety`, `/refunds`, city pages, JSON-LD, OG image, favicon.
14. `/api/analytics` 400 on every load.
15. No admin, no audit trail for admin actions.
16. Vercel Hobby plan → non-commercial + daily crons only.

### P2 — later
17. Vercel Web Analytics loaded from jsDelivr ESM on every page (fine, but consider removing until consented/needed).
18. `hatchable.toml` and Hatchable shims are dead weight on Vercel.
19. International trips, intro double opt-in, Vibe Match, streaks — deferred per spec.

## 8. Decisions taken from this audit
- Keep zero-build Node + static assets; add server-rendered HTML for SEO pages via one router function.
- Postgres via `pg`; local/test uses a real Postgres (no SQLite anywhere).
- Legacy SQLite migrations moved to `migrations/legacy-sqlite/` (never ran against a persistent DB; nothing to preserve). New Postgres baseline starts at `003_…` / `004_…` as specified.
- Booking hold expiry computed at query time (`hold_expires_at > now()`) so capacity is correct without a 15-minute cron (Hobby constraint); daily cron tidies up.
