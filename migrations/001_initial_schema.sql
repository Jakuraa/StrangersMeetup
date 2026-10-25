-- StrangersMeetup Database Migration: 001_initial_schema.sql
-- Compatible with PostgreSQL (Hatchable) and SQLite (Local test harness)

-- 1. Members / Telegram Identity Links
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    telegram_user_id BIGINT UNIQUE,
    telegram_username TEXT,
    first_name TEXT,
    last_name TEXT,
    age_declared INTEGER NOT NULL,
    date_of_birth TEXT NOT NULL,
    state_code TEXT NOT NULL,
    terms_accepted_at TIMESTAMP NOT NULL,
    is_blocked BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Membership Tiers
CREATE TABLE IF NOT EXISTS membership_tiers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    inr_target INTEGER NOT NULL,
    stars_price INTEGER NOT NULL,
    billing_period_seconds INTEGER NOT NULL DEFAULT 2592000,
    channel_id TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    benefits_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Subscription Records
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    telegram_user_id BIGINT NOT NULL,
    tier_id TEXT NOT NULL REFERENCES membership_tiers(id),
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, CANCELLED, EXPIRED, REVOKED
    billing_period_seconds INTEGER NOT NULL DEFAULT 2592000,
    starts_at TIMESTAMP,
    expires_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    is_recurring BOOLEAN DEFAULT 1,
    last_payment_charge_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subs_member ON subscriptions(member_id);
CREATE INDEX IF NOT EXISTS idx_subs_tg_user ON subscriptions(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at);

-- 4. Payment Transactions
CREATE TABLE IF NOT EXISTS payment_transactions (
    id TEXT PRIMARY KEY,
    subscription_id TEXT REFERENCES subscriptions(id),
    telegram_user_id BIGINT NOT NULL,
    telegram_payment_charge_id TEXT NOT NULL UNIQUE,
    provider_payment_charge_id TEXT,
    tier_id TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'XTR',
    total_amount INTEGER NOT NULL,
    is_recurring BOOLEAN DEFAULT 0,
    is_first_recurrence BOOLEAN DEFAULT 0,
    subscription_expiration_date TIMESTAMP,
    invoice_payload TEXT,
    raw_payload_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pay_charge ON payment_transactions(telegram_payment_charge_id);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payment_transactions(telegram_user_id);

-- 5. Access Entitlements (Tier-Specific Channel Access Links)
CREATE TABLE IF NOT EXISTS access_entitlements (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
    member_id TEXT REFERENCES members(id),
    telegram_user_id BIGINT NOT NULL,
    tier_id TEXT NOT NULL REFERENCES membership_tiers(id),
    channel_id TEXT NOT NULL,
    invite_link TEXT NOT NULL,
    invite_link_name TEXT,
    is_single_use BOOLEAN DEFAULT 1,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, REVOKED, EXPIRED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entitlements_sub ON access_entitlements(subscription_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_tg_user ON access_entitlements(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_channel ON access_entitlements(channel_id);

-- 6. Webhook Idempotency & Raw Event Records
CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    update_id BIGINT UNIQUE NOT NULL,
    event_type TEXT NOT NULL, -- pre_checkout_query, successful_payment, chat_member_updated
    idempotency_key TEXT UNIQUE,
    telegram_user_id BIGINT,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'SUCCESS', -- SUCCESS, FAILED, IGNORED, DUPLICATE
    error_message TEXT,
    raw_payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_update ON webhook_events(update_id);
CREATE INDEX IF NOT EXISTS idx_webhook_idempotency ON webhook_events(idempotency_key);

-- 7. Security Audit & Compliance Events
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL, -- SYSTEM, USER, ADMIN, WEBHOOK
    actor_id TEXT,
    ip_hash TEXT,
    user_agent_hash TEXT,
    details_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Privacy-Conscious Conversion Funnel Analytics
CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tier_id TEXT,
    region_code TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    metadata_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
