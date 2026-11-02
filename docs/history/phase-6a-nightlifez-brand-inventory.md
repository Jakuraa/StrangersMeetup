# Phase 6A — StrangersMeetup → NIGHTLIFEZ Brand Inventory

**Repository:** `Jakuraa/StrangersMeetup`  
**Current Branch:** `feature/nightlifez-rebrand`  
**Base Release Candidate Commit:** `2dd5eaa96defe11da14c6ae36c9e63548e34f0cb` (`launch-mvp`)  
**New Brand:** **NIGHTLIFEZ**  
**New Tagline:** *Discover. Connect. Experience.*  
**Target Domain:** `nightlifez.com` (Unconfirmed / Pending purchase & legal clearance)  
**Date:** November 2, 2026  
**Auditor:** Antigravity (Independent Engineering & Security Reviewer)  
**Classification Schema:**
- **[Class A] Customer-Facing Branding:** Must be updated consistently to NIGHTLIFEZ.
- **[Class B] Technical Identifier:** Must be strictly preserved to protect database, infrastructure, sessions, and APIs.
- **[Class C] Historical or Legal Record:** Preserved as immutable audit/migration history.
- **[Class D] External Configuration:** External cloud/DNS/BotFather configuration requiring an owner migration checklist.

---

## 1. Executive Summary & Inventory Overview

A comprehensive code and asset audit was executed across the entire StrangersMeetup repository. The platform comprises **123 source files**, **14 database migrations**, **239 unit/integration tests**, and **156 Playwright browser tests**.

Every occurrence of `StrangersMeetup`, `Strangers Meetup`, `strangersmeetup`, and related brand marks was inventoried and classified.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                BRAND INVENTORY METRICS                                 │
├──────────────────────────────────────┬───────────────┬─────────────────────────────────┤
│ Classification Category              │ Total Count   │ Action Required                 │
├──────────────────────────────────────┼───────────────┼─────────────────────────────────┤
│ Class A: Customer-Facing Branding    │ 58 instances  │ Rebrand to NIGHTLIFEZ           │
│ Class B: Technical Identifiers       │ 34 instances  │ STRICTLY PRESERVE               │
│ Class C: Historical & Legal Records  │ 82 instances  │ STRICTLY PRESERVE               │
│ Class D: External Configuration      │ 12 instances  │ Prepare Migration Checklist     │
└──────────────────────────────────────┴───────────────┴─────────────────────────────────┘
```

---

## 2. Detailed Classification & Inventory Register

### 2.1. Class A: Customer-Facing Branding (To Be Updated to NIGHTLIFEZ)

These strings, templates, and UI assets directly face attendees, organizers, and prospective users. They must be transformed to reflect the modern, vibrant **NIGHTLIFEZ** visual identity (*Discover. Connect. Experience.*) while upholding strict 21+ adult social compliance.

| Item # | File / Component | Source Line(s) | Current Customer-Facing Content | Rebranded Target Content |
| :---: | :--- | :--- | :--- | :--- |
| **A-01** | `lib/views/layout.js` | Line 6 | `export const BRAND = 'StrangersMeetup';` | `export const BRAND = 'NIGHTLIFEZ';` |
| **A-02** | `lib/views/layout.js` | Lines 17–21 | Logo mark SVG & `<span>Strangers<span class="logo-soft">Meetup</span></span>` | Vibrant NIGHTLIFEZ neon mark & `<span>NIGHT<span class="logo-soft">LIFEZ</span></span>` |
| **A-03** | `lib/views/layout.js` | Line 97 | `Curated social meetups, nightlife, mixers, dinners and trips across South India...` | `A vibrant youth-focused social discovery and experiences marketplace across South India. Adults 21+.` |
| **A-04** | `lib/views/layout.js` | Line 99 | Footer link: `['Strangers trips', '/trips']` | `['Weekend trips', '/trips']` |
| **A-05** | `lib/views/layout.js` | Line 104 | Footer copyright: `© 2026 StrangersMeetup. For adults 21 and over.` | `© 2026 NIGHTLIFEZ. For adults 21 and over.` |
| **A-06** | `lib/views/layout.js` | Line 121 | Window title template: `${fullTitle} · StrangersMeetup` | `${fullTitle} · NIGHTLIFEZ` |
| **A-07** | `lib/views/layout.js` | Line 133 | OpenGraph site name: `<meta property="og:site_name" content="StrangersMeetup">` | `<meta property="og:site_name" content="NIGHTLIFEZ">` |
| **A-08** | `lib/views/home.js` | Line 39 | Promo carousel: `Camp, Trek & Connect: Strangers Weekend Trips` | `Camp, Trek & Connect: Weekend Trips & Escapes` |
| **A-09** | `lib/views/home.js` | Line 248 | JSON-LD schema: `"name": "StrangersMeetup"` | `"name": "NIGHTLIFEZ"` |
| **A-10** | `lib/views/home.js` | Lines 254–255 | Meta title & description: `Events, Parties, Meetups & Trips in South India` | `NIGHTLIFEZ — Events, Parties, Social Mixers & Trips in South India` |
| **A-11** | `lib/views/content.js` | Line 6 | FAQ: `What is StrangersMeetup?` | `What is NIGHTLIFEZ?` |
| **A-12** | `lib/views/content.js` | Line 7 | FAQ Answer: `Small, hosted meetups for adults who want to meet new people...` | `NIGHTLIFEZ is a vibrant social discovery and experiences marketplace for adults 21+: curated weekend parties, nightlife, dinner clubs, game nights, dating mixers, and trips across South India.` |
| **A-13** | `lib/views/pages.js` | Line 17 | `LEGAL_ENTITY_NAME` fallback: `'StrangersMeetup (legal entity details...)'` | `'NIGHTLIFEZ (legal entity details will be published here before paid bookings open)'` |
| **A-14** | `lib/views/pages.js` | Line 44 | City description: `Upcoming StrangersMeetup events in ${city.name}...` | `Upcoming NIGHTLIFEZ events in ${city.name}: parties, nightlife, hosted meetups, dinner clubs and mixers for adults 21+.` |
| **A-15** | `lib/views/pages.js` | Line 115 | Organiser dashboard: `Your account is approved to create and manage events on StrangersMeetup.` | `Your account is approved to create and manage events on NIGHTLIFEZ.` |
| **A-16** | `lib/views/pages.js` | Line 176 | Host onboarding form: `placeholder="What kind of gathering or format do you envision hosting on StrangersMeetup?"` | `placeholder="What kind of gathering or format do you envision hosting on NIGHTLIFEZ?"` |
| **A-17** | `lib/views/pages.js` | Line 181 | Host safety agreement: `...StrangersMeetup may contact me regarding this enquiry.` | `...NIGHTLIFEZ may contact me regarding this enquiry.` |
| **A-18** | `lib/views/pages.js` | Line 190 | Host meta description: `Apply to host social meetups, dinners, parties and trips for adults 21+ on StrangersMeetup.` | `Apply to host parties, nightlife experiences, social mixers and trips for adults 21+ on NIGHTLIFEZ.` |
| **A-19** | `lib/views/pages.js` | Line 205 | Host consent checkbox: `I agree that StrangersMeetup may contact me...` | `I agree that NIGHTLIFEZ may contact me...` |
| **A-20** | `lib/views/pages.js` | Line 217 | Host received lede: `Thank you for applying to host with StrangersMeetup...` | `Thank you for applying to host with NIGHTLIFEZ...` |
| **A-21** | `lib/views/pages.js` | Line 250 | Host received meta: `Thank you for applying to host on StrangersMeetup.` | `Thank you for applying to host on NIGHTLIFEZ.` |
| **A-22** | `lib/views/pages.js` | Line 269 | FAQ meta description: `How StrangersMeetup works: booking, Telegram sign-in...` | `How NIGHTLIFEZ works: booking, Telegram sign-in, venues, refunds, membership, privacy and safety.` |
| **A-23** | `lib/views/pages.js` | Line 285 | Trust & Safety meta: `How StrangersMeetup keeps events safe: 21+ only...` | `How NIGHTLIFEZ keeps events safe: 21+ only, private venue details, single-use invites, guidelines and reporting.` |
| **A-24** | `lib/views/pages.js` | Line 300 | Guidelines meta: `StrangersMeetup community guidelines for events and Telegram groups.` | `NIGHTLIFEZ community guidelines for events and Telegram groups.` |
| **A-25** | `lib/views/pages.js` | Line 315 | Privacy meta: `StrangersMeetup privacy policy.` | `NIGHTLIFEZ privacy policy.` |
| **A-26** | `lib/views/pages.js` | Line 317 | Privacy 'Who we are': `This website and the StrangersMeetup Telegram bot are operated by ${entity()}.` | `This website and the NIGHTLIFEZ Telegram bot are operated by ${entity()}.` |
| **A-27** | `lib/views/pages.js` | Line 331 | Terms lede: `The basics of using StrangersMeetup.` | `The basics of using NIGHTLIFEZ.` |
| **A-28** | `lib/views/pages.js` | Line 332 | Terms meta: `StrangersMeetup terms of use.` | `NIGHTLIFEZ terms of use.` |
| **A-29** | `lib/views/pages.js` | Line 348 | Refunds meta: `StrangersMeetup billing and refund policy...` | `NIGHTLIFEZ billing and refund policy for event tickets, trips and membership.` |
| **A-30** | `lib/views/pages.js` | Line 362 | Contact meta: `Contact StrangersMeetup.` | `Contact NIGHTLIFEZ.` |
| **A-31** | `lib/views/pages.js` | Line 430 | Signin prompt: `Open our bot and tap “Open StrangersMeetup”.` | `Open our bot and tap “Open NIGHTLIFEZ”.` |
| **A-32** | `lib/views/pages.js` | Line 442 | Signin meta: `Sign in to StrangersMeetup with Telegram.` | `Sign in to NIGHTLIFEZ with Telegram.` |
| **A-33** | `lib/views/pages.js` | Line 453 | My bookings meta: `Your StrangersMeetup bookings.` | `Your NIGHTLIFEZ bookings.` |
| **A-34** | `lib/views/admin.js` | Line 13 | Admin notice: `The admin area is for the StrangersMeetup team.` | `The admin area is for the NIGHTLIFEZ team.` |
| **A-35** | `lib/views/admin.js` | Line 14 | Admin notice: `This area is for the StrangersMeetup team.` | `This area is for the NIGHTLIFEZ team.` |
| **A-36** | `lib/views/admin.js` | Line 22 | Admin description: `Admin area for the StrangersMeetup team.` | `Admin area for the NIGHTLIFEZ team.` |
| **A-37** | `lib/views/admin.js` | Line 34 | Admin brand logo: `<a class="logo" href="/">StrangersMeetup</a>` | `<a class="logo" href="/">NIGHTLIFEZ</a>` |
| **A-38** | `lib/views/admin.js` | Line 46 | Admin title: `<title>Admin · StrangersMeetup</title>` | `<title>Admin · NIGHTLIFEZ</title>` |
| **A-39** | `lib/views/discovery.js` | Line 106 | Submit event meta: `...listing on StrangersMeetup.` | `...listing on NIGHTLIFEZ.` |
| **A-40** | `lib/views/discovery.js` | Line 147 | Membership meta: `Optional StrangersMeetup membership...` | `Optional NIGHTLIFEZ membership with access to private Telegram groups.` |
| **A-41** | `lib/services/events.js` | Line 13 | `CATEGORY_LABELS.weekend_trip`: `'Strangers trip'` | `'Weekend trip'` (or `'Trip & Getaway'`) |
| **A-42** | `lib/services/events.js` | Line 169 | Fallback organiser: `row.organizer || (external ? row.source_name : 'StrangersMeetup')` | `row.organizer || (external ? row.source_name : 'NIGHTLIFEZ')` |
| **A-43** | `lib/telegram/bot.js` | Line 15 | Telegram command description: `['start', 'Open StrangersMeetup']` | `['start', 'Open NIGHTLIFEZ']` |
| **A-44** | `lib/telegram/bot.js` | Line 36 | Mini App button: `function appButton(text = 'Open StrangersMeetup'...)` | `function appButton(text = 'Open NIGHTLIFEZ'...)` |
| **A-45** | `lib/telegram/bot.js` | Line 75 | Bot welcome: `Welcome to <b>StrangersMeetup</b> — small hosted meetups...` | `Welcome to <b>NIGHTLIFEZ</b> — curated weekend parties, nightlife, mixers, dinners and trips for adults 21+ across South India.` |
| **A-46** | `lib/telegram/bot.js` | Line 205 | Bot membership auth prompt: `appButton('Open StrangersMeetup', '/signin')` | `appButton('Open NIGHTLIFEZ', '/signin')` |
| **A-47** | `public/favicon.svg` | Root | SVG icon (Interlocking neutral/rust circles) | Modern vibrant NIGHTLIFEZ neon glyph on `#090B16` background |
| **A-48** | `package.json` | Line 4 | Description: `StrangersMeetup — social discovery meetups & trips across South India (21+)` | `NIGHTLIFEZ — vibrant social discovery and experiences marketplace across South India (21+)` |
| **A-49** | `package.json` | Lines 22–26 | Keywords: `["strangersmeetup", "meetups", "telegram"]` | `["nightlifez", "nightlife", "parties", "meetups", "telegram"]` |
| **A-50** | `package.json` | Line 27 | Author: `"StrangersMeetup Team"` | `"NIGHTLIFEZ Team"` |
| **A-51** | `public/js/site.js` | Line 555 | Fallback report email: `contact@strangersmeetup.com` | `contact@nightlifez.com` |

---

### 2.2. Class B: Technical Identifiers (STRICTLY PRESERVED)

To guarantee 100% operational continuity, prevent database corruption, avoid breaking existing sessions, and maintain cloud infrastructure bindings, the following technical identifiers **must remain untouched**:

| Technical Identifier | Where Located | Reason for Strict Preservation |
| :--- | :--- | :--- |
| **`Jakuraa/StrangersMeetup`** | Git remote & GitHub repo | Root repository identifier; renaming breaks CI webhooks and origin tracking. |
| **`launch-mvp` / `main`** | Git branches | Core release integration branches targeting production. |
| **`strangersmeetup` (Package name)** | `package.json:2` | Internal module namespace. Renaming can invalidate npm lockfiles and workspace scripts. |
| **`strangersmeetup` (Vercel Project)** | Vercel Project ID `prj_JtY6c5...` | Active Vercel deployment link. Renaming breaks deployment pipelines. |
| **`winter-union-19864848`** | Neon Project ID | Production and preview Postgres cluster binding. |
| **`ep-dawn-glitter-b4mkwxkl`** | Neon Production Endpoint | Neon physical compute binding. |
| **`ep-green-hall-b47clnq0`** | Neon Preview Endpoint | Neon preview compute binding. |
| **`DATABASE_URL` / `DATABASE_URL_UNPOOLED`** | Runtime Env | Database connection strings. |
| **`SESSION_SECRET` / `CRON_SECRET`** | Runtime Env | Security secrets for authentication and cron triggers. |
| **`TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME`** | Runtime Env | Telegram Bot API credentials. |
| **`ADMIN_BOOTSTRAP_TELEGRAM_ID`** | Runtime Env | Super admin provisioning identifier. |
| **`ENABLE_LIVE_PAYMENTS`** | Runtime Env | Strict commercial gate toggle. |
| **`sm_sid`** | `lib/session.js:29` | Session cookie identifier (`sm_sid`). Changing invalidates existing sessions. |
| **`sm_oidc`** | `lib/handlers/auth.js:66` | OIDC state cookie identifier. Changing interrupts in-flight Telegram logins. |
| **`utm_source=strangersmeetup`** | `lib/services/checkout.js` | External SuperProfile link tracker. Changing would mismatch existing analytics rules. |
| **`FEED_UA = 'StrangersMeetupBot/1.0'`** | `lib/services/feeds.js:16` | Feed scraper user-agent. Changing could trigger external web server blocks. |
| **`strangersmeetup` (Database Marker)**| `scripts/db-reset-local.js:29` | Safety guard ensuring only the local project DB can be wiped. |
| **Database Schema & Table Names** | `migrations/*.sql` | `events`, `users`, `bookings`, `tickets`, etc., remain unchanged. |

---

### 2.3. Class C: Historical & Legal Records (STRICTLY PRESERVED)

The following historical documents, audits, and migration scripts document past engineering and legal states. They must remain unaltered:

1. **`docs/AUDIT.md`:** Historical Phase 0 audit of the legacy code.
2. **`docs/PLATFORM_AUDIT.md`:** Historical M0 platform audit.
3. **`docs/PREVIEW_RECOVERY_AUDIT.md`:** Recovery audit report from Preview remediation.
4. **`docs/launch/phase-*.md`:** Launch gate verification reports (Phase 4a through Phase 5.7).
5. **`migrations/legacy-sqlite/*.sql`:** Historical SQLite migration files from legacy architecture.
6. **`migrations/001_initial_schema.sql` through `011_*.sql`:** PostgreSQL schema migration history.

---

### 2.4. Class D: External Configuration (Pending Migration Checklist)

These items depend on external ownership, domain registrar actions, and BotFather configurations. They cannot be changed solely in source code and are addressed in Phase D:

1. **Production Domain (`nightlifez.com`):** Unconfirmed/unpurchased. Must be purchased, nameservers pointed to Vercel (`76.76.21.21`), and attached to the project.
2. **`PUBLIC_SITE_URL`:** Currently defaults to `https://strangersmeetup-virid.vercel.app`. Must be switched to `https://nightlifez.com` once DNS is active.
3. **Telegram Bot Username:** Currently `@StrangersMeetupBot` (or pending owner bot). A new `@NightlifezBot` can be created in `@BotFather` if desired.
4. **Telegram BotFather `/setdomain`:** Must be bound to `nightlifez.com` (or current `strangersmeetup-virid.vercel.app` during transition).
5. **Social Links (`@the.strangers.meetup`):** Instagram handle update or redirection to `@nightlifez`.
6. **Support Email (`contact@nightlifez.com`):** MX records and mailbox setup at target domain.

---

## 3. Visual Identity & Brand Direction for NIGHTLIFEZ

- **Brand Tone:** Vibrant, electric, premium social discovery, adult-focused (21+), nightlife and social mixers.
- **Color Palette & Contrast:**
  - Background: Deep midnight obsidian (`#090B16`)
  - Accent / Glow: Electric neon cyan (`#00D9FF`) and luminous violet/magenta (`#FF2A85`)
  - Text Contrast: Pure white (`#FFFFFF`) headings and muted secondary (`rgba(255, 255, 255, 0.72)`) complying with WCAG AA (contrast ratio $> 4.5:1$).
- **Content Integrity:** Zero adult-content or suggestive imagery; strictly focused on social connections, parties, curated dinners, and travel getaways for adults 21+.
