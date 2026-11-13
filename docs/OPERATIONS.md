# NIGHTLIFEZ — Essential Operating Instructions & Runbook

**Primary Monitoring Endpoint:** [https://nightlifez.com/api/health](https://nightlifez.com/api/health)  
**Telegram Bot:** `@Nightlifez_bot`  
**Operations Inbox:** `nightlifezofficial@gmail.com`  

---

## 1. System Health & Observability

### A. Health Check Inspection
The `/api/health` endpoint performs real-time diagnostics on database connectivity and configuration readiness:
```bash
curl -s https://nightlifez.com/api/health | jq .
```
Expected healthy response:
```json
{
  "ok": true,
  "database": "ok",
  "config": {
    "publicSiteUrl": "configured",
    "telegramBot": "configured",
    "paymentProvider": "configured"
  }
}
```

### B. Structured Logs
All server logs are emitted in JSON format containing a unique request trace ID (`reqId`).
To filter errors in Vercel CLI or Dashboard:
```bash
vercel logs strangersmeetup --prod
```

---

## 2. Scheduled Cron Jobs (`/api/cron/*`)

Scheduled maintenance routines require an `Authorization: Bearer <CRON_SECRET>` header.

### Master Daily Cron (`/api/cron/daily`)
Runs every morning at 06:00 IST via Vercel Cron. The daily cron executes four idempotent tasks in sequence:

| Task Name | Sub-endpoint | Action Performed |
|---|---|---|
| **Expire Holds** | `/api/cron/expire-holds` | Cancels bookings stuck in `pending_payment` older than 15 minutes and restores event capacity. |
| **Memberships** | `/api/cron/memberships` | Dispatches renewal reminders 3 days before expiry; revokes chat access for expired subscriptions. |
| **Notifications** | `/api/cron/notifications`| Retries failed Telegram DMs and invite links with exponential backoff. |
| **Cleanup** | `/api/cron/cleanup` | Purges expired login nonces, stale session rows, and obsolete rate-limit counters. |

*Manual Trigger Example:*
```bash
curl -X POST https://nightlifez.com/api/cron/daily \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## 3. Telegram Bot Operations

### A. Bot Webhook Registration
To register or update the webhook with Telegram:
```bash
curl -s -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://nightlifez.com/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query","chat_member"]'
```

### B. Bot Permission Requirements
To generate single-use invites and manage chat memberships, `@Nightlifez_bot` must be added as an **Administrator** in:
1. The official community channel (`NIGHTLIFEZ Official`).
2. Every private event chat group (`events.telegram_chat_id`).
3. Required administrator rights: **Invite Users via Link** and **Ban Users**.

---

## 4. Operational Incident Runbooks

### Incident 1: Telegram Invites Failing
- **Symptom:** Admin dashboard indicates "Invite failures".
- **Diagnosis:** Inspect `last_error` in the `notifications` database table:
  - `user_has_not_started_bot`: The attendee has never messaged `@Nightlifez_bot`. Attendee must open the bot and click **/start**; the bot will immediately deliver their pending invite.
  - `not enough rights`: Bot is not an administrator in the target chat or lacks *Invite Users* permission.
  - `chat not found`: `TG_CHAT_ID_EVENTS` or event chat ID is invalid.
- **Remediation:** Resolve permission, then trigger retry via `/api/cron/notifications`.

### Incident 2: Inbound Webhook Failures
- **Symptom:** Customers report payment completion but tickets remain `pending_payment`.
- **Diagnosis:**
  - `401 Unauthorized`: Webhook secret in provider dashboard does not match `SUPERPROFILE_WEBHOOK_SECRET`.
  - Check `/admin/orders` for **Unmatched** or **Flagged** orders:
    - *Unmatched:* Payment succeeded but buyer email/handle did not match. Buyer can use `/claim <order_id>` in `@Nightlifez_bot`, or Finance can manually link the order in `/admin`.
    - *Flagged:* Currency mismatch, duplicate payment, or event unpublished.

### Incident 3: Refund Execution
- **Ticket Refunds:** Tickets purchased via external checkout must be refunded on the merchant dashboard (SuperProfile). When the refund webhook arrives, NIGHTLIFEZ automatically updates the booking to `refunded`, revokes any unused invite link, and kicks the user from the event chat.
- **Telegram Stars Memberships:** Finance administrators can refund directly from `/admin/bookings` using the **Refund Star Payment** button.

### Incident 4: Account Ban or Misuse
- If an attendee violates community guidelines or leaks invite links:
  ```sql
  -- Ban user and revoke platform access
  UPDATE users SET status = 'banned' WHERE id = '<user_uuid>';
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'banned' WHERE user_id = '<user_uuid>';
  ```
  *The user is immediately signed out from all web sessions, blocked from booking, and kicked from active event chats.*

---

## 5. Secret Rotation Procedures

| Secret Name | Rotation Procedure | Immediate Operational Effect |
|---|---|---|
| `SESSION_SECRET` | Set new secret in Vercel $\to$ Redeploy | Signs out all active web sessions. Users must re-authenticate. |
| `CRON_SECRET` | Set new secret in Vercel $\to$ Redeploy | Vercel Cron uses the updated secret automatically. |
| `TELEGRAM_BOT_TOKEN` | Revoke in @BotFather $\to$ Update Vercel $\to$ Redeploy $\to$ Rerun webhook registration | Bot immediately switches to the new token. |
| `TICKET_SECRET` | Set new secret in Vercel $\to$ Redeploy | Previously generated QR passes will fail door check-in. Rotate only between active event cycles. |
| `SUPERPROFILE_WEBHOOK_SECRET` | Set in Vercel $\to$ Update webhook header in provider dashboard | Inbound webhooks during rotation may return 401; provider retries automatically. |

---

## 6. Pre-Launch Database Sanitization

Before publishing the first live event, sample demo data must be archived:
```sql
-- Archive demo events to ensure only authentic experiences appear
UPDATE events SET status = 'archived' WHERE is_demo = true;
```
Verify that `SELECT count(*) FROM events WHERE status = 'published' AND NOT is_demo;` returns the expected number of authentic events.

---

## 7. First-Event Operational Readiness Checklist

Before publishing the first live event and selling tickets:

- [ ] **1. Telegram Super-Admin Bootstrap (`ADMIN_BOOTSTRAP_TELEGRAM_ID`):**
  - Obtain numeric Telegram User ID from `@userinfobot`.
  - Add `ADMIN_BOOTSTRAP_TELEGRAM_ID` in Vercel Production environment variables.
  - Sign in at `https://nightlifez.com/signin` and navigate to `/admin` to verify `super_admin` access.
- [ ] **2. Telegram Event Chat Setup (`TG_CHAT_ID_EVENTS`):**
  - Create a private group for the event baseline.
  - Add `@Nightlifez_bot` as Administrator with *Invite Users via Link* and *Ban Users* rights.
  - Extract the signed numeric Chat ID (e.g. `-100...`) and add `TG_CHAT_ID_EVENTS` to Vercel Production environment variables.
- [ ] **3. Bot Webhook & Slash Commands:**
  - Run `node scripts/telegram-setup.js` with bot credentials, or run Bot API commands (`setWebhook`, `setMyCommands`, `setChatMenuButton`).
  - Verify `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` reports `0` pending updates.
- [ ] **4. Cloudflare Inbound Aliases & DMARC:**
  - In Cloudflare Email Routing, add 3 forwarding rules (`contact@`, `safety@`, `grievance@` $\to$ `nightlifezofficial@gmail.com`). Keep Catch-all Disabled.
  - In Cloudflare DNS, add TXT record: Name `_dmarc`, Value `v=DMARC1; p=none; rua=mailto:nightlifezofficial@gmail.com`.
  - Test inbound email delivery from external email to `contact@nightlifez.com`.
- [ ] **5. Demo Event Archival:**
  - Execute Section 6 query to archive sample events: `UPDATE events SET status = 'archived' WHERE is_demo = true;`.
- [ ] **6. First Event Creation & Publishing:**
  - In `/admin/events/new`, create the first event with authentic details, attach dedicated private group chat ID, configure a ₹0 test tier, and publish.
- [ ] **7. End-to-End Free Booking Test on Mobile:**
  - Open `https://nightlifez.com/events/<slug>` on a mobile browser; complete Telegram authentication and book a free ticket.
  - Verify booking confirmation page displays reference and dynamic QR pass.
- [ ] **8. Telegram DM & Single-Use Invite Verification:**
  - Confirm `@Nightlifez_bot` delivers booking DM with the private group invite link.
  - Join the group; verify that forwarding the link to another user rejects entry as expired/already used.
- [ ] **9. Door QR Check-In & Duplicate-Scan Rejection:**
  - In `/admin/checkin`, scan the attendee QR pass: confirm first scan returns `200 OK` (Checked In).
  - Immediately scan the same pass again: confirm duplicate scan returns `409 Conflict` (`already_checked_in`).
- [ ] **10. Support & Safety Escalation Test:**
  - Submit test report via `https://nightlifez.com/trust-safety` or `/report` in bot.
  - Verify report appears in `/admin/leads` and triggers high-priority alert.
