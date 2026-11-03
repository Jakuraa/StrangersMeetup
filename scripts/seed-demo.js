// scripts/seed-demo.js - Sample events for previews. Every row is is_demo=true and renders a
// visible "Sample" label. Includes free ticket tiers so attendees and reviewers can test the
// booking journey, ticket issuance, and mystery venue unlock without a paid provider.
// Guarded by seed-guard.js: never in production, remote DBs only with SEED_ALLOW_REMOTE=true, and
// never into a remote DB that already holds real (non-demo) events. `npm run seed:demo` only.
import { db } from '../lib/db.js';
import { assertSeedAllowed, SeedRefused } from './seed-guard.js';

const DAY = 86_400_000;

export function at(daysFromNow, hourIst, minute = 0) {
  const d = new Date(Date.now() + daysFromNow * DAY);
  // Build the date in IST (UTC+5:30) at the given local hour.
  const ymd = new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T${String(hourIst).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`).toISOString();
}

export const DEMO_EVENTS = [
  {
    slug: 'sample-bengaluru-indiranagar-rooftop-mixer',
    category: 'nightlife',
    city: 'Bengaluru',
    area_public: 'Indiranagar',
    title: 'Indiranagar Rooftop Social & Cocktails',
    summary: 'A relaxed 21+ evening on an open-air terrace with music, drinks, and low-pressure introductions.',
    description: 'Join fellow Bangaloreans for an evening on an open-air Indiranagar terrace. Arrive solo or with a friend — our community host facilitates low-pressure introductions so everyone connects naturally. Includes one welcome drink and tapas.',
    start: [8, 19, 30],
    hours: 3,
    capacity: 25,
    tier: { name: 'Free RSVP Entry', kind: 'free', pricePaise: 0, quantity: 25, maxPerBooking: 2 },
    inclusions: ['Welcome drink', 'Tapas appetizers', 'Host introductions'],
    refund_policy: 'Full refund / free cancellation up to 24 hours before start.',
    gender_policy: 'Gender-balanced registration',
    food: true,
    stay: false,
    venue_private: 'Secret Terrace, 12th Main Road, Indiranagar (Synthetic Test Venue)'
  },
  {
    slug: 'sample-chennai-besant-nagar-supper-club',
    category: 'dinner_club',
    city: 'Chennai',
    area_public: 'Besant Nagar',
    title: 'Six Strangers Supper Club: Besant Nagar',
    summary: 'Six strangers around one communal table for a curated coastal dinner and easy conversation.',
    description: 'Experience our signature supper club format: intimate tables of six, shared appetizers, fresh coastal fare, and conversation menus with thought-provoking prompts. Perfect for meeting thoughtful conversationalists in Chennai.',
    start: [10, 20, 0],
    hours: 2.5,
    capacity: 18,
    tier: { name: 'Supper Club Guest Seat', kind: 'free', pricePaise: 0, quantity: 18, maxPerBooking: 1 },
    inclusions: ['Curated set dinner menu', 'Conversation menu', 'Host table arrangement'],
    refund_policy: 'Free cancellation up to 48 hours before start.',
    gender_policy: 'Balanced seating',
    food: true,
    stay: false,
    venue_private: 'The Hidden Bistro, 4th Beach Avenue, Besant Nagar (Synthetic Test Venue)'
  },
  {
    slug: 'sample-kochi-fort-kochi-sunset-walk',
    category: 'meetup',
    city: 'Kochi',
    area_public: 'Fort Kochi',
    title: 'Fort Kochi Sunset Heritage Walk & Chai',
    summary: 'A breezy evening stroll along the Chinese fishing nets, followed by spiced tea and café conversation.',
    description: 'An easy-going weekend walk exploring colonial Fort Kochi backstreets, art murals, and harbor waterfront at golden hour. We wrap up at a quiet heritage courtyard for fresh tea and open social conversation.',
    start: [12, 17, 0],
    hours: 2,
    capacity: 20,
    tier: { name: 'Explorer Pass', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2 },
    inclusions: ['Guided walking route', 'Chai & tea snacks', 'Group icebreakers'],
    refund_policy: 'Free cancellation anytime before start.',
    gender_policy: null,
    food: false,
    stay: false,
    venue_private: 'Old Harbour Courtyard, Bastion Street, Fort Kochi (Synthetic Test Venue)'
  },
  {
    slug: 'sample-coorg-coffee-trail-weekend',
    category: 'weekend_trip',
    city: 'Bengaluru',
    area_public: 'Coorg / Indiranagar Pickup',
    title: 'Coorg Weekend Coffee Trail & Campfire',
    summary: 'Two days in the misty hills of Madikeri: estate plantation walk, campfire acoustic night, and stargazing.',
    description: 'Escape the city for a restorative 2-day getaway with 12 friendly strangers. Private minibus transfer from Indiranagar/Hebbal, twin-sharing plantation cottages, traditional Kodava meals, and evening campfire music.',
    start: [16, 6, 0],
    hours: 34,
    capacity: 14,
    tier: { name: 'Trip Guest RSVP', kind: 'free', pricePaise: 0, quantity: 14, maxPerBooking: 1 },
    inclusions: ['Plantation homestay (1 night)', 'All estate meals', 'Private tempo transfer', 'Campfire & guide'],
    exclusions: ['Personal expenses', 'Optional river rafting'],
    refund_policy: 'Free cancellation up to 7 days before departure.',
    food: true,
    stay: true,
    venue_private: 'Estate 9, Madikeri Hills Road, Coorg (Synthetic Test Destination)'
  }
];

export async function seedDemo({ e = process.env } = {}) {
  const { local } = assertSeedAllowed({ kind: 'demo', e });
  if (!local) {
    const real = await db.one('SELECT count(*)::int AS n FROM events WHERE NOT is_demo');
    if (real.n) throw new SeedRefused(`refusing to seed: this database already has ${real.n} real event(s)`);
  }
  let n = 0;
  for (const item of DEMO_EVENTS) {
    const start = at(...item.start);
    const end = new Date(new Date(start).getTime() + item.hours * 3600_000).toISOString();
    await db.tx(async (tx) => {
      const res = await tx.query(
        `INSERT INTO events (slug, category, title, summary, description, city, area_public, venue_private, venue_privacy,
           start_at, end_at, capacity, price_status, inclusions, exclusions, refund_policy, gender_policy,
           food_available, stay_available, organizer, status, is_demo, ticketing, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'disclosed_after_booking',$9,$10,$11,'tbd',$12,$13,$14,$15,$16,$17,
           'StrangersMeetup','published',true,'tiers',now())
         ON CONFLICT (slug) DO UPDATE SET
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           capacity = EXCLUDED.capacity,
           title = EXCLUDED.title,
           summary = EXCLUDED.summary,
           description = EXCLUDED.description,
           inclusions = EXCLUDED.inclusions,
           exclusions = EXCLUDED.exclusions,
           venue_private = EXCLUDED.venue_private,
           venue_privacy = EXCLUDED.venue_privacy,
           ticketing = 'tiers'
         WHERE events.is_demo = true
         RETURNING id`,
        [item.slug, item.category, item.title, item.summary, item.description, item.city, item.area_public, item.venue_private,
          start, end, item.capacity, JSON.stringify(item.inclusions || []), JSON.stringify(item.exclusions || []),
          item.refund_policy, item.gender_policy || null, Boolean(item.food), Boolean(item.stay)]
      );

      const eventId = res.rows[0]?.id;
      if (eventId && item.tier) {
        const existing = (await tx.query('SELECT id FROM ticket_types WHERE event_id = $1 AND name = $2', [eventId, item.tier.name])).rows[0];
        if (!existing) {
          await tx.query(
            `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, true, 0)`,
            [eventId, item.tier.name, item.tier.kind, item.tier.pricePaise, item.tier.quantity, item.tier.maxPerBooking]
          );
        } else {
          await tx.query(
            `UPDATE ticket_types SET quantity = $2, max_per_booking = $3, active = true WHERE id = $1`,
            [existing.id, item.tier.quantity, item.tier.maxPerBooking]
          );
        }
      }
    });
    n++;
  }
  return n;
}
