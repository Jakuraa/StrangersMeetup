# NIGHTLIFEZ Launch Operations: DNS & Email Routing Runbook

**Scope:** domain `nightlifez.com` on Cloudflare DNS, served by Vercel; inbound mail for `contact@`, `safety@` and `grievance@`.
**Status:** owner-executed. The agent does not change DNS, Cloudflare or Vercel settings.
**Last checked against vendor docs:** 2026-11-10 (sources in §6).

---

## 1. Decisions (and why they changed)

| Topic | Old instruction | Now | Reason |
|:---|:---|:---|:---|
| Vercel records | Proxied (orange cloud) + Cloudflare SSL `Full (Strict)` | **DNS only (grey cloud)**. No Cloudflare SSL/TLS, HSTS or redirect-rule setup for these hosts. | Vercel's guidance is "Use DNS-only mode for direct traffic": a proxy in front of Vercel reduces the connection signals its firewall and DDoS mitigation use, disables the Bot Protection managed ruleset, adds a second cache that Vercel deploys do not invalidate, and must keep certificate-validation paths open. The `Full (Strict)` steps only applied when proxying, so they are removed. [V1][V3] |
| Apex record | `CNAME @ → cname.vercel-dns.com` | **A `@` → the IP shown in Vercel → Project → Settings → Domains** | Vercel's documented apex record is an A record; values are project-specific, so copy them from the dashboard rather than this file. [V1] |
| `www` | CNAME `www → nightlifez.com` (proxied) + Cloudflare redirect rule | **CNAME `www` → the target shown in Settings → Domains**, and a redirect `www → apex` configured **in Vercel** | Vercel: if both apex and www are added, configure a redirect in project settings. [V1] |
| DMARC | `p=reject; sp=reject; pct=100` on day one | **`p=none` with `rua` reporting**, then `quarantine`, then `reject` | Start in monitor mode; tighten only once every real sender passes aligned SPF/DKIM. A day-one `reject` silently blocks the first legitimate sender added later (transactional mail, Google Workspace, a newsletter tool) before anyone notices. [C3][C4] |
| "Send as contact@" | Not addressed | **Not possible with Cloudflare Email Routing** (see §3.4) | Email Routing is receive/forward only. [C1] |

---

## 2. Web: Vercel records on Cloudflare DNS

### 2.1 Nameservers
At the registrar, set the two nameservers Cloudflare assigned to the zone (shown on the zone's Overview page).

### 2.2 Add the domains in Vercel first
Vercel → project `strangersmeetup` → Settings → Domains → add `nightlifez.com` and `www.nightlifez.com`. Choose **`nightlifez.com` as primary** and set `www.nightlifez.com` to **redirect (308) to `nightlifez.com`**. Vercel then shows the exact record values for each host. (Choosing www as primary instead is equally valid; just invert the redirect. Pick one and keep it.)

### 2.3 Cloudflare DNS records

| Type | Name | Content | Proxy status | Purpose |
|:---|:---|:---|:---|:---|
| **A** | `@` | value from Vercel → Settings → Domains (historically `76.76.21.21`; newer projects get a project-specific IP) | **DNS only (grey)** | apex → Vercel |
| **CNAME** | `www` | value from Vercel → Settings → Domains (e.g. `cname.vercel-dns.com` or a project-specific `*.vercel-dns-0xx.com`) | **DNS only (grey)** | www → Vercel, which then redirects to apex |
| **TXT** | `_vercel` | only if Vercel shows a verification TXT (domain already used by another Vercel account) | DNS only | ownership verification |

Remove any pre-existing `AAAA` record on `@` or `www`. Do **not** add a CNAME at the apex. There is **no `preview.` subdomain**: Preview uses the stable branch alias `strangersmeetup-git-launch-mvp-jakuraa.vercel.app` (see `docs/launch/PREVIEW_LOGIN.md`).

### 2.4 Cloudflare settings that must NOT be applied to these hosts
- No orange-cloud proxy, so no SSL/TLS mode, edge certificate, HSTS, "Always Use HTTPS" or Redirect Rules are needed for `@`/`www`. Vercel serves HTTPS and redirects HTTP→HTTPS itself. [V1]
- If the zone's SSL/TLS mode is ever changed for other proxied hosts, it does not affect grey-cloud records.

### 2.5 Verify
```bash
dig +short A nightlifez.com          # the Vercel IP from Settings → Domains, NOT 104.21.x / 172.67.x (those mean it is proxied)
dig +short CNAME www.nightlifez.com  # the Vercel CNAME target
curl -sI http://nightlifez.com | head -3         # 308 → https://nightlifez.com/
curl -sI https://www.nightlifez.com | head -3    # 308 → https://nightlifez.com/
curl -s https://nightlifez.com/api/health        # ok
vercel domains verify nightlifez.com --project strangersmeetup
```
Vercel → Settings → Domains must show both hosts as **Valid Configuration**.

---

## 3. Email: inbound only, via Cloudflare Email Routing

### 3.1 Enable
Cloudflare → Email Service → Email Routing → Onboard domain `nightlifez.com`. Cloudflare adds its own MX, SPF and DKIM records; **accept the values it generates** rather than typing them from this file. [C2]

Expected shape (verify against what Cloudflare created):

| Type | Name | Content |
|:---|:---|:---|
| MX | `@` | `route1/2/3.mx.cloudflare.net` (priorities as created) |
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT | `cf2024-1._domainkey` (or as created) | Cloudflare-generated DKIM key |

Only one SPF TXT record may exist on `@`. When a real sender is added later, edit that one record (e.g. add the provider's `include:`), never add a second.

### 3.2 Destination and rules
1. Email Routing → Destination addresses → add the operations inbox → click the verification link.
2. Routing rules: `contact@`, `safety@`, `grievance@` → Send to → the verified inbox. Catch-all: Drop (or disabled).

### 3.3 DMARC (start in monitor mode)

| Type | Name | Content |
|:---|:---|:---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:contact@nightlifez.com` |

Path to enforcement:
1. **Now:** `p=none`. Read the aggregate (`rua`) reports for 2–4 weeks.
2. **After every real sender (see §3.4) passes *aligned* SPF or DKIM in the reports:** `p=quarantine` (optionally `pct=25` → `100`).
3. **After a clean month at quarantine:** `p=reject`.

Note: forwarded mail can fail a *sender's* strict DMARC at the destination; Cloudflare mitigates with SRS and ARC but documents this limitation. [C1]

### 3.4 Can we send *as* `contact@nightlifez.com` for free?
- **Cloudflare Email Routing: no.** Cloudflare states that Email Routing "does not support sending or replying from your Cloudflare domain"; replies go out from the destination address (e.g. the Gmail inbox). [C1]
- **Cloudflare Email Sending** can send from the domain, but it is a **public beta on the Workers Paid plan**, not free for arbitrary recipients. [C2]
- **Gmail "Send mail as"** with Gmail's own servers: Gmail can label the From as `contact@nightlifez.com`, but the mail is signed by `gmail.com`, so DMARC for `nightlifez.com` will **not align**. Under `p=none` it is delivered, but deliverability is unreliable, and it becomes rejected once DMARC reaches `quarantine`/`reject`. Not recommended for anything important.
- **Recommended when sending is actually needed:** a provider that signs DKIM for `nightlifez.com` (e.g. Google Workspace mailbox, or a transactional service such as Resend/Postmark/Cloudflare Email Sending). Add its SPF include and DKIM records, confirm alignment in DMARC reports, then continue the §3.3 path.

The product does not send email today; it notifies via Telegram.

### 3.5 Verify
```bash
dig +short MX nightlifez.com
dig +short TXT nightlifez.com | grep v=spf1      # exactly one line
dig +short TXT _dmarc.nightlifez.com             # "v=DMARC1; p=none; rua=mailto:contact@nightlifez.com"
```
Then send a test mail from a different account to `contact@nightlifez.com` and confirm it arrives.

---

## 4. Rollback
- Web: DNS changes are reversible by editing the records. Because records are grey-cloud, there is no proxy layer to roll back.
- Email: disabling Email Routing removes the MX records Cloudflare added; mail to the domain then bounces.
- DMARC: if legitimate mail is quarantined/rejected, step back to `p=none` immediately and fix alignment.

---

## 5. Owner checklist
1. Vercel → Settings → Domains: add apex + www, apex primary, www → 308 apex.
2. Cloudflare DNS: A `@` and CNAME `www` with Vercel's values, **grey cloud**; remove conflicting AAAA/CNAME records.
3. Run §2.5 checks.
4. Cloudflare Email Routing: onboard, verify destination, add the three rules.
5. Add DMARC `p=none` with `rua`.
6. Run §3.5 checks.

---

## 6. Sources
- [V1] Vercel — Set up a custom domain (A record for apex, CNAME for subdomains, redirect between apex and www): https://vercel.com/docs/domains/set-up-custom-domain
- [V2] Vercel — Troubleshooting domains (`dig` checks, HTTPS redirect): https://vercel.com/docs/domains/troubleshooting
- [V3] Vercel KB — Using Cloudflare and other reverse proxies with Vercel (updated 2026-10-19; "Why is another CDN or proxy in front of Vercel not recommended?", "Use DNS-only mode for direct traffic"): https://vercel.com/kb/guide/can-i-use-a-proxy-on-top-of-my-vercel-deployment
- [C1] Cloudflare — Email Service Postmaster, Known limitations ("Sending or replying to an email from your Cloudflare domain"; restrictive DMARC and forwarding; SRS): https://developers.cloudflare.com/email-service/reference/postmaster/
- [C2] Cloudflare — Email Service overview (Email Sending beta on Workers Paid; Email Routing on Free/Paid; onboarding adds MX/SPF/DKIM): https://developers.cloudflare.com/email-service/ and https://developers.cloudflare.com/email-service/get-started/route-emails/
- [C3] Cloudflare — Email authentication, DMARC deployment strategy (`p=none` → `quarantine` → `reject`): https://developers.cloudflare.com/email-service/concepts/email-authentication/
- [C4] Cloudflare — DNS: Set up Google Workspace, DMARC ("Start with `p=none`"): https://developers.cloudflare.com/dns/manage-dns-records/how-to/set-up-google-workspace/
