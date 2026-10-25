-- 004_payments_entitlements_admin.sql — payments, idempotency, membership, invites, leads, admin, outbox.

DO $$ BEGIN
  CREATE TYPE payment_provider AS ENUM ('razorpay', 'cashfree', 'telegram_stars');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE payment_purpose AS ENUM ('ticket', 'membership');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('created', 'paid', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE entitlement_status AS ENUM ('active', 'grace', 'expired', 'revoked', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE lead_type AS ENUM ('partner', 'host', 'venue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'closed', 'spam');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE admin_role AS ENUM ('super_admin', 'event_manager', 'moderator', 'finance', 'support');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             payment_provider NOT NULL,
  provider_txn_id      TEXT NOT NULL,          -- order / payment-link id / Stars charge id
  provider_payment_id  TEXT,                   -- captured payment id (used for refunds)
  purpose              payment_purpose NOT NULL,
  user_id              UUID REFERENCES users(id),
  booking_id           UUID REFERENCES bookings(id),
  amount               BIGINT NOT NULL CHECK (amount > 0),  -- paise for INR, stars for XTR
  currency             TEXT NOT NULL CHECK (currency IN ('INR', 'XTR')),
  status               payment_status NOT NULL DEFAULT 'created',
  is_test              BOOLEAN NOT NULL DEFAULT true,
  checkout_url         TEXT,
  failure_reason       TEXT,
  raw_ref              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- minimal: ids + status only
  paid_at              TIMESTAMPTZ,
  refunded_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_provider_txn UNIQUE (provider, provider_txn_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id);
DROP TRIGGER IF EXISTS trg_payments_updated ON payments;
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT fk_bookings_payment FOREIGN KEY (payment_id) REFERENCES payments(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Webhook idempotency: a (provider, event_id) pair is processed at most once.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  result        TEXT,
  CONSTRAINT uq_webhook_events UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS membership_tiers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  benefits          JSONB NOT NULL DEFAULT '[]'::jsonb,
  stars_amount      INTEGER CHECK (stars_amount IS NULL OR stars_amount > 0),  -- NULL until owner sets
  period_seconds    INTEGER NOT NULL DEFAULT 2592000,
  telegram_chat_id  BIGINT,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_tiers_updated ON membership_tiers;
CREATE TRIGGER trg_tiers_updated BEFORE UPDATE ON membership_tiers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS entitlements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  tier_id              UUID NOT NULL REFERENCES membership_tiers(id),
  status               entitlement_status NOT NULL DEFAULT 'active',
  starts_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  last_payment_id      UUID REFERENCES payments(id),
  reminder_sent_for    TIMESTAMPTZ,  -- expires_at value a reminder was already sent for
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlements_live
  ON entitlements (user_id, tier_id) WHERE status IN ('active', 'grace', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_entitlements_expiry ON entitlements (status, expires_at);
DROP TRIGGER IF EXISTS trg_entitlements_updated ON entitlements;
CREATE TRIGGER trg_entitlements_updated BEFORE UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS invite_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id  UUID REFERENCES entitlements(id),
  booking_id      UUID REFERENCES bookings(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  chat_id         BIGINT NOT NULL,
  link            TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invite_has_owner CHECK ((entitlement_id IS NULL) <> (booking_id IS NULL))
);

CREATE TABLE IF NOT EXISTS leads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        lead_type NOT NULL,
  payload     JSONB NOT NULL,
  status      lead_status NOT NULL DEFAULT 'new',
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC);
DROP TRIGGER IF EXISTS trg_leads_updated ON leads;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS admin_users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id  BIGINT UNIQUE,
  email             TEXT UNIQUE,
  role              admin_role NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_identity CHECK (telegram_user_id IS NOT NULL OR email IS NOT NULL)
);
DROP TRIGGER IF EXISTS trg_admin_users_updated ON admin_users;
CREATE TRIGGER trg_admin_users_updated BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS audit_log (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT,
  details  JSONB NOT NULL DEFAULT '{}'::jsonb,
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);

-- Outbox for bot side effects (DMs + invites); sent after commit, retried by cron.
CREATE TABLE IF NOT EXISTS notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL,
  user_id          UUID REFERENCES users(id),
  booking_id       UUID REFERENCES bookings(id),
  entitlement_id   UUID REFERENCES entitlements(id),
  dedupe_key       TEXT UNIQUE NOT NULL,
  status           notification_status NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications (status, next_attempt_at);

-- Basic funnel analytics only (no PII).
CREATE TABLE IF NOT EXISTS analytics_events (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  visitor_uuid  UUID,
  event_id      UUID,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_name_at ON analytics_events (name, at);

-- Membership tiers: structure only. Prices NULL until the owner sets them; no "popular" flags.
INSERT INTO membership_tiers (code, name, benefits, sort_order) VALUES
  ('tier_1', 'Insider',     '["Access to the Insider private Telegram group"]'::jsonb, 1),
  ('tier_2', 'Social Plus', '["Access to the Social Plus private Telegram group"]'::jsonb, 2),
  ('tier_3', 'VIP Circle',  '["Access to the VIP Circle private Telegram group"]'::jsonb, 3)
ON CONFLICT (code) DO NOTHING;
