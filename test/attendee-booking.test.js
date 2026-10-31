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

  // Verify all 4 categories exist
  const cats = await db.query(`SELECT DISTINCT category FROM events WHERE is_demo = true`);
  const catList = cats.rows.map((r) => r.category);
  assert.ok(catList.includes('nightlife'), 'includes nightlife');
  assert.ok(catList.includes('dinner_club'), 'includes dinner_club');
  assert.ok(catList.includes('meetup'), 'includes meetup');
  assert.ok(catList.includes('weekend_trip'), 'includes weekend_trip');

  // Verify free tiers exist for each
  const tiers = await db.query(`SELECT t.* FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.is_demo = true`);
  assert.equal(tiers.rows.length, 4, 'all 4 demo events have active ticket tiers');
  for (const t of tiers.rows) {
    assert.equal(t.kind, 'free', 'tier is free');
    assert.equal(t.price_paise, 0, 'free tier has 0 paise');
    assert.equal(t.active, true, 'tier is active');
  }

  // Idempotency check: running seed again does not duplicate events or tiers
  const n2 = await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
  assert.equal(n2, 4, 'second seed upserts 4 demo events idempotently');
  const countAfter = await db.query(`SELECT count(*)::int AS n FROM events WHERE is_demo = true`);
  assert.equal(countAfter.rows[0].n, 4, 'event count remains exactly 4');
  const tiersAfter = await db.query(`SELECT count(*)::int AS n FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.is_demo = true`);
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

    // Clean up any previous test booking for this user and event
    const userRow = await db.one(`SELECT id FROM users WHERE telegram_user_id = $1`, [REVIEWER_TG_ID]);
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
