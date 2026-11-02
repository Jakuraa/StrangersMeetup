// scripts/seed-local.js - Reproducible LOCAL dataset: test personas (lib/dev-personas.js), their
// orgs and venues, and events in known states, for manual testing and the browser suite. Usage: npm run seed:local
//
// Guarded by seed-guard.js (kind 'local'): never on Vercel, never in production, and only a
// database on this machine — there is no remote override. Every run first deletes what earlier
// runs (and tests) created for the personas, then inserts the same data again, so two runs in a
// row produce identical counts. Nothing outside the persona id range or `local-*` demo events is touched.
import { fileURLToPath } from 'node:url';
import '../lib/config.js'; // loads a local .env (never on Vercel)
import { db, migrate } from '../lib/db.js';
import { PERSONAS, PERSONA_KEYS, PERSONA_TG_IDS, PERSONA_ORGS, REVIEWER_TG_ID } from '../lib/dev-personas.js';
import { ensurePersonalOrg } from '../lib/services/permissions.js';
import { assertSeedAllowed, SeedRefused } from './seed-guard.js';
import { at } from './seed-demo.js';

const HOUR = 3_600_000;

// owner: persona key. tiers: [name, kind, price_paise, quantity, max_per_booking]. All is_demo=true.
// single: { price, spUrl? } = a standard one-price event; with spUrl it is sold through SuperProfile.
export const LOCAL_EVENTS = [
  {
    slug: 'local-board-games-night', owner: 'organiser', category: 'board_games', city: 'Chennai', area: 'Besant Nagar',
    title: 'Test: Board games night', venue: 'Test venue — 14 Elliot’s Beach Rd, Besant Nagar (private)',
    start: [7, 18, 30], hours: 3, capacity: 20, tiers: [['General', 'free', 0, 20, 2]]
  },
  {
    slug: 'local-sunday-picnic', owner: 'organiser', category: 'meetup', city: 'Bengaluru', area: 'Cubbon Park',
    title: 'Test: Sunday picnic (open for booking)', venue: 'Test venue — Bandstand lawn, gate 3 (private)',
    start: [9, 10, 0], hours: 3, capacity: 30, tiers: [['Free entry', 'free', 0, 30, 2]]
  },
  {
    slug: 'local-approval-dinner', owner: 'organiser', category: 'dinner_club', city: 'Chennai', area: 'Nungambakkam',
    title: 'Test: Dinner club (host approves guests)', venue: 'Test venue — 3rd floor, 22 Khader Nawaz Khan Rd (private)',
    start: [11, 20, 0], hours: 2.5, capacity: 12, approval: true, tiers: [['Seat', 'free', 0, 12, 1]],
    questions: [{ id: 'work', label: 'College or work', type: 'short', required: false }]
  },
  {
    slug: 'local-paid-workshop', owner: 'organiser', category: 'workshop', city: 'Kochi', area: 'Fort Kochi',
    title: 'Test: Pottery workshop (paid — payments off)', venue: 'Test venue — Studio 5, Princess St (private)',
    start: [13, 16, 0], hours: 2, capacity: 10, tiers: [['Workshop seat', 'paid', 149900, 10, 2]]
  },
  {
    slug: 'local-sp-social', owner: 'organiser', category: 'meetup', city: 'Chennai', area: 'Alwarpet',
    title: 'Test: Social meetup (tickets on SuperProfile)', venue: 'Test venue — 8 TTK Rd, Alwarpet (private)',
    start: [12, 18, 0], hours: 3, capacity: 25, single: { price: 49900, spUrl: 'https://superprofile.bio/meetup_host/local-sp-social', productId: 'local-sp-social-prod' }
  },
  {
    slug: 'local-sp-unlinked', owner: 'organiser', category: 'meetup', city: 'Chennai', area: 'Mylapore',
    title: 'Test: Paid meetup (no SuperProfile product yet)', venue: 'Test venue — Mylapore tank (private)',
    start: [14, 18, 0], hours: 3, capacity: 25, single: { price: 39900 }
  },
  {
    slug: 'local-low-seats-trek', owner: 'organiser2', category: 'weekend_trip', city: 'Bengaluru', area: 'Nandi Hills',
    title: 'Test: Sunrise trek (1 seat left)', venue: 'Test pickup — Hebbal flyover bus stop (private)',
    start: [8, 4, 30], hours: 6, capacity: 3, tiers: [['Trek seat', 'free', 0, 3, 2]]
  },
  {
    slug: 'local-sold-out-mixer', owner: 'organiser2', category: 'dating_mixer', city: 'Hyderabad', area: 'Jubilee Hills',
    title: 'Test: Slow dating mixer (sold out)', venue: 'Test venue — Road No. 36 rooftop (private)',
    start: [10, 19, 0], hours: 3, capacity: 2, tiers: [['Entry', 'free', 0, 2, 2]]
  },
  {
    slug: 'local-past-meetup', owner: 'organiser', category: 'meetup', city: 'Chennai', area: 'Adyar',
    title: 'Test: Coffee meetup (completed)', venue: 'Test venue — Adyar café (private)',
    start: [-5, 17, 0], hours: 2, capacity: 15, tiers: [['General', 'free', 0, 15, 1]]
  },
  {
    slug: 'local-cancelled-movie', owner: 'organiser2', category: 'movie', city: 'Bengaluru', area: 'Koramangala',
    title: 'Test: Movie night (cancelled)', venue: 'Test venue — Koramangala screening room (private)',
    start: [6, 21, 0], hours: 3, capacity: 25, status: 'cancelled', tiers: [['General', 'free', 0, 25, 2]]
  }
];

// [persona, event slug, status, quantity, extra]
export const LOCAL_BOOKINGS = [
  ['guest', 'local-board-games-night', 'confirmed', 1],
  ['guest2', 'local-approval-dinner', 'pending_approval', 1, { answers: { work: 'Test answer: design student' } }],
  ['guest2', 'local-low-seats-trek', 'confirmed', 2],
  ['guest', 'local-sold-out-mixer', 'confirmed', 2],
  ['guest', 'local-past-meetup', 'checked_in', 1],
  ['guest2', 'local-past-meetup', 'confirmed', 1],
  ['guest2', 'local-cancelled-movie', 'cancelled', 1]
];

// [persona, title]: unfinished wizard drafts, one per organiser (owner-scoping is visible in tests).
export const LOCAL_DRAFTS = [
  ['organiser', 'Test draft: Book swap brunch'],
  ['organiser2', 'Test draft: Night cycling tour']
];

// Moderation rows for the admin console. Leads carry payload.seed = 'local' so a re-seed removes exactly these.
export const LOCAL_LEADS = [
  ['venue', { seed: 'local', name: 'Test Venue Owner', email: 'venue@example.test', message: 'Rooftop for 40 guests. Menu: https://example.test/menu/' + 'x'.repeat(96) }],
  ['host', { seed: 'local', name: 'Test Host', email: 'host@example.test', message: 'I run a weekly board games meetup.' }]
];
export const LOCAL_REPORTS = [['guest', 'Test report: someone at the last event made me uncomfortable.\nPlease review. Ref: TEST-0001']];

/** Remove everything earlier runs created for the personas and synthetic reviewer. Order follows the foreign keys. */
async function clearPersonaData(c) {
  const allTestTgIds = [...PERSONA_TG_IDS, REVIEWER_TG_ID];
  await c.query(`CREATE TEMP TABLE _pu ON COMMIT DROP AS SELECT id FROM users WHERE telegram_user_id = ANY($1::bigint[])`, [allTestTgIds]);
  await c.query(`CREATE TEMP TABLE _pe ON COMMIT DROP AS
    SELECT id FROM events WHERE organiser_user_id IN (SELECT id FROM _pu) OR (is_demo AND slug LIKE 'local-%')`);
  await c.query(`CREATE TEMP TABLE _pb ON COMMIT DROP AS
    SELECT id FROM bookings WHERE event_id IN (SELECT id FROM _pe) OR user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM invite_links WHERE user_id IN (SELECT id FROM _pu) OR booking_id IN (SELECT id FROM _pb)`);
  await c.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM _pu) OR booking_id IN (SELECT id FROM _pb)
    OR event_id IN (SELECT id FROM _pe) OR entitlement_id IN (SELECT id FROM entitlements WHERE user_id IN (SELECT id FROM _pu))`);
  await c.query(`DELETE FROM entitlements WHERE user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM external_orders WHERE event_id IN (SELECT id FROM _pe) OR matched_booking_id IN (SELECT id FROM _pb)`);
  await c.query(`DELETE FROM checkout_intents WHERE event_id IN (SELECT id FROM _pe) OR user_id IN (SELECT id FROM _pu)`);
  await c.query(`UPDATE bookings SET payment_id = NULL WHERE id IN (SELECT id FROM _pb)`);
  await c.query(`DELETE FROM payments WHERE user_id IN (SELECT id FROM _pu) OR booking_id IN (SELECT id FROM _pb)`);
  await c.query(`UPDATE bookings SET decided_by = NULL WHERE decided_by IN (SELECT id FROM _pu) AND id NOT IN (SELECT id FROM _pb)`);
  await c.query(`DELETE FROM bookings WHERE id IN (SELECT id FROM _pb)`);
  await c.query(`DELETE FROM ticket_types WHERE event_id IN (SELECT id FROM _pe)`);
  await c.query(`DELETE FROM analytics_events WHERE event_id IN (SELECT id FROM _pe)`);
  await c.query(`DELETE FROM user_blocks WHERE blocker_user_id IN (SELECT id FROM _pu) OR blocked_user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM reports WHERE user_id IN (SELECT id FROM _pu) OR reported_user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM leads WHERE payload->>'seed' = 'local'`);
  await c.query(`UPDATE event_drafts SET event_id = NULL WHERE organiser_user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM events WHERE id IN (SELECT id FROM _pe)`);
  await c.query(`DELETE FROM event_images WHERE owner_user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM event_drafts WHERE organiser_user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM _pu)`);
  // Orgs: the personas' personal orgs and every org a persona owns (only personas are ever in them).
  await c.query(`CREATE TEMP TABLE _po ON COMMIT DROP AS
    SELECT id FROM organisations WHERE personal_user_id IN (SELECT id FROM _pu)
    UNION SELECT org_id FROM org_memberships WHERE role = 'owner' AND user_id IN (SELECT id FROM _pu)`);
  await c.query(`UPDATE events SET organiser_org_id = NULL WHERE organiser_org_id IN (SELECT id FROM _po)`);
  await c.query(`DELETE FROM event_team WHERE org_id IN (SELECT id FROM _po) OR user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM venues WHERE org_id IN (SELECT id FROM _po)`);
  await c.query(`DELETE FROM org_memberships WHERE org_id IN (SELECT id FROM _po) OR user_id IN (SELECT id FROM _pu)`);
  await c.query(`DELETE FROM organisations WHERE id IN (SELECT id FROM _po)`);
  await c.query(`DELETE FROM user_capabilities WHERE user_id IN (SELECT id FROM _pu)`);
}

async function insertPersonas(c) {
  const ids = {};
  for (const key of PERSONA_KEYS) {
    const p = PERSONAS[key];
    const u = (await c.query(
      `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, organiser_enabled, status, city)
       VALUES ($1, $2, true, now(), $3, 'active', 'Chennai')
       ON CONFLICT (telegram_user_id) DO UPDATE SET alias = EXCLUDED.alias, age_confirmed_21 = true,
         age_confirmed_at = COALESCE(users.age_confirmed_at, now()), organiser_enabled = EXCLUDED.organiser_enabled, status = 'active'
       RETURNING id`, [p.tg, p.alias, Boolean(p.organiser)])).rows[0];
    ids[key] = u.id;
    for (const cap of p.capabilities || []) {
      await c.query(`INSERT INTO user_capabilities (user_id, capability_code, status) VALUES ($1, $2, 'claimed')`, [u.id, cap]);
    }
    if (p.organiser) {
      await ensurePersonalOrg({ id: u.id, alias: p.alias }, c);
    }
    if (p.adminRole) {
      await c.query(
        `INSERT INTO admin_users (telegram_user_id, role, active) VALUES ($1, $2, true)
         ON CONFLICT (telegram_user_id) DO UPDATE SET role = EXCLUDED.role, active = true`, [p.tg, p.adminRole]);
    } else {
      await c.query('DELETE FROM admin_users WHERE telegram_user_id = $1', [p.tg]);
    }
  }
  return ids;
}

/** Team and venue orgs (PERSONA_ORGS). Returns org ids by name. */
async function insertOrgs(c, users) {
  const orgs = {};
  for (const o of PERSONA_ORGS) {
    const org = (await c.query(`INSERT INTO organisations (kind, name, verified_at) VALUES ($1, $2, now()) RETURNING id`, [o.kind, o.name])).rows[0];
    for (const [who, role] of o.members) {
      await c.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES ($1, $2, $3)`, [users[who], org.id, role]);
    }
    for (const v of o.venues || []) {
      await c.query(`INSERT INTO venues (org_id, name, capacity, address_private, lat, lng) VALUES ($1, $2, $3, $4, $5, $6)`,
        [org.id, v.name, v.capacity, v.address, v.lat, v.lng]);
    }
    orgs[o.name] = org.id;
  }
  return orgs;
}

/** Which org runs a persona's events: the team org it owns, else its personal org. */
async function eventOrgFor(c, userId) {
  const r = (await c.query(
    `SELECT o.id FROM org_memberships m JOIN organisations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.role = 'owner' ORDER BY (o.kind = 'organiser_team') DESC, o.created_at LIMIT 1`, [userId])).rows[0];
  return r?.id || null;
}

async function insertEvents(c, users) {
  const events = {};
  for (const e of LOCAL_EVENTS) {
    const start = at(...e.start);
    const end = new Date(new Date(start).getTime() + e.hours * HOUR).toISOString();
    const status = e.status || 'published';
    const row = (await c.query(
      `INSERT INTO events (slug, category, title, summary, description, city, area_public, venue_private, venue_privacy,
         start_at, end_at, capacity, price_status, organizer, organiser_user_id, ticketing, requires_approval,
         booking_questions, refund_policy, status, is_demo, published_at, ticket_price_paise,
         superprofile_url, superprofile_product_id, checkout_mode, organiser_org_id)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 'disclosed_after_booking', $8, $9, $10, $16, $11, $12, $17, $13,
         $14, 'Local test data — no money changes hands.', $15, true, now(), $18, $19, $20, $21::checkout_mode, $22)
       RETURNING id`,
      [e.slug, e.category, e.title, 'Local test event created by npm run seed:local.', e.city, e.area, e.venue, start, end,
        e.capacity, PERSONAS[e.owner].alias, users[e.owner], Boolean(e.approval), JSON.stringify(e.questions || []), status,
        e.single ? 'set' : 'tbd', e.single ? 'single' : 'tiers', e.single?.price ?? null, e.single?.spUrl ?? null,
        e.single?.productId ?? null, e.single?.spUrl ? 'superprofile' : 'none', await eventOrgFor(c, users[e.owner])])).rows[0];
    const tiers = [];
    for (const [i, [name, kind, price, quantity, max]] of (e.tiers || []).entries()) {
      tiers.push((await c.query(
        `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [row.id, name, kind, price, quantity, max, i])).rows[0].id);
    }
    events[e.slug] = { id: row.id, tierId: tiers[0] };
  }
  return events;
}

async function insertBookings(c, users, events) {
  for (const [who, slug, status, qty, extra = {}] of LOCAL_BOOKINGS) {
    const ev = events[slug];
    await c.query(
      `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, answers, amount_paise, status, payment_mode,
         confirmed_at, checked_in_at, cancelled_at, cancel_reason)
       VALUES ($1, $2, $3, $4, $5, 0, $6::text::booking_status, CASE WHEN $6::text = 'pending_approval' THEN NULL ELSE 'free' END,
         CASE WHEN $6::text IN ('confirmed', 'checked_in') THEN now() END,
         CASE WHEN $6::text = 'checked_in' THEN now() END,
         CASE WHEN $6::text = 'cancelled' THEN now() END,
         CASE WHEN $6::text = 'cancelled' THEN 'event_cancelled' END)`,
      [ev.id, users[who], ev.tierId, qty, JSON.stringify(extra.answers || {}), status]);
  }
}

async function insertDrafts(c, users) {
  for (const [who, title] of LOCAL_DRAFTS) {
    await c.query(`INSERT INTO event_drafts (organiser_user_id, data, step) VALUES ($1, $2, 'basics')`,
      [users[who], JSON.stringify({ template: 'general', category: 'meetup', timezone: 'Asia/Kolkata', title, tickets: [] })]);
  }
}

async function insertModeration(c, users) {
  for (const [type, payload] of LOCAL_LEADS) {
    await c.query(`INSERT INTO leads (type, payload) VALUES ($1::lead_type, $2)`, [type, JSON.stringify(payload)]);
  }
  for (const [who, body] of LOCAL_REPORTS) await c.query(`INSERT INTO reports (user_id, body) VALUES ($1, $2)`, [users[who], body]);
}

/** A little funnel data across the 7/30/90-day insight windows, attributed to the seeded events. */
async function insertAnalytics(c, events) {
  const ids = Object.values(events).map((e) => e.id);
  await c.query(
    `INSERT INTO analytics_events (name, event_id, path, at)
     SELECT a.name, e.id, '/events', now() - make_interval(days => a.days)
       FROM unnest($1::uuid[]) AS e(id)
      CROSS JOIN (VALUES ('event_view', 2), ('event_view', 12), ('book_click', 3), ('event_view', 45), ('book_click', 70)) AS a(name, days)`,
    [ids]);
}

/** Seed (or re-seed) the local dataset. Returns row counts for the personas' data. */
export async function seedLocal({ e = process.env } = {}) {
  assertSeedAllowed({ kind: 'local', e });
  return db.tx(async (c) => {
    await clearPersonaData(c);
    const users = await insertPersonas(c);
    await insertOrgs(c, users);
    const events = await insertEvents(c, users);
    await insertBookings(c, users, events);
    await insertDrafts(c, users);
    await insertModeration(c, users);
    await insertAnalytics(c, events);
    return countLocal(c);
  });
}

export async function countLocal(c = db) {
  return (await c.query(
    `WITH pu AS (SELECT id FROM users WHERE telegram_user_id = ANY($1::bigint[])),
          pe AS (SELECT id FROM events WHERE organiser_user_id IN (SELECT id FROM pu))
     SELECT (SELECT count(*)::int FROM pu) AS users,
            (SELECT count(*)::int FROM admin_users WHERE telegram_user_id = ANY($1::bigint[])) AS admins,
            (SELECT count(*)::int FROM pe) AS events,
            (SELECT count(*)::int FROM ticket_types WHERE event_id IN (SELECT id FROM pe)) AS ticket_types,
            (SELECT count(*)::int FROM bookings WHERE event_id IN (SELECT id FROM pe)) AS bookings,
            (SELECT count(*)::int FROM event_drafts WHERE organiser_user_id IN (SELECT id FROM pu)) AS drafts,
            (SELECT count(*)::int FROM analytics_events WHERE event_id IN (SELECT id FROM pe)) AS analytics,
            (SELECT count(*)::int FROM leads WHERE payload->>'seed' = 'local') AS leads,
            (SELECT count(*)::int FROM reports WHERE user_id IN (SELECT id FROM pu)) AS reports,
            (SELECT count(DISTINCT org_id)::int FROM org_memberships WHERE user_id IN (SELECT id FROM pu)) AS orgs,
            (SELECT count(*)::int FROM org_memberships WHERE user_id IN (SELECT id FROM pu)) AS memberships,
            (SELECT count(*)::int FROM venues WHERE org_id IN (SELECT org_id FROM org_memberships WHERE user_id IN (SELECT id FROM pu))) AS venues`,
    [PERSONA_TG_IDS])).rows[0];
}

async function main() {
  try {
    assertSeedAllowed({ kind: 'local' }); // before migrating, so a refused seed changes nothing
  } catch (err) {
    console.error(`[seed:local] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    await migrate({ log: false });
    const counts = await seedLocal();
    console.log('[seed:local] done', counts);
    console.log('[seed:local] personas (sign in at /signin with DEV_LOGIN=true):');
    for (const k of PERSONA_KEYS) console.log(`  ${k.padEnd(11)} ${PERSONAS[k].alias.padEnd(22)} ${PERSONAS[k].role.padEnd(22)} → ${PERSONAS[k].landing}`);
  } catch (err) {
    console.error(`[seed:local] ${err instanceof SeedRefused ? '' : 'failed: '}${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
