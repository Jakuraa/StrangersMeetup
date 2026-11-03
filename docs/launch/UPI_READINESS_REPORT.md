# NIGHTLIFEZ Operational Readiness Report: UPI-First Checkout & Dynamic QR Integration

**Milestone:** M4.1 — UPI-First Checkout, Dynamic QR & Verified Payment Integration  
**Date:** November 2026  
**Status:** Verification Passed · Gated for Production Release  
**Reference Specification:** [`docs/arch/UPI_PAYMENT_INTEGRATION.md`](file:///Users/pradeepjakuraa/strangersmeetup/docs/arch/UPI_PAYMENT_INTEGRATION.md)  
**Safety Gate:** `ENABLE_LIVE_PAYMENTS=false` Enforced

---

## 1. Executive Summary

Milestone M4.1 delivers an enterprise-grade, native **UPI-First Payment Integration** for NIGHTLIFEZ. The implementation replaces third-party redirect checkouts with an in-product, device-adaptive payment interface supporting India's National Payments Corporation of India (NPCI) UPI rails.

All functionality has been implemented using pure ECMAScript (zero external binary QR libraries), wrapped in a provider-neutral gateway adapter layer (PhonePe PG primary, PayU fallback ready), backed by an additive database migration (`015_upi_payment_integration.sql`), and guarded by an immutable audit ledger (`payment_audits`).

Every transaction is cryptographically verified server-side. No client-supplied payment screenshots or return redirects are ever accepted as proof of payment.

---

## 2. Safety Boundary Verification

The platform's strict payment safety boundary remains intact across all environments:

| Environment | Variable Name | Required Value | Actual Verified Value | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Local Development** | `ENABLE_LIVE_PAYMENTS` | `false` | `false` | **VERIFIED PASS** |
| **Preview (`sm-preview`)** | `ENABLE_LIVE_PAYMENTS` | `false` | `false` | **VERIFIED PASS** |
| **Production (`sm-prod`)** | `ENABLE_LIVE_PAYMENTS` | `false` | `false` | **VERIFIED PASS** |

### Safety Invariants Enforced:
- No real money is collected or processed during automated testing or preview deployment.
- Real payment gateway API credentials are not committed or exposed in any repository file or build artifact.
- Setting `ENABLE_LIVE_PAYMENTS=false` immediately halts paid intent creation with HTTP 403 `live_payments_disabled`.

---

## 3. Implementation Verification Checklist

### 3.1 Core Architecture & Device Adaptability
- [x] **Zero-Dependency Vector QR Generator (`lib/upi/qr.js`)**:
  - Pure ECMAScript Model 2 QR Code generator with Reed-Solomon Error Correction Level M.
  - Generates lightweight, pixel-perfect, scalable SVG elements without raster blurring or native compilation dependencies.
  - Implements NPCI standard UPI format: `upi://pay?pa={vpa}&pn={name}&am={amount}&cu=INR&tr={orderId}&tn={note}`.
- [x] **Mobile Experience**:
  - Generic UPI intent trigger invoking device application chooser.
  - Explicit deep-link fallbacks for Google Pay (`gpay://`), PhonePe (`phonepe://`), Paytm (`paytmmp://`), CRED (`credpay://`), and BHIM (`bhim://`).
- [x] **Desktop Experience**:
  - Dynamic vector QR display with real-time 15-minute countdown clock.
  - Non-intrusive automated status polling every 3.5 seconds (`GET /api/checkout/upi/status/:id`).
  - Manual "I have paid" refresh button.
  - Auto-blur and expired state overlay when session timer reaches zero.

### 3.2 Provider Abstraction & Gateway Integration
- [x] **Provider-Neutral Interface (`lib/upi/adapter.js`)**:
  - Standardized contract: `createPaymentIntent()`, `getPaymentStatus()`, `verifyWebhook()`, `initiateRefund()`.
  - Primary adapter: **PhonePe PG Adapter** implementing `/pg/v1/pay`, `/pg/v1/status`, `/pg/v1/refund`, and SHA256 checksum verification.
  - Test sandbox adapter: `MockUpiAdapter` for deterministic local and CI verification without third-party network calls.
- [x] **Fallback Gateway Readiness**:
  - PayU integration path fully documented and structurally compatible with the adapter interface.

### 3.3 State Machine & Data Integrity
- [x] **Deterministic Finite State Machine (`lib/services/upi-payments.js`)**:
  - States: `created`, `pending`, `processing`, `succeeded`, `failed`, `expired`, `cancelled`, `refund_pending`, `refunded`, `disputed`.
  - Illegal status transitions strictly rejected by `isLegalTransition()` validator.
- [x] **Immutable Audit Ledger (`payment_audits` table)**:
  - Every state mutation records actor, timestamp, previous state, new state, and JSON metadata snapshot.
- [x] **Database Concurrency & Anti-Overselling**:
  - Atomically locks ticket tiers (`SELECT ... FOR UPDATE`) during intent creation.
  - Prevents checkout for sold-out events (returns HTTP 409 `sold_out`).
- [x] **Automated Refund & Access Revocation**:
  - Triggering refund transitions payment and booking to `refunded`.
  - Immediately revokes active Telegram chat invite links associated with the booking.

### 3.4 Cryptographic Security & Zero-Trust Verification
- [x] **Constant-Time Webhook Verification**:
  - PhonePe incoming `X-VERIFY` header validated using `crypto.timingSafeEqual`.
  - Rejects malformed, tampered, or replay payloads with HTTP 401.
- [x] **Webhook Idempotency**:
  - Duplicate webhook deliveries return HTTP 200 `{ ok: true, result: 'duplicate' }` and do not create duplicate bookings or duplicate tickets.
- [x] **Zero Prohibited Names Invariant**:
  - Scanned repository to ensure 0 occurrences of prohibited legacy provider names ("Razorpay" and "Cashfree"). Enforced via `test/superprofile-checkout.test.js`.

---

## 4. Test Suite Execution Results

All 446 repository tests executed in sequence against a local PostgreSQL database (`sm_test`):

```text
✔ QR & URI: generates valid NPCI UPI URI with merchant, amount, orderId and note
✔ mobile intents: generates generic UPI intent and app-specific deep links
✔ payment intent: creates pending payment row and audit ledger entry
✔ state machine: strictly validates legal and illegal status transitions
✔ webhook security: PhonePe adapter verifies valid signature and rejects tampered ones
✔ webhook confirmation: valid webhook confirms booking, updates payment, and is idempotent
✔ status polling: client polling returns current status and handles expiry
✔ refunds: refund transitions payment to refunded and revokes Telegram invites
✔ concurrency: simultaneous checkout intents respect capacity limits
✔ safety boundary: ENABLE_LIVE_PAYMENTS=false blocks paid intent creation in non-test mode
✔ http routes: GET /checkout/:slug/upi renders checkout view for signed-in user
✔ http routes: POST /api/checkout/upi/intent creates intent and returns QR and UPI URI
✔ http routes: POST /api/payments/webhook/phonepe processes valid webhook payload via HTTP

ℹ tests 446
ℹ suites 0
ℹ pass 444
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2 (Telegram stars membership sandbox test skipped when unconfigured)
ℹ todo 0
ℹ duration_ms 48366ms
```

---

## 5. Owner Activation Checklist (Pre-Live Gateway Launch)

Before toggling `ENABLE_LIVE_PAYMENTS=true` in Production, the business and operations teams must complete the following mandatory gates:

1. [ ] **Merchant Account Onboarding**:
   - Complete KYB verification on PhonePe Business Console.
   - Obtain Production `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, and `PHONEPE_SALT_INDEX`.
2. [ ] **NPCI VPA Whitelisting**:
   - Register and verify official business VPA (e.g., `nightlifez@ybl`).
3. [ ] **Webhook Endpoint Registration**:
   - Configure PhonePe Production Webhook URL to: `https://strangersmeetup.com/api/payments/webhook/phonepe`.
4. [ ] **Vercel Production Environment Variables**:
   - Add `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, `PHONEPE_SALT_INDEX`, `PHONEPE_ENV=PROD`, `PHONEPE_MERCHANT_VPA`.
5. [ ] **End-to-End Production ₹1 Verification**:
   - Execute a single live transaction of ₹1.00 using a personal test device.
   - Verify server-to-server webhook receipt, audit ledger entry, ticket delivery, and subsequent ₹1.00 refund reconciliation.
6. [ ] **Owner Launch Authorization**:
   - Flip `ENABLE_LIVE_PAYMENTS=true` only after all gates 1–5 are formally signed off.
