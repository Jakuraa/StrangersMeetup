# NIGHTLIFEZ — Cloudflare DNS, SSL & Email Destination Audit

**Domain:** `nightlifez.com`  
**Cloudflare Account Context:** `Satelinkinternet@gmail.com's Account`  
**Cloudflare Account ID:** `56bbee1ae042d8a991d6d8b5eddad865`  
**Cloudflare Zone ID:** `10a4dcb91581bb730c90da29a57655a7`  
**Authoritative Nameservers:** `alexandra.ns.cloudflare.com`, `chance.ns.cloudflare.com`  
**Vercel Project:** `jakuraa/strangersmeetup` (`prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`)  
**Audit Timestamp:** 2026-11-13T13:30:00+05:30  
**Overall Status:** **DNS & SSL LIVE (PASS) — EMAIL ROUTING MX/SPF ACTIVE — DESTINATION VERIFICATION PENDING OWNER ONE-CLICK ACTION**

---

## 1. Public & Authoritative DNS Verification Evidence

Empirical queries executed across authoritative nameservers and four global public DNS recursive resolvers:

```text
Query Command: dig @<resolver> nightlifez.com A +noall +answer
Query Command: dig @<resolver> www.nightlifez.com CNAME +noall +answer
```

### A. Authoritative Cloudflare Nameservers
- **`alexandra.ns.cloudflare.com`:**
  - `nightlifez.com. 300 IN A 76.76.21.21` (**PASS — DNS-only, direct IP verified**)
  - `www.nightlifez.com. 300 IN CNAME cname.vercel-dns.com.` (**PASS — DNS-only verified**)
- **`chance.ns.cloudflare.com`:**
  - `nightlifez.com. 300 IN A 76.76.21.21` (**PASS — DNS-only, direct IP verified**)
  - `www.nightlifez.com. 300 IN CNAME cname.vercel-dns.com.` (**PASS — DNS-only verified**)

### B. Global Public Resolvers
| Public Resolver | Provider | Apex `A` Record Resolution | `www` `CNAME` Resolution | Status |
|---|---|---|---|:---:|
| `8.8.8.8` | Google Public DNS | `76.76.21.21` (TTL 300) | `cname.vercel-dns.com.` | **PASS** |
| `1.1.1.1` | Cloudflare Public DNS | `76.76.21.21` (TTL 300) | `cname.vercel-dns.com.` | **PASS** |
| `9.9.9.9` | Quad9 | `76.76.21.21` (TTL 300) | `cname.vercel-dns.com.` | **PASS** |
| `208.67.222.222` | Cisco OpenDNS | `76.76.21.21` (TTL 300) | `cname.vercel-dns.com.` | **PASS** |

**Conclusion:** 100% global DNS propagation achieved with exact unproxied (grey cloud) target records.

---

## 2. Vercel Domain Configuration & SSL Certificate State

Queried via authenticated Vercel REST API and tested with real TLS handshakes:

### Vercel API Domain State
- **`nightlifez.com`:**
  - `configuredBy: "A"`
  - `aValues: ["76.76.21.21"]`
  - `misconfigured: false` (**PASS**)
  - `verified: true` (**PASS**)
- **`www.nightlifez.com`:**
  - `configuredBy: "CNAME"`
  - `cnames: ["cname.vercel-dns.com."]`
  - `misconfigured: false` (**PASS**)
  - `verified: true` (**PASS**)
  - `redirectStatusCode: 308` redirecting to `https://nightlifez.com/` (**PASS**)

### SSL Certificate Issuance Evidence
- **Certificate ID:** `cert_A3MCXlA5bbrEzarNc98aVtPf`
- **Issued By:** Let's Encrypt (`CN=YR2`)
- **Common Names:** `nightlifez.com`, `www.nightlifez.com`
- **Validity:** Nov 13 06:58:18 2026 GMT to Feb 11 06:58:17 2027 GMT
- **Auto-Renew:** `true`

### Live HTTPS Handshake Evidence
```text
$ curl -Iv https://nightlifez.com
* Connected to nightlifez.com (76.76.21.21) port 443
* ALPN: server accepted h2
* Server certificate:
*  subject: CN=nightlifez.com
*  issuer: C=US; O=Let's Encrypt; CN=YR2
*  SSL certificate verify ok.
< HTTP/2 200 
< server: Vercel
< strict-transport-security: max-age=31536000; includeSubDomains
```

### Live HTTP 308 Redirect Evidence
```text
$ curl -sI https://www.nightlifez.com
HTTP/2 308 
cache-control: public, max-age=0, must-revalidate
content-type: text/plain
location: https://nightlifez.com/
refresh: 0;url=https://nightlifez.com/
server: Vercel
```

---

## 3. Cloudflare Email Routing Forensic Investigation

### Observed Authoritative DNS State (Cloudflare NS)
Empirical query against `alexandra.ns.cloudflare.com`:
```text
nightlifez.com.    300 IN MX  73 route1.mx.cloudflare.net.
nightlifez.com.    300 IN MX  92 route2.mx.cloudflare.net.
nightlifez.com.    300 IN MX 100 route3.mx.cloudflare.net.
nightlifez.com.    300 IN TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
```
**Finding:** Cloudflare Email Routing MX records and SPF TXT record have been successfully onboarded and activated on the zone.

### Investigation of Conflicting Destination Status
- **Reported Incident:** An automated script reported clicking the Cloudflare verification link in Gmail, but the Cloudflare dashboard subsequently showed `nightlifezofficial@gmail.com` as **Pending**.
- **Forensic Root Cause Analysis:**
  1. **Session Context & Anti-Bot Boundary:** Cloudflare verification links follow the pattern:  
     `https://dash.cloudflare.com/?to=/:account/email/routing/destination-addresses&verify=<token>`  
     When an automation tool (such as a script or headless agent) executes an HTTP `GET` against this link, it encounters Cloudflare's client-side SPA routing and anti-bot challenge (Turnstile / Bot Management). A stateless HTTP client does NOT execute the underlying React runtime or submit the authenticated API request (`POST /api/v4/accounts/:id/email/routing/addresses/:address_id/verify`).
  2. **Account Authentication Requirement:** Cloudflare requires the browser following the link to hold an active, authenticated session belonging to `Satelinkinternet@gmail.com's Account` (`56bbee1ae042d8a991d6d8b5eddad865`). If the link was clicked in an isolated container or an unauthenticated browser instance, Cloudflare redirects to a login prompt and does not confirm the address.
  3. **Token Expiration:** Cloudflare verification tokens carry a 60-minute time-to-live. If the automation interacted with an older email, the token expired.
  4. **UI Confirmation Dialog:** Modern Cloudflare Email Routing flows display an in-app confirmation banner requiring a manual click on **"Confirm verification"**.

### Destination Address Status Assessment
- **Current Status:** `Pending`
- **Assessment:** Verification did **not** silently succeed; it remains unconfirmed in Cloudflare's backend datastore.
- **Remediation Action Required:** Because the owner already has both the authenticated Cloudflare dashboard tab (`https://dash.cloudflare.com/56bbee1ae042d8a991d6d8b5eddad865/email-service/routing/10a4dcb91581bb730c90da29a57655a7/destination-addresses`) and the Gmail tab (`nightlifezofficial@gmail.com`) open in Google Chrome, a fresh verification email should be triggered by clicking **"Resend verification email"** in the Cloudflare tab, followed by opening the email in the adjacent Gmail tab and clicking **Verify email address**.

---

## 4. Policy Enforcement: Forwarding Rules Gating

Per strict release integrity constraints:
> [!IMPORTANT]
> **Rule 5 Invariant:** Forwarding rules (`contact@`, `safety@`, `grievance@`) are **strictly prohibited from being created** while the destination address is in `Pending` state. Cloudflare API rejects routing rules targeting unverified destinations, and creating premature rules risks silent mail dropping.

### Specified Forwarding Rules (On Hold Pending Verification)
| Inbound Custom Address | Target Destination | Statutory / Operational Role | Status |
|---|---|---|:---:|
| `contact@nightlifez.com` | `nightlifezofficial@gmail.com` | General inquiry & attendee support | **GATED — awaiting destination verification** |
| `safety@nightlifez.com` | `nightlifezofficial@gmail.com` | Trust & safety, urgent attendee alerts | **GATED — awaiting destination verification** |
| `grievance@nightlifez.com` | `nightlifezofficial@gmail.com` | Statutory Grievance Redressal (IT Rules 2021) | **GATED — awaiting destination verification** |

### DMARC Policy Specification
- **Type:** `TXT`
- **Name:** `_dmarc` (or `_dmarc.nightlifez.com`)
- **Content:** `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`
- **Current Status:** **PENDING CREATION** in Cloudflare DNS.

---

## 5. Master Status Classification Matrix

| Category | Item | Specification | Status | Evidence / Notes |
|:---:|---|---|:---:|---|
| **DNS** | Apex `A` Record | `@` $\to$ `76.76.21.21` (DNS only) | **COMPLETED** | Verified on Cloudflare NS & 4 public resolvers |
| **DNS** | `www` `CNAME` Record | `www` $\to$ `cname.vercel-dns.com` (DNS only) | **COMPLETED** | Verified on Cloudflare NS & 4 public resolvers |
| **Vercel** | Apex Domain Attachment | `nightlifez.com` verified | **COMPLETED** | Vercel API: `misconfigured: false` |
| **Vercel** | `www` Subdomain Attachment | `www.nightlifez.com` verified | **COMPLETED** | Vercel API: `misconfigured: false` |
| **Vercel** | HTTP 308 Permanent Redirect | `www` $\to$ `nightlifez.com` | **COMPLETED** | Verified with `curl -sI https://www.nightlifez.com` |
| **SSL** | Let's Encrypt Edge TLS | `cert_A3MCXlA5bbrEzarNc98aVtPf` | **COMPLETED** | Valid through Feb 11, 2027; HTTP/2 200 OK |
| **Mail** | Cloudflare Email Routing MX | `route1`, `route2`, `route3.mx.cloudflare.net` | **COMPLETED** | Authoritative on Cloudflare nameservers |
| **Mail** | Cloudflare Email Routing SPF | `v=spf1 include:_spf.mx.cloudflare.net ~all` | **COMPLETED** | Authoritative on Cloudflare nameservers |
| **Mail** | Destination Address Verification | `nightlifezofficial@gmail.com` | **PENDING** | Cloudflare reports `Pending`; manual click required |
| **Mail** | Custom Forwarding Rules (3) | `contact@`, `safety@`, `grievance@` | **BLOCKED** | Gated until destination address is `Verified` |
| **Mail** | DMARC Record | `_dmarc` TXT `p=none` | **PENDING** | To be saved alongside destination confirmation |
| **Production**| Code & DB Deployment Gate | PR #45 & PR #17 merge + migrations | **BLOCKED** | Intentionally held per safety constraints |

---

## 6. Next Immediate Actions

1. **Owner Action (2 Minutes in Open Chrome Tabs):**
   - **Tab 1 (`Cloudflare Destination Addresses`):** If `nightlifezofficial@gmail.com` displays `Pending`, click **Resend verification email**.
   - **Tab 2 (`Gmail - nightlifezofficial@gmail.com`):** Open the fresh verification email from Cloudflare and click **Verify email address**.
   - Return to Tab 1 and confirm the badge changes to **Verified**.
2. **Post-Verification Execution:**
   - Create the 3 custom routing rules (`contact@`, `safety@`, `grievance@` $\to$ `nightlifezofficial@gmail.com`).
   - Add the DMARC TXT record: `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`.
   - Dispatch an authorised, safe end-to-end inbound test email to verify mailbox delivery.
