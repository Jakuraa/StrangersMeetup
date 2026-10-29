# StrangersMeetup — UI/UX quality audit (pre-release)

- **Branch:** `feature/m2-responsive-admin` · audited from head `6bb6f08`; first-pass fixes in `515154d`; the follow-up pass in §10 is a later commit on the same branch.
- **Audited:** 2026-10-29, on a local build only (Node server + local Postgres `sm_e2e`, `DEV_LOGIN=true`, `ENABLE_LIVE_PAYMENTS=false`).
- **Verification levels used in this report**
  - **Local** = observed on my machine against seeded demo data. Everything below is at this level unless stated.
  - **Preview** = on a Vercel preview deployment. **Not done in this audit** (deploying was out of scope).
  - **Production** = on the live site. **Not done, and nothing here may be read as production-verified.**
- **Not done:** no screen-reader (VoiceOver/NVDA/TalkBack) pass, no real device or Safari/Firefox testing (Chromium only), no real Telegram sign-in, no real payment, no load/performance testing, no copy/legal review.

## 1. Headline

**Overall: 59 / 100 (58 after the first pass; re-scored in §10) — a solid, safe-by-default engineering base with a good-looking public front door, but not release-ready as a product.**

The pages that exist are clean, responsive and accessible by automated measures. What holds the score down is not broken CSS but missing product: members can sign in only with Telegram (not configured here, so unverifiable), there are no event photos, paid checkout is off, a signed-in member cannot cancel a booking, event-scoped staff do not exist, and nothing has been seen on a deployed URL.

### Scoring rubric (transparent)
Each category is scored 0–100 from observed evidence; the overall score is the weighted sum.

| Category | Weight | What earns points | Score | Weighted |
|---|---|---|---|---|
| Visual polish | 20% | Hierarchy, spacing, consistency, premium/adult-social feel, real imagery | **68** | 13.6 |
| Mobile UX | 20% | No overflow at 320–768, tap targets, nav, forms on phones | **72** | 14.4 |
| Core user journeys | 25% | Each journey works end to end for real users, not just personas | **50** | 12.5 |
| Accessibility | 15% | axe clean, focus, landmarks, labels; capped without a human screen-reader pass | **70** | 10.5 |
| Reliability | 10% | Tests, error states, no console/network errors, guarded data paths | **70** | 7.0 |
| Launch readiness | 10% | External config done, verified on preview/prod, support/ops paths | **20** | 2.0 |
| **Total** | 100% | | | **60.0** |

I then deducted 2 points for the one issue in this audit that shipped with a green test suite (§4, D1: the suite passed while a core page scrolled sideways at 320px), because it shows the automated suite does not cover everything. **Final: 58.** Passing tests did not raise the score; they are why Reliability is 70 rather than lower.

## 2. Feature-by-feature status

Legend: **Pass** = observed working, no material defect · **Partial** = works with a gap · **Fail** = broken · **N/I** = not implemented. Evidence is what I observed or ran; "e2e" means the existing Playwright spec passed in my run (97 passed, 1 intentional skip).

| # | Journey | Status | Evidence (local) |
|---|---|---|---|
| 1 | Landing page, nav, footer, CTAs | **Pass** | 30 public pages × 5 viewports crawled: HTTP 200, no console errors, no failed requests, one `h1` each. Hero is distinctive and on-brand. Mobile menu opens/closes (`375-menu-open.png`), skip-link first in tab order. Caveat: the single primary CTA is "Continue with Telegram", which cannot complete here (not configured). |
| 2 | Event discovery, cards, filters, detail | **Partial** | Filters work on real data (city 6→2/1 results, category 6→1, "this week" → empty state). Detail pages render. Gap: every card uses the same placeholder two-circle graphic; there are no event photos, which weakens the "premium" feel. Seed titles start with "Test:" (demo data only). |
| 3 | Free registration → booking confirmation | **Pass** (e2e + observed) | `guest-booking.spec` passes; the confirmed-booking page shows ticket, "No payment needed" and the venue (`375-booking` reviewed). The confirmation is delivered by a Telegram bot that is not configured here, so message delivery is **unverified**. |
| 4a | Sold-out state | **Pass** | Disabled "Sold out" button, red state label (`375-event-soldout`). |
| 4b | One-seat-left | **Pass** | `local-low-seats-trek` shows seat-left state; it lives at `/trips/…`, and `/events/<slug>` redirects there correctly. |
| 4c | Past / cancelled | **Pass** (after §10) | First pass: button disabled but the page still showed the ticket choice, quantity picker and the venue-after-booking line (D5). §10: replaced by a status panel; server already refused bookings. |
| 4d | Approval-required | **Pass** | "Request to join", host question field, "host approves each guest" (`375-event-approval`); organiser approve/decline covered by unit tests. |
| 5 | Private venue privacy | **Pass** | `private-venue.spec` passes: venue absent from visitor HTML and `/api/events`, hidden from non-booked guests, pending requests, and other guests opening the booking URL; shown on own confirmed booking. Strongest area of the product. |
| 6 | Login / logout / sessions / auth methods | **Partial** | Telegram is the only real method; it is **not configured locally, so not tested**. The persona picker is dev-only (404 off-localhost, guarded in code and tests). Server-side sessions with revocation exist (unit tests). Google sign-in: **N/I** (planned M3). Logged-out access to `/me` and `/admin` is handled (401 page / sign-in), see D6. |
| 7 | Member dashboard & history | **Partial** | `/me` lists bookings with status and an optional profile form (`375-member-dashboard`). No cancel, no calendar add, no ticket/QR for the member — **N/I**. |
| 8 | Organiser wizard (Basics→Tickets→Features→Preview) | **Pass** (e2e) | `organiser-create.spec` drives all four steps, publishes, and checks the public page hides the venue and that another organiser gets 404. I looked at step 1 and the draft banner on desktop/phone; I did not hand-review steps 2–4 visually. |
| 9 | Organiser manage / attendees / analytics | **Partial** | Guest list + approve/decline exist. Per-organiser analytics: **N/I** (listed as "proposed" in `docs/ROUTES_AND_ROLES.md`; insights are platform-wide and admin-only). Editing a published event: **N/I**. |
| 10 | Admin dashboard, sections, tables, states, moderation | **Pass** | `admin-responsive.spec` ×5 viewports + `admin.spec` pass: cards/tables, loading/empty/error/offline/forbidden, role-filtered sections, lead/report moderation. Overview and sections reviewed at 320/375/desktop. Admin uses a different typeface/visual language from the public site (D7). |
| 11 | Staff permissions & check-in | **Partial** | Check-in works and is audit-logged (e2e); staff see only permitted sections and get 403 on admin-only APIs. But "staff" is the platform-wide `support` role, not event-scoped staff (**N/I**, M5). No camera/QR scanning. |
| 12 | Mobile navigation & mobile versions | **Pass** | No horizontal scroll on any public page at 320/375/Pixel 7/768/1280 after fix D1; menu, forms, booking card, admin all usable. |
| 13 | Paid checkout disabled / messaging | **Pass** | Paid event shows "Online booking not available yet", an explanatory note, a disabled tier and no buy path (`320-event-paid`). No payment keys configured; real payment provider code **not exercised**. |

### Local vs. external, honestly
| State | Features |
|---|---|
| **Implemented and locally tested** | Free booking, private-venue rules, organiser wizard, admin console, check-in, role gating, server-side sessions, disabled paid state |
| **Implemented but needs external config (untested end to end)** | Telegram login, Telegram bot confirmations/invite links, cron jobs (`cron: NOT CONFIGURED`), payment provider keys, SuperProfile webhook, admin bootstrap |
| **Not implemented** | Google sign-in, member cancel/calendar/QR, event photos in cards, per-organiser analytics, editing published events, event-scoped staff, QR check-in |
| **Verified on preview / production** | Nothing |

## 3. Visual review

Reviewed screenshots at 320, 375, Pixel 7 (412), tablet 768 and desktop 1280 (§6). Overall the public site reads as a coherent, restrained dark/cream editorial brand with a distinctive hero — not a generic template. It falls short of "premium" mainly because there is no photography: event cards are all the same outlined-circles placeholder, so the listing page looks sparse and repetitive. Admin is functional and tidy but visually a separate product.

| Check | Result |
|---|---|
| Spacing / hierarchy / typography | Good. Clear H1→lede→CTA rhythm; card text sizes consistent. |
| Contrast | axe (WCAG 2.1 A/AA, reduced-motion) reports no serious/critical issues on the covered pages. Not exhaustively checked on every state/hover. |
| Responsive overflow | One real defect found and fixed (D1). None remain on the 30 crawled pages × 5 viewports. |
| Touch targets | Most primary controls ≥44px. Below 44px: the header Telegram icon button (40×40), ticket radios (20×20), consent checkbox (20×20), several plain text links (footer, card titles ~26px tall). Meets WCAG 2.2 AA minimum (24px) in most places but not the 44px target recommended for primary phone actions (D4). |
| Loading / error / empty | Admin states covered by tests; listing empty state present. Public booking-failure messaging was not exercised (no fake failures induced). |
| Forms | Labels present; inline field errors exist in wizard; `/submit-event` honeypot field is correctly hidden. |
| Keyboard | Visible 2px focus outlines on every tab stop in the sampled sequence; skip link first. Admin keyboard covered by e2e. |
| Reduced motion | Site has a reduced-motion fallback; all my captures and axe runs used `prefers-reduced-motion: reduce`. **Full-motion experience was not reviewed**, so scroll-animation quality is unassessed. |

## 4. Defects

Severity: P0 security/privacy/data · P1 core journey broken · P2 significant UI/UX · P3 polish. **No P0 or P1 defects were found.**

| ID | Sev | Page / viewport | Defect | Repro | Status |
|---|---|---|---|---|---|
| D1 | **P2** | `/events/local-paid-workshop`, 320px | Page scrolled sideways (359px wide in a 320px viewport); the booking card and facts were clipped. Cause: `1fr` grid tracks and a `<fieldset>` grew to content width. The existing 320px test did not include paid/sold-out/cancelled/past events, so the suite stayed green. | Open at 320px width | **Fixed** + regression test |
| D2 | **P2** | `/events`, `/meetups/:city`, all widths | Format links (Nightlife, Trips, …) rendered as an unstyled browser bullet list (no CSS for `.format-nav`), and the page header was centred while the filters/grid were left-aligned. | Open `/events` | **Fixed** (pills; left-aligned header) |
| D3 | P3 | Event detail, desktop | WHEN and WHERE columns touched with no gap ("9:30 pm IST" ran into "Besant Nagar"). | Open any event at 1280px | **Fixed** |
| D4 | P3 | Phones | Some primary controls under 44px (see §3). | Measure at 375px | **Fixed in §10** (≥44px at 320/375 on audited pages, regression test) |
| D5 | P3 | Past / cancelled event detail | Still shows ticket picker, quantity and "address appears on your booking once confirmed". | Open `local-past-meetup` | **Fixed in §10** + regression tests |
| D6 | P3 | `/admin` signed out (and non-admin) | Bare, unstyled 401/403 page with no site header; `/me` signed out also triggers a console 401 from `/api/me/bookings` before the sign-in prompt. | Open `/admin` logged out | **Partly fixed in §10**: branded access screens. The `/me` signed-out console 401 is still open. |
| D7 | P3 | Admin vs public | Different typeface/visual language. Acceptable for an internal tool; noted for consistency. | Compare screenshots | **Open** |
| D8 | P2 (product) | All event cards | No imagery: identical placeholder graphic. Biggest gap vs. a premium discovery product. | Open `/events` | **Partly addressed in §10**: category-specific fallback art. Still no real photography (content decision). |
| D9 | P2 (product) | Sign-in | Single method (Telegram) and it is the only visible CTA site-wide; users without Telegram have no path. | Open `/signin` | **Open** (Google is planned M3) |

## 5. Fixes made

Scope was limited to clear, low-risk CSS/markup fixes inside this branch. No architecture, route, data or auth code was touched.

| File | Change |
|---|---|
| `public/css/site.css` | `minmax(0,1fr)` tracks on `.event-grid`, `.facts`, `.tier-form`, `.tiers`, `.tier-opt`; 28px column gap and `overflow-wrap` on facts (D1, D3); new `.format-nav` pill styles (D2); cache-bust `v=5`→`v=10` |
| `lib/views/layout.js` | `pageHeader(..., wide)` optional flag; cache-bust bump |
| `lib/views/discovery.js`, `lib/views/pages.js` | Listing headers (`/events`, formats, city) use `wide` so they align with the grid |
| `lib/views/admin.js` | cache-bust bump only |
| `e2e/mobile-layout.spec.js` | 320px no-overflow test now also visits paid, sold-out, cancelled and past event pages |

One of my own intermediate CSS edits briefly collapsed the ticket card on desktop; I caught it in the screenshot review and fixed it before committing (the automated tests would not have caught it).

### Test results after fixes (local)
| Check | Result |
|---|---|
| `npm run lint` | 92/92 files OK |
| `npm test` (unit/integration, `sm_pv2_test`) | 149/149 pass |
| `npm run test:e2e` (desktop + mobile + responsive, 5 viewports) | 97 passed, 1 intentional skip, 0 failed — same before and after |
| Guard check | New 320px test **fails on the old CSS** (`div.event-main, dl.facts…` overflow) and passes with the fix |
| Re-crawl after fixes | `/events/local-paid-workshop` @320: no overflow; other pages unchanged |

## 6. Screenshots (local build, after fixes)

Files are in `docs/ui-audit/`, named `<viewport>-<page>.png`. Viewports: 320×640, 375×667, Pixel 7 412×839, tablet 768×1024, desktop 1280×800 (viewport-sized captures; scrolled where noted).

| Viewport | Page | File |
|---|---|---|
| Desktop | Home (hero) | `desktop-home.png` |
| 320 | Home (hero) | `320-home.png` |
| 375 | Home (hero) | `375-home.png` |
| Desktop / Tablet / Pixel 7 | `/events` | `desktop-events.png`, `tablet-events.png`, `pixel7-events.png` |
| Desktop / 375 | Event detail (free, bookable) | `desktop-event.png`, `375-event.png` |
| 320 | Event detail, paid (checkout off) — the D1 page, fixed | `320-event-paid.png` |
| 375 | Sold-out / approval-required event | `375-event-soldout.png`, `375-event-approval.png` |
| 375 | Sign-in (dev personas visible locally only) | `375-signin.png` |
| 375 | Member dashboard `/me` (guest persona) | `375-member-dashboard.png` |
| Desktop | Organiser wizard entry (draft banner) | `desktop-organiser-wizard.png` |
| 375 | Guest opening `/organiser` (not an organiser) | `375-not-organiser.png` |
| Desktop / 375 / 320 | Admin overview (admin persona) | `desktop-admin-overview.png`, `375-admin-overview.png`, `320-admin-overview.png` |
| 375 | `/admin` signed out | `375-admin-signed-out.png` |

The e2e suite additionally writes full-page admin screenshots per section and viewport to `test-results/screenshots/` (git-ignored).

## 7. Cannot be verified locally / needs external setup

- Telegram Login (bot token, OIDC/widget domain), Telegram bot confirmations and private-group invite links, webhook secret, events chat id.
- Cron (`CRON_SECRET`): hold expiry, reconcile, notifications, feed ingestion.
- Payments: Razorpay/Cashfree keys, webhooks, refunds; `ENABLE_LIVE_PAYMENTS` must remain `false` until intentionally enabled and tested in test mode.
- SuperProfile membership webhook; admin bootstrap Telegram id.
- Behaviour on Vercel (the `__path` rewrite router hardening is flagged in project notes as needing a preview check), real database latency, cache headers, custom domain/HTTPS, email/DNS.
- Safari/iOS and Firefox rendering; real-device touch behaviour; screen readers.

## 8. Remaining work for an MVP release (prioritised)

**Must do before any public launch**
1. Configure Telegram login + bot on a **preview** deployment and walk the full journey there: sign in → book → confirmation message → venue reveal → logout. (Highest-risk unknown.)
2. Deploy a preview, run the existing browser suite's public subset against it, and check Vercel logs for errors; confirm the `__path` router behaviour.
3. Decide the launch auth story: Telegram-only (state it plainly on the sign-in page and add a "Why Telegram?" line), or ship Google sign-in (M3).
4. Replace the placeholder card graphic with real event imagery (organiser uploads exist; add a tasteful fallback) — biggest visual lever (D8).
5. Add member **cancel booking** and an "add to calendar"/ticket view — members currently have no self-service after booking.

**Should do**
6. ~~Past/cancelled event detail~~ — done in §10.
7. ~~Branded `/admin` access screens~~ — done in §10. Still open: avoid the console 401 on `/me` signed out.
8. ~~44px phone targets~~ — done in §10 for the audited pages (not for every state, e.g. wizard steps 2–4 and admin were only spot-covered).
9. Event-scoped staff + QR check-in (M5) before relying on volunteers at the door.
10. Per-organiser analytics and editing of published events.

**Then**
11. Human accessibility pass with VoiceOver and TalkBack; Safari/iOS and Firefox runs; full-motion visual review.
12. Test-mode payments end to end, then a deliberate go/no-go for live payments.
13. Copy and legal review (refunds, privacy, age-gating wording).

## 9. Commands used

```
git worktree list; git status; git log --oneline -3          # state check; branch feature/m2-responsive-admin @ 6bb6f08, clean
npm run lint
TEST_DATABASE_URL=postgres://localhost/sm_pv2_test npm test
npm run test:e2e                                              # before and after fixes; own server on :3100, DB sm_e2e (local)
# audit server (local only, own env, port 3200, DB sm_e2e, DEV_LOGIN=true, payments off):
env -i … SKIP_DOTENV=true NODE_ENV=development PORT=3200 DATABASE_URL=postgres://localhost/sm_e2e DEV_LOGIN=true \
  SESSION_SECRET=<e2e-only value> ENABLE_LIVE_PAYMENTS=false node server.js
# throwaway Playwright scripts (kept out of the repo) crawled 30 pages × 5 viewports for console/network/overflow/tap-target
# data and took the screenshots above; persona sign-in via POST /api/auth/dev (local only).
npx playwright test --project=mobile -g "no sideways scrolling at 320px"   # run against the OLD CSS to prove the new guard fails
```

Nothing was merged, rebased, reset, force-pushed or deployed; `main` and `launch-mvp` were not touched; no DNS, Vercel, payment or production data changes.


## 10. Follow-up pass: closed events, admin access screen, tap targets, card art

Branch `feature/m2-responsive-admin`, from head `515154d` (clean tree at start). Local only; nothing deployed, pushed, merged or touched on `main`/`launch-mvp`.

### What changed
| # | Fix | Files | Notes |
|---|---|---|---|
| 1 | Past and cancelled event pages show a status panel ("This event has ended" / "has been cancelled" + link to upcoming events) instead of ticket picker, quantity, submit button, venue-after-booking and "confirmation via Telegram" lines. Covers tiered and legacy single-price events. | `lib/views/event.js`, `public/css/site.css` | **Server-side enforcement already existed** (`bookTier` and the legacy booking path refuse unpublished and started events; approval refuses closed events). I added regression tests that lock it in; those tests passed *before* the view change, so they are guards, not fixes. Private venue is not in the closed page. |
| 2 | Signed-out and non-admin `/admin` use the site layout (header, footer, skip link) with a clear heading, a Telegram sign-in button (`/signin?next=/admin`) and a way back. HTTP status stays 401 / 403, `noindex`. The 403 screen no longer mentions the allowlist, and neither screen loads admin JS or carries role/CSRF data. | `lib/views/admin.js`, `e2e/admin.spec.js` (copy) | Authorization code (`lib/handlers/admin.js`) untouched. |
| 3 | 44px minimum touch targets at ≤800px: logo, header Telegram button (40→44) and "My bookings", `.btn-sm`, checkbox rows, footer links, card-title links, breadcrumbs, `link-arrow`, standalone prose links, booking-list titles. Desktop rules unchanged (all inside `max-width` queries). | `public/css/site.css` | In-sentence links are exempt (WCAG 2.5.8 inline exception). |
| 4 | Cards without a photo get a per-category tint and glyph (12 categories, inline SVG, `aria-hidden`), keeping the existing two-ring motif. Real covers still win. | `lib/views/components.js`, `public/css/site.css` | Reuses existing classes and brand colours; no new image files. It is a better fallback, not photography. |

Cache-bust `site.css` `v=10`→`v=11` (`lib/views/layout.js`, `lib/views/admin.js`).

### Tests added (regression)
- `test/closed-events.test.js` (9): closed pages have no picker; API refuses booking, no booking/payment row; pending request on a cancelled event cannot be approved; legacy page; `/admin` 401/403 screens. Page and `/admin` tests **failed before the fix** (6 failures run before editing views); API tests passed before (see above).
- `test/card-art.test.js` (2): each category has a distinct decorative glyph; unknown category and cover-photo fallbacks. Fails on the old markup (no glyph).
- `e2e/tap-targets.spec.js` (4, phone project, 320 and 375): measures every interactive control on public, menu-open, `/me` and organiser pages. Baseline run listed ~30 distinct offenders (footer links 20px tall, logo 27px, header button 40px, card titles ~26px, `.btn-sm` 36px, 20px checkbox rows); passes after.
- `e2e/closed-and-gates.spec.js` (desktop + phone): closed pages (no radio/combobox/checkbox/textbox/button in the booking panel, axe, no overflow, keyboard Enter on the link), signed-out `/admin` (401, heading, focus, ≥44px CTA, axe, 320px fit), non-admin 403, card art.

### Results (local; `sm_pv2_test` for unit, `sm_e2e` for browser)
| Check | Result |
|---|---|
| `npm run lint` | 96/96 files OK |
| `npm test` | 160/160 pass (was 149) |
| `npm run test:e2e` | 113 passed, 5 skipped, 0 failed (118 tests). Skips: 1 intentional mobile-menu skip; 4 phone-only tap-target tests skip on the desktop project. |

### Checks done and screenshots reviewed
Reviewed at 320, 375, tablet 768 and desktop 1280: past and cancelled event pages, `/events` cards, signed-out `/admin`, plus `/admin` 403 and card art from the suite's captures. Keyboard: closed-page link and admin sign-in CTA are focusable, Enter works. Accessible names: panel is the named "Booking" landmark; CTA names are visible text. Overflow: none at 320. Error states: API refusals tested; sign-in page's own failure states unchanged.

### Re-score (rubric in §1)
| Category | Before | After | Why |
|---|---|---|---|
| Visual polish | 68 | **70** | Better card fallback and cleaner closed pages; still no photography, so only +2 |
| Mobile UX | 72 | **76** | Tap targets fixed and now guarded by a test; checked only on the audited pages |
| Core user journeys | 50 | 50 | A misleading page was fixed, but no new journey works end to end |
| Accessibility | 70 | 70 | No human screen-reader pass yet (cap) |
| Reliability | 70 | 70 | More tests do not change what is observed in use |
| Launch readiness | 20 | 20 | Nothing deployed or externally verified |

Weighted 61.2; keeping the earlier 2-point deduction for the suite-green-but-broken D1 gives **59 / 100**. This is not a release-ready score.

### Outstanding product decisions / future work (not implemented here)
Member booking cancellation; QR check-in; event-scoped staff (`event_staff`, M5); additional OAuth providers (Google, M3); payment integration (live payments stay off). Also open: real event photography, `/me` signed-out console 401, tap targets on wizard steps 2–4 and unvisited states, Safari/Firefox/device and screen-reader checks, preview/production verification.
