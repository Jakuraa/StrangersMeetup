# Preview login: two Telegram bots, one login domain each

**Status:** config only. No code change was needed; this records which env names the code reads and the exact owner steps.
**Why:** a Telegram bot's login is bound to the domain(s) registered with @BotFather. Preview and Production live on different hosts, so they need **two bots**. Sharing the production bot with Preview would also let Preview message real users.

| | Production | Preview |
|---|---|---|
| Bot | production bot (e.g. `@NightlifezBot`) | **separate test bot** (e.g. `@NightlifezTestBot`) |
| Login domain (`/setdomain` + Web Login allowed URLs) | `nightlifez.com` | `strangersmeetup-git-launch-mvp-jakuraa.vercel.app` (the **stable branch alias** for `launch-mvp`) |
| Callback | `https://nightlifez.com/auth/telegram/callback` | `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app/auth/telegram/callback` |

Use the branch alias, never a per-deployment URL (`strangersmeetup-<hash>-jakuraa.vercel.app`): those change on every push and would break login after each deploy.

## What the code reads (verified 2026-11-10)

| Purpose | Env name(s) | Where | Preview behaviour |
|---|---|---|---|
| Bot token (sending, webhook) | `PREVIEW_TELEGRAM_BOT_TOKEN`, else `TELEGRAM_TEST_BOT_TOKEN` | `lib/config.js` `botToken()` | When `VERCEL_ENV=preview` **only** these are used. `TELEGRAM_BOT_TOKEN` is ignored unless `ALLOW_PREVIEW_TELEGRAM=true` (keep that unset). No valid token means Telegram sending is disabled on Preview (fail-closed). |
| Bot username (login button, deep links) | `TELEGRAM_BOT_USERNAME` | `lib/config.js` `botUsername()` | Same name in every environment, so set a **Preview-scoped value** = the test bot's username. |
| Login (OIDC) client | `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET` | `lib/telegram/auth.js` | Same names in every environment, so set **Preview-scoped values** = the test bot's Web Login client ID/secret. The ID token `aud` must equal this client ID. |
| Callback base URL | `PREVIEW_PUBLIC_SITE_URL`, else `VERCEL_URL` | `lib/config.js` `siteUrl()`, `lib/handlers/auth.js` `redirectUri()` | **Must be set** to `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app`. Otherwise the callback uses the per-deployment `VERCEL_URL`, which never matches the bot's registered domain. |
| Sessions | `SESSION_SECRET` (≥ 32 chars) | `lib/session.js` | Without it every authenticated route returns 503. This is why Preview has never authenticated a user. Use a value different from Production. |
| First super_admin | `ADMIN_BOOTSTRAP_TELEGRAM_ID` | `lib/handlers/admin.js` | Owner's numeric Telegram user ID. The first visit to `/admin` by that user bootstraps `super_admin` and writes an audit row. |
| QR ticket signing | `TICKET_SECRET`, else `SESSION_SECRET` | `lib/services/tickets.js` | Optional on Preview, because `SESSION_SECRET` covers it. |

Production reads `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_LOGIN_CLIENT_ID/SECRET` and `PUBLIC_SITE_URL=https://nightlifez.com`, all Production-scoped.

## Owner steps (in order)

1. **Create the test bot:** @BotFather → `/newbot` → e.g. `NightlifezTestBot`. Copy its token.
2. **Bind the test bot's login domain:**
   - `/setdomain` → test bot → `strangersmeetup-git-launch-mvp-jakuraa.vercel.app`
   - Bot Settings → Web Login → allowed URLs: `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app` and `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app/auth/telegram/callback`. Copy the **Client ID** and **Client Secret**.
3. **Vercel → Settings → Environment Variables, scope = Preview** (optionally restricted to branch `launch-mvp`):
   - `PREVIEW_TELEGRAM_BOT_TOKEN` = test bot token
   - `TELEGRAM_BOT_USERNAME` = test bot username (no `@`)
   - `TELEGRAM_LOGIN_CLIENT_ID` / `TELEGRAM_LOGIN_CLIENT_SECRET` = the test bot's values
   - `PREVIEW_PUBLIC_SITE_URL` = `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app`
   - `SESSION_SECRET` = `openssl rand -hex 32` (a Preview-only value)
   - `ADMIN_BOOTSTRAP_TELEGRAM_ID` = your numeric Telegram ID
   - Confirm **unset** on Preview: `ALLOW_PREVIEW_TELEGRAM`, `ENABLE_LIVE_PAYMENTS`, `UPI_CHECKOUT_ENABLED`, `ALLOW_PREVIEW_PAID_CHECKOUT`.
4. **Production bot (at launch, not now):** `/setdomain` → production bot → `nightlifez.com`; Web Login allowed URLs → `https://nightlifez.com` and `https://nightlifez.com/auth/telegram/callback`.
5. **Redeploy** the `launch-mvp` Preview (env changes apply only to new deployments).
6. **Check:** `curl -s https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app/api/health` (with the protection-bypass header if Deployment Protection is on). `session`, `telegramBot` and `telegramLogin` should read `configured`.
7. *(Optional, enables an agent-run smoke)* Vercel → Settings → Deployment Protection → **Protection Bypass for Automation**. Share the secret through a channel you trust; the agent sends it as `x-vercel-protection-bypass`.
