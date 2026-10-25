-- StrangersMeetup Seed Data: seed.sql

INSERT INTO membership_tiers (id, name, slug, inr_target, stars_price, billing_period_seconds, channel_id, is_active, benefits_json)
VALUES 
(
  'insider',
  'Insider',
  'insider',
  149,
  75,
  2592000,
  'TELEGRAM_INSIDER_CHANNEL_ID',
  1,
  '[{"text":"Access to the Insider private Telegram channel","status":"active"},{"text":"Verified 21+ adults-only regional community updates","status":"active"},{"text":"Curated member social activity notifications","status":"active"},{"text":"Entry-level member experiences & open circles","status":"active"},{"text":"Direct community moderation & report tools","status":"active"},{"text":"Interactive member discovery polling","status":"planned"}]'
),
(
  'social-plus',
  'Social Plus',
  'social-plus',
  499,
  250,
  2592000,
  'TELEGRAM_SOCIAL_PLUS_CHANNEL_ID',
  1,
  '[{"text":"Access to the Social Plus private Telegram channel","status":"active"},{"text":"All Insider member benefits included","status":"active"},{"text":"Priority RSVP & reservations for public adult meetups","status":"active"},{"text":"Premium curated social mixers and themed evenings","status":"active"},{"text":"Additional premium social discovery experiences","status":"active"},{"text":"Curated member introduction drops (bi-weekly)","status":"planned"}]'
),
(
  'vip-circle',
  'VIP Circle',
  'vip-circle',
  999,
  500,
  2592000,
  'TELEGRAM_VIP_CHANNEL_ID',
  1,
  '[{"text":"Access to the exclusive VIP Circle private Telegram channel","status":"active"},{"text":"All Social Plus & Insider privileges included","status":"active"},{"text":"Exclusive VIP-only salons and private gatherings","status":"active"},{"text":"Guaranteed priority access to limited-capacity member meetups","status":"active"},{"text":"Direct host concierge for meetup arrangements","status":"active"},{"text":"VIP member spotlight & private matching salons","status":"planned"}]'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  inr_target = EXCLUDED.inr_target,
  stars_price = EXCLUDED.stars_price,
  benefits_json = EXCLUDED.benefits_json;
