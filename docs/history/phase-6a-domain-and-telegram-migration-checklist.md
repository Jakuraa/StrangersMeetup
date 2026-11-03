# Phase 6A — Domain & Telegram Migration Checklist (StrangersMeetup → NIGHTLIFEZ)

**Document:** Domain and Telegram Migration Checklist  
**Project:** NIGHTLIFEZ (`Jakuraa/StrangersMeetup`)  
**Proposed Domain:** `nightlifez.com`  
**Current Status:** PROPOSED / UNCONFIRMED (Awaiting Purchase & Legal Clearance)  
**Target Environment:** Production (`prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`)  
**Date:** 2026-11-02  
**Status:** DRAFT / PENDING OWNER PURCHASE & LEGAL CLEARANCE

---

> [!CAUTION]
> **DO NOT EXECUTE THESE CHANGES PREMATURELY.**
> The domain `nightlifez.com` has NOT yet been confirmed as purchased or legally cleared for commercial operations under Indian Law.
> **Zero changes** may be made to production DNS, Vercel domains, Telegram BotFather, or live credentials until legal clearance is obtained and explicit product owner authorization is granted.

---

## 1. Prerequisites & Legal Clearance Gate

Before initiating any technical migration steps:

- [ ] **Domain Purchase Confirmation:**
  - Secure ownership of `nightlifez.com` through a reputable ICANN-accredited registrar.
  - Enable WHOIS privacy protection and registrar lock.
  - Enable Multi-Factor Authentication (MFA) on the registrar account.
- [ ] **Trademark Clearance (India & Key Jurisdictions):**
  - Verify that "NIGHTLIFEZ" does not infringe upon registered trademarks in Nice Class 35 (advertising/marketplace), Class 41 (entertainment/events), or Class 42 (software/platform).
  - Obtain written sign-off from qualified Indian IP counsel.
- [ ] **Business Identity Registration:**
  - Confirm legal entity name under which the domain and service operate.
  - Confirm official registered grievance officer and grievance contact email.

---

## 2. Infrastructure & Vercel Custom Domain Configuration

### 2.1 Add Domain to Vercel Project
- [ ] Log in to Vercel dashboard and navigate to project `prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa` (`strangersmeetup`).
- [ ] Go to **Settings** → **Domains**.
- [ ] Add the following domain records:
  - `nightlifez.com` (Recommended: Redirect to `www.nightlifez.com` or serve as primary apex).
  - `www.nightlifez.com` (Primary production hostname).
- [ ] Select **Production** environment assignment.

### 2.2 DNS & TLS Validation
- [ ] In the domain registrar DNS manager, configure the required Vercel DNS records:
  - **Apex (`nightlifez.com`):**
    - `A` record pointing to `76.76.21.21` (or registrar ALIAS/ANAME if supported).
  - **Subdomain (`www.nightlifez.com`):**
    - `CNAME` record pointing to `cname.vercel-dns.com`.
- [ ] Verify SSL/TLS certificate issuance:
  - Vercel automatically requests and provisions Let's Encrypt certificates.
  - Confirm status shows `Valid Configuration` with a green checkmark in Vercel dashboard.

---

## 3. Environment Variable Reconfiguration

The following variables must be updated in Vercel **Production** environment settings:

| Variable | Current/Fallback Value | Target Rebrand Value | Owner Action Required |
| :--- | :--- | :--- | :--- |
| `PUBLIC_SITE_URL` | Staging/Preview URL | `https://nightlifez.com` (or `https://www.nightlifez.com`) | Update in Vercel Production Environment Settings. **No trailing slash.** |
| `TELEGRAM_BOT_USERNAME` | Existing bot username | New or updated bot username (e.g. `NightlifezBot`) | Confirm username after BotFather setup. |
| `LEGAL_ENTITY_NAME` | Placeholder | Registered corporate/LLP entity name | Confirm with legal counsel. |
| `GRIEVANCE_OFFICER_NAME`| Placeholder | Designated Officer Name | Confirm with legal counsel. |
| `GRIEVANCE_EMAIL` | Placeholder | `grievance@nightlifez.com` | Create mailbox and configure in Vercel. |
| `ENABLE_LIVE_PAYMENTS` | `false` | `false` (until payment readiness audit) | **Keep `false`** for Free-Only launch. |

---

## 4. Telegram BotFather Configuration

The Telegram login widget and inline web app require strict domain authorization via BotFather:

### 4.1 Update Existing Bot or Register New Brand Bot
- [ ] Open Telegram and message `@BotFather`.
- [ ] If retaining existing bot:
  - Send `/setname` → Select bot → Enter `NIGHTLIFEZ`.
  - Send `/setdescription` → Enter:
    `NIGHTLIFEZ — Discover events, meet new people, and experience your city. Vibrant social discovery & experiences marketplace. Strictly 21+.`
  - Send `/setabouttext` → Enter `Discover. Connect. Experience. https://nightlifez.com`.
  - Send `/setuserpic` → Upload the official NIGHTLIFEZ avatar (squircle with cyan/magenta pulse).
- [ ] If registering a dedicated new bot:
  - Send `/newbot` → Name: `NIGHTLIFEZ` → Username: `nightlifez_bot` (or available alternative).
  - Copy new `TELEGRAM_BOT_TOKEN` directly into Vercel Production environment (never expose in git or chat).
  - Update `TELEGRAM_BOT_USERNAME` in Vercel.

### 4.2 Authorize Domain (`/setdomain`)
- [ ] In `@BotFather`, send `/setdomain`.
- [ ] Select the bot.
- [ ] Enter the exact domain hostname: `nightlifez.com` (or `www.nightlifez.com`, matching `PUBLIC_SITE_URL`).
- [ ] Verify BotFather confirms: `"Success! Domain linked to the bot."`

---

## 5. Session, Cookie & Security Scope Verification

### 5.1 Cookie Domain Behavior
- [ ] Review `lib/auth/session.js`:
  - Session cookie: `sm_sid`
  - OIDC temporary state cookie: `sm_oidc`
  - Current configuration uses host-only cookies (omits `Domain=` attribute).
  - **Recommendation:** Maintain host-only cookies. This prevents cookie leakage across untrusted subdomains and ensures seamless operation on `nightlifez.com`.
  - Verify flags: `HttpOnly=true`, `SameSite=Lax`, `Secure=true`.

### 5.2 Content Security Policy & CORS
- [ ] Verify that Telegram login script origin is permitted:
  - `https://telegram.org`
  - `https://oauth.telegram.org`
- [ ] Verify image sources:
  - Self origin (`'self'`)
  - Telegram user avatars (`https://t.me`, `https://*.telegram.org`)
  - Cloudflare/Vercel Blob storage (if configured)

---

## 6. Email & Communications Infrastructure

- [ ] **Domain Mailboxes:**
  - Create `contact@nightlifez.com` for general support and host inquiries.
  - Create `grievance@nightlifez.com` for statutory compliance and IT Act escalation.
- [ ] **Email Authentication Records:**
  - Add `TXT` record for SPF: `v=spf1 include:... ~all`.
  - Add `CNAME`/`TXT` records for DKIM.
  - Add `TXT` record for DMARC: `v=DMARC1; p=quarantine; rua=mailto:dmarc@nightlifez.com`.
- [ ] **Template Updates:**
  - Verify that transactional ticket confirmation emails and notification emails reference `NIGHTLIFEZ` and link to `https://nightlifez.com/bookings`.

---

## 7. Migration Execution Runbook (Step-by-Step)

```
[ Phase 1: Legal & Purchase ]
  ├── 1. Acquire nightlifez.com domain & lock registrar
  ├── 2. Legal review & trademark clearance sign-off
  └── 3. Mailbox creation (contact@, grievance@)

[ Phase 2: DNS & Cloud Setup ]
  ├── 4. Add domain to Vercel project
  ├── 5. Configure DNS A/CNAME records
  └── 6. Verify SSL certificate issuance (https://nightlifez.com)

[ Phase 3: Telegram Alignment ]
  ├── 7. Message @BotFather /setdomain to nightlifez.com
  └── 8. Update bot name, bio, and avatar

[ Phase 4: Production Env Update ]
  ├── 9. Update PUBLIC_SITE_URL=https://nightlifez.com
  ├── 10. Update LEGAL_* and GRIEVANCE_* variables
  └── 11. Trigger production deployment from approved branch

[ Phase 5: Verification & Smoke Test ]
  ├── 12. Verify homepage, navigation, and footer
  ├── 13. Verify Telegram login widget flow
  ├── 14. Verify free ticket booking and pass generation
  └── 15. Verify 404/redirect from legacy endpoints
```

---

## 8. Rollback Procedure

If domain routing, DNS propagation, or Telegram authentication encounters critical failure during cutover:

1. **Revert Telegram Bot Domain:**
   - Message `@BotFather` → `/setdomain` → Revert to the fallback active hostname.
2. **Revert Vercel Environment Variables:**
   - Change `PUBLIC_SITE_URL` back to the stable hostname.
   - Redeploy the production release candidate.
3. **DNS Fallback:**
   - Retain previous DNS records with low TTL (300s) during the transition window to enable immediate recovery.
