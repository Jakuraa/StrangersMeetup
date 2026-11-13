# NIGHTLIFEZ — Next Owner Actions & Infrastructure Runbook

**Target Domain:** [nightlifez.com](https://nightlifez.com)  
**Target Email:** `nightlifezofficial@gmail.com`  
**Telegram Bot:** `@Nightlifez_bot`  
**Candidate Commit:** `8a31fab` on `candidate/production-readiness`  
**Timestamp:** 2026-11-13T13:55:00+05:30  
**Status:** **INFRASTRUCTURE OPERATIONAL — DESTINATION & DMARC PENDING OWNER MANUAL COMPLETION**

---

## 1. Master Task Classification Summary

- **VERIFIED:** Apex A (`76.76.21.21`, DNS-only), WWW CNAME (`cname.vercel-dns.com`, DNS-only), Vercel domain config (`misconfigured: false`), Let's Encrypt TLS 1.3 cert (`cert_A3MCXlA5bbrEzarNc98aVtPf`), HTTP 308 redirect, Cloudflare MX records (`route1`, `route2`, `route3`), Cloudflare SPF TXT (`v=spf1 include:_spf.mx.cloudflare.net ~all`), CI suite (157 lint, 700 Postgres tests, E2E).
- **PENDING:**
  1. Destination verification: `nightlifezofficial@gmail.com` in Cloudflare (currently `Pending`).
  2. DMARC TXT publication: `_dmarc` on Cloudflare authoritative NS (currently absent).
- **BLOCKED (Gated):**
  1. Creation of 3 forwarding rules (`contact@`, `safety@`, `grievance@` $\to$ `nightlifezofficial@gmail.com`).
  2. End-to-end inbound email delivery test.
  3. Production merge & deployment (PR #45 & PR #17 held).
  4. Production database migrations.
  5. Live payment flags (`ENABLE_LIVE_PAYMENTS=false`, `UPI_CHECKOUT_ENABLED=false`).

---

## 2. Immediate Owner Actions (Manual Completion)

### Step 1: Confirm Destination in Gmail
Both tabs are open in your Google Chrome browser:
1. In the **Gmail tab (`nightlifezofficial@gmail.com`)**:
   [https://mail.google.com/mail/u/2/#inbox](https://mail.google.com/mail/u/2/#inbox)
   - Locate the email from Cloudflare: `[Cloudflare] Please verify your email address`.
   - Click the blue button: **"Verify email address"**.
2. In the **Cloudflare Destination Addresses tab**:
   [https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/destination-addresses](https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/destination-addresses)
   - Reload the page and confirm the status badge transitions from `Pending` to **`Verified`**.

### Step 2: Publish DMARC TXT Record in Cloudflare DNS
In Cloudflare, go to **DNS → Records** and click **Add record**:
- **Type:** `TXT`
- **Name:** `_dmarc`
- **Content:** `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`
- **TTL:** `Auto`
- Click **Save**.

---

## 3. Immediate Next Execution Upon Confirmation
Once you reply that the destination is **Verified** and DMARC is saved:
1. Antigravity will re-query authoritative DNS to verify the DMARC TXT record.
2. Antigravity will provision the 3 routing rules (`contact@`, `safety@`, `grievance@`).
3. Antigravity will dispatch distinct test emails to each alias and confirm inbound delivery into `nightlifezofficial@gmail.com`.
