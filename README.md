# StrangersMeetup — Implementation & Setup Guide

StrangersMeetup is an adults-only (21+) dating and social-discovery membership experience for discerning adults in:
- **Tamil Nadu**
- **Puducherry**
- **Karnataka**
- **Kerala**

This repository contains the complete full-stack implementation: a premium mobile-first landing page, three configuration-driven monthly membership tiers, server-side Telegram Stars (`XTR`) recurring billing adapter, cryptographic payload signing, webhook handlers with idempotency protection, and tier-specific private channel access provisioning.

---

## 1. Architecture Overview

- **Frontend:** Zero-build native ES modules, semantic HTML5, accessible modern dialogs (`<dialog>`), WCAG AA compliant obsidian-teal visual theme, mobile navigation, and persistent tier selector.
- **Backend:** Zero-dependency Node.js HTTP server following Hatchable file-system conventions (`api/*`, `public/*`, `migrations/*`).
- **Database:** Unified query engine supporting managed PostgreSQL (Hatchable) and native SQLite (`node:sqlite`) for local development and testing.
- **Payment Rail:** Server-side Telegram Stars recurring subscription adapter using official Bot API (`createInvoiceLink`, `answerPreCheckoutQuery`, `createChatInviteLink`, `banChatMember`/`unbanChatMember`).
- **Idempotency & Security:** Constant-time webhook secret authentication, HMAC-SHA256 invoice tamper protection, and database charge ID uniqueness to prevent replay attacks or duplicate entitlements.

---

## 2. Directory Structure

```
strangersmeetup/
├── hatchable.toml               # Platform manifest, cron schedule & declared secrets
├── package.json                 # Project manifest & test scripts
├── server.js                    # Lightweight zero-build HTTP server & API router
├── .env.example                 # Configuration template with required environment variables
├── .gitignore                   # Ignores secrets, database files, and local logs
├── config/
│   └── tiers.json               # Configuration-driven tier definitions, benefits & pricing
├── migrations/
│   ├── 001_initial_schema.sql   # Postgres & SQLite compatible schema migration
│   └── seed.sql                 # Seed script for initial tier definitions
├── lib/
│   ├── config.js                # Unified configuration & secrets reader
│   ├── db.js                    # Database interface (PostgreSQL / SQLite)
│   ├── logger.js                # Structured JSON logger with secret redaction
│   ├── telegram.js              # Server-side Telegram Bot API adapter & HMAC signer
│   └── entitlements.js          # Pre-checkout validator & entitlement lifecycle engine
├── api/
│   ├── tiers.js                 # GET  /api/tiers (Public tier list & pricing)
│   ├── checkout.js              # POST /api/checkout (Generates Stars invoice link)
│   ├── webhook.js               # POST /api/webhook (Pre-checkout queries & payments)
│   ├── entitlements.js          # GET  /api/entitlements (Subscription & invite link query)
│   ├── cancel.js                # POST /api/cancel (Cancellation flow instructions)
│   └── analytics.js             # POST /api/analytics (Privacy-conscious funnel telemetry)
├── public/
│   ├── index.html               # 21+ Age Gate, Hero, Tiers, Regions, Safety, FAQ & Footer
│   ├── terms.html               # Terms of Service with statutory placeholders
│   ├── privacy.html             # Privacy Policy (DPDPA 2023 aligned)
│   ├── community.html           # Community Rules & Anti-harassment standard
│   ├── safety.html              # Dating Safety Guide & Indian Emergency Helplines
│   ├── billing.html             # Billing, Telegram Stars & Cancellation Guide
│   ├── grievance.html           # IT Rules 2021 Statutory Grievance Redressal Mechanism
│   ├── css/
│   │   └── styles.css           # Premium obsidian/teal luxury design system
│   └── js/
│       └── app.js               # Age gate verification, checkout controller & analytics
├── test/
│   ├── age_gate.test.js         # Tests age gate boundaries (20 vs 21 vs 25) & geofencing
│   ├── checkout_and_tiers.test.js # Tests tier structure, 404 on unknown tiers, invoice gen
│   ├── webhook_idempotency.test.js # Tests secret token check, pre-checkout & idempotency
│   ├── entitlements.test.js     # Tests channel separation, expiry revocation & cancel API
│   └── security_and_secrets.test.js # Verifies no credentials leaked in public assets
└── scripts/
    └── lint.js                  # Integrity and schema validator
```

---

## 3. Step-by-Step Setup Instructions

### Step 3.1: Create Your Bot with @BotFather
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Choose a display name: `StrangersMeetup` (or your chosen brand name).
4. Choose a username ending in `bot` (e.g., `StrangersMeetupClubBot`).
5. BotFather will provide your **`TELEGRAM_BOT_TOKEN`** (format: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
6. Enable Telegram Stars on your bot:
   - Send `/mybots` to `@BotFather`.
   - Select your bot.
   - Go to **Bot Settings** > **Payments**.
   - Select **Telegram Stars** and accept developer payment terms.

### Step 3.2: Create the Three Private Telegram Channels
Create three separate private channels in your Telegram client:
1. **Insider Lounge:**
   - Name: `StrangersMeetup — Insider Lounge`
   - Type: **Private Channel**
2. **Social Plus Circle:**
   - Name: `StrangersMeetup — Social Plus Circle`
   - Type: **Private Channel**
3. **VIP Circle:**
   - Name: `StrangersMeetup — VIP Circle`
   - Type: **Private Channel**

### Step 3.3: Add Bot as Administrator to Each Channel
In each of the three private channels:
1. Open Channel Settings > **Administrators** > **Add Administrator**.
2. Search for your bot's username and add it.
3. Grant the bot the following minimum permission:
   - ✅ **Invite Users via Link** (required so the bot can generate single-use invite links).
   - ✅ **Ban Users** (required to revoke access when subscriptions expire).
4. Uncheck unnecessary permissions (Post Messages, Delete Messages, etc.) if desired.

### Step 3.4: Obtain Channel IDs
1. Forward any message from each channel to `@userinfobot` or `@raw_data_bot` on Telegram.
2. Note the channel ID (it will start with `-100`, e.g., `-1002489123456`).
3. Set the respective IDs:
   - `TELEGRAM_INSIDER_CHANNEL_ID`
   - `TELEGRAM_SOCIAL_PLUS_CHANNEL_ID`
   - `TELEGRAM_VIP_CHANNEL_ID`

### Step 3.5: Set Up the Webhook
Once the application is hosted with a public HTTPS URL (e.g., via Hatchable at `https://your-app.hatchable.site`):
Generate a random secret token (16-32 characters), e.g.:
```bash
WEBHOOK_SECRET=$(openssl rand -hex 16)
echo $WEBHOOK_SECRET
```
Register the webhook with Telegram using `curl`:
```bash
curl -F "url=https://your-app.hatchable.site/api/webhook" \
     -F "secret_token=YOUR_WEBHOOK_SECRET" \
     -F "allowed_updates=[\"pre_checkout_query\",\"message\"]" \
     https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
```

---

## 4. Local Testing & Verification

Run the lint check:
```bash
npm run lint
```

Run all 25 automated tests:
```bash
npm test
```

Start the local server:
```bash
npm start
```
Open `http://localhost:3000` in your browser.

---

## 5. Review & Approval Checkpoints

Before launching live traffic:
1. **Commercial Stars Validation:** Review and sign off on the target Stars denominations in [`config/tiers.json`](file:///Users/pradeepjakuraa/strangersmeetup/config/tiers.json):
   - Insider: 75 Stars / 30 days
   - Social Plus: 250 Stars / 30 days
   - VIP Circle: 500 Stars / 30 days
2. **Legal Placeholders:** Populate the statutory placeholders in:
   - [`public/grievance.html`](file:///Users/pradeepjakuraa/strangersmeetup/public/grievance.html) (Grievance Officer Name, Email, Address)
   - [`public/terms.html`](file:///Users/pradeepjakuraa/strangersmeetup/public/terms.html) (Operating Legal Entity Name)
   - [`public/privacy.html`](file:///Users/pradeepjakuraa/strangersmeetup/public/privacy.html) (Data Protection Desk Contact)
3. **Live Bot Credentials:** Supply `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and the three channel IDs in the hosting dashboard.
