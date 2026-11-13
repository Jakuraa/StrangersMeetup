# NIGHTLIFEZ — Next Owner Actions & Infrastructure Runbook

**Target Domain:** [nightlifez.com](https://nightlifez.com)  
**Target Email:** `nightlifezofficial@gmail.com`  
**Telegram Bot:** `@Nightlifez_bot`  
**Candidate Baseline:** `5197a9d` on `candidate/production-readiness`  
**Timestamp:** 2026-11-13T14:15:00+05:30  
**Status:** **DESTINATION VERIFIED — READY FOR 3 FORWARDING RULES & DMARC RECORD**

---

## 1. Master Task Classification Summary

- **VERIFIED:**
  - Destination email verification: `nightlifezofficial@gmail.com` (verified by owner with official Cloudflare confirmation page).
  - Public DNS: Apex A (`76.76.21.21`), WWW CNAME (`cname.vercel-dns.com`) DNS-only (unproxied).
  - Vercel domain config: `misconfigured: false`, `verified: true`.
  - Let's Encrypt TLS 1.3 certificate: `cert_A3MCXlA5bbrEzarNc98aVtPf` (valid Nov 13, 2026 to Feb 11, 2027).
  - HTTP 308 permanent redirect: `https://www.nightlifez.com` $\to$ `https://nightlifez.com/`.
  - Cloudflare Email Routing MX records: `route1`, `route2`, `route3.mx.cloudflare.net`.
  - Cloudflare Email Routing SPF TXT: `v=spf1 include:_spf.mx.cloudflare.net ~all`.
  - Full CI suite on PR #45 (157 linted, 700 Postgres tests, Playwright E2E).
- **PENDING:**
  1. Creation of 3 Inbound Forwarding Rules in Cloudflare Email Routing.
  2. Publication of DMARC TXT record in Cloudflare DNS.
  3. End-to-end inbound delivery verification.
- **BLOCKED (Gated):**
  1. Machine Access Layer browser clicking (session lacks coordinate GUI agent; AppleScript JS and TinyFish strictly prohibited).
  2. Production merge (PR #45 & PR #17 intentionally withheld).
  3. Production database migrations.
  4. Live payment gateway flags (`ENABLE_LIVE_PAYMENTS=false`, `UPI_CHECKOUT_ENABLED=false`).

---

## 2. Immediate Owner Actions (3 Minutes in Open Cloudflare Dashboard)

Your Chrome browser is open and authenticated to Cloudflare. Complete these final setup steps:

### Step 1: Add the 3 Inbound Forwarding Rules
In Cloudflare Dashboard $\to$ **Email Routing** $\to$ **Routing Rules** ([https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/routes](https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/routes)):
Click **"Create rule"** for each:
1. **Rule 1:**
   - Custom address: `contact` @ `nightlifez.com`
   - Action: `Send to`
   - Destination address: `nightlifezofficial@gmail.com`
2. **Rule 2:**
   - Custom address: `safety` @ `nightlifez.com`
   - Action: `Send to`
   - Destination address: `nightlifezofficial@gmail.com`
3. **Rule 3:**
   - Custom address: `grievance` @ `nightlifez.com`
   - Action: `Send to`
   - Destination address: `nightlifezofficial@gmail.com`
- Verify **Catch-all** rule is **Disabled** or set to **Drop**.

---

### Step 2: Publish DMARC TXT Record in Cloudflare DNS
In Cloudflare Dashboard $\to$ **DNS** $\to$ **Records** ([https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/nightlifez.com/dns/records](https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/nightlifez.com/dns/records)):
Click **"Add record"**:
- **Type:** `TXT`
- **Name:** `_dmarc`
- **Content:** `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`
- **TTL:** `Auto`
- Click **Save**.

---

## 3. Phase 4 Execution Upon Completion
Once you finish these steps and reply:
1. Antigravity will empirically verify the live DMARC record on both authoritative nameservers (`alexandra` and `chance`).
2. Dispatch 3 test emails to `contact@nightlifez.com`, `safety@nightlifez.com`, and `grievance@nightlifez.com` to confirm end-to-end receipt in `nightlifezofficial@gmail.com`.
3. Finalise and seal the launch documentation.
