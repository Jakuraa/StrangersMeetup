# NIGHTLIFEZ — Security & Privacy Architecture

**Status:** Active Security Policy  
**Classification:** Public / Open Source Security Guidelines  
**Reporting Contact:** `nightlifezofficial@gmail.com`  

---

## 1. Security Principles

NIGHTLIFEZ is architected under the principle of **Defense in Depth**:
1. **Never trust client state:** The server is the exclusive source of truth for identities, entitlements, capacities, and payments.
2. **Fail closed:** Any missing, expired, or malformed signature results in immediate request rejection (`401 Unauthorized` or `403 Forbidden`).
3. **Data minimization:** Only essential user attributes are gathered; private venue locations and attendee contact details are restricted until ticket confirmation.
4. **Zero secret exposure:** Secrets exist strictly within server runtime environment variables and are never bundled into client scripts.

---

## 2. Authentication & Session Security

### A. Session Token Architecture (`sm_session`)
- **Transport Security:** Sessions are delivered via HTTP-only, Secure, SameSite=Lax cookies with a strict 7-day expiration.
- **Cryptographic Signing:** Session payloads contain user ID, session UUID, and expiration timestamp, signed using `SESSION_SECRET` via HMAC-SHA256.
- **Server-Side Revocation:** Every authenticated request verifies the session UUID against the PostgreSQL `user_sessions` table. If the session has been revoked, or the user's status is `banned`, the session is rejected immediately.
- **Instant Revocation Endpoints:**
  - `POST /api/auth/logout`: Revokes the current session row.
  - `POST /api/auth/logout-all`: Revokes all active sessions for the user.

### B. Telegram Authentication Verification
- **Mini App `initData`:**
  - Validates `hash` parameter against `HMAC-SHA-256("WebAppData", bot_token)`.
  - Rejects authentication if `auth_date` is older than 300 seconds.
  - Replay attacks are mitigated by enforcing single-use nonce checks.
- **Telegram Login Widget:**
  - Validates hash against `SHA-256(bot_token)`.
  - Rejects any client-supplied user identifiers that do not match the cryptographic payload.

---

## 3. Request Security & CSRF Mitigation

### A. Anti-CSRF Token Generation
- All state-mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) require an `X-CSRF-Token` header.
- The CSRF token is cryptographically derived:
  $$\text{CSRF Token} = \text{HMAC-SHA256}(\text{SESSION\_SECRET}, \text{session\_id} + \text{"csrf"})$$
- Requests without a valid matching token fail with `403 Forbidden`.

### B. Input Validation & Schema Enforcement
- All incoming payloads are parsed and validated using strict **Zod** schemas.
- Extra, unexpected, or prototype pollution fields are automatically stripped or rejected.
- Form submissions (Host, Partner, Venue applications) incorporate hidden honeypot fields to trap automated spam bots.

### C. SQL Injection Immunity
- Direct string interpolation into SQL queries is prohibited across the codebase.
- All database operations use parameterized queries (`$1, $2, ...`) via the `pg` client.

### D. Cross-Site Scripting (XSS) Prevention
- All server-rendered HTML components utilize an auto-escaping `html` template literal tag.
- Dynamic user content is sanitized before insertion into the DOM.
- A strict Content Security Policy (CSP) header is emitted on all HTML responses:
  ```
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  ```

---

## 4. Payment & Checkout Safeguards

### A. Feature Flag Kill Switches
To protect against unauthorized transactions or unreviewed merchant pathways:
- `ENABLE_LIVE_PAYMENTS=false`: Disables outbound live merchant links; forces test/sandbox mode.
- `UPI_CHECKOUT_ENABLED=false`: Blocks native UPI payment routing until operational and compliance approval is granted.

### B. Webhook Signature Verification
- Inbound payment webhooks (SuperProfile / UPI) require a valid cryptographic signature header (`X-Webhook-Secret`).
- Missing or mismatched secrets return `401 Unauthorized` without reading the payload.
- Every processed event ID is recorded in `webhook_events(provider, provider_event_id)` with a unique constraint to ensure strict idempotency.

### C. Digital Ticket Pass Authentication
- Door admission passes contain an encrypted QR code payload signed with `TICKET_SECRET` using HMAC-SHA256:
  $$\text{QR Signature} = \text{HMAC-SHA256}(\text{TICKET\_SECRET}, \text{booking\_id} + \text{user\_id} + \text{event\_id})$$
- Prevents screenshot duplication, forgery, and pass sharing.

---

## 5. PII & Privacy Protections

1. **Hidden Venue Locations:** Precise venue addresses are withheld on public event listings. Addresses are revealed only to confirmed attendees via Telegram DM and booking view.
2. **Minimal Data Storage:** User profiles contain only the essential Telegram identifier, username, and contact handle.
3. **Log Sanitization:** Server logs are output as structured JSON lines. Request bodies, query parameters, tokens, credentials, and payment details are strictly excluded from logging statements.
4. **Automated Secret Auditing:** The test suite executes automated scanner assertions (`test/m9-security-audit.test.js`) ensuring that no server secret names or secret values exist within client-accessible static files.

---

## 6. Vulnerability Disclosure Policy

If you discover a potential security vulnerability within NIGHTLIFEZ, please report it immediately:

- **Security Contact:** `nightlifezofficial@gmail.com`
- **Response SLA:** Acknowledgement within 24 hours; remediation assessment within 48 hours.
- **Responsible Disclosure:** Please allow our engineering team reasonable time to patch any confirmed issue before public disclosure.
