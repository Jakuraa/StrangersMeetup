# Go-live checklist (owner executes)

Nothing below has been done. Each step needs the owner's decision or credentials.

## 0. Prerequisites
- [ ] **Vercel Pro** for the team (Hobby is non-commercial; Pro also allows more frequent crons).
- [ ] **Postgres**: Vercel → Storage / Marketplace → Neon (or Supabase) → connect to project `strangersmeetup` for Production + Preview. This sets `DATABASE_URL`.
- [ ] Env vars set (Production + Preview) per `.env.example`: `SESSION_SECRET` (`openssl rand -base64 48`), `CRON_SECRET`, `PUBLIC_SITE_URL`, `ADMIN_BOOTSTRAP_TELEGRAM_ID`, `LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_EMAIL`.
- [ ] Telegram per `docs/TELEGRAM_SETUP.md` (bot, groups, chat ids, OIDC client, `node scripts/telegram-setup.js`). Rename `Telegram_HTTP_API` → `TELEGRAM_BOT_TOKEN`.
- [ ] Razorpay account activated under an events/ticketing category, **with written confirmation of the category** (see PAYMENTS_DECISION.md); test keys tested end-to-end on Preview first.

## 1. Set final prices
- [ ] Ticket prices: Admin → Events → Edit → "Ticket price ₹".
- [ ] Membership Stars amounts (≤ 10,000): Admin → Membership tiers (super_admin).

## 2. Load the first real event
- [ ] Admin → Events → New event (draft) → fill venue, refund policy, inclusions, chat id if per-event → Preview → Publish.
- [ ] Archive sample events: Admin → Events → Archive each "Sample" row (or `UPDATE events SET status='archived' WHERE is_demo;`).
- [ ] Add owner-authorised photos/reviews: Admin → Media → Add → Authorise → Show.

## 3. Switch to live keys
- [ ] Razorpay live mode → generate live keys → create a live webhook to `https://<domain>/api/payments/webhook/razorpay` with events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.failed`, `refund.processed`.
- [ ] Production env: `RAZORPAY_KEY_ID=rzp_live_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (live), **`ENABLE_LIVE_PAYMENTS=true`**. (The app refuses live keys while the flag is false, and test keys while it is true.)
- [ ] Production must not have `TELEGRAM_TEST_ENV=true`.

## 4. One real ₹ transaction (owner)
- [ ] Create a hidden-capacity test event priced ₹1–₹10, publish, book it yourself on the production URL.
- [ ] Verify: Razorpay dashboard shows the payment; `/api/health` ok; booking `confirmed` in Admin; bot DM arrived; invite link joins the events group; Overview KPI "Paid (live)" updated.
- [ ] **Refund it** from Admin → Bookings & payments; verify refund in Razorpay, booking `refunded`, DM received.
- [ ] Cancel/archive the test event.

## 5. Promote to production
- [ ] Merge the `launch-mvp` PR to `main` (Vercel deploys production from `main`) — only after steps 0–4 on Preview.
- [ ] Re-run `node scripts/telegram-setup.js` with production `PUBLIC_SITE_URL`.

## 6. Domain / DNS (only with explicit approval)
- [ ] Add the custom domain in Vercel, set DNS records at the registrar, update `PUBLIC_SITE_URL`, Telegram Login allowed URLs, Razorpay webhook URL and website URL, then re-run the setup script.
