# StrangersMeetup — Platform audit (M0)

Audit date: 2026-10-29 · Base: `origin/launch-mvp` @ `fb73c31` (includes PR #3) · Branch: `feature/platform-v2`

Method: read the source (router, handlers, services, migrations, views, client JS, tests, `vercel.json`), ran
`npm run lint` and `npm test` against a throwaway local Postgres 14, and checked branch/PR state with `git` and `gh`.
Independent read-only audits (security/RBAC, data/migrations, UX/frontend, tests) were reconciled against the code;
claims below that matter were re-checked by hand and carry `file:line` evidence.

Status legend: **Verified** (code read + test or manual run) · **Implemented, unverified** (code exists, no test/run) ·
**Partial** · **Missing** · **Blocked** (needs credentials, third-party approval or infrastructure).

---

## 1. Branches and PRs (verified with `git fetch` + `gh pr list`, 2026-10-28)

| Ref | Commit | State |
|---|---|---|
| `origin/main` | `b13d927` | PR #1 (Vercel Web Analytics) merged. Production deploys from here. |
| `origin/launch-mvp` | `fb73c31` | Built on `b13d927`; PR #3 (organiser wizard) merged into it 2026-10-28 14:17 UTC. |
| PR #2 `launch-mvp → main` | — | Open, draft. `git merge-tree` of `launch-mvp` into `main`: clean. Merging deploys production. |
| `feature/organiser-wizard` | `b3a1d37` | Fully merged (same tree as `fb73c31`). |

- PR #1's static `public/js/analytics.js` + HTML pages were removed by the rebrand (`e08c2fc`) and replaced by the
  server-rendered `/_vercel/insights/script.js` tag (`lib/views/layout.js:110`). Nothing from PR #1 is lost.
- No `.github/` CI. Vercel's Git checks fail on PR #2/#3 because of the plan (Hobby + private org), not the code;
  previews have been CLI deploys.
- Baseline at `fb73c31`: `npm run lint` 73/73 files OK; `npm test` **114/114 pass**.

## 2. Stack
Zero-build Node ≥20 (runs on 24), one Vercel function (`api/index.js` → `lib/router.js`, ~90 routes),
Postgres via `pg`, `zod` validation, server-rendered views with an auto-escaping `html` tag (`lib/views/html.js`),
vanilla client JS. Migrations `003`–`008` (now `009`), each in a transaction under an advisory lock (`lib/db.js` `migrate`).

## 3. Findings by area

### Authentication and sessions
| Item | Status | Evidence |
|---|---|---|
| Telegram Mini App initData (HMAC, 300 s, replay nonce) | Verified | `lib/telegram/auth.js`; `test/auth.test.js` |
| Telegram Login via OIDC (PKCE, sealed state, nonce, id_token replay) | Implemented, unverified live | `lib/handlers/auth.js:94-133`; needs real client id/secret |
| Legacy Login Widget fallback | Verified | `test/auth.test.js:60` |
| Google sign-in | **Missing** | No code. `users.telegram_user_id` is `NOT NULL` (`migrations/003:41`) — needs an identities table |
| Session cookie: HMAC-signed, HttpOnly, SameSite=Lax, Secure on Vercel, 7-day TTL | Verified | `lib/session.js` |
| Server-side revocation on sign-out | **Fixed in M1** (was missing: logout only cleared the cookie) | `migrations/009`, `lib/session.js`, `test/safety.test.js` |
| CSRF (HMAC of session in `X-CSRF-Token` + Origin check) | Verified for admin/auth/profile; organiser writes enforce it via the shared guard (`lib/handlers/organiser.js:23`) but are **untested** | |
| Local dev login | Verified (404 path only) | `lib/handlers/auth.js:136` — refuses on Vercel, without `DEV_LOGIN=true`, or with `NODE_ENV=production`; single fixed identity |
| Account linking, deletion, export | **Missing** | FKs have no `ON DELETE` rules; deletion must be an anonymisation design |

### Roles and access control
| Item | Status | Evidence |
|---|---|---|
| Admin roles `super_admin`, `event_manager`, `moderator`, `finance`, `support` | Verified | `admin_users`; role map `lib/handlers/admin.js:22-37`; `guard()` on all 38 admin handlers |
| Role grants only by super_admin; no self-demotion | Verified | `admin.js:485-499`; `test/admin.test.js:125` |
| Organiser access (`users.organiser_enabled`), granted by super_admin, audited | Verified | `admin.js:520-531`; `test/organiser.test.js:72` |
| No self-promotion path (strict profile schema, upserts never touch role columns) | Verified by reading | `lib/handlers/profile.js:16-21` |
| Organiser drafts/images/events scoped to owner | Verified | `lib/services/organiser.js:316-353,380-393,547`; tests for drafts, approve, guests, images |
| Cross-organiser decline, manage page, image delete, events list, revoked organiser | Implemented, **untested** | |
| Event staff / per-event roles | **Missing** | |
| Organiser publish moderation | **Missing** — organiser publish inserts `status='published'` directly (`lib/services/organiser.js:512`) | Decision: first event of a new organiser goes to admin review (M5/M6) |

### Events, tickets, bookings
| Item | Status | Evidence |
|---|---|---|
| Four-step wizard, server drafts, optimistic version (409), local safety copy, templates | Verified | `test/organiser.test.js:82-147` |
| Ticket tiers free/paid, quantity, per-booking max, `valid_on` days; DB refuses priced free tier | Verified | `migrations/008:68-83`; `test/organiser.test.js:150-190` |
| Inventory under event row lock (no oversell) | Verified (8 guests / 3 seats; 12 checkouts / 3 seats) | `lib/services/ticketing.js:69`; `test/organiser.test.js:371`, `test/payments.test.js:140`. App-level only — no DB constraint |
| Approval flow (`pending_approval` → confirmed/declined); pending requests hold no seat | Verified | `ticketing.js:108,163-194`; `test/organiser.test.js:273` |
| Guest questions (required enforced server-side), pickup points, crowd balance, contact for confirmed guests only | Verified | `test/organiser.test.js:341-503` |
| Guest self-cancel | **Missing** | No endpoint |
| Check-in | Partial — admin-only, by booking UUID, atomic single use (`UPDATE … WHERE status='confirmed'`) | `lib/handlers/admin.js:266-275`. **No QR, ticket token or scanner exists**; **no test**; whole booking checks in at once (no per-seat count) |
| Editing a published event | **Missing** (documented as out of scope in `docs/ORGANISER_WIZARD.md`) | |

### Privacy
| Item | Status | Evidence |
|---|---|---|
| Private venue/maps link hidden from pages, `/api/events`, sitemap, JSON-LD, OG | Verified | `toPublicEvent` `lib/services/events.js:104-149`; `test/organiser.test.js:388` |
| Venue/maps/WhatsApp revealed only to the booking owner once confirmed | Verified | `lib/services/bookings.js:271-282` |
| Public pages CDN-cached (`s-maxage=60` + SWR 300) | Note: a venue switched to private can show for ~6 min on cached pages | `lib/http.js:152` |
| Admin/organiser/member pages `no-store`, `X-Frame-Options: DENY` on `/admin` | Verified by reading | `vercel.json:52-56`, handlers |

### Payments
| Item | Status | Evidence |
|---|---|---|
| Paid ticket checkout gated off unless `TICKET_CHECKOUT_ENABLED=true` and keys exist | Verified | `lib/payments/availability.js:14-27`; `test/organiser.test.js:217` |
| Payment becomes paid only from a signature-verified webhook or server reconcile; client redirect ignored | Verified | `test/payments.test.js:66,105,131` |
| Amount check | **Fixed in M1** — previously skipped when a signed event omitted the amount (`lib/services/bookings.js:162`); now fails closed | `test/safety.test.js` |
| Live-key guard (`ENABLE_LIVE_PAYMENTS`) | Verified | `test/payments.test.js:205` |
| Card payment gateways | **Dropped** | Owner decision: SuperProfile is the only checkout (see `PAYMENTS_DECISION.md`) |

### Admin and analytics
| Item | Status | Evidence |
|---|---|---|
| Admin console (11 tabs) over JSON APIs, CSRF + rate limit + audit on writes | Verified | `public/js/admin.js`, `test/admin.test.js` |
| Insights from real queries; "Unavailable + reason" vs real 0; k≥5 suppression; demo rows excluded | Verified | `lib/services/insights.js`; `test/insights.test.js` |
| Upcoming fill | **Fixed in M1** — counted booking rows, not tickets (`insights.js:121`) | `test/safety.test.js` |
| Per-event / per-organiser analytics | **Missing** — derivable from `analytics_events.event_id` + bookings; no index on `event_id` | |
| Audit log | Implemented; viewer is raw JSON in a table | `lib/audit.js`, `public/js/admin.js` |
| Pagination, search, CSV export in admin | **Missing** | |

### Data, migrations, seed
| Item | Status | Evidence |
|---|---|---|
| Preview builds could migrate the production DB | **Fixed in M1** — `vercel-build` migrated whatever `DATABASE_URL` it had | `migrationPolicy` in `lib/db.js`; `test/safety.test.js` |
| `npm run migrate` ignored a local `.env` | **Fixed in M1** | `scripts/migrate.js` |
| Demo seed: `is_demo` rows, labelled "Sample", excluded from insights | Verified | `scripts/seed-demo.js`, `test/site.test.js` |
| Seed production guard / reset command | **Fixed in M1** (was a comment only; no reset existed) | `scripts/seed-guard.js`, `scripts/db-reset-local.js` |
| Rich synthetic seed (users, organisers, bookings, check-ins, analytics windows) | **Missing** (M8) | |
| Migration rollback / checksums | Missing (forward-only by design; rollback = new migration) | |

### Frontend, UX, accessibility
| Item | Status | Evidence |
|---|---|---|
| Cinematic homepage; reduced-motion handled in CSS and JS | Verified | `public/css/site.css:269-272,434-438`; `test/site.test.js:133` |
| Skip link, landmarks, global `:focus-visible`, wizard errors tied to fields | Verified by reading | `lib/views/layout.js:113`, `public/js/organiser.js:250-262` |
| Mobile nav: `aria-expanded` but no Escape, no focus management, does not close on link click | Partial | `public/js/site.js:69-74` |
| Native `confirm()/alert()/prompt()` for refunds, cancels, age gate | Present (to replace in M2) | `public/js/admin.js:158,189,216`; `site.js:233` |
| Design tokens: colours/radii only; no spacing/type scale; ~12 ad-hoc breakpoints; duplicate `.pill` | Partial | `site.css:5-23`; `admin.css:27` vs `organiser.css:21` |
| Guest `/me`: flat list, no error branch, no ticket pass | Partial | `site.js:367-371` |
| Images: DB-stored, client-resized to 1600 px, lazy on cards; no `srcset`/thumbnails | Partial | `lib/services/organiser.js:386`; `components.js:24` |
| Browser E2E / a11y tooling | **Missing** — no Playwright config, no devDependencies | |

### Platform and config
- `Permissions-Policy: camera=()` on all routes (`vercel.json`) — a camera scanner needs a scoped exception on the scan route only.
- Rate limits are Postgres-backed fixed windows (`lib/ratelimit.js`) — effective on serverless. IP from first
  `X-Forwarded-For` entry (fine on Vercel, spoofable behind other proxies).
- `__path` query parameter overrides the pathname for any request (`lib/router.js`). Low risk (auth still applies);
  tightening it is **deferred** until the function's `req.url` under the Vercel rewrite is confirmed on a preview,
  because a wrong guess would 404 every route.
- Env vars read but not in `.env.example` before M0: `DISABLE_WEB_ANALYTICS`, `PG_POOL_MAX`, `NODE_ENV`
  (now documented), plus test/internal `LOG_SILENT`, `SKIP_DOTENV`, `TEST_DATABASE_URL`.

## 4. Blocked by credentials or third parties (owner)
- Google OAuth client id/secret + registered callback URLs (local, preview, production).
- Telegram bot token, webhook secret, bot username, chat ids, Telegram Login client id/secret.
- Production `DATABASE_URL`, plus a **separate** preview database before setting `MIGRATE_ON_PREVIEW=true`.
- Vercel Preview has no env vars; Git-triggered deploys need Vercel Pro (or a public repo).
- Payments: SuperProfile is the only checkout; paid tickets are bookable only on events with a linked SuperProfile product.
