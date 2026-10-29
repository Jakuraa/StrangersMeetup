# Runbook

Health first: `GET /api/health` → `database: ok` and each config item `configured`. Logs: Vercel → Project → Logs (JSON lines with `reqId`; tokens, initData and payment payloads are never logged).

## Webhook failures

### Razorpay webhook not arriving / failing
1. Razorpay Dashboard → Webhooks → the endpoint → delivery log. 401 = secret mismatch (`RAZORPAY_WEBHOOK_SECRET` must equal the secret set on that webhook; test and live webhooks have separate secrets). 5xx = our processing error — check Vercel logs for `payment webhook` / `request failed`.
2. Razorpay disables a webhook after 24h of failures. Re-enable it in the dashboard.
3. Missed payments are recovered by the daily cron (`reconcile`), or immediately:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/reconcile`
   It asks Razorpay about every `created` payment older than 10 minutes and applies the result through the same idempotent code path.

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
- Admin → Bookings & payments (finance or super_admin) → **Refund** on a paid payment. Full refund via provider (Razorpay `receipt` makes it idempotent), booking → `refunded`, invites revoked, member DM'd. Stars memberships refund via `refundStarPayment` and remove the member from the tier chat.
- **Refunds due** (Overview KPI, filter `refund_due`): payments that completed after the seat hold lapsed when the event was full or cancelled. Refund each one — the money must not be kept.
- Cancelling an event (Admin → Events → Cancel) DMs confirmed attendees that they will be refunded; then refund each paid booking from Bookings.

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
| `RAZORPAY_KEY_SECRET` | Dashboard → API keys → regenerate → set → redeploy | Checkouts fail until redeployed. |
| `RAZORPAY_WEBHOOK_SECRET` | Edit webhook secret in dashboard and env at the same time → redeploy | Deliveries in between 401 and are retried. |
| `DATABASE_URL` | Rotate in Neon/Supabase → set → redeploy | — |
| `TELEGRAM_LOGIN_CLIENT_SECRET` | BotFather Login Widget → regenerate → set → redeploy | — |

## Crons (Hobby: daily 06:00 IST)
`/api/cron/daily` runs: `expire-holds`, `reconcile`, `memberships` (3-day reminders, expiry + removal), `notifications` (retries), `cleanup` (nonces, rate limits). Each is idempotent and can be called individually with the bearer secret.

## Database
- Migrations: `npm run migrate` (also runs in the Vercel **Production** build; Preview builds skip unless `MIGRATE_ON_PREVIEW=true` with a separate DB). Never edit an applied migration — add a new numbered file.
- Revoke a user's sessions (compromised account): set `revoked_at = now(), revoke_reason = 'admin'` on that user's live `user_sessions` rows (an admin UI action is planned in M6). Users can do it themselves with `POST /api/auth/logout-all`.
- Demo data: `npm run seed:demo` upserts only `is_demo` rows. Remove before launch: `UPDATE events SET status = 'archived' WHERE is_demo;`
