# ADR-001: Launch architecture — single Node router on Vercel + Postgres, webhook-driven state

**Status:** Accepted · **Date:** 2026-10-26 · **Deciders:** engineering; owner informed

## Context
- Existing app: zero-build static HTML + 9 Node functions, data in ephemeral SQLite (`/tmp`) — not viable (AUDIT P0-1).
- Vercel **Hobby** plan: crons at most daily; non-commercial terms (Pro needed before live money).
- Needs: SEO-rendered event pages, one money loop, Telegram webhook bot, admin, strict idempotency.
- Small team, no build pipeline today, Node 24.

## Decision
1. **Keep zero-build.** All server code is one Vercel function `api/index.js` → `lib/router.js`. `vercel.json` rewrites `/api/*`, `/events/*`, `/trips/*`, `/admin*`, city pages, `sitemap.xml` to it. Static CSS/JS/images served from `public/`. `server.js` runs the same router locally.
2. **Postgres** via `pg` Pool (`DATABASE_URL`, Neon/Supabase from Vercel Marketplace). Tracked migrations (`schema_migrations`) run by `npm run migrate` (and in the Vercel build). No SQLite anywhere.
3. **Server is source of truth.** Booking/entitlement transitions happen only inside webhook handlers or crons, in one DB transaction, after signature verification and `webhook_events` insert (unique) for idempotency.
4. **Side effects after commit** via a `notifications` outbox row (DM + invite). Sent inline right after commit; failures retried by cron. Invite failures are a KPI.
5. **Holds expire lazily**: capacity query counts `pending_payment` only while `hold_expires_at > now()`; daily cron flips stale holds to `cancelled` (Hobby constraint). On Pro, cron frequency can increase with no code change.
6. **Sessions**: stateless HMAC-signed cookie (`sm_session`, httpOnly, Secure, SameSite=Lax, 7 days) containing `uid` + `exp`; user status re-checked per request. CSRF token = HMAC(session, "csrf") sent in `X-CSRF-Token` for all mutating session-authenticated calls.
7. **Rate limiting** in Postgres (`rate_limits` fixed window). Good enough at launch volume; swap for Upstash if needed.

## Options considered
| | A: Keep zero-build + one router (chosen) | B: Migrate to Next.js App Router |
|---|---|---|
| Complexity | Low — no framework, plain templates | Medium — rewrite all pages into React |
| Cost | Same | Same |
| SEO | Server-rendered HTML strings | Excellent |
| Team familiarity | Matches current code | New |
| Risk to launch | Low | Higher (full rewrite) |

B is the better long-term frontend but doubles the surface of this phase; revisit after first events run.

## State machines

### Booking
```
            createCheckout (tx, FOR UPDATE, capacity ok)
   (none) ───────────────────────────────────────────► pending_payment ──(hold expiry / cron)──► cancelled
                                                             │
                                  verified webhook: paid     │       verified webhook: failed → stays pending,
                                  (in tx, capacity re-check) ▼       payment.status=failed; expires normally
                                                         confirmed ──admin check-in──► checked_in
                                                             │
                                          finance refund ok  ▼
                                                          refunded
   confirmed/pending ──admin cancel──► cancelled  (refund issued separately by finance)
```
Late payment (hold expired) → if capacity still free: confirm; else booking `cancelled`, payment `paid`, `notifications(kind=refund_needed)` + admin alert. Never silently keep money.

### Payment
`created → paid | failed`, `paid → refunded`. Unique `(provider, provider_txn_id)`.

### Entitlement (membership)
```
successful_payment (first) → active (expires_at = subscription_expiration_date)
successful_payment (renewal, same user+tier) → active, expires_at extended
user cancels in Telegram → cancelled (keeps access until expires_at)
cron: now > expires_at → expired → revoke (ban+unban in tier chat) → revoked
admin revoke → revoked
```
Optional `grace` reserved (not used at launch).

### Invite link
Created per booking (event chat: `events.telegram_chat_id` or `TG_CHAT_ID_EVENTS`) or entitlement (tier chat). `member_limit=1`, `expire_date=now+24h`. `used_at` set when `chat_member` update shows the user joined via that link.

## Consequences
- Easier: one deploy unit, one DB, testable in-process with real Postgres.
- Harder: HTML templating by hand (escape helper is mandatory; tests assert escaping).
- Revisit: Next.js migration; queue (Vercel Queues) if notification volume grows; Pro plan cron cadence.

## Action items
1. [x] Postgres migrations 003/004 + runner
2. [ ] Router + pages, auth, bot, providers, admin, crons (phases 3–6)
3. [ ] Owner: provision Neon via Vercel Marketplace, set env vars, upgrade to Pro before live
