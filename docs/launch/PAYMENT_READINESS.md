# NIGHTLIFEZ — Payment Readiness & Financial Safety Report

> **Milestone:** M4 Payment, Booking and Revenue Readiness Audit  
> **Status:** Safety Boundary Active (`ENABLE_LIVE_PAYMENTS=false`)  
> **Auditor:** Independent Security Reviewer  
> **Integration Baseline:** PR #26 (`46b85c1`) on `launch-mvp`  

---

## 1. Executive Summary

This report establishes the financial safety boundary, payment integrity architecture, and regulatory compliance posture for the NIGHTLIFEZ platform ahead of beta release.

### Core Policy Determinations
1. **Safety Boundary Enforced:** `ENABLE_LIVE_PAYMENTS=false` remains strictly enforced across **all** environments (local development, CI, Preview, and Production). No live transactions, credit card charges, UPI debits, or payment gateway collections are permitted.
2. **Free-Only MVP Scope:** The platform launch operates exclusively on free ticket tiers, manual host approvals, and link-outs to third-party platforms.
3. **Rejection of Manual Payment Proofs:** UPI transaction screenshots, payment receipts, and client-asserted transaction references are categorically rejected as proof of payment. Payment success can only be established via authenticated provider webhooks or authorized finance reconciliation.
4. **Regulatory Insulation:** The platform does not collect, hold, aggregate, or split money between event hosts and guests, fully insulating NIGHTLIFEZ from Reserve Bank of India (RBI) Payment Aggregator (PA) licensing requirements.

---

## 2. Payment Safety Boundary: `ENABLE_LIVE_PAYMENTS=false`

### 2.1 Technical Enforcement
The safety boundary is implemented at the core configuration and routing layers:
- **Configuration Default (`lib/config.js`):**
  ```javascript
  export const livePayments = () => env('ENABLE_LIVE_PAYMENTS') === 'true';
  ```
  Defaults to `'false'` whenever unset or set to any value other than `'true'`.
- **Availability Check (`lib/payments/availability.js`):**
  ```javascript
  export function checkoutForEvent(row) {
    if (!livePayments()) {
      return { available: false, reason: 'live_payments_disabled', message: 'Paid ticket checkout is currently disabled.' };
    }
    // ...
  }
  ```
- **Routing Interceptor (`lib/handlers/checkout.js`):**
  If `createCheckoutIntent()` returns `null` (triggered when `checkoutForEvent().available === false`), the handler halts external redirect and issues a 302 redirect back to the event detail page:
  ```javascript
  if (!intent) return redirect(res, `/events/${slug}`);
  ```

### 2.2 Invariant Verification Across Environments
- **Local Development:** Default environment sets `ENABLE_LIVE_PAYMENTS=false`.
- **Vercel Preview Deployments:** Blocked by both `ENABLE_LIVE_PAYMENTS=false` and explicit Preview check (`ALLOW_PREVIEW_PAID_CHECKOUT !== 'true'`).
- **Production Environment:** Retains `ENABLE_LIVE_PAYMENTS=false` until owner gate requirements are fully satisfied.

---

## 3. Threat Analysis: Why UPI Screenshots Alone Cannot Establish Payment Success

In early-stage Indian consumer apps, organizers frequently request that attendees upload UPI payment screenshots or enter a 12-digit UPI reference number (UTR). This practice is **strictly prohibited** in NIGHTLIFEZ due to severe security and fraud vulnerabilities.

### 3.1 Known Fraud Vectors with Manual Payment Proofs
1. **Synthetic Image Generation & Template Manipulation:** Readily available mobile apps and web tools generate realistic mockups of popular UPI payment confirmation screens (Google Pay, PhonePe, Paytm). These mockups display valid timestamps, recipient VPA names, and fabricated transaction IDs.
2. **Replay & Cross-Account Recycling:** A single legitimate payment screenshot can be cropped, recompressed, and submitted by multiple users or across multiple events. Without automated database-level uniqueness validation linked to banking rails, manual reviewers cannot detect reused receipts.
3. **Pending, Cancelled & Reversed Transactions:** UPI interfaces display a green "Processing" or "Initiated" screen before settlement is confirmed. Fraudulent users capture this intermediate screen, subsequently cancel or decline the debit request in their banking app, and present the screenshot as proof of completed payment.
4. **Administrative Fatigue & Review Blindness:** Manual verification of hundreds of image uploads during peak ticket sales inevitably causes human error, resulting in admission of unpaid attendees and revenue loss for event organizers.
5. **No Provable Audit Trail:** An image attachment does not constitute a legally binding banking confirmation and cannot be reconciled during statutory financial audits.

### 3.2 The NIGHTLIFEZ Cryptographic Assurance Standard
To achieve zero-trust financial integrity, NIGHTLIFEZ enforces that an order is marked `paid` **only** when one of the following conditions is satisfied:
1. **Authenticated Provider Webhook:**
   - Received directly from SuperProfile with a valid `X-Webhook-Secret` matching our configured secret ($\ge 24$ characters) verified using constant-time comparison (`safeEqual`).
   - Webhook payload includes verified order status (`purchase`), currency (`INR`), and amount in paise matching the configured ticket tier price $\times$ quantity.
   - Ref matches an unexpired, unconsumed checkout intent, or buyer email hash matches a previously verified user account.
2. **Authorized Finance Administrative Reconciliation:**
   - A privileged platform administrator with the `finance` role manually links an unclaimed order (`/api/admin/orders/:id/link`) after verifying settlement in official banking statements. Every manual link is permanently recorded in the audit log.

---

## 4. Provider Architecture & Revenue Models

### 4.1 SuperProfile Hosted Checkout Integration
NIGHTLIFEZ integrates with SuperProfile via an external hosted redirect model:
- **Zero Cardholder Data Handling:** NIGHTLIFEZ never collects, processes, or stores payment card numbers, CVVs, expiration dates, or bank credentials.
- **Provider Fees:** SuperProfile applies a standard transaction processing fee (typically 2% to 3% + applicable GST) deducted from the organizer's gross payout.
- **Taxation (GST):**
  - Event tickets: The event organizer is responsible for GST compliance on ticket sales based on their turnover and tax registration status.
  - Platform fees: If NIGHTLIFEZ levies listing fees or commissions in future phases, NIGHTLIFEZ will issue GST-compliant tax invoices.
- **Chargebacks & Disputes:** Disputes raised by cardholders or bank account holders are resolved upstream by SuperProfile and the acquiring banks. Upon receiving a reversal notification, NIGHTLIFEZ revokes the booking, marks the order `refunded`, invalidates unused Telegram invite links, and removes the attendee from community chats.

### 4.2 Reconciliation Architecture (`lib/services/reconcile.js`)
To detect discrepancies between external payment records and internal database state, NIGHTLIFEZ implements automated reconciliation:
- **Data Export Comparison:** Compares SuperProfile sales reports with internal `external_orders` rows.
- **Drift Detection:**
  - `missingInDb`: Orders paid on SuperProfile but never received via webhook.
  - `missingInSuperprofile`: Orders present locally but missing from upstream provider records.
  - `amountDrift`: Discrepancies between paise collected and paise recorded.
  - `statusDrift`: Divergence between upstream refund status and internal booking state.
- **Alerting:** Any drift automatically logs an integration alert and notifies platform administrators via Telegram.

---

## 5. Regulatory & Compliance Considerations

### 5.1 Reserve Bank of India (RBI) Payment Aggregator Guidelines
Under the RBI *Guidelines on Regulation of Payment Aggregators and Payment Gateways* (circular DPSS.CO.PD.No.1810/02.14.008/2019-20):
- Entities that intermediate funds between consumers and third-party merchants/sellers are defined as **Payment Aggregators (PAs)** and require formal RBI authorization, a minimum net worth of ₹25 Crore, and strict nodal/escrow account operations.
- **NIGHTLIFEZ Architecture Avoids Intermediation:**
  - NIGHTLIFEZ does **not** collect ticket money from attendees into a corporate bank account with the intention of disbursing payouts to independent event organizers.
  - Independent organizers must collect their own ticketing revenue directly (via external ticketing platforms like SuperProfile or BookMyShow) or host free community events.
  - This architecture ensures complete compliance without subjecting NIGHTLIFEZ to PA licensing obligations.

---

## 6. Activation Gate: Requirements for Future Live Payments

Live payments may **only** be activated in Production after the company owner formally signs off on all of the following requirements:

| Checkpoint | Requirement | Verification Method | Status |
| :--- | :--- | :--- | :--- |
| **G-1: Legal Entity** | Registered corporate legal entity with active bank account in India | Certificate of Incorporation & KYC | Required |
| **G-2: Merchant Agreement** | Formal merchant agreement executed with approved payment gateway or hosted checkout provider | Signed merchant agreement | Required |
| **G-3: Webhook Secret** | High-entropy shared secret ($\ge 32$ characters) configured in Vercel Production environment | Secret length & complexity check | Configured (`SUPERPROFILE_WEBHOOK_SECRET`) |
| **G-4: Reconciliation Job** | Automated daily reconciliation cron scheduled and alerting verified | Test reconciliation against mock export | Verified |
| **G-5: Terms of Service** | Updated Terms of Service & Cancellation/Refund Policy published on public site | Legal review of `/terms` & `/refunds` | Complete |
| **G-6: Production DB** | Production database endpoint confirmed and isolated from Preview | Endpoint ID check against Vercel Storage | Pending Owner Confirmation |
| **G-7: Owner Approval** | Explicit written instruction from repository owner to set `ENABLE_LIVE_PAYMENTS=true` | Owner prompt / decision record | Blocked (Pending Gate) |
