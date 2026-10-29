-- 010_superprofile_checkout.sql — SuperProfile as the only checkout for tickets (additive).
-- Buyers pay on SuperProfile-hosted pages; SuperProfile notifications (via Zapier/Pabbly) reach
-- /api/webhooks/superprofile and land in external_orders. The legacy ticket `payments` rows and the
-- razorpay/cashfree enum labels from 004 stay (Postgres cannot drop enum labels); no code uses them.

DO $$ BEGIN
  CREATE TYPE checkout_mode AS ENUM ('none', 'superprofile', 'free');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- events ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS superprofile_url TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS superprofile_product_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS checkout_mode checkout_mode NOT NULL DEFAULT 'none';
-- https and a superprofile.bio host only (apex or subdomain; no userinfo, no look-alike hosts).
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT events_superprofile_url_host
    CHECK (superprofile_url IS NULL OR superprofile_url ~* '^https://([a-z0-9-]+\.)*superprofile\.bio(:443)?([/?#].*)?$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT events_superprofile_mode
    CHECK (checkout_mode <> 'superprofile' OR superprofile_url IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_superprofile_product
  ON events (lower(superprofile_product_id)) WHERE superprofile_product_id IS NOT NULL;

-- ---------- membership tiers (superprofile_url + superprofile_product_ref came with 006) ----------
DO $$ BEGIN
  ALTER TABLE membership_tiers ADD CONSTRAINT tier_superprofile_url_host
    CHECK (superprofile_url IS NULL OR superprofile_url ~* '^https://([a-z0-9-]+\.)*superprofile\.bio(:443)?([/?#].*)?$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- bookings ----------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'site';
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_source CHECK (source IN ('site', 'superprofile'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- external: paid on SuperProfile (confirmed by a matched notification, never by a client redirect).
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_mode;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_mode CHECK (payment_mode IS NULL OR payment_mode IN ('free', 'provider', 'external'));

-- ---------- users: claim flow ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;             -- keyed hash of the buyer email, set on a verified claim
ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_prompt_until TIMESTAMPTZ; -- bot is waiting for an order id until then
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users (email_hash) WHERE email_hash IS NOT NULL;

-- ---------- checkout intents: carry the buyer across to SuperProfile ----------
CREATE TABLE IF NOT EXISTS checkout_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             TEXT NOT NULL,
  user_id         UUID REFERENCES users(id),           -- NULL: anonymous click
  event_id        UUID REFERENCES events(id),
  tier_id         UUID REFERENCES membership_tiers(id),
  ticket_type_id  UUID REFERENCES ticket_types(id),
  qty             INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT checkout_intents_target CHECK ((event_id IS NULL) <> (tier_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_intents_ref ON checkout_intents (ref);
CREATE INDEX IF NOT EXISTS idx_checkout_intents_expiry ON checkout_intents (expires_at);

-- ---------- external orders: every SuperProfile order we hear about ----------
DO $$ BEGIN
  CREATE TYPE external_order_status AS ENUM ('paid', 'refunded', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS external_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            TEXT NOT NULL DEFAULT 'superprofile' CHECK (provider = 'superprofile'),
  order_id            TEXT NOT NULL,
  product_id          TEXT,
  event_id            UUID REFERENCES events(id),
  amount_paise        BIGINT CHECK (amount_paise IS NULL OR amount_paise >= 0),
  currency            TEXT NOT NULL DEFAULT 'INR',
  qty                 INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
  status              external_order_status NOT NULL DEFAULT 'paid',
  buyer_email_hash    TEXT,
  buyer_phone_hash    TEXT,
  ref                 TEXT,
  matched_booking_id  UUID REFERENCES bookings(id),
  match_state         TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_state IN ('matched', 'unmatched', 'flagged')),
  flag_reason         TEXT,      -- unknown_product | amount_mismatch | duplicate_booking | refund_after_check_in | ...
  raw_minimal         JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_external_orders_order UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS idx_external_orders_product ON external_orders (product_id);
CREATE INDEX IF NOT EXISTS idx_external_orders_state ON external_orders (match_state, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_orders_email ON external_orders (buyer_email_hash) WHERE buyer_email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_orders_booking ON external_orders (matched_booking_id) WHERE matched_booking_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_external_orders_updated ON external_orders;
CREATE TRIGGER trg_external_orders_updated BEFORE UPDATE ON external_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
