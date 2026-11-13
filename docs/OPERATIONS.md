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
