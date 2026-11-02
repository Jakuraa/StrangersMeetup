# Go-live checklist (owner executes)

Nothing below has been done. Each step needs the owner's decision or credentials.

## 0. Prerequisites
- [ ] **Vercel Pro** for the team (Hobby is non-commercial; Pro also allows more frequent crons).
- [ ] **Postgres**: Vercel → Storage / Marketplace → Neon (or Supabase) → connect to project `strangersmeetup` for Production + Preview. This sets `DATABASE_URL`.
- [ ] Env vars set (Production + Preview) per `.env.example`: `SESSION_SECRET` (`openssl rand -base64 48`), `CRON_SECRET`, `PUBLIC_SITE_URL`, `ADMIN_BOOTSTRAP_TELEGRAM_ID`, `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_EMAIL`.
- [ ] Telegram per `docs/TELEGRAM_SETUP.md` (bot, groups, chat ids, OIDC client, `node scripts/telegram-setup.js`). Rename `Telegram_HTTP_API` → `TELEGRAM_BOT_TOKEN`.
- [ ] SuperProfile account `Meetup_Host` active; product copy avoids "dating" wording (see `docs/SUPERPROFILE_OPS.md`). Zapier/Pabbly zap (or a native SuperProfile webhook) created and pointed at `/api/webhooks/superprofile`.
- [ ] `SUPERPROFILE_WEBHOOK_SECRET` (24+ chars) set in Production; the same value is sent as `X-Webhook-Secret` by the zap.

## 1. Set final prices
- [ ] Ticket prices: set on the SuperProfile product (the owner approves each publish). Optionally mirror the price in Admin → Events → Edit so the app can verify the amount on each order.
- [ ] Membership Stars amounts (≤ 10,000): Admin → Membership tiers (super_admin). SuperProfile membership prices live on SuperProfile.

## 2. Load the first real event
- [ ] Admin → Events → New event (draft) → fill venue, refund policy, inclusions, chat id if per-event → Preview → Publish.
- [ ] Archive sample events: Admin → Events → Archive each "Sample" row (or `UPDATE events SET status='archived' WHERE is_demo;`).
- [ ] Add owner-authorised photos/reviews: Admin → Media → Add → Authorise → Show.

## 3. Link the event to its SuperProfile product
- [ ] Publish the product on SuperProfile (owner approval). Set its quantity equal to the event capacity: SuperProfile is the source of truth for stock.
- [ ] Admin → Events → Edit: *Checkout* `superprofile`, paste the product link (`https://…superprofile.bio/…`) and the product id/name the zap sends. Publish the event.
- [ ] Production must not have `TELEGRAM_TEST_ENV=true`.

## 4. One real ticket (owner)
- [ ] Buy one ticket yourself on the production event page ("Book Tickets" → SuperProfile).
- [ ] Verify: the zap fires; Admin → Orders shows it `matched` (or `unmatched` until you `/claim` it in the bot); booking `confirmed`; bot DM and single-use invite arrive and the invite joins the events group; `/api/health` is green.
- [ ] **Refund it on SuperProfile**; verify the order becomes `refunded`, the booking `refunded`, the invite revoked.
- [ ] Cancel/archive the test event if it was a throwaway.

## 5. Promote to production
- [ ] Merge the `launch-mvp` PR to `main` (Vercel deploys production from `main`) — only after steps 0–4 on Preview.
- [ ] Re-run `node scripts/telegram-setup.js` with production `PUBLIC_SITE_URL`.

## 6. Domain / DNS (only with explicit approval)
- [ ] Add the custom domain in Vercel, set DNS records at the registrar, update `PUBLIC_SITE_URL`, Telegram Login allowed URLs and the zap's webhook URL, then re-run the setup script.
