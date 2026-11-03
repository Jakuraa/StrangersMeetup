-- 013_location_intelligence.sql — India location intelligence foundation based on official
-- Local Government Directory (LGD) identifiers. Country -> State/UT -> District -> City/Town -> Locality.
-- Additive only, guarded, re-runnable. Safe on fresh database and when upgrading from migration 012.

DO $$ BEGIN
  CREATE TYPE state_kind AS ENUM ('state', 'union_territory');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. States and Union Territories (All 28 States and 8 UTs with official LGD codes)
CREATE TABLE IF NOT EXISTS location_states (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL DEFAULT 'IN',
  lgd_code     INTEGER UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  type         state_kind NOT NULL,
  state_code   TEXT UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT true,
  source_url   TEXT NOT NULL DEFAULT 'https://lgdirectory.gov.in/',
  source_date  DATE NOT NULL DEFAULT '2024-01-01',
  verified     BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_states_type ON location_states (type, active);
DROP TRIGGER IF EXISTS trg_location_states_updated ON location_states;
CREATE TRIGGER trg_location_states_updated BEFORE UPDATE ON location_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Districts (Initial focus: Tamil Nadu, Puducherry, Karnataka, Kerala with official LGD codes)
CREATE TABLE IF NOT EXISTS location_districts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id          UUID NOT NULL REFERENCES location_states(id),
  state_lgd_code    INTEGER NOT NULL,
  lgd_code          INTEGER UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  census_2011_code  TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  source_url        TEXT NOT NULL DEFAULT 'https://lgdirectory.gov.in/',
  source_date       DATE NOT NULL DEFAULT '2024-01-01',
  verified          BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_districts_state ON location_districts (state_id, active);
DROP TRIGGER IF EXISTS trg_location_districts_updated ON location_districts;
CREATE TRIGGER trg_location_districts_updated BEFORE UPDATE ON location_districts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cities / Towns (Active for discovery, with coordinates, aliases and business market tier)
CREATE TABLE IF NOT EXISTS location_cities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id         UUID REFERENCES location_districts(id),
  state_id            UUID NOT NULL REFERENCES location_states(id),
  slug                TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                TEXT NOT NULL,
  local_name          TEXT,
  lgd_code            INTEGER,
  lat                 DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                 DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  aliases             TEXT[] NOT NULL DEFAULT '{}',
  market_tier         TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  is_discovery_active BOOLEAN NOT NULL DEFAULT true,
  source_url          TEXT NOT NULL DEFAULT 'https://lgdirectory.gov.in/',
  source_date         DATE NOT NULL DEFAULT '2024-01-01',
  verified            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cities_state ON location_cities (state_id, active);
CREATE INDEX IF NOT EXISTS idx_cities_discovery ON location_cities (is_discovery_active) WHERE is_discovery_active = true;
DROP TRIGGER IF EXISTS trg_location_cities_updated ON location_cities;
CREATE TRIGGER trg_location_cities_updated BEFORE UPDATE ON location_cities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Localities / Neighborhoods
CREATE TABLE IF NOT EXISTS location_localities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id      UUID NOT NULL REFERENCES location_cities(id),
  slug         TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         TEXT NOT NULL,
  postal_code  TEXT,
  lat          DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng          DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  aliases      TEXT[] NOT NULL DEFAULT '{}',
  active       BOOLEAN NOT NULL DEFAULT true,
  source_url   TEXT NOT NULL DEFAULT 'https://lgdirectory.gov.in/',
  verified     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_localities_city ON location_localities (city_id, active);
DROP TRIGGER IF EXISTS trg_location_localities_updated ON location_localities;
CREATE TRIGGER trg_location_localities_updated BEFORE UPDATE ON location_localities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Haversine distance function in kilometers (fast, immutable, parallel-safe, zero extension dependencies)
CREATE OR REPLACE FUNCTION haversine_km(
  lat1 DOUBLE PRECISION,
  lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION,
  lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
  r CONSTANT DOUBLE PRECISION := 6371.0; -- Mean Earth radius in km
  dlat DOUBLE PRECISION;
  dlng DOUBLE PRECISION;
  a DOUBLE PRECISION;
BEGIN
  IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN
    RETURN NULL;
  END IF;
  dlat := radians(lat2 - lat1);
  dlng := radians(lng2 - lng1);
  a := (sin(dlat / 2.0) ^ 2) + cos(radians(lat1)) * cos(radians(lat2)) * (sin(dlng / 2.0) ^ 2);
  IF a > 1.0 THEN a := 1.0; END IF;
  RETURN 2.0 * r * asin(sqrt(a));
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

-- 6. Add location references and coordinates to events and venues
ALTER TABLE events ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES location_cities(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS locality_id UUID REFERENCES location_localities(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90);
ALTER TABLE events ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180);
CREATE INDEX IF NOT EXISTS idx_events_city_id ON events (city_id);
CREATE INDEX IF NOT EXISTS idx_events_coords ON events (lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE venues ADD CONSTRAINT fk_venues_locality FOREIGN KEY (locality_id) REFERENCES location_localities(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. Seed Official States & Union Territories (All 28 States + 8 UTs)
INSERT INTO location_states (lgd_code, name, type, state_code, verified) VALUES
  (1, 'Jammu and Kashmir', 'union_territory', 'JK', true),
  (2, 'Himachal Pradesh', 'state', 'HP', true),
  (3, 'Punjab', 'state', 'PB', true),
  (4, 'Chandigarh', 'union_territory', 'CH', true),
  (5, 'Uttarakhand', 'state', 'UK', true),
  (6, 'Haryana', 'state', 'HR', true),
  (7, 'Delhi', 'union_territory', 'DL', true),
  (8, 'Rajasthan', 'state', 'RJ', true),
  (9, 'Uttar Pradesh', 'state', 'UP', true),
  (10, 'Bihar', 'state', 'BR', true),
  (11, 'Sikkim', 'state', 'SK', true),
  (12, 'Arunachal Pradesh', 'state', 'AR', true),
  (13, 'Nagaland', 'state', 'NL', true),
  (14, 'Manipur', 'state', 'MN', true),
  (15, 'Mizoram', 'state', 'MZ', true),
  (16, 'Tripura', 'state', 'TR', true),
  (17, 'Meghalaya', 'state', 'ML', true),
  (18, 'Assam', 'state', 'AS', true),
  (19, 'West Bengal', 'state', 'WB', true),
  (20, 'Jharkhand', 'state', 'JH', true),
  (21, 'Odisha', 'state', 'OD', true),
  (22, 'Chhattisgarh', 'state', 'CG', true),
  (23, 'Madhya Pradesh', 'state', 'MP', true),
  (24, 'Gujarat', 'state', 'GJ', true),
  (27, 'Maharashtra', 'state', 'MH', true),
  (28, 'Andhra Pradesh', 'state', 'AP', true),
  (29, 'Karnataka', 'state', 'KA', true),
  (30, 'Goa', 'state', 'GA', true),
  (31, 'Lakshadweep', 'union_territory', 'LD', true),
  (32, 'Kerala', 'state', 'KL', true),
  (33, 'Tamil Nadu', 'state', 'TN', true),
  (34, 'Puducherry', 'union_territory', 'PY', true),
  (35, 'Andaman and Nicobar Islands', 'union_territory', 'AN', true),
  (36, 'Telangana', 'state', 'TS', true),
  (37, 'Ladakh', 'union_territory', 'LA', true),
  (38, 'Dadra and Nagar Haveli and Daman and Diu', 'union_territory', 'DH', true)
ON CONFLICT (lgd_code) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  state_code = EXCLUDED.state_code;

-- 8. Seed Official Districts for Tamil Nadu (38 districts), Karnataka (31 districts), Kerala (14 districts), Puducherry (4 districts)
-- Tamil Nadu Districts (State LGD: 33)
INSERT INTO location_districts (state_id, state_lgd_code, lgd_code, name, verified)
SELECT s.id, 33, v.code, v.name, true
  FROM (VALUES
    (610, 'Ariyalur'),
    (730, 'Chengalpattu'),
    (568, 'Chennai'),
    (569, 'Coimbatore'),
    (570, 'Cuddalore'),
    (571, 'Dharmapuri'),
    (572, 'Dindigul'),
    (573, 'Erode'),
    (729, 'Kallakurichi'),
    (574, 'Kancheepuram'),
    (575, 'Kanniyakumari'),
    (576, 'Karur'),
    (577, 'Krishnagiri'),
    (578, 'Madurai'),
    (735, 'Mayiladuthurai'),
    (579, 'Nagapattinam'),
    (580, 'Namakkal'),
    (581, 'Perambalur'),
    (582, 'Pudukkottai'),
    (583, 'Ramanathapuram'),
    (731, 'Ranipet'),
    (584, 'Salem'),
    (585, 'Sivagangai'),
    (733, 'Tenkasi'),
    (586, 'Thanjavur'),
    (587, 'The Nilgiris'),
    (588, 'Theni'),
    (589, 'Thiruvallur'),
    (590, 'Thiruvarur'),
    (591, 'Tiruchirappalli'),
    (592, 'Tirunelveli'),
    (732, 'Tirupathur'),
    (634, 'Tiruppur'),
    (593, 'Tiruvannamalai'),
    (594, 'Thoothukkudi'),
    (595, 'Vellore'),
    (596, 'Villupuram'),
    (597, 'Virudhunagar')
  ) AS v(code, name)
  CROSS JOIN (SELECT id FROM location_states WHERE lgd_code = 33) s
ON CONFLICT (lgd_code) DO UPDATE SET name = EXCLUDED.name;

-- Karnataka Districts (State LGD: 29)
INSERT INTO location_districts (state_id, state_lgd_code, lgd_code, name, verified)
SELECT s.id, 29, v.code, v.name, true
  FROM (VALUES
    (524, 'Bagalkote'),
    (528, 'Ballari'),
    (527, 'Belagavi'),
    (526, 'Bengaluru Rural'),
    (525, 'Bengaluru Urban'),
    (529, 'Bidar'),
    (531, 'Chamarajanagara'),
    (630, 'Chikkaballapura'),
    (532, 'Chikkamagaluru'),
    (533, 'Chitradurga'),
    (534, 'Dakshina Kannada'),
    (535, 'Davangere'),
    (536, 'Dharwad'),
    (537, 'Gadag'),
    (539, 'Hassan'),
    (540, 'Haveri'),
    (538, 'Kalaburagi'),
    (541, 'Kodagu'),
    (542, 'Kolar'),
    (543, 'Koppal'),
    (544, 'Mandya'),
    (545, 'Mysuru'),
    (546, 'Raichur'),
    (631, 'Ramanagara'),
    (547, 'Shivamogga'),
    (548, 'Tumakuru'),
    (549, 'Udupi'),
    (550, 'Uttara Kannada'),
    (530, 'Vijayapura'),
    (738, 'Vijayanagara'),
    (635, 'Yadgir')
  ) AS v(code, name)
  CROSS JOIN (SELECT id FROM location_states WHERE lgd_code = 29) s
ON CONFLICT (lgd_code) DO UPDATE SET name = EXCLUDED.name;

-- Kerala Districts (State LGD: 32)
INSERT INTO location_districts (state_id, state_lgd_code, lgd_code, name, verified)
SELECT s.id, 32, v.code, v.name, true
  FROM (VALUES
    (554, 'Alappuzha'),
    (555, 'Ernakulam'),
    (556, 'Idukki'),
    (557, 'Kannur'),
    (558, 'Kasaragod'),
    (559, 'Kollam'),
    (560, 'Kottayam'),
    (561, 'Kozhikode'),
    (562, 'Malappuram'),
    (563, 'Palakkad'),
    (564, 'Pathanamthitta'),
    (565, 'Thiruvananthapuram'),
    (566, 'Thrissur'),
    (567, 'Wayanad')
  ) AS v(code, name)
  CROSS JOIN (SELECT id FROM location_states WHERE lgd_code = 32) s
ON CONFLICT (lgd_code) DO UPDATE SET name = EXCLUDED.name;

-- Puducherry Districts (State LGD: 34)
INSERT INTO location_districts (state_id, state_lgd_code, lgd_code, name, verified)
SELECT s.id, 34, v.code, v.name, true
  FROM (VALUES
    (598, 'Karaikal'),
    (599, 'Mahe'),
    (600, 'Puducherry'),
    (601, 'Yanam')
  ) AS v(code, name)
  CROSS JOIN (SELECT id FROM location_states WHERE lgd_code = 34) s
ON CONFLICT (lgd_code) DO UPDATE SET name = EXCLUDED.name;

-- 9. Seed Active Cities & Towns (with coordinates, aliases and business market tier)
INSERT INTO location_cities (slug, name, state_id, district_id, lat, lng, aliases, market_tier, verified, is_discovery_active)
VALUES
  ('chennai', 'Chennai',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 568),
   13.0827, 80.2707, ARRAY['Madras', 'MAA', 'Singara Chennai'], 'primary_market', true, true),

  ('bengaluru', 'Bengaluru',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 525),
   12.9716, 77.5946, ARRAY['Bangalore', 'BLR', 'Bengaluru Urban', 'Silicon Valley'], 'primary_market', true, true),

  ('coimbatore', 'Coimbatore',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 569),
   11.0168, 76.9558, ARRAY['Kovai', 'CJB'], 'primary_market', true, true),

  ('kochi', 'Kochi',
   (SELECT id FROM location_states WHERE lgd_code = 32),
   (SELECT id FROM location_districts WHERE lgd_code = 555),
   9.9312, 76.2673, ARRAY['Cochin', 'Ernakulam', 'COK'], 'primary_market', true, true),

  ('puducherry', 'Puducherry',
   (SELECT id FROM location_states WHERE lgd_code = 34),
   (SELECT id FROM location_districts WHERE lgd_code = 600),
   11.9416, 79.8083, ARRAY['Pondicherry', 'Pondi', 'Pondy', 'PNY'], 'primary_market', true, true),

  ('mysuru', 'Mysuru',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 545),
   12.2958, 76.6394, ARRAY['Mysore', 'MYQ'], 'expansion_market', true, true),

  ('mangaluru', 'Mangaluru',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 534),
   12.9141, 74.8560, ARRAY['Mangalore', 'IXE', 'Kudla'], 'expansion_market', true, true),

  ('madurai', 'Madurai',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 578),
   9.9252, 78.1198, ARRAY['Temple City', 'IXM'], 'expansion_market', true, true),

  ('salem', 'Salem',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 584),
   11.6643, 78.1460, ARRAY['SXV', 'Mango City'], 'expansion_market', true, true),

  ('tiruchirappalli', 'Tiruchirappalli',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 591),
   10.7905, 78.7047, ARRAY['Trichy', 'Tiruchi', 'TRZ'], 'expansion_market', true, true),

  ('thiruvananthapuram', 'Thiruvananthapuram',
   (SELECT id FROM location_states WHERE lgd_code = 32),
   (SELECT id FROM location_districts WHERE lgd_code = 565),
   8.5241, 76.9366, ARRAY['Trivandrum', 'TRV'], 'expansion_market', true, true),

  ('kozhikode', 'Kozhikode',
   (SELECT id FROM location_states WHERE lgd_code = 32),
   (SELECT id FROM location_districts WHERE lgd_code = 561),
   11.2588, 75.7804, ARRAY['Calicut', 'CCJ'], 'expansion_market', true, true),

  ('ooty', 'Ooty',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 587),
   11.4102, 76.6950, ARRAY['Udhagamandalam', 'Udhagai', 'Nilgiris'], 'getaway_destination', true, true),

  ('kodaikanal', 'Kodaikanal',
   (SELECT id FROM location_states WHERE lgd_code = 33),
   (SELECT id FROM location_districts WHERE lgd_code = 572),
   10.2381, 77.4892, ARRAY['Kodai', 'Princess of Hill Stations'], 'getaway_destination', true, true),

  ('coorg', 'Coorg',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 541),
   12.4244, 75.7382, ARRAY['Kodagu', 'Madikeri'], 'getaway_destination', true, true),

  ('gokarna', 'Gokarna',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 550),
   14.5479, 74.3188, ARRAY['Om Beach', 'Gokarn'], 'getaway_destination', true, true),

  ('chikmagalur', 'Chikmagalur',
   (SELECT id FROM location_states WHERE lgd_code = 29),
   (SELECT id FROM location_districts WHERE lgd_code = 532),
   13.3161, 75.7720, ARRAY['Chikkamagaluru', 'Coffee Land'], 'getaway_destination', true, true),

  ('varkala', 'Varkala',
   (SELECT id FROM location_states WHERE lgd_code = 32),
   (SELECT id FROM location_districts WHERE lgd_code = 565),
   8.7379, 76.7163, ARRAY['Varkala Cliff', 'Papanasam'], 'getaway_destination', true, true),

  ('wayanad', 'Wayanad',
   (SELECT id FROM location_states WHERE lgd_code = 32),
   (SELECT id FROM location_districts WHERE lgd_code = 567),
   11.6854, 76.1320, ARRAY['Kalpetta', 'Sulthan Bathery'], 'getaway_destination', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  aliases = EXCLUDED.aliases,
  market_tier = EXCLUDED.market_tier,
  verified = EXCLUDED.verified,
  is_discovery_active = EXCLUDED.is_discovery_active;

-- 10. Seed Core Localities for Hubs
INSERT INTO location_localities (city_id, slug, name, postal_code, lat, lng, aliases, verified)
VALUES
  -- Bengaluru Localities
  ((SELECT id FROM location_cities WHERE slug = 'bengaluru'), 'indiranagar', 'Indiranagar', '560038', 12.9784, 77.6408, ARRAY['100ft Road', '12th Main'], true),
  ((SELECT id FROM location_cities WHERE slug = 'bengaluru'), 'koramangala', 'Koramangala', '560034', 12.9352, 77.6245, ARRAY['Kora', '5th Block'], true),
  ((SELECT id FROM location_cities WHERE slug = 'bengaluru'), 'mg-road', 'MG Road & Brigade', '560001', 12.9756, 77.6066, ARRAY['CBD', 'Church Street'], true),
  ((SELECT id FROM location_cities WHERE slug = 'bengaluru'), 'whitefield', 'Whitefield', '560066', 12.9698, 77.7500, ARRAY['ITPL', 'EPIP'], true),
  ((SELECT id FROM location_cities WHERE slug = 'bengaluru'), 'hsr-layout', 'HSR Layout', '560102', 12.9121, 77.6446, ARRAY['HSR'], true),
  -- Chennai Localities
  ((SELECT id FROM location_cities WHERE slug = 'chennai'), 'nungambakkam', 'Nungambakkam', '600034', 13.0604, 80.2376, ARRAY['KNK Road', 'Khader Nawaz Khan'], true),
  ((SELECT id FROM location_cities WHERE slug = 'chennai'), 't-nagar', 'T. Nagar', '600017', 13.0418, 80.2341, ARRAY['Thyagaraya Nagar'], true),
  ((SELECT id FROM location_cities WHERE slug = 'chennai'), 'besant-nagar', 'Besant Nagar', '600090', 13.0002, 80.2667, ARRAY['Bessie', 'Elliot Beach'], true),
  ((SELECT id FROM location_cities WHERE slug = 'chennai'), 'alwarpet', 'Alwarpet', '600018', 13.0336, 80.2505, ARRAY['TTK Road'], true),
  -- Kochi Localities
  ((SELECT id FROM location_cities WHERE slug = 'kochi'), 'fort-kochi', 'Fort Kochi', '682001', 9.9658, 76.2421, ARRAY['Old Kochi'], true),
  ((SELECT id FROM location_cities WHERE slug = 'kochi'), 'panampilly-nagar', 'Panampilly Nagar', '682036', 9.9602, 76.2995, ARRAY['Panampilly'], true),
  -- Coimbatore Localities
  ((SELECT id FROM location_cities WHERE slug = 'coimbatore'), 'rs-puram', 'RS Puram', '641002', 11.0090, 76.9510, ARRAY['DB Road'], true),
  -- Puducherry Localities
  ((SELECT id FROM location_cities WHERE slug = 'puducherry'), 'white-town', 'White Town', '605001', 11.9338, 79.8354, ARRAY['French Quarter'], true)
ON CONFLICT (city_id, slug) DO UPDATE SET
  name = EXCLUDED.name,
  postal_code = EXCLUDED.postal_code,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  aliases = EXCLUDED.aliases,
  verified = EXCLUDED.verified;

-- 11. Safe Data Backfill: Associate existing events with location_cities & default city coordinates
UPDATE events e
   SET city_id = c.id,
       lat = COALESCE(e.lat, c.lat),
       lng = COALESCE(e.lng, c.lng)
  FROM location_cities c
 WHERE e.city_id IS NULL
   AND (lower(e.city) = lower(c.name) OR lower(e.city) = lower(c.slug));
