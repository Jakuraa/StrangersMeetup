-- migrations/024_event_promotional_campaigns.sql
-- Opt-in event promotion campaigns, audience filtering, approval workflows, and delivery logs.
-- Strictly additive and idempotent.

-- 1. Promotional Campaigns table
CREATE TABLE IF NOT EXISTS promotional_campaigns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_by_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organiser_org_id      UUID REFERENCES organisations(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  template_name         TEXT NOT NULL DEFAULT 'nightlifez_promotional_event_v1',
  channel               TEXT NOT NULL DEFAULT 'whatsapp',
  target_city           TEXT, -- null means all South Indian cities
  target_category       TEXT, -- null means all event categories
  status                TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'pending_approval', 'approved', 'sending', 'completed', 'cancelled', 'rejected'
  approved_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  estimated_recipients  INT NOT NULL DEFAULT 0,
  actual_recipients     INT NOT NULL DEFAULT 0,
  estimated_cost_paise  INT NOT NULL DEFAULT 0,
  actual_cost_paise     INT NOT NULL DEFAULT 0,
  template_variables    JSONB NOT NULL DEFAULT '{}'::jsonb,
  live_sending_enabled  BOOLEAN NOT NULL DEFAULT false,
  audit_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_event ON promotional_campaigns (event_id);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_org ON promotional_campaigns (organiser_org_id);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_status ON promotional_campaigns (status);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_created ON promotional_campaigns (created_at DESC);

-- 2. Campaign Recipients & Delivery Log table
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           UUID NOT NULL REFERENCES promotional_campaigns(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_destination TEXT NOT NULL, -- normalized phone number
  status                TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'dispatched', 'delivered', 'read', 'skipped_suppressed', 'skipped_no_consent', 'failed'
  notification_message_id UUID REFERENCES notification_messages(id) ON DELETE SET NULL,
  delivery_cost_paise   INT NOT NULL DEFAULT 80,
  error_reason          TEXT,
  dispatched_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_user ON campaign_recipients (user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients (status);
