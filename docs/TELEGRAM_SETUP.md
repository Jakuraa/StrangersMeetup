# Telegram setup (owner)

Status today: **NOT CONFIGURED.** All bot, invite, Mini App and Stars code is built and tested against a stubbed Bot API; nothing is live until the steps below are done. Never paste tokens or secrets into chat — set them only as Vercel environment variables.

## 1. Bot (BotFather)
1. In Telegram open **@BotFather** → `/newbot` (or pick your existing bot). Name: *StrangersMeetup*; username e.g. `StrangersMeetupBot` (must be one you own — the old site linked `@StrangersMeetupBot` without it being verified).
2. Set the profile photo to the site logo (`public/favicon.svg`) — Telegram shows it on the login prompt.
3. Copy the token. In Vercel → Project → Settings → Environment Variables add **`TELEGRAM_BOT_TOKEN`** (Preview + Production).
   - The project currently has a variable named `Telegram_HTTP_API`. The code accepts it as a fallback *only if it is shaped exactly like a bot token*, but please rename it to `TELEGRAM_BOT_TOKEN` and add it to Preview too.
4. Add **`TELEGRAM_BOT_USERNAME`** (without `@`).
5. Generate a webhook secret (16–256 chars of `A-Z a-z 0-9 _ -`), e.g. `openssl rand -hex 32`, and add **`TELEGRAM_WEBHOOK_SECRET`**.
6. BotFather → your bot → **Bot Settings → Configure Mini App / Menu Button** → URL = your site (`PUBLIC_SITE_URL`). (`scripts/telegram-setup.js` also sets the menu button.)
7. BotFather → **Payments**: nothing to connect for Stars. For sandbox Stars testing use Telegram's *test environment* (separate test account + test bot) and set `TELEGRAM_TEST_ENV=true` on the preview that uses the test bot.

## 2. Website sign-in (Telegram Login, OpenID Connect)
Telegram's current web login is OpenID Connect (the old iframe widget is archived).
1. BotFather mini app → select bot → **Login Widget** → add Allowed URLs:
   - `https://<your-domain>` and `https://<your-domain>/auth/telegram/callback`
   - the same for the preview URL you test on.
2. Copy **Client ID** → `TELEGRAM_LOGIN_CLIENT_ID`, **Client Secret** → `TELEGRAM_LOGIN_CLIENT_SECRET`.
3. Without these two, `/signin` falls back to the legacy widget (needs `/setdomain` in BotFather for the site domain).

## 3. Private groups (one per membership tier + one for event coordination)
Create **private supergroups** (or channels for broadcast-only):

| Purpose | Env var |
|---|---|
| Event coordination group (venue reveal for paid attendees) | `TG_CHAT_ID_EVENTS` |
| Tier 1 — Insider | `TG_CHAT_ID_TIER_1` |
| Tier 2 — Social Plus | `TG_CHAT_ID_TIER_2` |
| Tier 3 — VIP Circle | `TG_CHAT_ID_TIER_3` |

For each chat:
1. Add the bot as **administrator** with: *Invite users via link* and *Ban users* (and *Delete messages* for moderation). Nothing else is needed.
2. Turn off "Approve new members" (invites are single-use, `member_limit: 1`, 24h expiry).
3. Get the chat id: after the webhook is set (step 4), add the bot and post any message; or temporarily add **@RawDataBot**/**@getidsbot**, read `chat.id` (starts with `-100…`), then remove it.
4. Put the id in the matching env var. A per-event group can instead be set on the event in **/admin → Events → Telegram chat id**.

## 4. Point Telegram at the site
After the env vars are on the deployment (and `PUBLIC_SITE_URL` is set to it):
```
vercel env pull .env.setup --environment=production   # or preview
set -a; . ./.env.setup; set +a
node scripts/telegram-setup.js
rm .env.setup
```
It calls `setWebhook` (with `secret_token` and `allowed_updates` including `chat_member`, which Telegram only sends when listed explicitly), `setMyCommands`, and the Mini App menu button. Re-runnable.

## 5. Verify
- `GET /api/health` → `telegramBot`, `telegramWebhookSecret`, `telegramEventsChat` all `configured`.
- DM the bot `/start` → welcome + "Open StrangersMeetup" button.
- `/events`, `/mybookings`, `/membership`, `/report test`, `/help`, `/terms`, `/paysupport` all answer.
- Admin: add yourself via `ADMIN_BOOTSTRAP_TELEGRAM_ID` (your numeric Telegram id) and open `/admin`.

## What the bot does
| Trigger | Behaviour |
|---|---|
| `/start` | Welcome + Mini App button. `start=event_<slug>` shows that event; `start=booking_<id>` re-issues your invite; `start=alerts` opts in to new-event alerts (`/stopalerts` to opt out). |
| Paid booking (verified webhook) | DM with event details + single-use 24h invite to the event chat. |
| Stars membership paid | DM + invite to tier chat. Renewals extend expiry (DM, no new invite). |
| 3 days before expiry | Reminder DM. |
| Expiry (+1h grace) | Removed from tier chat (ban then unban — not a permanent ban) + DM. |
| Someone joins with another person's invite | Removed automatically; invite revoked; audit log entry. |
| `/report <text>` | Stored in `reports`, visible in admin. |
