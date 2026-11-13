# NIGHTLIFEZ — Cloudflare DNS & Email Routing Audit

**Domain:** `nightlifez.com`  
**Authoritative Nameservers:** `alexandra.ns.cloudflare.com`, `chance.ns.cloudflare.com`  
**Vercel Project:** `jakuraa/strangersmeetup` (`prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`)  
**Audit Timestamp:** 2026-11-13T12:41:03+05:30  
**Status:** **AUDITED — NO EXISTING CONFLICTS — AWAITING OWNER DASHBOARD RECORD CREATION**

---

## 1. Authoritative DNS Audit Results

Empirical queries were executed against Google Public DNS (`8.8.8.8`), Cloudflare Public DNS (`1.1.1.1`), and the authoritative Cloudflare nameservers (`alexandra.ns.cloudflare.com`, `chance.ns.cloudflare.com`):

```text
Query Command: dig @alexandra.ns.cloudflare.com nightlifez.com <TYPE> +noall +answer
```

| Record Type | Host | Observed Value | Classification |
|---|---|---|---|
| **NS** | `nightlifez.com` | `alexandra.ns.cloudflare.com.`, `chance.ns.cloudflare.com.` | **DONE — independently verified** |
| **SOA** | `nightlifez.com` | `alexandra.ns.cloudflare.com. dns.cloudflare.com. 2419137044 10000 2400 604800 1800` | **DONE — independently verified** |
| **A** | `nightlifez.com` | *(EMPTY / NO RECORD)* | **BLOCKED — owner action required** |
| **AAAA** | `nightlifez.com` | *(EMPTY / NO RECORD)* | **DONE — independently verified** (No conflicting IPv6) |
| **CNAME** | `nightlifez.com` | *(EMPTY / NO RECORD)* | **DONE — independently verified** (Apex correctly has no CNAME) |
| **A** | `www.nightlifez.com` | *(EMPTY / NO RECORD)* | **DONE — independently verified** (No conflicting A record on www) |
| **CNAME** | `www.nightlifez.com` | *(EMPTY / NO RECORD)* | **BLOCKED — owner action required** |
| **MX** | `nightlifez.com` | *(EMPTY / NO RECORD)* | **BLOCKED — owner action required** (Email Routing unconfigured) |
| **TXT** | `nightlifez.com` | *(EMPTY / NO RECORD)* | **DONE — independently verified** (No conflicting SPF/verification) |
| **TXT** | `_dmarc.nightlifez.com`| *(EMPTY / NO RECORD)* | **BLOCKED — owner action required** (DMARC unconfigured) |

### Key Audit Finding
The Cloudflare DNS zone for `nightlifez.com` is completely **clean and devoid of records**. There are no pre-existing A, AAAA, CNAME, MX, or TXT records. Adding Vercel's required records will not overwrite or conflict with any existing services.

---

## 2. Vercel Domain Configuration & Verification State

Queried directly via the authenticated Vercel REST API (`/v9/projects/strangersmeetup/domains` and `/v6/domains/:domain/config`):

```json
{
  "domains": [
    {
      "name": "nightlifez.com",
      "apexName": "nightlifez.com",
      "verified": true,
      "misconfigured": true,
      "recommendedIPv4": [{"rank": 1, "value": ["76.76.21.21"]}],
      "recommendedCNAME": [{"rank": 1, "value": "cname.vercel-dns.com."}]
    },
    {
      "name": "www.nightlifez.com",
      "apexName": "nightlifez.com",
      "redirect": "nightlifez.com",
      "redirectStatusCode": 308,
      "verified": true,
      "misconfigured": true,
      "recommendedCNAME": [{"rank": 1, "value": "cname.vercel-dns.com."}]
    }
  ]
}
```

- **Domain Verification Status:** Both `nightlifez.com` and `www.nightlifez.com` are **`verified: true`**. No TXT ownership challenge is required.
- **Misconfiguration Reason:** Marked `misconfigured: true` exclusively because Cloudflare DNS records have not yet been populated.
- **Redirect Policy:** `www.nightlifez.com` is configured in Vercel to issue an immediate HTTP 308 permanent redirect to the apex `nightlifez.com`.

---

## 3. Required DNS Records (Grey Cloud / DNS-Only)

In the Cloudflare DNS dashboard, create the following two records:

| Type | Name | Target / Content | Proxy Status | Status |
|:---:|:---:|:---:|:---:|:---:|
| **A** | `@` | `76.76.21.21` | **DNS-only (Grey Cloud)** | **BLOCKED — owner action required** |
| **CNAME** | `www` | `cname.vercel-dns.com` | **DNS-only (Grey Cloud)** | **BLOCKED — owner action required** |

> [!CAUTION]
> **Do NOT enable the Orange Cloud (Proxy).** Vercel handles edge SSL termination, DDoS protection, Bot Protection, and HTTP-to-HTTPS redirection. Placing Cloudflare's CDN proxy in front of Vercel introduces dual-cache invalidation delays and disables Vercel firewall telemetry.

---

## 4. Cloudflare Email Routing Specification

**Destination Inbox:** `nightlifezofficial@gmail.com`  
**Purpose:** Free, zero-maintenance inbound mail forwarding for operational and statutory contact addresses.

### Required Inbound Aliases

| Inbound Address | Destination | Purpose | Status |
|---|---|---|---|
| `contact@nightlifez.com` | `nightlifezofficial@gmail.com` | General inquiries, attendee support | **BLOCKED — owner action required** |
| `safety@nightlifez.com` | `nightlifezofficial@gmail.com` | Trust & safety, urgent attendee alerts | **BLOCKED — owner action required** |
| `grievance@nightlifez.com` | `nightlifezofficial@gmail.com` | Statutory Grievance Redressal (IT Rules 2021) | **BLOCKED — owner action required** |

### Execution Protocol:
1. Navigate to **Cloudflare Dashboard → `nightlifez.com` → Email Routing**.
2. Click **Enable Email Routing**.
3. Accept the automatically generated MX records:
   - `route1.mx.cloudflare.net` (Priority 11)
   - `route2.mx.cloudflare.net` (Priority 45)
   - `route3.mx.cloudflare.net` (Priority 99)
4. Add `nightlifezofficial@gmail.com` as a **Destination Address**.
5. **Owner Action Required:** Open `nightlifezofficial@gmail.com` inbox, locate the verification email from Cloudflare, and click the confirmation link.
6. Create the 3 custom forwarding rules pointing to the verified destination.
7. Set Catch-All rule to **Drop** or **Disabled**.

> [!IMPORTANT]
> **Email Sending Invariant:** Cloudflare Email Routing is strictly an **inbound forwarding service**. It does NOT provide an SMTP server to send outbound emails "From: contact@nightlifez.com". All platform notifications currently route via Telegram. When transactional outbound email is required in future milestones, a dedicated DKIM-signing provider (e.g. Resend, Postmark, or Google Workspace) must be provisioned.

---

## 5. Mail Security (SPF, DKIM, DMARC)

Because there are currently no mail records, Cloudflare Email Routing will configure SPF and DKIM safely upon activation:

1. **SPF Record:**
   - Content: `v=spf1 include:_spf.mx.cloudflare.net ~all`
   - Generated automatically by Cloudflare Email Routing.
2. **DKIM Record:**
   - Host: `cf2024-1._domainkey` (or Cloudflare-specified selector)
   - Generated automatically by Cloudflare Email Routing.
3. **DMARC Record (Safe Monitor Mode):**
   - Type: `TXT`
   - Host: `_dmarc`
   - Value: `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`
   - Policy: `p=none` ensures zero legitimate forwarded emails are dropped while aggregate deliverability reports (`rua`) are collected. Do NOT set `p=reject` or `p=quarantine` until an outbound sender is established.

---

## 6. Action Status Summary

| Item | Description | Classification | Evidence / Source |
|---|---|---|---|
| **CF-01** | Audit existing Cloudflare DNS zone | **DONE — independently verified** | `dig @alexandra.ns.cloudflare.com` returned 0 records |
| **CF-02** | Confirm Vercel apex domain verification | **DONE — independently verified** | Vercel API: `nightlifez.com` `verified: true` |
| **CF-03** | Confirm Vercel www domain redirect | **DONE — independently verified** | Vercel API: `www.nightlifez.com` `redirectStatusCode: 308` |
| **CF-04** | Create Apex A record (`76.76.21.21`) | **BLOCKED — owner action required** | Requires Cloudflare dashboard login |
| **CF-05** | Create CNAME record (`cname.vercel-dns.com`) | **BLOCKED — owner action required** | Requires Cloudflare dashboard login |
| **CF-06** | Onboard Cloudflare Email Routing | **BLOCKED — owner action required** | Requires Cloudflare dashboard login |
| **CF-07** | Verify destination email in Gmail | **BLOCKED — owner action required** | Requires clicking link in `nightlifezofficial@gmail.com` |
| **CF-08** | Create 3 forwarding rules (contact, safety, grievance)| **BLOCKED — owner action required** | Requires Cloudflare dashboard login |
| **CF-09** | Publish DMARC TXT record (`p=none`) | **BLOCKED — owner action required** | Requires Cloudflare dashboard login |
