// test/attendee-booking.test.js - Phase 3D Attendee Discovery, Free Booking, Mystery Venue & Preview Reviewer
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, Client, db } from './helpers.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { previewReviewerEnabled, REVIEWER_TG_ID } from '../lib/dev-personas.js';

before(startServer);
after(stopServer);

test('seedDemo: seeds 4 synthetic preview events across nightlife, dinners, meetups, trips idempotently', async () => {
  const n1 = await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
  assert.equal(n1, 4, 'first seed upserts 4 demo events');

  // Verify all 4 categories exist for sample preview events
  const cats = await db.query(`SELECT DISTINCT category FROM events WHERE slug LIKE 'sample-%'`);
  const catList = cats.rows.map((r) => r.category);
  assert.ok(catList.includes('nightlife'), 'includes nightlife');
  assert.ok(catList.includes('dinner_club'), 'includes dinner_club');
  assert.ok(catList.includes('meetup'), 'includes meetup');
  assert.ok(catList.includes('weekend_trip'), 'includes weekend_trip');

  // Verify free tiers exist for each sample preview event
  const tiers = await db.query(`SELECT t.* FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.slug LIKE 'sample-%'`);
  assert.equal(tiers.rows.length, 4, 'all 4 sample demo events have active ticket tiers');
  for (const t of tiers.rows) {
    assert.equal(t.kind, 'free', 'tier is free');
    assert.equal(t.price_paise, 0, 'free tier has 0 paise');
    assert.equal(t.active, true, 'tier is active');
  }

  // Idempotency check: running seed again does not duplicate events or tiers
  const n2 = await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
  assert.equal(n2, 4, 'second seed upserts 4 demo events idempotently');
  const countAfter = await db.query(`SELECT count(*)::int AS n FROM events WHERE slug LIKE 'sample-%'`);
  assert.equal(countAfter.rows[0].n, 4, 'event count remains exactly 4');
  const tiersAfter = await db.query(`SELECT count(*)::int AS n FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.slug LIKE 'sample-%'`);
  assert.equal(tiersAfter.rows[0].n, 4, 'tier count remains exactly 4');
});

test('mystery venue presentation: hidden on public pages, teaser displayed, private address never leaked', async () => {
  const c = new Client();
  await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });

  // 1. Discovery list /events
  const list = await c.get('/events');
  assert.equal(list.status, 200);
  assert.match(list.text, /Mystery Venue/, 'event cards show Mystery Venue badge');
  assert.doesNotMatch(list.text, /Secret Terrace|12th Main Road/, 'private address never in public list');
  assert.doesNotMatch(list.text, /The Hidden Bistro|4th Beach Avenue/, 'private address never in public list');

  // 2. Event detail page
  const detail = await c.get('/events/sample-bengaluru-indiranagar-rooftop-mixer');
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Mystery Venue — Revealed after confirmed booking/, 'detail page shows branded teaser');
  assert.match(detail.text, /Indiranagar/, 'public area is shown');
  assert.match(detail.text, /Bengaluru/, 'city is shown');
  assert.doesNotMatch(detail.text, /Secret Terrace|12th Main Road/, 'private address never on public detail page');
  assert.doesNotMatch(detail.text, /Synthetic Test Venue/, 'synthetic private venue never leaks');

  // 3. API endpoint /api/events
  const apiRes = await c.get('/api/events');
  assert.equal(apiRes.status, 200);
  for (const ev of apiRes.json.events) {
    if (ev.slug === 'sample-bengaluru-indiranagar-rooftop-mixer') {
      assert.equal(ev.venue, '', 'public API venue is empty for private venue');
      assert.equal(ev.venuePrivacy, 'disclosed_after_booking');
      assert.equal(ev.area, 'Indiranagar');
    }
  }
});

test('preview reviewer auth: rejected in production, works in preview with restricted guest session', async () => {
  const c = new Client();

  const origVercelEnv = process.env.VERCEL_ENV;
  const origNodeEnv = process.env.NODE_ENV;
  const origIsPreview = process.env.IS_PREVIEW;
  try {
    process.env.VERCEL_ENV = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.IS_PREVIEW;

    assert.equal(previewReviewerEnabled(), false, 'disabled in production');
    const prodRes = await c.post('/api/auth/preview-reviewer', { next: '/me' });
    assert.equal(prodRes.status, 404, 'returns 404 in production');

    // Enable preview test mode
    delete process.env.VERCEL_ENV;
    delete process.env.NODE_ENV;
    process.env.IS_PREVIEW = 'true';

    assert.equal(previewReviewerEnabled(), true, 'enabled in preview test mode');

    // Reviewer signin via JSON
    const authRes = await c.post('/api/auth/preview-reviewer', { next: '/events' }, {
      'accept': 'application/json'
    });
    assert.equal(authRes.status, 200);
    assert.equal(authRes.json.ok, true);
    assert.match(authRes.json.user.alias, /Preview Reviewer/);
    assert.equal(authRes.json.user.ageConfirmed, true);

    // Verify session works and has guest-only privileges (cannot access admin)
    const meRes = await c.get('/api/me');
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.user.alias, 'Preview Reviewer (Synthetic)');

    const adminRes = await c.get('/api/admin/overview');
    assert.equal(adminRes.status, 403, 'preview reviewer has zero admin privileges');
  } finally {
    process.env.VERCEL_ENV = origVercelEnv;
    process.env.NODE_ENV = origNodeEnv;
    process.env.IS_PREVIEW = origIsPreview;
  }
});

test('attendee booking journey: free tier booking, confirmation, ticket pass, and mystery venue unlock', async () => {
  const c = new Client();
  const origIsPreview = process.env.IS_PREVIEW;
  try {
    process.env.IS_PREVIEW = 'true';
    await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });

    // 1. Sign in as preview reviewer
    const loginRes = await c.post('/api/auth/preview-reviewer', { next: '/me' }, {
      'accept': 'application/json'
    });
    assert.equal(loginRes.status, 200);
    c.csrf = loginRes.json.csrf;

    // 2. Get event and free tier id
    const eventRow = await db.one(`SELECT id, slug FROM events WHERE slug = 'sample-bengaluru-indiranagar-rooftop-mixer'`);
    const tierRow = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [eventRow.id]);

    // Clean up any previous test booking and notifications for this user and event
    const userRow = await db.one(`SELECT id FROM users WHERE telegram_user_id = $1`, [REVIEWER_TG_ID]);
    await db.query(`DELETE FROM notifications WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = $1 AND event_id = $2)`, [userRow.id, eventRow.id]);
    await db.query(`DELETE FROM invite_links WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = $1 AND event_id = $2)`, [userRow.id, eventRow.id]);
    await db.query(`DELETE FROM bookings WHERE user_id = $1 AND event_id = $2`, [userRow.id, eventRow.id]);

    // 3. Initiate and place free booking
    const bookRes = await c.post(`/api/events/${eventRow.id}/book`, {
      ticketTypeId: tierRow.id,
      quantity: 1,
      answers: {}
    });
    assert.equal(bookRes.status, 200);
    assert.equal(bookRes.json.ok, true);
    assert.equal(bookRes.json.status, 'confirmed', 'free tier confirms immediately');
    const bookingId = bookRes.json.bookingId;
    assert.ok(bookingId);

    // 4. Retrieve booking details via member API (/api/bookings/:id)
    const getRes = await c.get(`/api/bookings/${bookingId}`);
    assert.equal(getRes.status, 200);
    const bk = getRes.json.booking;
    assert.equal(bk.status, 'confirmed');
    assert.equal(bk.paymentStatus, 'not_required');
    assert.equal(bk.ticket.name, 'Free RSVP Entry');
    assert.equal(bk.ticket.quantity, 1);

    // 5. Mystery Venue is now UNLOCKED for confirmed guest!
    assert.ok(bk.venue, 'venue is disclosed on confirmed booking');
    assert.match(bk.venue, /Secret Terrace, 12th Main Road/);

    // 6. Attendee booking history (/api/me/bookings)
    const myBookings = await c.get('/api/me/bookings');
    assert.equal(myBookings.status, 200);
    assert.ok(myBookings.json.bookings.some((b) => b.id === bookingId && b.status === 'confirmed'));

    // 7. Authorization safety: another unauthenticated client CANNOT access this booking
    const anonClient = new Client();
    const anonRes = await anonClient.get(`/api/bookings/${bookingId}`);
    assert.equal(anonRes.status, 401, 'unauthenticated client rejected');
  } finally {
    process.env.IS_PREVIEW = origIsPreview;
  }
});

test('preview reviewer auth: rate limiting enforced after 30 requests per IP', async () => {
  const c = new Client();
  const origIsPreview = process.env.IS_PREVIEW;
  try {
    process.env.IS_PREVIEW = 'true';
    await db.query(`DELETE FROM rate_limits WHERE key LIKE 'reviewer:%'`);

    for (let i = 0; i < 30; i++) {
      const res = await c.post('/api/auth/preview-reviewer', { next: '/events' }, { 'accept': 'application/json' });
      assert.equal(res.status, 200, `request ${i + 1} succeeds`);
    }

    // 31st request triggers rate limiting (HTTP 429)
    const rateLimitedRes = await c.post('/api/auth/preview-reviewer', { next: '/events' }, { 'accept': 'application/json' });
    assert.equal(rateLimitedRes.status, 429, '31st request returns 429');
    assert.equal(rateLimitedRes.json.error, 'rate_limited');
    assert.ok(rateLimitedRes.headers.get('retry-after'), 'includes Retry-After header');
  } finally {
    process.env.IS_PREVIEW = origIsPreview;
    await db.query(`DELETE FROM rate_limits WHERE key LIKE 'reviewer:%'`);
  }
});

test('re-booking an event returns existing: true and slug in booking detail', async () => {
  const origIsPreview = process.env.IS_PREVIEW;
  try {
    process.env.IS_PREVIEW = 'true';
    const c = new Client();
    await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
    const loginRes = await c.post('/api/auth/preview-reviewer', { next: '/me' }, { 'accept': 'application/json' });
    c.csrf = loginRes.json.csrf;

    const eventRow = await db.one(`SELECT id, slug FROM events WHERE slug = 'sample-bengaluru-indiranagar-rooftop-mixer'`);
    const tierRow = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [eventRow.id]);

    // First booking
    const book1 = await c.post(`/api/events/${eventRow.id}/book`, { ticketTypeId: tierRow.id, quantity: 1, answers: {} });
    assert.equal(book1.status, 200);
    assert.equal(book1.json.ok, true);

    // Re-booking the same event returns existing: true
    const book2 = await c.post(`/api/events/${eventRow.id}/book`, { ticketTypeId: tierRow.id, quantity: 1, answers: {} });
    assert.equal(book2.status, 200);
    assert.equal(book2.json.ok, true);
    assert.equal(book2.json.existing, true, 're-booking returns existing: true');
    assert.equal(book2.json.bookingId, book1.json.bookingId, 'returns same booking id');

    // Retrieve booking: slug must be returned so UI can link back to event
    const getRes = await c.get(`/api/bookings/${book2.json.bookingId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.booking.slug, eventRow.slug, 'slug is provided for back-navigation');
  } finally {
    process.env.IS_PREVIEW = origIsPreview;
  }
});

test('attendee booking authorization isolation: user A cannot access user B booking pass', async () => {
  const origIsPreview = process.env.IS_PREVIEW;
  try {
    process.env.IS_PREVIEW = 'true';
    // User A: preview reviewer
    const clientA = new Client();
    await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
    const loginA = await clientA.post('/api/auth/preview-reviewer', { next: '/me' }, { 'accept': 'application/json' });
    clientA.csrf = loginA.json.csrf;

    const eventRow = await db.one(`SELECT id, slug FROM events WHERE slug = 'sample-bengaluru-indiranagar-rooftop-mixer'`);
    const tierRow = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [eventRow.id]);
    const bookA = await clientA.post(`/api/events/${eventRow.id}/book`, { ticketTypeId: tierRow.id, quantity: 1, answers: {} });
    const bookingIdA = bookA.json.bookingId;

    // User B: distinct user via signedInClient
    const { signedInClient } = await import('./helpers.js');
    const clientB = await signedInClient({ ageConfirmed: true });

    // User B attempts to view User A's booking
    const stolen = await clientB.get(`/api/bookings/${bookingIdA}`);
    assert.equal(stolen.status, 404, 'returns 404 to isolate cross-user booking data');
  } finally {
    process.env.IS_PREVIEW = origIsPreview;
  }
});

test('sold-out event renders clear sold-out notice and rejects bookings', async () => {
  const origIsPreview = process.env.IS_PREVIEW;
  const slug = `test-sold-out-${Date.now()}`;
  try {
    process.env.IS_PREVIEW = 'true';
    const { signedInClient } = await import('./helpers.js');

    // Create an event with capacity 1 and a free tier of quantity 1
    const ev = (await db.query(
      `INSERT INTO events (slug, category, title, city, start_at, end_at, capacity, ticketing, status, published_at, venue_private, venue_privacy)
       VALUES ($1, 'meetup', 'Sold Out Test Meetup', 'Chennai', now() + interval '5 days', now() + interval '5 days 2 hours', 1, 'tiers', 'published', now(), 'Secret Room', 'disclosed_after_booking')
       RETURNING id, slug`, [slug])).rows[0];

    const tier = (await db.query(
      `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
       VALUES ($1, 'Limited Free RSVP', 'free', 0, 1, 1, true)
       RETURNING id`, [ev.id])).rows[0];

    // User 1 books the only seat
    const user1 = await signedInClient({ ageConfirmed: true });
    const b1 = await user1.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1, answers: {} });
    assert.equal(b1.status, 200);

    // Event is now sold out: public page shows sold-out notice
    const anon = new Client();
    const pageHtml = await anon.get(`/events/${ev.slug}`);
    assert.equal(pageHtml.status, 200);
    assert.match(pageHtml.text, /notice-sold-out/, 'renders sold-out notice banner');
    assert.match(pageHtml.text, /This event is sold out/, 'renders clear sold-out copy');

    // User 2 attempts to book: fails due to capacity
    const user2 = await signedInClient({ ageConfirmed: true });
    const b2 = await user2.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1, answers: {} });
    assert.equal(b2.status, 409, 'returns 409 for sold out event');
    assert.equal(b2.json.error, 'sold_out');
  } finally {
    process.env.IS_PREVIEW = origIsPreview;
    await db.query(`DELETE FROM notifications WHERE booking_id IN (SELECT id FROM bookings WHERE event_id IN (SELECT id FROM events WHERE slug LIKE 'test-sold-out%')) OR event_id IN (SELECT id FROM events WHERE slug LIKE 'test-sold-out%')`);
    await db.query(`DELETE FROM invite_links WHERE booking_id IN (SELECT id FROM bookings WHERE event_id IN (SELECT id FROM events WHERE slug LIKE 'test-sold-out%'))`);
    await db.query(`DELETE FROM bookings WHERE event_id IN (SELECT id FROM events WHERE slug LIKE 'test-sold-out%')`);
    await db.query(`DELETE FROM ticket_types WHERE event_id IN (SELECT id FROM events WHERE slug LIKE 'test-sold-out%')`);
    await db.query(`DELETE FROM events WHERE slug LIKE 'test-sold-out%'`);
  }
});

