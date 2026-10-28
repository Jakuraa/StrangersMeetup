// scripts/seed-demo.js - Sample events for previews. Every row is is_demo=true and renders a
// visible "Sample" label. No bookings, no sold counts, no prices (price_status = 'tbd').
// Guarded by seed-guard.js: never in production, remote DBs only with SEED_ALLOW_REMOTE=true, and
// never into a remote DB that already holds real (non-demo) events. `npm run seed:demo` only.
import { db } from '../lib/db.js';
import { assertSeedAllowed, SeedRefused } from './seed-guard.js';

const DAY = 86_400_000;

function at(daysFromNow, hourIst, minute = 0) {
  const d = new Date(Date.now() + daysFromNow * DAY);
  // Build the date in IST (UTC+5:30) at the given local hour.
  const ymd = new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T${String(hourIst).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`).toISOString();
}

export const DEMO_EVENTS = [
  {
    slug: 'sample-chennai-board-games-evening',
    category: 'board_games', city: 'Chennai', area_public: 'Besant Nagar',
    title: 'Board games & new faces',
    summary: 'A relaxed evening of easy party games designed for people who have never met.',
    start: [12, 18, 30], hours: 3, capacity: 24,
    inclusions: ['Game hosts at every table', 'Welcome drink'],
    refund_policy: 'Full refund up to 48 hours before start.',
    gender_policy: 'Gender-balanced tables'
  },
  {
    slug: 'sample-bengaluru-dinner-club',
    category: 'dinner_club', city: 'Bengaluru', area_public: 'Indiranagar',
    title: 'Dinner club: six strangers, one table',
    summary: 'Small tables of six, a shared menu and conversation prompts if you need them.',
    start: [16, 20, 0], hours: 2.5, capacity: 18,
    inclusions: ['Set dinner menu', 'Host-led introductions'],
    refund_policy: 'Full refund up to 48 hours before start.',
    gender_policy: 'Gender-balanced tables'
  },
  {
    slug: 'sample-kochi-dating-mixer',
    category: 'dating_mixer', city: 'Kochi', area_public: 'Fort Kochi',
    title: 'Slow dating mixer',
    summary: 'Short, hosted one-to-one conversations followed by an open social hour.',
    start: [20, 19, 0], hours: 3, capacity: 30,
    inclusions: ['Hosted rotations', 'Welcome drink'],
    refund_policy: 'Full refund up to 72 hours before start.',
    gender_policy: 'Gender-balanced registration'
  },
  {
    slug: 'sample-puducherry-resort-weekend',
    category: 'resort_getaway', city: 'Puducherry', area_public: 'East Coast Road',
    title: 'Weekend resort getaway',
    summary: 'Two days at a beach resort with a small group: shared meals, a sunrise walk, free time.',
    start: [26, 11, 0], hours: 30, capacity: 16,
    inclusions: ['Twin-sharing stay (1 night)', 'Breakfast, lunch, dinner', 'Host on site'],
    exclusions: ['Travel to the resort', 'Personal expenses'],
    refund_policy: 'Full refund up to 7 days before start; 50% up to 72 hours.',
    food: true, stay: true
  }
];

export async function seedDemo({ e = process.env } = {}) {
  const { local } = assertSeedAllowed({ kind: 'demo', e });
  if (!local) {
    const real = await db.one('SELECT count(*)::int AS n FROM events WHERE NOT is_demo');
    if (real.n) throw new SeedRefused(`refusing to seed: this database already has ${real.n} real event(s)`);
  }
  let n = 0;
  for (const e of DEMO_EVENTS) {
    const start = at(...e.start);
    const end = new Date(new Date(start).getTime() + e.hours * 3600_000).toISOString();
    await db.query(
      `INSERT INTO events (slug, category, title, summary, description, city, area_public, venue_privacy,
         start_at, end_at, capacity, price_status, inclusions, exclusions, refund_policy, gender_policy,
         food_available, stay_available, organizer, status, is_demo, published_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,'disclosed_after_booking',$7,$8,$9,'tbd',$10,$11,$12,$13,$14,$15,
         'StrangersMeetup','published',true,now())
       ON CONFLICT (slug) DO UPDATE SET start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at
       WHERE events.is_demo = true`,
      [e.slug, e.category, e.title, e.summary, e.city, e.area_public, start, end, e.capacity,
        JSON.stringify(e.inclusions || []), JSON.stringify(e.exclusions || []), e.refund_policy,
        e.gender_policy || null, Boolean(e.food), Boolean(e.stay)]
    );
    n++;
  }
  return n;
}
