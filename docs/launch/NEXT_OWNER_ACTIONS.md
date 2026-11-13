# NIGHTLIFEZ — Next Owner Actions & Machine Access Runbook

**Target Domain:** [nightlifez.com](https://nightlifez.com)  
**Target Email:** `nightlifezofficial@gmail.com`  
**Telegram Bot:** `@Nightlifez_bot`  
**Candidate Baseline:** `7a34d54` on `candidate/production-readiness`  
**Timestamp:** 2026-11-13T14:35:00+05:30  
**Status:** **DESTINATION VERIFIED — READY FOR AUTONOMOUS API EXECUTION OR DASHBOARD COMPLETION**

---

## 1. Master Task Classification Summary

- **VERIFIED:**
  - Destination email verification: `nightlifezofficial@gmail.com` (confirmed by owner).
  - Public DNS: Apex A (`76.76.21.21`), WWW CNAME (`cname.vercel-dns.com`) DNS-only (unproxied).
  - Vercel domain config: `misconfigured: false`, `verified: true`.
  - Let's Encrypt TLS 1.3 cert: `cert_A3MCXlA5bbrEzarNc98aVtPf` (valid Nov 13, 2026 to Feb 11, 2027).
  - HTTP 308 permanent redirect: `https://www.nightlifez.com` $\to$ `https://nightlifez.com/`.
  - Cloudflare Email Routing MX records: `route1`, `route2`, `route3.mx.cloudflare.net`.
  - Cloudflare Email Routing SPF TXT: `v=spf1 include:_spf.mx.cloudflare.net ~all`.
  - PR #45 CI suite (157 linted, 700 Postgres tests, Playwright E2E).
- **PENDING:**
  1. Creation of 3 Inbound Forwarding Rules in Cloudflare Email Routing.
  2. Publication of DMARC TXT record in Cloudflare DNS.
  3. End-to-end inbound delivery verification.
- **BLOCKED (Gated):**
  1. Production merge (PR #45 & PR #17 intentionally withheld).
  2. Production database migrations.
  3. Live payment gateway flags (`ENABLE_LIVE_PAYMENTS=false`, `UPI_CHECKOUT_ENABLED=false`).

---

## 2. Autonomous API Execution (Recommended: 30 Seconds)

To have Antigravity autonomously create the DMARC record and the 3 forwarding rules via the official Cloudflare v4 REST API without manual dashboard entry:

### Step 1: Create a Scoped Cloudflare API Token
1. Go to [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token** $\to$ Use **Create Custom Token**.
3. Name: `nightlifez-email-routing`
4. Add Permissions:
   - **Zone $\to$ DNS $\to$ Edit**
   - **Zone $\to$ Email Routing Rules $\to$ Edit**
   - **Zone $\to$ Email Routing Addresses $\to$ Read**
   - **Zone $\to$ Zone $\to$ Read**
5. Zone Resources: **Include $\to$ Specific zone $\to$ `nightlifez.com`**.
6. Click **Continue to summary** $\to$ **Create Token**.

### Step 2: Provision Securely to Local Machine (Zero Chat Exposure)
In your local terminal (do NOT paste the token into this chat):
```bash
mkdir -p ~/.cloudflare && chmod 700 ~/.cloudflare
echo "YOUR_TOKEN_HERE" > ~/.cloudflare/token
chmod 600 ~/.cloudflare/token
```
*Once saved, reply "Token provisioned" in chat. Antigravity will automatically execute Phases 2 through 5.*

---

## 3. Alternative: Manual Dashboard Entry (1 Minute)
If you prefer not to create an API token, you can complete the 4 entries directly in your open Chrome browser:
1. **DMARC Record:** [Cloudflare DNS](https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/nightlifez.com/dns/records) $\to$ **Add record** $\to$ Type `TXT`, Name `_dmarc`, Content `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`.
2. **3 Forwarding Rules:** [Email Routing Rules](https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/routes) $\to$ **Create rule**:
   - `contact@nightlifez.com` $\to$ `nightlifezofficial@gmail.com`
   - `safety@nightlifez.com` $\to$ `nightlifezofficial@gmail.com`
   - `grievance@nightlifez.com` $\to$ `nightlifezofficial@gmail.com`
   - Catch-all: **Disabled / Drop**.
