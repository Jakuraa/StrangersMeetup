-- StrangersMeetup Database Migration: 003_trips_and_event_metadata.sql
-- Additive migration for Event Scopes, Trip Classifications, Rich Metadata & Authentic Visuals
-- Compatible with PostgreSQL and SQLite

-- 1. Alter Table: Add columns if not already present
-- (lib/db.js catches duplicate column names safely in SQLite)
ALTER TABLE events ADD COLUMN event_scope TEXT DEFAULT 'south_india';
ALTER TABLE events ADD COLUMN event_type TEXT DEFAULT 'local_meetup';
ALTER TABLE events ADD COLUMN duration_label TEXT DEFAULT '3 Hours';
ALTER TABLE events ADD COLUMN image_url TEXT;
ALTER TABLE events ADD COLUMN exclusions TEXT DEFAULT '[]';
ALTER TABLE events ADD COLUMN booking_terms TEXT;

-- 2. Update existing South India events with authentic imagery and duration
UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3 Hours',
  image_url = 'https://images.unsplash.com/photo-1610890716171-6b1bb98ffd09?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_blr_boardgames_01';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '2.5 Hours',
  image_url = 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_blr_coffee_02';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3.5 Hours',
  image_url = 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_chn_retro_cinema_03';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3.5 Hours',
  image_url = 'https://images.unsplash.com/photo-1543807535-eceef0bc6599?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_chn_neon_mixer_04';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3 Hours',
  image_url = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_cbe_acoustic_05';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3.5 Hours',
  image_url = 'https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_koc_sunset_cruise_06';

UPDATE events SET 
  event_scope = 'south_india',
  event_type = 'local_meetup',
  duration_label = '3.5 Hours',
  image_url = 'https://images.unsplash.com/photo-1582510003544-4d00b7f74220?auto=format&fit=crop&w=800&q=80'
WHERE id = 'evt_pdy_coastal_resort_07';

-- 3. Seed Additional South India Meetups (Café & Cultural City Explorations)
INSERT OR IGNORE INTO events (
    id, title, slug, category, city, area_name, start_time, end_time, capacity, tickets_sold,
    price_inr, ticketing_status, description, inclusions, confirmed_resort_food_lodging,
    accessibility_notes, cancellation_terms, organizer_name, is_demo, is_published,
    event_scope, event_type, duration_label, image_url, exclusions, booking_terms
) VALUES 
(
    'evt_blr_cubbon_walk_08',
    'Cubbon Park Morning Walk & Filter Kaapi Circle',
    'bengaluru-cubbon-park-walk',
    'open_meetups',
    'bengaluru',
    'Cubbon Park & MG Road',
    '2026-11-22 07:30:00',
    '2026-11-22 10:00:00',
    18,
    7,
    199,
    'open',
    'A tranquil morning walk beneath ancient bamboo groves and mahogany trees. Facilitated conversational walking pairs followed by authentic filter coffee at a heritage cafe.',
    '["Guided scenic morning walk route", "Authentic traditional filter coffee & warm South Indian snack", "Curated prompt cards for walking pairs", "Private Telegram coordination group"]',
    0,
    'Paved park paths with flat elevation; wheelchair-friendly park route.',
    'Full refund up to 24 hours prior to meetup time.',
    'StrangersMeetup Bengaluru Chapter',
    1,
    1,
    'south_india',
    'local_meetup',
    '2.5 Hours',
    'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=800&q=80',
    '["Personal shopping expenses", "Extra beverages outside set menu"]',
    'Participants must affirm 21+ age eligibility. Meetup coordinates shared 24h prior in Telegram.'
),
(
    'evt_chn_mylapore_walk_09',
    'Mylapore Cultural Heritage Walk & Temple Cafe Gathering',
    'chennai-mylapore-heritage-walk',
    'open_meetups',
    'chennai',
    'Mylapore Cultural Precinct',
    '2026-11-29 07:00:00',
    '2026-11-29 09:30:00',
    16,
    5,
    299,
    'open',
    'Immerse in the timeless architecture, temple tank corridors, and vibrant cultural heritage of historic Mylapore with curious adults. Concludes with breakfast and open reflections.',
    '["Architectural & cultural storyteller guide", "Traditional Mylapore tiffin breakfast & degree coffee", "Interactive neighborhood question cards", "Private Telegram community access"]',
    0,
    'Paved street walking route with short pedestrian curbs.',
    'Full refund up to 24 hours prior.',
    'StrangersMeetup Chennai Chapter',
    1,
    1,
    'south_india',
    'local_meetup',
    '2.5 Hours',
    'https://images.unsplash.com/photo-1596178065887-1198b6148b2b?auto=format&fit=crop&w=800&q=80',
    '["Temple camera permits (if applicable)"]',
    'Strict 21+ age affirmative required. Respectful dress etiquette observed in temple precinct.'
);

-- 4. Seed Domestic Trips (Verified Upcoming Group Travel Experiences Within India)
INSERT OR IGNORE INTO events (
    id, title, slug, category, city, area_name, start_time, end_time, capacity, tickets_sold,
    price_inr, ticketing_status, description, inclusions, confirmed_resort_food_lodging,
    accessibility_notes, cancellation_terms, organizer_name, is_demo, is_published,
    event_scope, event_type, duration_label, image_url, exclusions, booking_terms
) VALUES 
(
    'evt_trip_meghalaya_10',
    'Meghalaya Living Root Bridges & Cloud Valley Expedition',
    'domestic-trip-meghalaya-expedition',
    'weekend_trips',
    'meghalaya',
    'Shillong, Cherrapunji & Mawlynnong',
    '2026-12-04 09:00:00',
    '2026-12-08 18:00:00',
    14,
    9,
    18500,
    'open',
    'A curated 5-day small group journey through the mist-shrouded hills of Meghalaya. Hike to double-decker living root bridges, swim in crystal-clear river pools of Dawki, and share evenings in sustainable boutique homestays.',
    '["4 nights verified boutique homestay accommodation (twin sharing)", "All inter-city private SUV transfers from Guwahati Airport", "Breakfast and chef-prepared dinner daily", "Certified Khasi community trail guide & trek permits", "Caving excursion & safety gear", "Dedicated StrangersMeetup host concierge"]',
    1,
    'Moderate fitness required for root bridge stone stairs (approx. 3,000 steps). Not wheelchair accessible.',
    '100% refund up to 21 days before departure; 50% refund between 10-20 days; non-refundable within 10 days.',
    'StrangersMeetup Travel Cohorts',
    1,
    1,
    'domestic_trip',
    'trip',
    '5 Days / 4 Nights',
    'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=800&q=80',
    '["Airfare / rail to Guwahati (GAU) Airport", "Lunch on travel days", "Personal expenses & shopping", "Travel insurance (mandatory)"]',
    'Strict 21+ adult group travel. Full KYC and emergency contact required upon booking confirmation.'
),
(
    'evt_trip_gokarna_11',
    'Gokarna Coastal Trail & Sunset Beach Camp Escape',
    'domestic-trip-gokarna-beach-camp',
    'weekend_trips',
    'gokarna',
    'Kudle Beach & Half Moon Cliff',
    '2026-11-20 15:00:00',
    '2026-11-22 17:00:00',
    16,
    11,
    6499,
    'open',
    'Connect under the stars along the rugged Karnataka coastline. Traverse secluded coves from Om Beach to Paradise Beach, camp in comfortable shoreline tents, and enjoy acoustic bonfire jams.',
    '["2 nights safari-style beach tent stay with ocean views", "Facilitated 5-beach cliff trek with certified outdoor leader", "All breakfasts and seaside barbecue dinner", "Stargazing and acoustic conversation circle", "Private Telegram group for carpool / train meetup"]',
    1,
    'Coastal walking path with uneven dirt paths and slight rocky inclines.',
    'Full refund up to 7 days before trip start; 50% up to 72 hours.',
    'StrangersMeetup Travel Cohorts',
    1,
    1,
    'domestic_trip',
    'trip',
    '3 Days / 2 Nights',
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&q=80',
    '["Travel to Gokarna railway station or bus depot", "Lunch & optional water sports"]',
    '21+ adults only. Respectful coastal Leave No Trace community guidelines strictly enforced.'
),
(
    'evt_trip_wayanad_12',
    'Wayanad Cloud Forest Hike & Estate Coffee Retreat',
    'domestic-trip-wayanad-coffee-retreat',
    'resort_getaways',
    'wayanad',
    'Vythiri & Chembra Valley',
    '2026-12-11 14:00:00',
    '2026-12-13 16:00:00',
    14,
    4,
    7999,
    'open',
    'Escape into the high-canopy rainforests of Wayanad. Stay in a century-old heritage coffee estate, hike through mist-draped shola forests, sample artisanal cuppings, and unwind with quiet evening conversations.',
    '["2 nights accommodation in heritage plantation estate bungalows", "Specialty coffee cupping workshop & farm-to-table meals", "Forest department permitted day hike", "Bonfire conversation circle and stargazing", "StrangersMeetup regional host coordination"]',
    1,
    'Bungalow estate has ramp access. Nature walk includes forest trails with gentle slopes.',
    'Full refund up to 10 days before check-in.',
    'StrangersMeetup Travel Cohorts',
    1,
    1,
    'domestic_trip',
    'trip',
    '3 Days / 2 Nights',
    'https://images.unsplash.com/photo-1593693397690-362cb9666fc2?auto=format&fit=crop&w=800&q=80',
    '["Travel to Wayanad estate from Kozhikode (CCJ) or Bengaluru", "Alcoholic beverages"]',
    'Adults 21+ only. Verified booking with Telegram private coordination 7 days prior.'
);

-- 5. Seed International Trips (Verified Upcoming Group Travel Experiences Outside India)
INSERT OR IGNORE INTO events (
    id, title, slug, category, city, area_name, start_time, end_time, capacity, tickets_sold,
    price_inr, ticketing_status, description, inclusions, confirmed_resort_food_lodging,
    accessibility_notes, cancellation_terms, organizer_name, is_demo, is_published,
    event_scope, event_type, duration_label, image_url, exclusions, booking_terms
) VALUES 
(
    'evt_trip_vietnam_13',
    'Vietnam Heritage & Coffee Discovery: Hanoi to Ninh Binh',
    'international-trip-vietnam-hanoi-ninh-binh',
    'weekend_trips',
    'vietnam',
    'Hanoi Old Quarter & Trang An, Vietnam',
    '2026-12-18 10:00:00',
    '2026-12-23 18:00:00',
    12,
    8,
    34900,
    'open',
    'An immersive 6-day journey through northern Vietnam with a tight cohort of curious travelers. Navigate the winding culinary alleyways of Hanoi, kayak through towering limestone karsts in Ninh Binh, and bond over egg coffee workshops.',
    '["5 nights 4-star boutique hotel accommodation (twin share)", "Private air-conditioned overland transit throughout", "All breakfasts, 4 curated local culinary lunches & 2 group dinners", "Traditional wooden sampan boat ride through Trang An grottoes", "Hanoi Old Quarter street food walk with local culinary storyteller", "Egg coffee brewing masterclass", "Dedicated bilingual host and StrangersMeetup tour director"]',
    1,
    'Walking tours involve historic cobbled streets and boat boarding ramps. Moderate overall accessibility.',
    'Free cancellation up to 30 days before departure; 50% refund between 15-29 days; non-refundable within 14 days.',
    'StrangersMeetup Global Expeditions',
    1,
    1,
    'international_trip',
    'trip',
    '6 Days / 5 Nights',
    'https://images.unsplash.com/photo-1528127269322-539801943592?auto=format&fit=crop&w=800&q=80',
    '["International roundtrip airfare to Hanoi (HAN)", "Vietnam eVisa fee ($25 USD)", "Comprehensive international travel insurance", "Personal shopping & discretionary tips"]',
    'Strictly 21+ adults only. Valid passport with minimum 6 months validity required. Booking includes direct onboarding session with tour director.'
),
(
    'evt_trip_bali_14',
    'Bali Creative Retreat & Island Exploration: Ubud to Uluwatu',
    'international-trip-bali-ubud-uluwatu',
    'resort_getaways',
    'bali',
    'Ubud Cultural Valley & Uluwatu Cliffs, Bali',
    '2027-01-14 11:00:00',
    '2027-01-20 16:00:00',
    12,
    5,
    42500,
    'open',
    'A transformative 7-day escape blending creative exploration, cliffside sunsets, and lush jungle sanctuary living. Connect with founders, creators, and professionals in private pool villas.',
    '["6 nights boutique private pool villa accommodation in Ubud & Uluwatu", "All private airport and island transfers", "Daily organic Balinese breakfast & welcome sunset feast", "Curated sound bath and evening conversation salons", "Private catamaran sunset cruise with snorkeling", "Uluwatu cliffside amphitheater Kecak fire performance", "StrangersMeetup retreat facilitator"]',
    1,
    'Villa grounds feature paved stone pathways; catamaran boarding requires stepping assistance.',
    'Full refund up to 35 days before arrival; 50% up to 18 days; non-refundable thereafter.',
    'StrangersMeetup Global Expeditions',
    1,
    1,
    'international_trip',
    'trip',
    '7 Days / 6 Nights',
    'https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=800&q=80',
    '["Flights to Denpasar Ngurah Rai (DPS)", "Indonesia Visa on Arrival (approx $35 USD)", "Travel insurance", "Personal lunches on free exploration afternoons"]',
    '21+ adults only. Passport must have 6+ months validity. Pre-trip cohort Telegram orientation 2 weeks prior.'
),
(
    'evt_trip_srilanka_15',
    'Sri Lanka Highland Scenic Train & Southern Coast Escape',
    'international-trip-sri-lanka-ella-galle',
    'weekend_trips',
    'sri_lanka',
    'Ella Tea Highlands & Galle Fort, Sri Lanka',
    '2027-02-05 09:00:00',
    '2027-02-10 17:00:00',
    12,
    0,
    29800,
    'opening_soon',
    'Ride the iconic blue train through emerald tea mountains, hike to Little Adams Peak at dawn, and explore the colonial ramparts and golden beaches of Galle Fort with verified adult travelers.',
    '["5 nights boutique heritage hotel stays", "Reserved first-class observation car seats on the Kandy-Ella scenic train", "All breakfasts and 3 authentic Sri Lankan feasts", "Tea factory tasting tour & architectural walk of UNESCO Galle Fort", "Private air-conditioned minibus with professional chauffeur & host"]',
    1,
    'Historic train cars have elevated boarding steps. Galle Fort walking routes are flat and paved.',
    'Full refund up to 28 days before departure.',
    'StrangersMeetup Global Expeditions',
    1,
    1,
    'international_trip',
    'trip',
    '6 Days / 5 Nights',
    'https://images.unsplash.com/photo-1586861635167-e5223aadc9fe?auto=format&fit=crop&w=800&q=80',
    '["Flights to Colombo (CMB)", "Sri Lanka ETA visa fee", "Personal expenses & snacks"]',
    'Strict 21+ verification. Bookings open shortly for early waitlist members.'
);
