-- migrations/027_master_auth_onboarding_neon.sql
-- Master Auth, Onboarding, Community Growth & City Directory Expansion.
-- Additive, idempotent, backward-compatible migration.

-- 1. Ensure user_gender enum includes 'self_describe'
DO $$ BEGIN
  ALTER TYPE user_gender ADD VALUE IF NOT EXISTS 'self_describe';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Add gender_custom for self-describe gender details
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender_custom TEXT;

-- 3. Table for user-confirmed community channel joins
CREATE TABLE IF NOT EXISTS member_community_joins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL, -- 'telegram', 'whatsapp_channel', 'instagram'
  confirmed    BOOLEAN NOT NULL DEFAULT true,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT,
  UNIQUE (user_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_member_community_joins_user ON member_community_joins(user_id);
CREATE INDEX IF NOT EXISTS idx_member_community_joins_channel ON member_community_joins(channel);

-- 4. Reconcile legacy aliases and prevent duplicate canonical records
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM location_cities WHERE slug = 'thiruvananthapuram') THEN
    IF NOT EXISTS (SELECT 1 FROM location_cities WHERE slug = 'trivandrum') THEN
      UPDATE location_cities
      SET slug = 'trivandrum', name = 'Trivandrum', aliases = ARRAY['Thiruvananthapuram', 'TRV']
      WHERE slug = 'thiruvananthapuram';
    ELSE
      UPDATE events SET city_id = (SELECT id FROM location_cities WHERE slug = 'trivandrum')
      WHERE city_id = (SELECT id FROM location_cities WHERE slug = 'thiruvananthapuram');
      UPDATE venues SET city_id = (SELECT id FROM location_cities WHERE slug = 'trivandrum')
      WHERE city_id = (SELECT id FROM location_cities WHERE slug = 'thiruvananthapuram');
      UPDATE location_localities SET city_id = (SELECT id FROM location_cities WHERE slug = 'trivandrum')
      WHERE city_id = (SELECT id FROM location_cities WHERE slug = 'thiruvananthapuram');
      DELETE FROM location_cities WHERE slug = 'thiruvananthapuram';
    END IF;
  END IF;
END $$;

-- 5. Expanded Major Indian Event Markets into location_cities (49 unique canonical cities)
-- Uses state_code lookups from location_states (all 36 states/UTs seeded in 013).
INSERT INTO location_cities (slug, name, state_id, lat, lng, aliases, market_tier, verified, is_discovery_active, active)
VALUES
  -- South India (18 canonical markets)
  ('chennai', 'Chennai',
   (SELECT id FROM location_states WHERE state_code = 'TN'),
   13.0827, 80.2707, ARRAY['Madras', 'MAA', 'Singara Chennai'], 'primary_market', true, true, true),
  ('bengaluru', 'Bengaluru',
   (SELECT id FROM location_states WHERE state_code = 'KA'),
   12.9716, 77.5946, ARRAY['Bangalore', 'BLR', 'Bengaluru Urban'], 'primary_market', true, true, true),
  ('hyderabad', 'Hyderabad',
   (SELECT id FROM location_states WHERE state_code = 'TS'),
   17.3850, 78.4867, ARRAY['HYD', 'Secunderabad', 'Cyberabad'], 'primary_market', true, true, true),
  ('kochi', 'Kochi',
   (SELECT id FROM location_states WHERE state_code = 'KL'),
   9.9312, 76.2673, ARRAY['Cochin', 'Ernakulam', 'COK'], 'primary_market', true, true, true),
  ('coimbatore', 'Coimbatore',
   (SELECT id FROM location_states WHERE state_code = 'TN'),
   11.0168, 76.9558, ARRAY['Kovai', 'CJB'], 'primary_market', true, true, true),
  ('puducherry', 'Puducherry',
   (SELECT id FROM location_states WHERE state_code = 'PY'),
   11.9416, 79.8083, ARRAY['Pondicherry', 'Pondi', 'Pondy', 'PNY'], 'primary_market', true, true, true),
  ('madurai', 'Madurai',
   (SELECT id FROM location_states WHERE state_code = 'TN'),
   9.9252, 78.1198, ARRAY['IXM', 'Temple City'], 'expansion_market', true, true, true),
  ('trivandrum', 'Trivandrum',
   (SELECT id FROM location_states WHERE state_code = 'KL'),
   8.5241, 76.9366, ARRAY['Thiruvananthapuram', 'TRV'], 'expansion_market', true, true, true),
  ('kozhikode', 'Kozhikode',
   (SELECT id FROM location_states WHERE state_code = 'KL'),
   11.2588, 75.7804, ARRAY['Calicut', 'CCJ'], 'expansion_market', true, true, true),
  ('mysuru', 'Mysuru',
   (SELECT id FROM location_states WHERE state_code = 'KA'),
   12.2958, 76.6394, ARRAY['Mysore', 'MYQ'], 'expansion_market', true, true, true),
  ('mangaluru', 'Mangaluru',
   (SELECT id FROM location_states WHERE state_code = 'KA'),
   12.9141, 74.8560, ARRAY['Mangalore', 'IXE', 'Kudla'], 'expansion_market', true, true, true),
  ('vijayawada', 'Vijayawada',
   (SELECT id FROM location_states WHERE state_code = 'AP'),
   16.5062, 80.6480, ARRAY['VGA', 'Bezawada'], 'expansion_market', true, true, true),
  ('visakhapatnam', 'Visakhapatnam',
   (SELECT id FROM location_states WHERE state_code = 'AP'),
   17.6868, 83.2185, ARRAY['Vizag', 'VTZ', 'Waltair'], 'expansion_market', true, true, true),
  ('tiruchirappalli', 'Tiruchirappalli',
   (SELECT id FROM location_states WHERE state_code = 'TN'),
   10.7905, 78.7047, ARRAY['Trichy', 'TRZ'], 'expansion_market', true, true, true),
  ('salem', 'Salem',
   (SELECT id FROM location_states WHERE state_code = 'TN'),
   11.6643, 78.1460, ARRAY['SXV', 'Mango City'], 'expansion_market', true, true, true),
  ('warangal', 'Warangal',
   (SELECT id FROM location_states WHERE state_code = 'TS'),
   17.9689, 79.5941, ARRAY['WGL', 'Tri-city', 'Orugallu'], 'expansion_market', true, true, true),
  ('guntur', 'Guntur',
   (SELECT id FROM location_states WHERE state_code = 'AP'),
   16.3067, 80.4365, ARRAY['GNT', 'Chilli City'], 'expansion_market', true, true, true),
  ('hubli-dharwad', 'Hubli-Dharwad',
   (SELECT id FROM location_states WHERE state_code = 'KA'),
   15.3647, 75.1240, ARRAY['Hubballi', 'Dharwad', 'HBX'], 'expansion_market', true, true, true),

  -- West India (10 canonical markets)
  ('mumbai', 'Mumbai',
   (SELECT id FROM location_states WHERE state_code = 'MH'),
   19.0760, 72.8777, ARRAY['Bombay', 'BOM', 'Navi Mumbai', 'Thane'], 'primary_market', true, true, true),
  ('pune', 'Pune',
   (SELECT id FROM location_states WHERE state_code = 'MH'),
   18.5204, 73.8567, ARRAY['Poona', 'PNQ', 'Pimpri-Chinchwad'], 'primary_market', true, true, true),
  ('ahmedabad', 'Ahmedabad',
   (SELECT id FROM location_states WHERE state_code = 'GJ'),
   23.0225, 72.5714, ARRAY['Amdavad', 'AMD', 'Gandhinagar'], 'primary_market', true, true, true),
  ('goa', 'Goa / Panaji',
   (SELECT id FROM location_states WHERE state_code = 'GA'),
   15.4909, 73.8278, ARRAY['Panaji', 'Panjim', 'GOI', 'North Goa', 'South Goa'], 'primary_market', true, true, true),
  ('surat', 'Surat',
   (SELECT id FROM location_states WHERE state_code = 'GJ'),
   21.1702, 72.8311, ARRAY['STV', 'Diamond City'], 'expansion_market', true, true, true),
  ('vadodara', 'Vadodara',
   (SELECT id FROM location_states WHERE state_code = 'GJ'),
   22.3072, 73.1812, ARRAY['Baroda', 'BDQ'], 'expansion_market', true, true, true),
  ('nagpur', 'Nagpur',
   (SELECT id FROM location_states WHERE state_code = 'MH'),
   21.1458, 79.0882, ARRAY['NAG', 'Orange City'], 'expansion_market', true, true, true),
  ('nashik', 'Nashik',
   (SELECT id FROM location_states WHERE state_code = 'MH'),
   19.9975, 73.7898, ARRAY['Nasik', 'ISK', 'Wine Capital'], 'expansion_market', true, true, true),
  ('rajkot', 'Rajkot',
   (SELECT id FROM location_states WHERE state_code = 'GJ'),
   22.3039, 70.8022, ARRAY['RAJ', 'Chitranagri'], 'expansion_market', true, true, true),
  ('kolhapur', 'Kolhapur',
   (SELECT id FROM location_states WHERE state_code = 'MH'),
   16.7050, 74.2433, ARRAY['KLH', 'Historical Capital'], 'expansion_market', true, true, true),

  -- North India (13 canonical markets)
  ('delhi-ncr', 'Delhi NCR',
   (SELECT id FROM location_states WHERE state_code = 'DL'),
   28.6139, 77.2090, ARRAY['Delhi', 'New Delhi', 'DEL', 'NCR'], 'primary_market', true, true, true),
  ('chandigarh', 'Chandigarh',
   (SELECT id FROM location_states WHERE state_code = 'CH'),
   30.7333, 76.7794, ARRAY['IXC', 'Mohali', 'Panchkula', 'Tricity'], 'primary_market', true, true, true),
  ('jaipur', 'Jaipur',
   (SELECT id FROM location_states WHERE state_code = 'RJ'),
   26.9124, 75.7873, ARRAY['JAI', 'Pink City'], 'primary_market', true, true, true),
  ('gurugram', 'Gurugram',
   (SELECT id FROM location_states WHERE state_code = 'HR'),
   28.4595, 77.0266, ARRAY['Gurgaon', 'Millennium City'], 'expansion_market', true, true, true),
  ('noida', 'Noida',
   (SELECT id FROM location_states WHERE state_code = 'UP'),
   28.5355, 77.3910, ARRAY['Greater Noida'], 'expansion_market', true, true, true),
  ('lucknow', 'Lucknow',
   (SELECT id FROM location_states WHERE state_code = 'UP'),
   26.8467, 80.9462, ARRAY['LKO', 'City of Nawabs'], 'expansion_market', true, true, true),
  ('dehradun', 'Dehradun',
   (SELECT id FROM location_states WHERE state_code = 'UK'),
   30.3165, 78.0322, ARRAY['DED', 'Doon'], 'expansion_market', true, true, true),
  ('amritsar', 'Amritsar',
   (SELECT id FROM location_states WHERE state_code = 'PB'),
   31.6340, 74.8723, ARRAY['ATQ', 'Golden City'], 'expansion_market', true, true, true),
  ('ludhiana', 'Ludhiana',
   (SELECT id FROM location_states WHERE state_code = 'PB'),
   30.9010, 75.8573, ARRAY['LUH'], 'expansion_market', true, true, true),
  ('jammu', 'Jammu',
   (SELECT id FROM location_states WHERE state_code = 'JK'),
   32.7266, 74.8570, ARRAY['IXJ', 'City of Temples'], 'expansion_market', true, true, true),
  ('agra', 'Agra',
   (SELECT id FROM location_states WHERE state_code = 'UP'),
   27.1767, 78.0081, ARRAY['AGR', 'Taj City'], 'expansion_market', true, true, true),
  ('varanasi', 'Varanasi',
   (SELECT id FROM location_states WHERE state_code = 'UP'),
   25.3176, 82.9739, ARRAY['Banaras', 'Kashi', 'VNS', 'Holy City'], 'expansion_market', true, true, true),
  ('kanpur', 'Kanpur',
   (SELECT id FROM location_states WHERE state_code = 'UP'),
   26.4499, 80.3319, ARRAY['KNU', 'Cawnpore', 'Leather City'], 'expansion_market', true, true, true),

  -- East & Central India (8 canonical markets)
  ('kolkata', 'Kolkata',
   (SELECT id FROM location_states WHERE state_code = 'WB'),
   22.5726, 88.3639, ARRAY['Calcutta', 'CCU', 'City of Joy'], 'primary_market', true, true, true),
  ('bhubaneswar', 'Bhubaneswar',
   (SELECT id FROM location_states WHERE state_code = 'OD'),
   20.2961, 85.8245, ARRAY['BBI', 'Bhubaneshwar', 'Temple City'], 'expansion_market', true, true, true),
  ('guwahati', 'Guwahati',
   (SELECT id FROM location_states WHERE state_code = 'AS'),
   26.1445, 91.7362, ARRAY['GAU', 'Gauhati', 'Gateway to Northeast'], 'expansion_market', true, true, true),
  ('patna', 'Patna',
   (SELECT id FROM location_states WHERE state_code = 'BR'),
   25.5941, 85.1376, ARRAY['PAT', 'Pataliputra'], 'expansion_market', true, true, true),
  ('ranchi', 'Ranchi',
   (SELECT id FROM location_states WHERE state_code = 'JH'),
   23.3441, 85.3096, ARRAY['IXR', 'City of Waterfalls'], 'expansion_market', true, true, true),
  ('raipur', 'Raipur',
   (SELECT id FROM location_states WHERE state_code = 'CG'),
   21.2514, 81.6296, ARRAY['RPR'], 'expansion_market', true, true, true),
  ('indore', 'Indore',
   (SELECT id FROM location_states WHERE state_code = 'MP'),
   22.7196, 75.8577, ARRAY['IDR', 'Cleanest City'], 'expansion_market', true, true, true),
  ('bhopal', 'Bhopal',
   (SELECT id FROM location_states WHERE state_code = 'MP'),
   23.2599, 77.4126, ARRAY['BHO', 'City of Lakes'], 'expansion_market', true, true, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  state_id = EXCLUDED.state_id,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  aliases = EXCLUDED.aliases,
  market_tier = EXCLUDED.market_tier,
  verified = true,
  -- Preserve administrator city toggles across migration re-runs
  is_discovery_active = location_cities.is_discovery_active,
  active = location_cities.active,
  updated_at = now();
