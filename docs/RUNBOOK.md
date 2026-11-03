# Runbook

Health first: `GET /api/health` → `database: ok` and each config item `configured`. Logs: Vercel → Project → Logs (JSON lines with `reqId`; tokens, initData and payment payloads are never logged).

## Webhook failures

### SuperProfile notifications not arriving / failing
1. Zapier/Pabbly → the zap's task history. 401 = the `X-Webhook-Secret` header differs from `SUPERPROFILE_WEBHOOK_SECRET`; 503 = the secret is not set (or shorter than 24 chars); 400 = a mapped field is wrong (the response lists the field names); 5xx = our processing error — check Vercel logs for `superprofile webhook failed`.
2. Admin → Orders: **unmatched** orders are paid but not tied to a person (the buyer can `/claim` them in the bot; finance can link one by hand). **flagged** orders need a decision: `amount_mismatch`, `currency_mismatch`, `event_not_published`, `duplicate_booking`, `refund_after_check_in`, `unknown_product` (link the product id on the event).
3. Missed notifications are caught by the daily reconciliation (see `docs/SUPERPROFILE_OPS.md`), which diffs SuperProfile sales against `external_orders`. Replaying a notification is safe: it is idempotent on the order id.

### Telegram webhook
1. `node scripts/telegram-setup.js` prints `getWebhookInfo` (pending updates, last error). Re-running it is safe.
2. 401s in logs = `TELEGRAM_WEBHOOK_SECRET` differs from the one passed to `setWebhook` → re-run the setup script after fixing the env var.
3. Updates that fail return 500 and Telegram retries; duplicates are ignored by `update_id`.

### Bot DMs / invites failed
- Admin → Overview → "Invite failures". The `notifications` table has `last_error`:
  - `user_has_not_started_bot` — the member must open the bot and press Start (the booking page shows the link). Then `/start` re-sends the invite.
  - `not enough rights` — make the bot an admin with *Invite users* + *Ban users* in that chat.
  - `NOT CONFIGURED: chat id …` — set `TG_CHAT_ID_EVENTS` / `TG_CHAT_ID_TIER_n` (or the event's chat id in admin).
- Retries run with backoff (up to 6 attempts); force a run: `curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/notifications`.

## Refunds
- **Tickets are refunded on SuperProfile**, not in this app. When SuperProfile reports the refund, the order becomes `refunded`, the booking `refunded`, an unused invite is revoked and a guest who already joined is removed from the group. The app refuses to refund a ticket itself (`NOT_SUPPORTED_IN_APP`).
- Stars memberships: Admin → Bookings & payments (finance or super_admin) → **Refund** — `refundStarPayment`, and the member is removed from the tier chat.
- A refund after check-in keeps the check-in record and flags the order `refund_after_check_in` for finance.
- Cancelling an event (Admin → Events → Cancel) DMs confirmed attendees that they will be refunded; then refund each order on SuperProfile.

## Revoking access
- Membership: Admin → Memberships → search → **Revoke** (removes from the tier chat via ban+unban, so the person can rejoin later if they pay again).
- Leaked invite: anyone who joins with an invite issued to someone else is removed automatically and the invite is revoked (see audit log `invite.misuse_removed`).
- Ban a user entirely: `UPDATE users SET status = 'banned' WHERE telegram_user_id = …;` — they can no longer sign in, book or pay. Remove them from chats via Telegram.

## Rotating secrets
| Secret | Steps | Effect |
|---|---|---|
| `SESSION_SECRET` | Set new value in Vercel → redeploy | Everyone is signed out; pending OIDC logins fail once; unpaid Stars invoices created before rotation fail pre-checkout (users just retry). |
| `CRON_SECRET` | Set new value → redeploy | Vercel Cron picks it up automatically. |
| `TELEGRAM_WEBHOOK_SECRET` | Set new value → redeploy → `node scripts/telegram-setup.js` | Until the script runs, Telegram updates get 401 and are retried. |
| `TELEGRAM_BOT_TOKEN` | BotFather → `/revoke` → set new token → redeploy → setup script | Old token stops immediately. |
| `SUPERPROFILE_WEBHOOK_SECRET` | Set new value in Vercel → redeploy → update the `X-Webhook-Secret` header in the zap | Notifications in between 401; Zapier/Pabbly can replay them (idempotent). |
| `DATABASE_URL` | Rotate in Neon/Supabase → set → redeploy | — |
| `TELEGRAM_LOGIN_CLIENT_SECRET` | BotFather Login Widget → regenerate → set → redeploy | — |

## Crons (Hobby: daily 06:00 IST)
`/api/cron/daily` runs: `expire-holds`, `memberships` (3-day reminders, expiry + removal), `notifications` (retries), `cleanup` (nonces, rate limits). Each is idempotent and can be called individually with the bearer secret.

## Database
- Migrations: `npm run migrate` (also runs in the Vercel **Production** build; Preview builds skip unless `MIGRATE_ON_PREVIEW=true` with a separate DB). Never edit an applied migration — add a new numbered file.
- Revoke a user's sessions (compromised account): set `revoked_at = now(), revoke_reason = 'admin'` on that user's live `user_sessions` rows (an admin UI action is planned in M6). Users can do it themselves with `POST /api/auth/logout-all`.
- Demo data: `npm run seed:demo` upserts only `is_demo` rows. Remove before launch: `UPDATE events SET status = 'archived' WHERE is_demo;`
