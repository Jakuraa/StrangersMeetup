# NIGHTLIFEZ Production Release Packet

**Status:** prepared, not executed. The agent does not deploy to Production, touch the Production DB, or change Vercel env/DNS/BotFather.
**Prepared:** 2026-11-11 against `launch-mvp` @ `c6c8d72` (includes PR #41–#44, ticket secret fail-closed hardening).
**Production today:** running `5c6652a` (29 Oct). Its migration level is **believed** to be 009; unverified until Gate 3.

---

## 1. Migrations that will run on Production

The Vercel build runs `npm run vercel-build` → `scripts/migrate.js`. On `VERCEL_ENV=production` it applies every pending file in `migrations/` in filename order, once each, tracked in `schema_migrations` (`lib/db.js` `migrationPolicy`, `migrate`). Preview builds do not migrate unless `MIGRATE_ON_PREVIEW=true` and isolation is proven.

If Production is at 009, the release applies **010 → 020 (11 files)**. There is no 021.

| # | Purpose | Touches existing rows? | Pre-check (owner, read-only, before merge) |
|---|---|---|---|
| 010 | SuperProfile checkout: `external_orders`, booking source/payment-mode checks, user claim columns | **Yes: replaces CHECK `bookings_payment_mode`** with `payment_mode IS NULL OR IN ('free','provider','external')`; adds CHECK `bookings_source IN ('site','superprofile')` | `SELECT payment_mode, count(*) FROM bookings GROUP BY 1;` must show only NULL/free/provider/external. If `source` already exists: `SELECT source, count(*) FROM bookings GROUP BY 1;` |
| 011 | Safety reports: category, event/user refs; attendee blocking | No (columns with defaults) | — |
| 012 | Identities, organisations, memberships, capabilities, venues, event teams | **Yes: backfills** `user_identities` from `users`, a personal org + owner membership + `organise_events` capability for every organiser, and **UPDATEs `events.organiser_org_id`** | `SELECT count(*) FROM users;` `SELECT count(*) FROM events WHERE organiser_user_id IS NOT NULL;` (for after-checks) |
| 013 | LGD location directory (states/districts/cities) | Inserts reference data into new tables only | — |
| 014 | Coordinate provenance + location-resolution trigger on `events` | **Yes: UPDATE `events.coords_provenance='city'`** where lat/lng are set; the trigger fires on future event writes | `SELECT count(*) FROM events WHERE lat IS NOT NULL;` |
| 015 | UPI payment columns/enums, audit ledger | No (additive; enum values added) | — |
| 016 | `payment_audits` append-only trigger | No | — |
| 017 | Index for tier payment holds | No | — |
| 018 | Telegram link tokens, notification prefs, quiet hours | No | — |
| 019 | Event staff, `tickets`, QR check-in, announcements | **Yes: inserts one `tickets` row per confirmed/checked-in booking** that has none | `SELECT status, count(*) FROM bookings GROUP BY 1;` |
| 020 | Saved events, discovery indexes | No | — |

Notes:
- Every file is written to be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, guarded `DO` blocks). A failed migration fails the build, so the previous Production deployment keeps serving.
- Migrations run inside the build, **before** the new code is live. Old code runs against the new schema briefly; all changes are additive, so that is safe.
- 019's backfill sets `tickets.security_hash = md5('nlz_seed_sig_'||booking_id)`. That column is **not** used for check-in: QR codes are verified by HMAC-SHA256 keyed by `TICKET_SECRET`/`SESSION_SECRET` (`lib/services/tickets.js`). It is harmless, but it is dead data.

## 2. Gate 3: confirm the Production database endpoint

Why: Preview tooling refuses any DB URL whose Neon endpoint is on the blocklist. Today the list holds only `ep-dawn-glitter-b4mkwxkl`, the historical, *unconfirmed* endpoint (`lib/config.js` `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS`).

1. **Owner:** Vercel → project → Storage → the Production database → note the Neon **project ID** and **endpoint ID** (`ep-…`, also visible in the host of the Production `DATABASE_URL`). Send **only the IDs**, never the URL or password.
2. **Agent:** add the endpoint ID to `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` in `lib/config.js`, with a test asserting a URL with that host is refused by `isBlockedProductionDatabaseUrl`, `migrationPolicy` (Preview), the seed guard and `previewReviewerEnabled`. Open a PR into `launch-mvp`. (Optionally the owner also sets `BLOCKED_PRODUCTION_ENDPOINTS=<id>` on Preview; the code merges both lists.)
3. **Owner:** confirm the Preview `DATABASE_URL`/`PREVIEW_DATABASE_URL` host is a *different* endpoint.
4. **Owner, read-only:** `SELECT name FROM schema_migrations ORDER BY name;` on Production, to confirm the level is 009 before the release.

## 3. Production environment variables (names only; scope = Production)

| Name | Value / rule |
|---|---|
| `DATABASE_URL` | Production Neon URL (Gate 3 endpoint) |
| `SESSION_SECRET` | ≥ 32 chars, Production-only. **Required:** without it sessions return 503, and ticket QR signing fails closed (throws 503, no fallback to dev secret) |
| `TICKET_SECRET` | recommended, ≥ 32 chars; separates QR signing from sessions |
| `CRON_SECRET` | ≥ 16 chars |
| `PUBLIC_SITE_URL` | `https://nightlifez.com` |
| `TELEGRAM_BOT_TOKEN` | production bot |
| `TELEGRAM_BOT_USERNAME` | production bot username, no `@` |
| `TELEGRAM_WEBHOOK_SECRET` | `[A-Za-z0-9_-]{16,256}` |
| `TELEGRAM_LOGIN_CLIENT_ID` / `TELEGRAM_LOGIN_CLIENT_SECRET` | production bot's Web Login client |
| `TG_CHAT_ID_EVENTS` | events channel/group ID |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID` | owner's numeric Telegram ID |
| `SUPERPROFILE_WEBHOOK_SECRET` | ≥ 24 chars |
| `ENABLE_LIVE_PAYMENTS` | **`false`** (gates the SuperProfile link-out only) |
| `UPI_CHECKOUT_ENABLED` | **`false`** (gates every UPI/PhonePe route; see S3a) |
| `SUPPORT_EMAIL`, `GRIEVANCE_EMAIL`, `GRIEVANCE_OFFICER_NAME`, `LEGAL_ENTITY_NAME` | legal/contact copy |
| optional | `SOCIAL_PROOF_MIN` (≥ 5), `PG_POOL_MAX`, `DISABLE_WEB_ANALYTICS` |

Must be **absent** in Production: `MIGRATE_ON_PREVIEW`, `ISOLATED_PREVIEW_DB`, `PREVIEW_*`, `TELEGRAM_TEST_*`, `ALLOW_PREVIEW_*`, `IS_PREVIEW`, `UPI_ADAPTER`, `FORCE_PHONEPE`, `PHONEPE_*` (UPI stays off), `Telegram_HTTP_API` (legacy name).

Check after deploy: `GET /api/health` → every `config` entry `configured`, `livePayments: false`.

## 4. Release steps (owner, in order)

1. Gates done: DNS (`DNS_AND_EMAIL_ROUTING.md` §5), Gate 3 (§2 above), Production env (§3), the production bot's `/setdomain nightlifez.com` + Web Login URLs (`PREVIEW_LOGIN.md` step 4).
2. Run the §1 pre-checks (read-only) and keep the outputs.
3. Merge **PR #17** (`launch-mvp` → `main`) with CI green on its head SHA.
4. Watch the Production build log: expect `[migrate] done (11 applied; vercel production)` (or fewer if Production is past 009). Any `[migrate] failed` stops the release; the old deployment keeps serving.
5. `curl -s https://nightlifez.com/api/health` → DB ok, config all `configured`, `version` = the first 7 chars of the merge SHA.
6. Register the webhook: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d url=https://nightlifez.com/api/telegram/webhook -d secret_token=$TELEGRAM_WEBHOOK_SECRET`, then `getWebhookInfo` (no `last_error_message`).
7. Production smoke: owner Telegram login → `/admin` bootstraps `super_admin` (audit row) → publish a free test event → book from a second account → QR pass → staff scan → cancel → seat released → unpublish the test event.
8. After-checks for the §1 backfills: identity count = user count; every booking with status confirmed/checked_in has a ticket.

## 5. Rollback

- **Code:** Vercel → Deployments → previous Production deployment (`5c6652a`) → *Instant Rollback*; or revert the merge commit on `main` and redeploy.
- **Schema:** do **not** roll migrations back. 010–020 are additive, and the old code ignores the new tables/columns/indexes/triggers. Two exceptions worth knowing:
  - 010's stricter `bookings_payment_mode` CHECK also applies to old code. Old code writes only free/provider values, which the CHECK allows.
  - 016's append-only trigger blocks UPDATE/DELETE on `payment_audits`. Old code never writes that table.
- **Data:** if a backfill is wrong, fix forward with a new migration. Never hand-edit Production.
- **Webhook:** re-run `setWebhook` with the previous URL if the domain changes back.
