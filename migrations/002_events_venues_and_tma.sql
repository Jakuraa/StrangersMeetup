-- StrangersMeetup Database Migration: 002_events_venues_and_tma.sql
-- Additive migration for Events, RSVPs, Partner/Venue Inquiries, and Telegram Mini App Profiles
-- Compatible with PostgreSQL (Hatchable) and SQLite (Local test harness)

-- 1. Events Table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL, -- movie_nights, nightlife, board_games, open_meetups, weekend_trips, resort_getaways
    city TEXT NOT NULL,     -- chennai, bengaluru, coimbatore, kochi, puducherry
    area_name TEXT NOT NULL, -- Indiranagar, Koramangala, Nungambakkam, etc. (Public area only)
    venue_name TEXT,        -- Held private until booking / 24h prior via Telegram
    venue_address TEXT,     -- Held private until booking / 24h prior via Telegram
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    capacity INTEGER NOT NULL,
    tickets_sold INTEGER NOT NULL DEFAULT 0,
    price_inr INTEGER NOT NULL DEFAULT 0,
    ticketing_status TEXT NOT NULL DEFAULT 'open', -- open, waitlist, sold_out, opening_soon
    ticketing_provider TEXT, -- Neutral ticketing provider; disabled/unconfigured by default
    ticketing_url TEXT,
    description TEXT NOT NULL,
    inclusions TEXT,         -- JSON array of verified inclusions
    confirmed_resort_food_lodging BOOLEAN DEFAULT 0, -- Strictly 1 only if verified confirmed
    accessibility_notes TEXT,
    cancellation_terms TEXT,
    organizer_name TEXT NOT NULL DEFAULT 'StrangersMeetup Regional Hosts',
    is_demo BOOLEAN DEFAULT 0,
    is_published BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(ticketing_status);

-- 2. Event RSVPs & Ticket Reservations
CREATE TABLE IF NOT EXISTS event_rsvps (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    telegram_user_id BIGINT,
    attendee_name TEXT NOT NULL,
    attendee_contact TEXT NOT NULL, -- Email or phone
    ticket_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED, WAITLIST, CANCELLED
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rsvps_event ON event_rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_rsvps_tg_user ON event_rsvps(telegram_user_id);

-- 3. Partner, Host, and Venue Inquiries
CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL, -- 'partner', 'host', 'venue', 'contact'
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    city TEXT,
    organization TEXT,
    details_json TEXT,
    status TEXT NOT NULL DEFAULT 'NEW', -- NEW, CONTACTED, ARCHIVED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiries_type ON inquiries(type);
CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries(created_at);

-- 4. Telegram Mini App (TMA) Pseudonymous Profiles & Consent
CREATE TABLE IF NOT EXISTS tma_profiles (
    telegram_user_id BIGINT PRIMARY KEY,
    pseudonym TEXT,
    first_name TEXT,
    username TEXT,
    city TEXT,
    age_declared INTEGER,
    consent_community_rules BOOLEAN DEFAULT 0,
    consent_double_opt_in BOOLEAN DEFAULT 0,
    interests_json TEXT, -- JSON array of interests: ['board_games', 'indie_cinema', 'cocktail_mixers']
    profile_completed BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed Initial Real Events Across 5 Supported Cities
INSERT OR IGNORE INTO events (
    id, title, slug, category, city, area_name, start_time, end_time, capacity, tickets_sold,
    price_inr, ticketing_status, description, inclusions, confirmed_resort_food_lodging,
    accessibility_notes, cancellation_terms, organizer_name, is_demo, is_published
) VALUES 
(
    'evt_blr_boardgames_01',
    'Indiranagar Strangers Board Game & Strategy Salon',
    'bengaluru-board-games-indiranagar',
    'board_games',
    'bengaluru',
    'Indiranagar 100ft Road',
    '2026-11-07 18:30:00',
    '2026-11-07 21:30:00',
    24,
    14,
    499,
    'open',
    'An evening of social deduction, strategy, and casual party games designed to break the ice effortlessly. Friendly facilitators ensure everyone finds a table.',
    '["Curated game library of 30+ titles", "Dedicated game master table guidance", "Artisanal beverage & evening snack inclusion", "Private Telegram coordination circle"]',
    0,
    'Ground floor cafe lounge with step-free entrance and accessible restrooms.',
    'Full refund available up to 48 hours before the event. Non-refundable after that window.',
    'StrangersMeetup Bengaluru Chapter',
    0,
    1
),
(
    'evt_blr_coffee_02',
    'Sunday Morning Coffee & Strangers Book Exchange',
    'bengaluru-sunday-coffee-koramangala',
    'open_meetups',
    'bengaluru',
    'Koramangala 4th Block',
    '2026-11-15 10:30:00',
    '2026-11-15 13:00:00',
    20,
    8,
    299,
    'open',
    'Bring one book you love and leave with a new favorite. Thoughtful, low-pressure conversations over freshly brewed pour-overs in a quiet courtyard setting.',
    '["Single origin coffee or herbal infusion", "Pastry / breakfast bite", "Facilitated conversation cards", "Private Telegram group invite"]',
    0,
    'Step-free entrance and quiet semi-outdoor covered patio.',
    'Full refund up to 24 hours before start time.',
    'StrangersMeetup Bengaluru Chapter',
    0,
    1
),
(
    'evt_chn_retro_cinema_03',
    'Rooftop Retro Cinema & Conversation Salon',
    'chennai-rooftop-retro-cinema-nungambakkam',
    'movie_nights',
    'chennai',
    'Nungambakkam',
    '2026-11-13 19:30:00',
    '2026-11-13 22:45:00',
    28,
    22,
    599,
    'open',
    'An open-air screening of a celebrated regional classic followed by an engaging post-film discussion on storytelling, memories, and modern relationships.',
    '["Open-air projector screening under the stars", "Handcrafted snack box & cooler", "Facilitated thematic circle discussion", "Private Telegram coordination"]',
    0,
    'Elevator access to rooftop terrace. Accessible seating areas designated.',
    'Full refund up to 48 hours prior to screening time.',
    'StrangersMeetup Chennai Chapter',
    0,
    1
),
(
    'evt_chn_neon_mixer_04',
    'Friday Night Social Mixer & Lounge Beats',
    'chennai-friday-social-mixer-alwarpet',
    'nightlife',
    'chennai',
    'Alwarpet',
    '2026-11-20 20:00:00',
    '2026-11-20 23:30:00',
    35,
    18,
    799,
    'open',
    'An upbeat, stylish Friday mixer featuring curated house grooves, icebreaker prompt cards, and warm conversation areas for adults looking to expand their circle.',
    '["Complimentary welcome craft mocktail/drink", "Finger food platter", "Vetted 21+ adult crowd", "Private Telegram community access"]',
    0,
    'Venue features step-free access and dedicated elevator to 2nd floor lounge.',
    'Cancellations honored up to 72 hours before the event.',
    'StrangersMeetup Chennai Chapter',
    0,
    1
),
(
    'evt_cbe_acoustic_05',
    'Sunset Acoustic Circle & Storytelling Mixer',
    'coimbatore-sunset-acoustic-rs-puram',
    'open_meetups',
    'coimbatore',
    'RS Puram',
    '2026-11-21 17:30:00',
    '2026-11-21 20:30:00',
    18,
    6,
    349,
    'open',
    'A warm, soulful evening featuring an intimate acoustic performance and facilitated storytelling prompts. Discover meaningful perspectives with fellow Coimbatore residents.',
    '["Live unplugged acoustic set", "Artisan tea & evening refreshments", "Facilitated prompt circle", "Private Telegram circle"]',
    0,
    'Ground level courtyard with ramp access.',
    'Full refund up to 48 hours before the event.',
    'StrangersMeetup Coimbatore Chapter',
    0,
    1
),
(
    'evt_koc_sunset_cruise_06',
    'Backwater Sunset Cruise & Social Mixer',
    'kochi-backwater-sunset-cruise-fort-kochi',
    'weekend_trips',
    'kochi',
    'Fort Kochi & Vembanad Waters',
    '2026-11-28 16:00:00',
    '2026-11-28 19:30:00',
    22,
    19,
    1199,
    'open',
    'Cruise along the tranquil waters of Kochi at golden hour. Connect with creative professionals, travelers, and locals aboard a private traditional motor cruiser.',
    '["3-hour private backwater boat charter", "Traditional Kerala tea-time snacks & tender coconut", "Sunset photo stops", "Private Telegram coordination group"]',
    0,
    'Boarding jetty has short gangway with handrail assistance. Non-wheelchair-accessible boat cabin.',
    'Refundable up to 5 days prior to departure due to boat reservation policy.',
    'StrangersMeetup Kochi Chapter',
    0,
    1
),
(
    'evt_pdy_coastal_resort_07',
    'Heritage Promenade & Coastal Cafe Gathering',
    'puducherry-heritage-promenade-white-town',
    'resort_getaways',
    'puducherry',
    'White Town French Quarter',
    '2026-11-29 16:30:00',
    '2026-11-29 20:00:00',
    20,
    0,
    499,
    'opening_soon',
    'A leisurely golden-hour walk through the pastel architecture of White Town followed by an intimate evening mixer in a restored colonial garden cafe.',
    '["Facilitated heritage stroll", "French-Tamil cafe beverage & pastry pairing", "Private Telegram group", "Host coordination"]',
    0,
    'Flat walking route along paved streets; garden cafe has step-free outdoor seating.',
    'Full refund up to 48 hours prior to start.',
    'StrangersMeetup Puducherry Chapter',
    0,
    1
);
