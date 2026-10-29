# Routes and roles

Source of truth for routes: `lib/router.js`. Every rule below is enforced **on the server**; hiding a button is
never the control. "Proposed" rows are planned (see `docs/IMPLEMENTATION_PLAN.md`) and do not exist yet.

## 1. Roles

| Role | Where it lives | Granted by | Notes |
|---|---|---|---|
| Visitor | — | — | Not signed in |
| Member (guest) | `users` row, `status='active'`, live `user_sessions` row | Signing in (Telegram today; Google proposed) | `suspended`/`banned` users are treated as signed out |
| Organiser | `users.organiser_enabled = true` | `super_admin` via `POST /api/admin/organisers` (audited) | Active `super_admin`/`event_manager` admins also count as organisers (`lib/services/organiser.js:297-302`) |
| Event staff *(proposed)* | `event_staff(event_id, user_id, can_scan, can_view_guests)` | The event's organiser, `event_manager`, `super_admin` | Scoped to listed events only; expires with the event |
| `support` | `admin_users.role` | `super_admin` | Bookings read, check-in, leads |
| `moderator` | `admin_users.role` | `super_admin` | Media, reports, feed moderation, membership revoke |
| `event_manager` | `admin_users.role` | `super_admin` | All events, check-in, bookings, discovery, insights |
| `finance` | `admin_users.role` | `super_admin` | Bookings, payments, refunds, insights |
| `super_admin` | `admin_users.role` (+ bootstrap `ADMIN_BOOTSTRAP_TELEGRAM_ID`) | `super_admin` | Grants roles; cannot demote or deactivate themselves |

A user can never change their own role: the profile schema is strict (`lib/handlers/profile.js`), sign-in upserts
never write role columns, and every grant endpoint requires `super_admin`.

## 2. Permission matrix

✓ = allowed · *own* = only events where `events.organiser_user_id` is the user · *assigned* = only events where the
user is listed staff · blank = denied (404 for object routes so existence is not leaked, 403 for role-gated APIs).

| Capability | Visitor | Member | Staff | Organiser | support | moderator | event_manager | finance | super_admin |
|---|---|---|---|---|---|---|---|---|---|
| Browse public events/pages | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Book, view own bookings, cancel own booking *(cancel proposed)* | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See private venue/contact of an event | | own confirmed booking | own confirmed booking | own events | | | | | |
| Create/edit drafts, publish | | | | own | | | all | | all |
| Edit published event *(proposed)* | | | | own | | | all | | all |
| Guest list, answers, approve/decline | | | assigned (read) *(proposed)* | own | read | | all | | all |
| Check-in / scan | | | assigned *(proposed)* | own *(proposed)* | all | | all | | all |
| Assign event staff *(proposed)* | | | | own | | | all | | all |
| Review organiser first events *(proposed)* | | | | | | ✓ | ✓ | | ✓ |
| Moderate feeds, safety reports, media | | | | | | ✓ | ✓ (feeds only) | | ✓ |
| Bookings list (all events) | | | | | ✓ | | ✓ | ✓ | ✓ |
| Refunds, payment detail | | | | | | | | ✓ | ✓ |
| Platform insights | | | | own events only *(proposed)* | | | ✓ | ✓ | ✓ |
| Membership tiers/prices | | | | | | | | | ✓ |
| Grant/revoke organiser and admin roles | | | | | | | | | ✓ |
| Audit log | | | | | | | | | ✓ |
| Revoke a user's sessions *(proposed admin action)* | | own (`logout-all`) | own | own | | | | | ✓ |

## 3. Route inventory (current)

Legend — Auth: `—` none · `user` session · `org` session + organiser · `org*` session + `manageableEvent`
(owner, `super_admin` or `event_manager`) · `admin:X` admin role set `X` from `lib/handlers/admin.js:22-37` ·
`bearer` `CRON_SECRET` · `sig` provider signature/secret. CSRF = `X-CSRF-Token` required. RL = rate limited.

### Public pages (cacheable, `s-maxage=60`)
`GET /`, `/events`, `/events/:slug`, `/trips`, `/trips/:slug`, `/nightlife`, `/dating`, `/weekend-parties`,
`/dinners`, `/meetups`, `/meetups/:city`, `/membership`, `/submit-event`, `/partner-with-us`, `/become-a-host`,
`/list-your-venue`, `/faq`, `/trust-safety`, `/community-guidelines`, `/privacy`, `/terms`, `/refunds`, `/contact`,
`/sitemap.xml`, `/robots.txt`. Private venue data never reaches these (see `toPublicEvent`).

### Member shells (`no-store`; data loads from the API)
`GET /signin`, `/me`, `/bookings/:id`.

### Auth
| Method | Path | Auth | CSRF | RL |
|---|---|---|---|---|
| GET | `/auth/telegram/start`, `/auth/telegram/callback` | — | state+PKCE+nonce | 20/10 min |
| POST | `/api/auth/telegram` | — (signed initData/widget) | — | 20/10 min |
| POST | `/api/auth/dev` `{persona}` | local only: 404 on Vercel, without `DEV_LOGIN=true`, in production (`NODE_ENV`/`VERCEL_ENV`), or with a non-local `DATABASE_URL`; signs in seeded personas only (`docs/LOCAL_TESTING.md`) | — | — |
| POST | `/api/auth/logout` | user if signed in (no-op otherwise); revokes this session | ✓ when signed in | — |
| POST | `/api/auth/logout-all` | user; revokes all of the user's sessions | ✓ | — |
| POST | `/api/auth/confirm-age` | user | ✓ | — |
| GET | `/api/me`, `/api/me/bookings`, `/api/me/profile`, `/api/bookings/:id` | user, scoped to `user_id` | — | — |
| PATCH | `/api/me/profile` | user | ✓ | 30 |
| POST | `/api/bookings`, `/api/events/:id/book`, `/api/membership/checkout` | user (21+) | ✓ | ✓ |

### Public API
`GET /api/health` (names only, never values), `GET /api/events` (public fields only),
`POST /api/leads/:type` (RL 5/h, honeypot), `POST /api/events/submit` (RL 5/h, honeypot), `POST /api/analytics` (RL 120/min).

### Organiser (`lib/handlers/organiser.js`)
| Method | Path | Auth | CSRF/RL |
|---|---|---|---|
| GET | `/organiser`, `/organiser/new`, `/organiser/events/:id`, `/organiser/drafts/:id/preview` | page state (signed out / not organiser / ok); preview owner-scoped | `no-store`, `noindex` |
| GET | `/media/event-images/:id` | public once published; owner only while draft | — |
| GET | `/api/organiser/context`, `/drafts`, `/drafts/:id`, `/drafts/:id/check`, `/events` | org, owner-scoped | — |
| POST/PUT/DELETE | `/api/organiser/drafts`, `/drafts/:id`, `/drafts/:id/publish`, `/drafts/:id/images`, `/drafts/:id/images/:image` | org, owner-scoped | ✓ / 240 per 10 min (publish 20, images 40) |
| GET | `/api/organiser/events/:id/guests` | org* | — |
| POST | `/api/organiser/bookings/:id/approve`, `/decline` | org* (event resolved from the booking) | ✓ |

### Webhooks and cron
`POST /api/telegram/webhook` (secret header, constant-time, `update_id` dedupe) ·
`POST /api/payments/webhook/:provider` (HMAC; Cashfree timestamp window; `webhook_events` dedupe; amount must match — fails closed) ·
`POST /api/membership/superprofile/webhook` (shared secret, RL, idempotent) ·
`GET /api/cron/:job` (bearer `CRON_SECRET` ≥16 chars; jobs: expire-holds, reconcile, memberships, notifications, feeds, cleanup).

### Admin (`/admin` shell + `/api/admin/*`; every handler calls `guard()`; writes add CSRF + RL 120/min + audit)
| Area | Endpoints | Roles |
|---|---|---|
| Session, overview | `GET session`, `GET overview` | any admin |
| Insights | `GET insights` | super_admin, finance, event_manager |
| Telegram integration | `GET integrations/telegram` | super_admin |
| Discovery | `GET/POST feeds`, `PATCH feeds/:id`, `POST feeds/:id/fetch`, `GET candidates`, `POST candidates/:id/approve|reject` | super_admin, event_manager, moderator |
| SuperProfile | `GET superprofile` | super_admin, finance |
| Events | `GET events`, `GET events/:id`, `GET /admin/preview/:id` · `POST events`, `PATCH events/:id`, `POST events/:id/status` | read: any admin · write: super_admin, event_manager |
| Attendees | `GET events/:id/attendees` | super_admin, event_manager, support |
| Check-in | `POST bookings/:id/check-in` | super_admin, event_manager, support |
| Bookings | `GET bookings` | super_admin, event_manager, finance, support |
| Refunds | `POST payments/:id/refund` | super_admin, finance |
| Memberships | `GET memberships`, `POST entitlements/:id/revoke` | read: super_admin, finance, support, moderator · revoke: super_admin, moderator |
| Leads | `GET leads`, `PATCH leads/:id` | super_admin, event_manager, support |
| Safety reports | `PATCH reports/:id` | super_admin, moderator |
| Media | `GET/POST media`, `PATCH media/:id` | super_admin, moderator |
| Tiers | `GET tiers` · `PATCH tiers/:id` | read: any admin · write: super_admin |
| Admins, organisers, audit | `GET/POST admins`, `GET/POST organisers`, `GET audit` | super_admin |

## 4. Proposed routes (not built yet)

| Persona | Route | Milestone |
|---|---|---|
| Auth | `GET /auth/google/start`, `GET /auth/google/callback`; `POST /api/me/identities/:provider/unlink` | M3 |
| Guest | `/me/bookings` (upcoming / past / requests), `/me/tickets/:id` (QR pass), `/me/settings` (privacy, sessions, export, delete); `POST /api/bookings/:id/cancel`; `GET /api/me/export`; `POST /api/me/delete` | M4 |
| Organiser | `/organiser/events/:id/{guests,tickets,edit,analytics,scan,staff}`; `POST /api/organiser/events/:id/check-in` (signed ticket token, event-scoped); `PUT /api/organiser/events/:id` (validated edit); `POST/DELETE /api/organiser/events/:id/staff` | M5 |
| Admin | `/admin/{users,organisers,roles,events,moderation,bookings,payments,analytics,audit,health}`; `POST /api/admin/users/:id/sessions/revoke`; `POST /api/admin/events/:id/review` | M6 |
| Analytics | `GET /api/organiser/events/:id/analytics`, `GET /api/organiser/analytics.csv`, admin equivalents | M7 |

## 5. Test obligations
Every row of the matrix gets one **allowed** and at least one **denied** automated test (signed out, wrong role,
another organiser, unassigned staff). Gaps today: check-in (no test), CSRF on organiser writes, second-organiser
decline / manage page / image delete / events list, revoked organiser. These are scheduled in M5/M6 with the
features they touch; see `docs/TEST_STRATEGY.md`.
