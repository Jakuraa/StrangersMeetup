# NIGHTLIFEZ Independent Security Audit: M4.1 UPI Checkout & Payment Architecture

**Milestone:** M4.2 / M4.3 — Critical UPI Security & Financial Integrity Remediation  
**Target Commit:** `c71ec8d` (Merged PR #29 on `launch-mvp`) / `feature/m4-3-upi-security-remediation`  
**Auditor:** Independent Security Reviewer & Senior Payments Architect  
**Date:** November 2026  
**Safety Status:** Enforced (`ENABLE_LIVE_PAYMENTS=false`)  
**Overall Readiness Rating:** **REMEDIATED (M4.3)** — All 9 Critical, High, Medium, and Low Findings Fully Resolved and Verified

---

## 1. Executive Summary

An independent, zero-trust security audit of the Milestone M4.1 UPI-first checkout implementation was conducted across the database schema, cryptographic verification routines, provider adapter contracts, concurrency controls, QR encoding math, and user journey handlers.

Following the independent M4.2 audit and owner approval to merge PR #29 into `launch-mvp` at `c71ec8d`, all 9 identified security, financial, and integrity findings have been comprehensively remediated in Milestone M4.3 on branch `feature/m4-3-upi-security-remediation`.

---

## 2. Severity-Ranked Vulnerability & Defect Register

### Summary Table

| ID | Title | Severity | Impact | Affected Files | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | Real PhonePe Webhook Signature Mismatch | **CRITICAL** | All real PhonePe webhooks rejected (100% failure rate in production) | [`lib/upi/adapter.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/adapter.js) | **REMEDIATED (M4.3)** |
| **FIN-01** | Missing Amount Verification on Webhook Ingestion | **CRITICAL** | Underpayment attack; user pays ₹1 to confirm ₹5,000 tickets | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js) | **REMEDIATED (M4.3)** |
| **DATA-01** | Guest Checkout Webhook Crash (`NOT NULL bookings.user_id`) | **HIGH** | Money collected, but booking fails to create; 500 error on webhook | [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js), [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js) | **REMEDIATED (M4.3)** |
| **CONCUR-01** | Simultaneous Checkout Intent Capacity Bypass | **HIGH** | Event overbooking; unconfirmed intents ignore capacity locks | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js) | **REMEDIATED (M4.3)** |
| **AUTH-01** | Unauthenticated Information Disclosure & Polling IDOR | **HIGH** | Unauthenticated users can read order details and booking IDs | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js), [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js) | **REMEDIATED (M4.3)** |
| **QR-01** | ISO 18004 Dark Module Overwrite & Codeword Truncation | **MEDIUM** | Scanners may fail to decode dynamic QR codes in Region 2 | [`lib/upi/qr.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/qr.js) | **REMEDIATED (M4.3)** |
| **UI-01** | Missing Viewport Isolation in Checkout Template | **MEDIUM** | Both mobile buttons and desktop QR render simultaneously | [`lib/views/checkout-upi.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/views/checkout-upi.js) | **REMEDIATED (M4.3)** |
| **LOG-01** | Shared Rate Limit Keys with SuperProfile Webhook | **LOW** | IP rate-limiting collides between payment gateways | [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js) | **REMEDIATED (M4.3)** |
| **DB-01** | `payment_audits` Table Lacks Database-Level Append-Only Guard | **LOW** | Internal DB update could theoretically modify audit rows | [`migrations/016_payment_audits_immutable.sql`](file:///Users/pradeepjakuraa/strangersmeetup/migrations/016_payment_audits_immutable.sql) | **REMEDIATED (M4.3)** |

---

### Detailed Findings

#### SEC-01: Real PhonePe Webhook Signature Mismatch (Fatal Incompatibility)
- **Severity:** **CRITICAL**
- **Location:** [`lib/upi/adapter.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/adapter.js#L82-L91)
- **Description:**
  PhonePe sends Server-to-Server (S2S) webhook notifications in the following JSON format:
  ```json
  { "response": "<BASE64_ENCODED_PAYLOAD>" }
  ```
  According to official PhonePe Payment Gateway documentation, the checksum header `X-VERIFY` is computed as:
  $$\text{X-VERIFY} = \text{SHA256}(\text{response} + \text{saltKey}) + \text{"###"} + \text{saltIndex}$$
  where `response` is the exact Base64 string value extracted from the JSON object.
  
  In `lib/upi/adapter.js`:
  ```javascript
  verifyWebhookSignature(signatureHeader, rawResponseBody) {
    ...
    const expectedHash = crypto.createHash('sha256').update(`${rawResponseBody}${this.saltKey}`).digest('hex');
    return safeEqual(gotHash, expectedHash);
  }
  ```
  The code passes `rawResponseBody` (the full raw HTTP text `{"response":"..."}`) directly into the SHA256 digest instead of extracting `parsed.response`.
- **Proof of Vulnerability:**
  An empirical test script was executed feeding an official PhonePe S2S webhook payload and signature:
  ```text
  Does PhonePeAdapter accept real PhonePe signature?
  REJECTED with error: Invalid PhonePe webhook signature
  ```
- **Remediation:**
  Parse or extract the Base64 `response` property before calculating the SHA256 hash. Support both formats if testing with raw strings.

---

#### FIN-01: Missing Amount Verification on Webhook Ingestion (Underpayment Attack)
- **Severity:** **CRITICAL**
- **Location:** [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js#L243-L348)
- **Description:**
  When a webhook arrives from PhonePe, `verified.amountPaise` contains the actual amount debited from the customer's bank account.
  However, in `processUpiWebhook`:
  ```javascript
  if (status === 'succeeded') {
    const res = await applySuccessfulUpiPayment({
      orderId,
      providerTxnId: verified.providerTxnId,
      providerPaymentId: verified.providerPaymentId,
      actor: `webhook:${verified.provider}`
    });
  ```
  The extracted `verified.amountPaise` is discarded and **never passed** to `applySuccessfulUpiPayment`.
  In `applySuccessfulUpiPayment`:
  ```javascript
  const booking = (await c.query(
    `INSERT INTO bookings (..., amount_paise, ...) VALUES (..., $5, ...)`,
    [..., payment.amount, ...]
  )).rows[0];
  ```
  The function blindly assumes the customer paid `payment.amount`. If a malicious actor alters the UPI payment amount in a tampered client or if a payment gateway reports partial settlement (e.g. ₹1 instead of ₹4,999), the booking is confirmed as fully paid, issuing valid tickets and private venue access.
- **Remediation:**
  Assert `if (verified.amountPaise !== Number(payment.amount))` immediately in `processUpiWebhook` and `applySuccessfulUpiPayment`. If mismatched, mark the payment as `disputed` or `flagged_amount_mismatch`, alert finance, and refuse to confirm the booking.

---

#### DATA-01: Guest Checkout Webhook Crash (`NOT NULL bookings.user_id`)
- **Severity:** **HIGH**
- **Location:** [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js#L27), [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js#L106), [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js#L282)
- **Description:**
  In [`migrations/003_identity_events_bookings.sql`](file:///Users/pradeepjakuraa/strangersmeetup/migrations/003_identity_events_bookings.sql#L119), the `bookings` table defines:
  `user_id UUID NOT NULL REFERENCES users(id)`
  
  In [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js#L27):
  ```javascript
  const user = await getSessionUser(req);
  ```
  `upiCheckoutPage` does not enforce authentication (`requireUser`). If an unauthenticated guest visits `/checkout/:slug/upi`, `user` is `null`.
  In `createUpiPaymentIntent`:
  `resolvedUserId = null`, inserting a payment row with `user_id = NULL`.
  When payment completes and the webhook fires:
  ```javascript
  await c.query(`INSERT INTO bookings (..., user_id, ...) VALUES ($1, $2, ...)`,
    [event.id, payment.user_id, ...]);
  ```
  PostgreSQL throws:
  `null value in column "user_id" of relation "bookings" violates not-null constraint` (SQLSTATE 23502).
  The webhook handler catches this, logs an error, and returns HTTP 500. The customer’s money has been debited, but no booking is created, no ticket is generated, and no invite link is granted.
- **Remediation:**
  Either enforce authentication on `/checkout/:slug/upi` via `requireUser` / redirect to `/signin?next=...`, or establish an explicit guest claiming mechanism with cryptographic claim tokens.

---

#### CONCUR-01: Simultaneous Checkout Intent Capacity Bypass (Overbooking Vulnerability)
- **Severity:** **HIGH**
- **Location:** [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js#L96), [`lib/services/bookings.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/bookings.js#L7)
- **Description:**
  In `createUpiPaymentIntent`:
  ```javascript
  const takenEvent = await seatsTaken(c, event.id);
  const takenTier = await tierSeatsTaken(c, tier.id);
  ```
  `seatsTaken` and `tierSeatsTaken` query only the `bookings` table. Active unexpired intents in `payments` (`WHERE status IN ('pending', 'processing') AND expires_at > now()`) are completely ignored.
  Furthermore, `applySuccessfulUpiPayment` contains zero capacity checks when confirming a booking.
  
  **Scenario**: An event has 1 remaining seat. 20 users load the checkout page simultaneously. All 20 receive valid dynamic QR codes. If 5 users pay, all 5 webhooks will insert confirmed rows into `bookings`, overbooking the venue by 500%.
  
  *Audit Note on Test 9*: `test/upi-checkout.test.js` contained a false-positive test for concurrency because it called `applySuccessfulUpiPayment` on the first user before creating the second user's intent, testing sequential confirmation rather than simultaneous in-flight intents.
- **Remediation:**
  Incorporate active unexpired payment intents into `seatsTaken` (`payments.status IN ('pending', 'processing') AND expires_at > now()`), or lock capacity and verify remaining seats inside `applySuccessfulUpiPayment` transaction, transitioning oversubscribed payments to `refund_pending` / `overbooked`.

---

#### AUTH-01: Unauthenticated Information Disclosure & Polling IDOR
- **Severity:** **HIGH**
- **Location:** [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js#L190-L192)
- **Description:**
  In `getUpiPaymentStatus`:
  ```javascript
  if (payment.user_id && user && payment.user_id !== user.id && user.role !== 'super_admin' && user.role !== 'finance') {
    throw new HttpError(403, 'forbidden', 'Access denied to this payment order');
  }
  ```
  Because the condition requires `user` to be truthy, an **unauthenticated anonymous caller** (`user === null`) completely bypasses the block!
  An attacker scanning or guessing order IDs (or intercepting network links) can query `GET /api/checkout/upi/status/:orderId` without logging in. The endpoint returns sensitive order details, total amount, event title, payment status, and the `bookingId`.
- **Remediation:**
  Ensure that if `payment.user_id` is set, unauthenticated requests are strictly refused:
  ```javascript
  if (payment.user_id && (!user || (payment.user_id !== user.id && user.role !== 'super_admin' && user.role !== 'finance'))) {
    throw new HttpError(403, 'forbidden', 'Access denied to this payment order');
  }
  ```

---

#### QR-01: ISO/IEC 18004 Dark Module Overwrite & Codeword Truncation
- **Severity:** **MEDIUM**
- **Location:** [`lib/upi/qr.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/qr.js#L141-L159), [`lib/upi/qr.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/qr.js#L251-L260)
- **Description:**
  1. **Dark Module Overwrite**: Under ISO/IEC 18004 Section 7.9, the Dark Module at coordinate `(size - 8, 8)` must always be dark (binary 1). In `lib/upi/qr.js`, the loop writing format information bits to Region 2 used `if (i < 8) matrix[size - 1 - i][8] = bit`. For `i = 7`, this wrote bit 7 directly onto `matrix[size - 8][8]`. When format bit 7 was 0, it turned the Dark Module white (false), corrupting format information in Region 2.
  2. **Uneven Block Truncation**: In Version 8-M (used for ~130 character UPI strings), the total data capacity is 154 codewords split across 4 blocks (two blocks of 38, two blocks of 39). `lib/upi/qr.js` uses `dataLenPerBlock = Math.floor(154 / 4) = 38` for all blocks, silently dropping the final 2 data codewords and producing incorrect Reed-Solomon parity blocks.
- **Proof of Defect:**
  ```text
  Matrix size: 33
  Module at (size - 8, 8) [Dark Module position]: false
  Is Dark Module 1 (black) as required by ISO 18004? false
  ```
- **Remediation:**
  Update the format bit placement loop to `if (i < 7)`, place bits 7–14 along row 8 (`size - 15 + i`), and properly allocate unequal block capacities according to ISO/IEC 18004 Table 9.

---

#### UI-01: Missing Viewport Isolation in Checkout Template
- **Severity:** **MEDIUM**
- **Location:** [`lib/views/checkout-upi.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/views/checkout-upi.js#L48-L105)
- **Description:**
  The checkout template defines both `#mobile-checkout` (UPI deep links and app buttons) and `#desktop-checkout` (scannable SVG QR code).
  However, in the embedded CSS, there are no media queries toggling display between desktop and mobile viewports (`display: none`). Both containers render simultaneously on all screen sizes, confusing mobile users with a giant scannable QR code and desktop users with non-functional mobile deep link chips.
- **Remediation:**
  Add CSS media queries:
  ```css
  @media (min-width: 769px) { .checkout-mobile { display: none; } }
  @media (max-width: 768px) { .checkout-desktop { display: none; } }
  ```

---

#### LOG-01: Shared Rate Limit Keys with SuperProfile Webhook
- **Severity:** **LOW**
- **Location:** [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js#L134), [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js#L147)
- **Description:**
  `phonepeWebhook` uses rate limit prefixes `sp_hook:` and `sp_bad_sig:`, which were originally created for SuperProfile webhooks (`handlers/superprofile.js`).
- **Remediation:**
  Namespace rate-limit keys cleanly to `phonepe_hook:` and `phonepe_bad_sig:`.

---

#### DB-01: `payment_audits` Table Lacks Database-Level Append-Only Guard
- **Severity:** **LOW**
- **Location:** [`migrations/015_upi_payment_integration.sql`](file:///Users/pradeepjakuraa/strangersmeetup/migrations/015_upi_payment_integration.sql#L38-L48)
- **Description:**
  The `payment_audits` table is documented as an immutable audit ledger, but contains no PostgreSQL trigger or rule preventing `UPDATE` or `DELETE` statements.
- **Remediation:**
  In a future migration, add an engine-level trigger:
  ```sql
  CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'payment_audits is append-only'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_payment_audits_immutable BEFORE UPDATE OR DELETE ON payment_audits
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
  ```

---

## 3. Test Verification & Empirical Evidence

All verification was conducted using standard, sanctioned tooling against a real local PostgreSQL database (`sm_test`):

```bash
# 1. Full unit, migration, integration test suite
TEST_DATABASE_URL=postgres://localhost:5432/sm_test npm test
```
**Output**: 446 tests total, 444 passed, 2 skipped (unconfigured Stars sandbox), 0 failed (duration: 54.3s).

```bash
# 2. Migration integrity verification
TEST_DATABASE_URL=postgres://localhost:5432/sm_test node --test test/migrations.test.js
```
**Output**: 6/6 passed (13 sequential migrations verified: `003_` through `015_`).

```bash
# 3. Prohibited legacy provider names scan
TEST_DATABASE_URL=postgres://localhost:5432/sm_test node --test --test-name-pattern="are gone from code" test/superprofile-checkout.test.js
```
**Output**: 1/1 passed (0 hits across code, configs, UI, and docs).

```bash
# 4. Code quality & linting check
npm run lint
```
**Output**: `140/140 files OK`.

---

## 4. Remediation Plan & Owner Action Items

Before activating UPI payments in Production:
1. **Fix PhonePe Checksum Calculation**: Update `verifyWebhookSignature` to extract and hash the Base64 `response` payload.
2. **Implement Strict Amount Matching**: Reject any webhook or status update where `amountPaise !== payment.amount`.
3. **Enforce Authentication on UPI Checkout**: Protect `/checkout/:slug/upi` with `requireUser(req)` or redirect to sign-in.
4. **Fix Concurrency Inventory Allocation**: Count active unexpired payment intents in `seatsTaken` and verify capacity at confirmation time.
5. **Close IDOR Vulnerability**: Ensure unauthenticated requests to `/api/checkout/upi/status/:id` return HTTP 401/403.
6. **Correct QR Matrix Math**: Fix format information bit placement and multi-block capacity calculation in `lib/upi/qr.js`.
7. **Isolate Viewports**: Add responsive CSS media queries in `checkout-upi.js`.

---

## 5. Milestone M4.3 Remediation & Verification Record

All 9 audit findings were systematically resolved, implemented, and verified in Milestone M4.3 on branch `feature/m4-3-upi-security-remediation`:

### Remediation Ledger

| ID | Finding | Resolution Mechanism | Code Evidence | Test Verification |
|:---|:---|:---|:---|:---|
| **SEC-01** | PhonePe webhook signature calculation mismatch | Updated `PhonePeAdapter.verifyWebhookSignature` to calculate `SHA256(base64Response + saltKey) + "###" + saltIndex` per PhonePe S2S specification, with backward-compatible fallback | [`lib/upi/adapter.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/adapter.js) | Verified in `test/upi-checkout.test.js` (`SEC-01` test passes, valid header accepted, tampered body & index rejected) |
| **FIN-01** | Missing amount verification (underpayment attack) | Extracted `verifiedAmountPaise` in webhook/status query, verified `verifiedAmountPaise === payment.amount` before confirmation. If mismatched, marked payment `disputed`, recorded immutable audit entry, and returned 0 confirmed bookings | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js) | Verified in `test/upi-checkout.test.js` (`FIN-01` underpayment test: ₹1 paid on ₹5,000 ticket marks payment disputed, 0 bookings created) |
| **DATA-01** | Guest checkout crash on `NOT NULL bookings.user_id` | Gated `/checkout/:slug/upi` to require authentication (redirects to `/signin` unless explicit `?guest=1`). Stored `guestToken` on payment intent. In webhook, marked payment succeeded without creating invalid null user booking. Added authenticated `/api/checkout/upi/claim` endpoint | [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js), [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js), [`lib/router.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/router.js) | Verified in `test/upi-checkout.test.js` (`DATA-01` test passes without 500, anonymous claim rejected with 401, authenticated claim confirms booking idempotently) |
| **CONCUR-01** | Simultaneous intent capacity bypass & overbooking | Added `activePaymentHolds` and `activeTierPaymentHolds` to hold seats during active unexpired intents (`expires_at > now()`). Re-checked remaining capacity inside locked transaction at payment confirmation time; overbooked payments transition to `refund_pending` | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js) | Verified in `test/upi-checkout.test.js` (`CONCUR-01` test passes: intent 2 rejected as sold out while intent 1 is active; confirmation capacity guard flags oversold order for refund) |
| **AUTH-01** | Status endpoint authorization bypass / IDOR | Added strict permission check in `getUpiPaymentStatus`: authenticated user must match `payment.user_id` or possess staff role (`super_admin`, `finance`, `event_manager`, `support`). Guest orders require valid `guestToken` matching `raw_ref` or staff role | [`lib/services/upi-payments.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/services/upi-payments.js), [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js) | Verified in `test/upi-checkout.test.js` (`AUTH-01` test passes: anonymous returns 401, wrong user returns 403, correct guest token returns 200, admin returns 200) |
| **QR-01** | Format info Dark Module overwrite & V8 codeword truncation | Updated `lib/upi/qr.js` to preserve the mandatory ISO/IEC 18004 Dark Module at `(size - 8, 8)`. Configured exact ISO Table 9 multi-block group blocks (e.g., V8: 2 blocks of 38 + 2 blocks of 39 data codewords) and interleaved across max data length | [`lib/upi/qr.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/upi/qr.js) | Verified in `test/upi-checkout.test.js` (`QR-01` test passes for Version 1, Version 3, and Version 8 matrices; dark module strictly preserved) |
| **UI-01** | Missing responsive viewport isolation in checkout | Added CSS media queries in `renderUpiCheckout` hiding `.checkout-desktop` on viewports `<=768px` and hiding `.checkout-mobile` on viewports `>=769px` | [`lib/views/checkout-upi.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/views/checkout-upi.js) | Verified in `test/upi-checkout.test.js` (`UI-01` test passes: assertions confirm `@media` isolation rules) |
| **LOG-01** | Shared rate limit keys with external provider | Namespaced PhonePe webhook rate limiters to `phonepe_hook:${hashIp(ip)}` and `phonepe_bad_sig:${hashIp(ip)}` | [`lib/handlers/upi-checkout.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/upi-checkout.js) | Verified in `lib/handlers/upi-checkout.js` |
| **DB-01** | `payment_audits` lacks database-level append-only guard | Created migration `016_payment_audits_immutable.sql` creating trigger `prevent_payment_audit_mutation` that throws `'payment_audits is an append-only ledger; updates and deletes are forbidden'` on any UPDATE or DELETE attempt; added partial index `idx_payments_active_holds` | [`migrations/016_payment_audits_immutable.sql`](file:///Users/pradeepjakuraa/strangersmeetup/migrations/016_payment_audits_immutable.sql) | Verified in `test/migrations.test.js` and `test/upi-checkout.test.js` (`DB-01` test passes: UPDATE and DELETE rejected by PostgreSQL trigger) |

### Test Suite Execution Summary
- **Unit & Integration Suite**: 455 tests total, 453 passed, 2 skipped (unconfigured Stars sandbox), 0 failed (`duration: 49.6s`).
- **UPI Checkout Suite**: 21/21 passed (`test/upi-checkout.test.js`).
- **Migration Suite**: 7/7 passed (`test/migrations.test.js`).
- **Prohibited Provider Scan**: 0 occurrences across entire repository (`test/superprofile-checkout.test.js`).
- **Linter**: `140/140 files OK` (`npm run lint`).
- **Safety Boundary**: `ENABLE_LIVE_PAYMENTS=false` strictly preserved across all environments.
