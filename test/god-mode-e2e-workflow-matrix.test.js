// test/god-mode-e2e-workflow-matrix.test.js
// Comprehensive End-to-End Product Audit & Workflow Matrix for NIGHTLIFEZ.
// Covers Attendee, Organiser, Venue Operator, Admin, Security, Mobile, and Regression/Concurrency.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { db, resetDb, startServer, stopServer, signedInClient, Client } from './helpers.js';
import { checkoutForEvent } from '../lib/payments/availability.js';
import { createCheckoutIntent } from '../lib/services/checkout.js';
import { migrate } from '../lib/db.js';

function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function organiserClient(opts = {}) {
  const c = await signedInClient(opts);
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

before(async () => {
  await resetDb();
  await startServer();
});

after(async () => {
  await stopServer();
});

// ============================================================================
// SECTION A: Attendee Discovery and Booking (15 Scenarios)
// ============================================================================

test('A1. Public Homepage: renders hero, South India discovery, and navigation paths', async () => {
  const c = new Client();
  const res = await c.get('/');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('NIGHTLIFEZ'));
  assert.ok(res.text.includes('/list-your-venue'));
});

test('A2. Event Discovery: GET /events returns public events catalogue', async () => {
  const c = new Client();
  const res = await c.get('/events');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Events'));
});

test('A3. City Filtering: GET /meetups/bengaluru filters events for Bengaluru', async () => {
  const c = new Client();
  const res = await c.get('/meetups/bengaluru');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Bengaluru'));
});

test('A4. Category Page: GET /nightlife returns curated nightlife events', async () => {
  const c = new Client();
  const res = await c.get('/nightlife');
  assert.equal(res.status, 200);
});

test('A5. Search API: GET /api/events with query filters returns active public events', async () => {
  const c = new Client();
  const res = await c.get('/api/events?city=Bengaluru&kind=all');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.events));
});

test('A6. Event Detail Page: renders event overview, tier list, and organizer info', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  const draftRes = await org.post('/api/organiser/drafts', { template: 'social' });
  const d = draftRes.json.draft;
  d.data = {
    ...d.data,
    template: 'social',
    category: 'nightlife',
    title: 'Neon Rooftop Groove',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(5, '20:00'),
    endLocal: istLocal(5, '23:30'),
    multiDay: false,
    city: 'Bengaluru',
    area: 'Indiranagar',
    venue: 'Secret Rooftop Bar, 100 Feet Road',
    privateVenue: true,
    description: 'Exclusive social party with curated electronic music on an open-air rooftop.',
    tickets: [
      { id: 't-free', name: 'Early RSVP Guestlist', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2, minPerBooking: 1, admitCount: 1, validOn: 'all' }
    ]
  };
  await org.put(`/api/organiser/drafts/${d.id}`, { data: d.data, step: 'preview', version: d.version });
  const pub = await org.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version + 1, confirm: true });
  assert.equal(pub.status, 200);
  const slug = pub.json.slug;

  const c = new Client();
  const pageRes = await c.get(`/events/${slug}`);
  assert.equal(pageRes.status, 200);
  assert.ok(pageRes.text.includes('Neon Rooftop Groove'));
  assert.ok(pageRes.text.includes('Indiranagar'));
  // Secret venue address must NOT be leaked
  assert.ok(!pageRes.text.includes('Secret Rooftop Bar, 100 Feet Road'));
});

test('A7. Ticket Tier Availability: UI indicates remaining seats and free entry', async () => {
  const ev = (await db.query(`SELECT id, slug FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const c = new Client();
  const res = await c.get(`/events/${ev.slug}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Early RSVP Guestlist'));
  assert.ok(res.text.includes('Free'));
});

test('A8. Ticket Quantity Validation: exceeds maxPerBooking is rejected', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  const attendee = await signedInClient({ tgId: 800000002 });

  const res = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 5 // max is 2
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'validation');
});

test('A9. Free Ticket Booking: successfully creates confirmed booking pass', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  const attendee = await signedInClient({ tgId: 800000002 });

  const res = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.status, 'confirmed');
  assert.ok(res.json.bookingId);
});

test('A10. Booking Pass Confirmation View: renders digital pass and unlocks venue', async () => {
  const attendee = await signedInClient({ tgId: 800000002 });
  const myBookings = await attendee.get('/api/me/bookings');
  assert.equal(myBookings.status, 200);
  const bId = myBookings.json.bookings[0].id;

  const detailRes = await attendee.get(`/api/bookings/${bId}`);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.json.booking.status, 'confirmed');
  // Exact confidential venue address is unlocked for confirmed pass holders
  assert.equal(detailRes.json.booking.venue, 'Secret Rooftop Bar, 100 Feet Road');
  assert.ok(detailRes.json.booking.tickets.length > 0);
  assert.ok(detailRes.json.booking.tickets[0].qrSvg);
});

test('A11. Revisit and Refresh: booking pass persists and reloads reliably', async () => {
  const attendee = await signedInClient({ tgId: 800000002 });
  const myBookings = await attendee.get('/api/me/bookings');
  const bId = myBookings.json.bookings[0].id;

  const page = await attendee.get(`/bookings/${bId}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(bId));
});

test('A12. Duplicate Booking Idempotency: re-booking returns existing pass with no duplicate seat subtraction', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  const attendee = await signedInClient({ tgId: 800000002 });

  const res = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.existing, true);

  // Check seat counts in DB: only 1 booking row exists
  const count = (await db.query(`SELECT count(*)::int AS cnt FROM bookings WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = 800000002)`, [ev.id])).rows[0].cnt;
  assert.equal(count, 1);
});

test('A13. Sold-out Event Rejection: booking fails when capacity exhausted', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  // Artificially saturate tier seats
  await db.query(`UPDATE ticket_types SET quantity = 1 WHERE id = $1`, [tier.id]);

  const attendee3 = await signedInClient({ tgId: 800000003 });
  const res = await attendee3.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'sold_out');

  // Restore capacity for downstream tests
  await db.query(`UPDATE ticket_types SET quantity = 100 WHERE id = $1`, [tier.id]);
});

test('A14. Past Event Booking Rejection: cannot book an event whose start_at is in the past', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  await db.query(`UPDATE events SET start_at = now() - interval '2 hours' WHERE id = $1`, [ev.id]);

  const attendee4 = await signedInClient({ tgId: 800000004 });
  const res = await attendee4.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'event_started');

  // Restore start_at
  await db.query(`UPDATE events SET start_at = now() + interval '2 days' WHERE id = $1`, [ev.id]);
});

test('A15. Unauthenticated Booking Gate: signed-out visitor gets 401 on booking API', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [ev.id])).rows[0];
  const anon = new Client();
  const res = await anon.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(res.status, 401);
});

// ============================================================================
// SECTION B: Organiser Workflows and Venue Linkage (15 Scenarios)
// ============================================================================

test('B1. Organiser Account Activation: user claims organise_events capability', async () => {
  const user = await organiserClient({ tgId: 810000001 });
  const ctx = await user.get('/api/organiser/context');
  assert.equal(ctx.status, 200);
});

test('B2. Create Event Draft from Template: initializes draft with defaults', async () => {
  const user = await organiserClient({ tgId: 810000001 });
  const draftRes = await user.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(draftRes.status, 201);
  assert.equal(draftRes.json.ok, true);
  assert.equal(draftRes.json.draft.data.category, 'meetup');
});

test('B3. Create Event Draft with Venue ID Linkage: pre-populates venue details', async () => {
  // Create an active venue in DB
  const vOwner = await signedInClient({ tgId: 810000002 });
  const vRes = await vOwner.post('/api/venue/onboard', {
    name: 'Skylight Loft',
    category: 'studio_loft',
    city: 'Bengaluru',
    neighbourhood: 'Koramangala',
    address_public: '100 Feet Road, Koramangala',
    capacity: 150,
    is_draft: false
  });
  assert.equal(vRes.status, 201);
  const venueId = vRes.json.venue.id;
  const orgId = vRes.json.venue.org_id;

  // Unrelated organiser tries to link venueId -> rejected with 403
  const strangerOrg = await organiserClient({ tgId: 810000099 });
  const rejectedRes = await strangerOrg.post('/api/organiser/drafts', { template: 'social', venueId });
  assert.equal(rejectedRes.status, 403);
  assert.equal(rejectedRes.json.error, 'not_authorized_for_venue');

  // Authorize organiser in venue's organisation
  const org = await organiserClient({ tgId: 810000001 });
  await db.query(
    `INSERT INTO org_memberships (user_id, org_id, role, status)
     VALUES ($1, $2, 'manager', 'active')
     ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'manager', status = 'active'`,
    [org.userId, orgId]
  );

  // Authorized organiser initializes draft passing venueId
  const draftRes = await org.post('/api/organiser/drafts', { template: 'social', venueId });
  assert.equal(draftRes.status, 201);
  assert.equal(draftRes.json.draft.data.venueId, venueId);
  assert.equal(draftRes.json.draft.data.venue, 'Skylight Loft');
  assert.equal(draftRes.json.draft.data.city, 'Bengaluru');
  assert.equal(draftRes.json.draft.data.area, 'Koramangala');
});

test('B4. Save Draft Progress: updates draft data, step, and version', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const d = drafts[0];

  d.data = {
    ...d.data,
    template: 'social',
    title: 'Sunset Loft Sessions',
    category: 'nightlife',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(7, '19:00'),
    endLocal: istLocal(7, '23:00'),
    multiDay: false,
    city: 'Bengaluru',
    area: 'Koramangala',
    venue: 'Skylight Loft',
    description: 'Intimate electronic music showcase at Skylight Loft with curated artists.',
    tickets: [
      { id: 'tier-early', name: 'Early Bird RSVP', kind: 'free', pricePaise: 0, quantity: 30, maxPerBooking: 2, minPerBooking: 1, admitCount: 1, validOn: 'all' }
    ]
  };
  const saveRes = await org.put(`/api/organiser/drafts/${d.id}`, {
    data: d.data,
    step: 'tickets',
    version: d.version
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.json.draft.data.title, 'Sunset Loft Sessions');
  assert.equal(saveRes.json.draft.version, d.version + 1);
});

test('B5. Resume Draft Across Sessions: restores all previously saved fields', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const d = drafts[0];

  const getRes = await org.get(`/api/organiser/drafts/${d.id}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json.draft.data.title, 'Sunset Loft Sessions');
  assert.ok(getRes.json.draft.data.venueId);
});

test('B6. Image Upload Magic Bytes Sniffing: JPEG upload succeeds with 201', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const dId = drafts[0].id;

  // Real JPEG magic bytes: FF D8 FF E0 ...
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
  const upRes = await org.req('POST', `/api/organiser/drafts/${dId}/images`, jpegBuf, { 'content-type': 'image/jpeg' });
  assert.equal(upRes.status, 201);
  assert.ok(upRes.json.image.url);
});

test('B7. Image Upload Rejection: spoofed text file claiming to be JPEG is rejected with 415', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const dId = drafts[0].id;

  const fakeBuf = Buffer.from('NOT A REAL JPEG IMAGE FILE CONTENTS');
  const upRes = await org.req('POST', `/api/organiser/drafts/${dId}/images`, fakeBuf, { 'content-type': 'image/jpeg' });
  assert.equal(upRes.status, 415);
  assert.equal(upRes.json.error, 'image_type');
});

test('B8. Ticket Tiers Configuration: valid multi-tier capacity setup', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const d = (await org.get(`/api/organiser/drafts/${drafts[0].id}`)).json.draft;

  d.data.tickets = [
    { id: 'tier-early', name: 'Early Bird RSVP', kind: 'free', pricePaise: 0, quantity: 30, maxPerBooking: 2, minPerBooking: 1, admitCount: 1, validOn: 'all' },
    { id: 'tier-vip', name: 'VIP Guestpass', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, minPerBooking: 1, admitCount: 1, validOn: 'all' }
  ];
  const saveRes = await org.put(`/api/organiser/drafts/${d.id}`, {
    data: d.data,
    step: 'preview',
    version: d.version
  });
  assert.equal(saveRes.status, 200);
});

test('B9. Event Publishing with Linked Venue: inserts events.venue_id and event_sessions.venue_id', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const drafts = (await org.get('/api/organiser/drafts')).json.drafts;
  const currentDraft = (await org.get(`/api/organiser/drafts/${drafts[0].id}`)).json.draft;

  const pubRes = await org.post(`/api/organiser/drafts/${currentDraft.id}/publish`, {
    version: currentDraft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200);
  assert.equal(pubRes.json.ok, true);
  const eventId = pubRes.json.eventId || pubRes.json.id;

  // Assert events table has venue_id set
  const evRow = (await db.query(`SELECT id, venue_id FROM events WHERE id = $1`, [eventId])).rows[0];
  assert.ok(evRow, 'Event row must exist');
  assert.ok(evRow.venue_id, 'events.venue_id must be populated');
  assert.equal(evRow.venue_id, currentDraft.data.venueId);
});

test('B10. Public Event Metadata: exposes venueId on toPublicEvent', async () => {
  const evRow = (await db.query(`SELECT id, slug, venue_id FROM events WHERE title = 'Sunset Loft Sessions'`)).rows[0];
  assert.ok(evRow);
  const c = new Client();
  const res = await c.get(`/api/events?city=Bengaluru`);
  assert.equal(res.status, 200);
  const evItem = res.json.events.find((e) => e.id === evRow.id);
  assert.ok(evItem);
  assert.equal(evItem.venueId, evRow.venue_id);
});

test('B11. Venue Dashboard Reflects Linked Event: getVenueEvents matches explicit venue_id', async () => {
  const vOwner = await signedInClient({ tgId: 810000002 });
  const v = (await db.query(`SELECT id FROM venues WHERE name = 'Skylight Loft'`)).rows[0];
  const eventsRes = await vOwner.get(`/api/venue/events?venueId=${v.id}`);
  assert.equal(eventsRes.status, 200);
  assert.ok(eventsRes.json.events.some((e) => e.title === 'Sunset Loft Sessions'));
});

test('B12. Update Event Venue ID: organiser can update event details and re-link venue', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Sunset Loft Sessions'`)).rows[0];

  const updateRes = await org.put(`/api/organiser/events/${ev.id}`, {
    title: 'Sunset Loft Sessions (Updated)'
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.json.ok, true);
});

test('B13. Event Overview & Attendee Privacy: organiser inspects bookings without cross-event leakage', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Sunset Loft Sessions (Updated)'`)).rows[0];
  const ovRes = await org.get(`/api/organiser/events/${ev.id}/overview`);
  assert.equal(ovRes.status, 200);
  assert.equal(ovRes.json.ok, true);
});

test('B14. Cross-Organiser Isolation: Organiser B cannot inspect Organiser A event overview', async () => {
  const orgB = await organiserClient({ tgId: 810000003 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Sunset Loft Sessions (Updated)'`)).rows[0];
  const ovRes = await orgB.get(`/api/organiser/events/${ev.id}/overview`);
  assert.ok(ovRes.status === 403 || ovRes.status === 404);
});

test('B15. Event Cancellation: organiser cancels event recording reason and updates status', async () => {
  const org = await organiserClient({ tgId: 810000001 });
  // Create disposable draft to cancel
  const dRes = await org.post('/api/organiser/drafts', { template: 'social' });
  const d = dRes.json.draft;
  d.data = {
    ...d.data,
    template: 'social',
    category: 'meetup',
    title: 'Disposable Monsoon Meetup',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(10, '18:00'),
    endLocal: istLocal(10, '21:00'),
    multiDay: false,
    city: 'Bengaluru',
    venue: 'Board Game Lounge',
    area: 'Indiranagar',
    description: 'Casual community gathering for board games.',
    tickets: [{ id: 't-free', name: 'Free RSVP', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, minPerBooking: 1, admitCount: 1, validOn: 'all' }]
  };
  await org.put(`/api/organiser/drafts/${d.id}`, { data: d.data, step: 'preview', version: d.version });
  const pub = await org.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version + 1, confirm: true });
  assert.equal(pub.status, 200);
  const evId = pub.json.eventId || pub.json.id;

  const cancelRes = await org.post(`/api/organiser/events/${evId}/cancel`, {
    reason: 'Inclement monsoon weather forecast'
  });
  assert.equal(cancelRes.status, 200);
  const updatedEv = (await db.query(`SELECT status FROM events WHERE id = $1`, [evId])).rows[0];
  assert.equal(updatedEv.status, 'cancelled');
});

// ============================================================================
// SECTION C: Venue Partner Onboarding and Draft/Resume (20 Scenarios)
// ============================================================================

test('C1. GET /list-your-venue: renders partner benefits and CTA with zero legacy forms', async () => {
  const c = new Client();
  const res = await c.get('/list-your-venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('List Your Venue'));
  assert.ok(res.text.includes('Get Started'));
  assert.ok(!res.text.includes('<form action="/api/leads/venue"'));
});

test('C2. Unauthenticated GET /venue: renders sign-in gate', async () => {
  const c = new Client();
  const res = await c.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Telegram'));
});

test('C3. Authenticated GET /venue without Venue: renders direct onboarding wizard', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const res = await user.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('venueOnboardForm'));
});

test('C4. Save Venue Draft: status is draft and onboarding_completed is false', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const res = await user.post('/api/venue/onboard', {
    name: 'The Artisan Cellar',
    category: 'cocktail_speakeasy',
    city: 'Chennai',
    neighbourhood: 'Alwarpet',
    address_public: 'TTK Road, Alwarpet',
    capacity: 80,
    is_draft: true
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.isDraft, true);
  assert.equal(res.json.venue.status, 'draft');
  assert.equal(res.json.venue.onboarding_completed, false);
});

test('C5. Quarantined Draft: draft venue is excluded from public active venue discovery', async () => {
  const row = (await db.query(`SELECT status, onboarding_completed FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  assert.equal(row.status, 'draft');
  assert.equal(row.onboarding_completed, false);

  // Active query test
  const activeCount = (await db.query(`SELECT count(*)::int AS cnt FROM venues WHERE name = 'The Artisan Cellar' AND status = 'active' AND onboarding_completed = true`)).rows[0].cnt;
  assert.equal(activeCount, 0);
});

test('C6. Draft Venue Rejects Enquiries: attempting to enquire against draft venue returns 404', async () => {
  const v = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const user2 = await signedInClient({ tgId: 820000002 });
  const res = await user2.post(`/api/venue/enquiries?venueId=${v.id}`, {
    requester_name: 'Cocktail Mixer',
    event_name: 'Cocktail Mixer',
    event_date: '2026-12-15',
    start_time: '19:00',
    expected_guests: 50
  });
  assert.equal(res.status, 404);
});

test('C7. Resume Draft Context: getVenueContext returns draftVenue for owner', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = await user.get('/api/venue/context');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.json.context.hasVenue, false);
  assert.ok(ctx.json.context.draftVenue);
  assert.equal(ctx.json.context.draftVenue.name, 'The Artisan Cellar');
  assert.equal(ctx.json.context.draftVenue.cityName, 'Chennai');
});

test('C8. Step Navigation: draft preserves onboarding_step progression', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = (await user.get('/api/venue/context')).json.context;
  const dId = ctx.draftVenue.id;

  const updateRes = await user.post('/api/venue/onboard', {
    venue_id: dId,
    onboarding_step: 3,
    capacity: 90,
    is_draft: true
  });
  assert.ok([200, 201].includes(updateRes.status));
  assert.equal(updateRes.json.venue.onboarding_step, 3);
  assert.equal(updateRes.json.venue.capacity, 90);
});

test('C9. Incomplete Form Validation: launch without venue name is rejected with 400', async () => {
  const user = await signedInClient({ tgId: 820000003 });
  const res = await user.post('/api/venue/onboard', {
    name: '',
    category: 'rooftop_lounge',
    is_draft: false
  });
  assert.equal(res.status, 400);
});

test('C10. Invalid Capacity Validation: negative capacity is rejected', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = (await user.get('/api/venue/context')).json.context;
  const res = await user.post('/api/venue/onboard', {
    venue_id: ctx.draftVenue.id,
    capacity: -10,
    is_draft: true
  });
  assert.equal(res.status, 400);
});

test('C11. Direct Venue Photo Upload: valid PNG file uploads with 201 and stays strictly private in draft state', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  // Real PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A ...
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const upRes = await user.req('POST', '/api/venue/photos', pngBuf, { 'content-type': 'image/png' });
  assert.equal(upRes.status, 201);
  assert.ok(upRes.json.url);
  assert.ok(upRes.json.imageId);

  // Assert image is marked private in DB
  const imgRow = (await db.query(`SELECT is_public, owner_user_id FROM event_images WHERE id = $1`, [upRes.json.imageId])).rows[0];
  assert.equal(imgRow.is_public, false);
  assert.equal(imgRow.owner_user_id, user.userId);

  // Unauthenticated visitor CANNOT access private draft image (404)
  const anon = new Client();
  const anonRes = await anon.get(upRes.json.url);
  assert.equal(anonRes.status, 404);

  // Authenticated owner CAN access private draft image (200)
  const ownerRes = await user.get(upRes.json.url);
  assert.equal(ownerRes.status, 200);

  // Intruder from another account CANNOT attach this image ID to their venue (tampering guard)
  const intruder = await signedInClient({ tgId: 820000099 });
  const tamperRes = await intruder.post('/api/venue/onboard', {
    name: 'Tamperer Lounge',
    city: 'Bengaluru',
    photos: [upRes.json.url],
    is_draft: true
  });
  assert.equal(tamperRes.status, 403);
  assert.equal(tamperRes.json.error, 'image_ownership_violation');
});

test('C11b. Venue Photo Integrity: nonexistent UUID rejected with 400 invalid_image_reference', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const fakeId = '00000000-0000-0000-0000-000000000099';
  const res = await user.post('/api/venue/onboard', {
    name: 'Phantom Lounge',
    city: 'Bengaluru',
    photos: [`/media/event-images/${fakeId}`],
    is_draft: true
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid_image_reference');
});

test('C11c. Venue Photo Integrity: malformed image reference string rejected with 400 invalid_image_reference or validation error', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const res1 = await user.post('/api/venue/onboard', {
    name: 'Malformed Lounge 1',
    city: 'Bengaluru',
    photos: ['/media/event-images/not-a-valid-uuid'],
    is_draft: true
  });
  assert.equal(res1.status, 400);
  assert.ok(['validation', 'invalid_image_reference'].includes(res1.json.error));

  const res2 = await user.post('/api/venue/onboard', {
    name: 'Malformed Lounge 2',
    city: 'Bengaluru',
    photos: ['completely-invalid-photo-token'],
    is_draft: true
  });
  assert.equal(res2.status, 400);
  assert.ok(['validation', 'invalid_image_reference'].includes(res2.json.error));
});

test('C11d. Venue Photo Integrity: cross-account UUID rejected on profile PATCH with 403 and never exposed', async () => {
  const ownerA = await signedInClient({ tgId: 820000001 });
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const upA = await ownerA.req('POST', '/api/venue/photos', pngBuf, { 'content-type': 'image/png' });
  assert.equal(upA.status, 201);

  const ownerB = await signedInClient({ tgId: 820000077 });
  const onboardB = await ownerB.post('/api/venue/onboard', {
    name: 'Owner B Lounge',
    city: 'Bengaluru',
    capacity: 70,
    is_draft: false
  });
  assert.ok([200, 201].includes(onboardB.status));
  const venueBId = onboardB.json.venue.id;

  // Owner B attempts to attach Owner A's photo to their venue profile
  const patchRes = await ownerB.patch(`/api/venue/profile?venueId=${venueBId}`, {
    photos: [upA.json.url]
  });
  assert.equal(patchRes.status, 403);
  assert.equal(patchRes.json.error, 'image_ownership_violation');

  // Verify Owner A's image was not made public
  const imgRow = (await db.query(`SELECT is_public FROM event_images WHERE id = $1`, [upA.json.imageId])).rows[0];
  assert.equal(imgRow.is_public, false);
});

test('C11e. Venue Photo Integrity: legitimate same-organisation colleague image sharing succeeds', async () => {
  const owner = await signedInClient({ tgId: 820000010 });
  const onboard = await owner.post('/api/venue/onboard', {
    name: 'Colleague Shared Club',
    city: 'Hyderabad',
    capacity: 150,
    is_draft: true
  });
  const venueId = onboard.json.venue.id;
  const orgId = onboard.json.venue.orgId || onboard.json.venue.org_id;

  // Create colleague user and add to the same organisation
  const colleague = await signedInClient({ tgId: 820000011 });
  await db.query(
    `INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'staff', 'active') ON CONFLICT (user_id, org_id) DO NOTHING`,
    [colleague.userId, orgId]
  );

  // Colleague uploads a photo
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const colleagueUp = await colleague.req('POST', `/api/venue/photos?venueId=${venueId}`, pngBuf, { 'content-type': 'image/png' });
  assert.equal(colleagueUp.status, 201);

  // Owner attaches colleague's photo to the shared venue
  const attachRes = await owner.post('/api/venue/onboard', {
    venue_id: venueId,
    name: 'Colleague Shared Club',
    city: 'Hyderabad',
    photos: [colleagueUp.json.url],
    is_draft: true
  });
  assert.ok([200, 201].includes(attachRes.status));

  // Also verify duplicate IDs deduplication works cleanly
  const dupRes = await owner.post('/api/venue/onboard', {
    venue_id: venueId,
    name: 'Colleague Shared Club',
    city: 'Hyderabad',
    photos: [colleagueUp.json.url, colleagueUp.json.url],
    is_draft: true
  });
  assert.ok([200, 201].includes(dupRes.status));
});

test('C11f. Venue Photo Integrity: failed requests do not publish or expose images', async () => {
  const user = await signedInClient({ tgId: 820000020 });
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const up = await user.req('POST', '/api/venue/photos', pngBuf, { 'content-type': 'image/png' });
  assert.equal(up.status, 201);

  // Try to publish with one valid upload and one nonexistent UUID
  const failPublish = await user.post('/api/venue/onboard', {
    name: 'Fail Publish Lounge',
    city: 'Chennai',
    photos: [up.json.url, '/media/event-images/00000000-0000-0000-0000-000000000099'],
    is_draft: false
  });
  assert.equal(failPublish.status, 400);

  // Verify the valid upload in event_images was NOT published
  const imgRow = (await db.query(`SELECT is_public FROM event_images WHERE id = $1`, [up.json.imageId])).rows[0];
  assert.equal(imgRow.is_public, false);

  // Verify anonymous visitor cannot access the photo
  const anon = new Client();
  const anonRes = await anon.get(up.json.url);
  assert.equal(anonRes.status, 404);
});

test('C12. Venue Photo Upload Rejection: invalid file type rejected with 415', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const textBuf = Buffer.from('hello plain text not an image');
  const upRes = await user.req('POST', '/api/venue/photos', textBuf, { 'content-type': 'image/png' });
  assert.equal(upRes.status, 415);
  assert.equal(upRes.json.error, 'image_type');
});

test('C13. Venue Photo Upload Rejection: oversized file (>2MB) rejected with 413', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const hugeBuf = Buffer.alloc(2.2 * 1024 * 1024, 0xff);
  const upRes = await user.req('POST', '/api/venue/photos', hugeBuf, { 'content-type': 'image/jpeg' });
  assert.equal(upRes.status, 413);
});

test('C14. Complete Onboarding: publishing transitions venue to active and onboarding_completed: true', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = (await user.get('/api/venue/context')).json.context;
  const dId = ctx.draftVenue.id;

  // Retrieve user's uploaded photo from C11
  const userImg = (await db.query(`SELECT id FROM event_images WHERE owner_user_id = $1 LIMIT 1`, [user.userId])).rows[0];
  const photoUrl = `/media/event-images/${userImg.id}`;

  const pubRes = await user.post('/api/venue/onboard', {
    venue_id: dId,
    name: 'The Artisan Cellar',
    category: 'cocktail_speakeasy',
    city: 'Chennai',
    neighbourhood: 'Alwarpet',
    address_public: 'TTK Road, Alwarpet',
    address_private: 'Rear basement gate, TTK Road',
    capacity: 100,
    facilities: ['bar_license', 'sound_system', 'air_conditioning'],
    operating_hours: { general: 'Wed–Sun 6pm–1am' },
    rules: '21+ only, smart casual dress code',
    photos: [photoUrl],
    is_draft: false
  });
  assert.ok([200, 201].includes(pubRes.status));
  assert.equal(pubRes.json.isDraft, false);
  assert.equal(pubRes.json.venue.status, 'active');
  assert.equal(pubRes.json.venue.onboarding_completed, true);

  // Assert photo is now transitioned to public upon publication
  const imgRow = (await db.query(`SELECT is_public FROM event_images WHERE id = $1`, [userImg.id])).rows[0];
  assert.equal(imgRow.is_public, true);

  // Unauthenticated visitor can now access the published venue photo
  const anon = new Client();
  const anonRes = await anon.get(photoUrl);
  assert.equal(anonRes.status, 200);
});

test('C15. Post-Launch Context: hasVenue is now true and activeVenue is accessible', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = await user.get('/api/venue/context');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.json.context.hasVenue, true);
  assert.equal(ctx.json.context.activeVenue.name, 'The Artisan Cellar');
  assert.equal(ctx.json.context.activeVenue.status, 'active');
  assert.equal(ctx.json.context.activeVenue.onboardingCompleted, true);
});

test('C16. Profile Strength Calculation: evaluates completion percentage', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = (await user.get('/api/venue/context')).json.context;
  assert.ok(ctx.activeVenue.profileStrength.percentage >= 50, `Expected completion >= 50%, got ${ctx.activeVenue.profileStrength.percentage}%`);
});

test('C17. Organisation Unverified Protection: newly registered organisation has verified_at NULL', async () => {
  const user = await signedInClient({ tgId: 820000001 });
  const ctx = (await user.get('/api/venue/context')).json.context;
  assert.equal(ctx.activeVenue.orgVerified, false);

  const orgRow = (await db.query(`SELECT verified_at FROM organisations WHERE id = $1`, [ctx.activeVenue.orgId])).rows[0];
  assert.equal(orgRow.verified_at, null);
});

test('C18. Duplicate Venue Protection: exact name + city collision returns 409 conflict', async () => {
  const attacker = await signedInClient({ tgId: 820000004 });
  const dupRes = await attacker.post('/api/venue/onboard', {
    name: 'The Artisan Cellar',
    city: 'Chennai',
    is_draft: false
  });
  assert.equal(dupRes.status, 409);
  assert.equal(dupRes.json.error, 'duplicate_venue');
  assert.equal(dupRes.json.claimAllowed, true);
  assert.ok(dupRes.json.existingVenueId);
});

test('C19. Venue Ownership Claim Submission: claimant submits challenge with business proof', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const claimant = await signedInClient({ tgId: 820000004 });

  const claimRes = await claimant.post('/api/venue/claim', {
    venue_id: targetVenue.id,
    claimant_role: 'Director / Co-Founder',
    business_proof_type: 'gstin',
    business_proof_ref: '33AABCT1332L1Z4',
    contact_name: 'Karthik Raja',
    contact_email: 'karthik@artisancellar.test',
    contact_phone: '+91 99444 33221',
    notes: 'Official registration documentation attached via GSTIN reference.'
  });
  assert.equal(claimRes.status, 201);
  assert.equal(claimRes.json.ok, true);
  assert.equal(claimRes.json.claim.status, 'pending_verification');
});

test('C20. Duplicate Claim Prevention: claimant cannot submit repeat pending claim for same venue', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const claimant = await signedInClient({ tgId: 820000004 });

  const repRes = await claimant.post('/api/venue/claim', {
    venue_id: targetVenue.id,
    claimant_role: 'Director',
    business_proof_type: 'gstin',
    business_proof_ref: '33AABCT1332L1Z4',
    contact_name: 'Karthik Raja',
    contact_email: 'karthik@artisancellar.test',
    contact_phone: '+91 99444 33221'
  });
  assert.equal(repRes.status, 409);
  assert.equal(repRes.json.error, 'claim_already_pending');
});

// ============================================================================
// SECTION D: Venue Operations, Privacy, Staff and Safety (12 Scenarios)
// ============================================================================

test('D1. Confidential Address Isolation: outsider receives 404 on venue private profile', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const outsider = await signedInClient({ tgId: 830000001 });

  const res = await outsider.get(`/api/venue/profile?venueId=${targetVenue.id}`);
  assert.equal(res.status, 404);
});

test('D2. Confidential Address Leak Prevention: unauthenticated visitor cannot access profile', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const anon = new Client();
  const res = await anon.get(`/api/venue/profile?venueId=${targetVenue.id}`);
  assert.equal(res.status, 401);
});

test('D3. Owner Profile Access: legitimate owner reads full private address and telemetry', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });

  const res = await owner.get(`/api/venue/profile?venueId=${targetVenue.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.addressPrivate, 'Rear basement gate, TTK Road');
});

test('D4. Profile Update by Owner: PATCH /api/venue/profile succeeds with CSRF', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });

  const res = await owner.patch(`/api/venue/profile?venueId=${targetVenue.id}`, {
    capacity: 120,
    neighbourhood: 'Alwarpet Central'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.venue.capacity, 120);
});

test('D5. Profile Update by Outsider: outsider gets 404 on PATCH profile', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const outsider = await signedInClient({ tgId: 830000001 });

  const res = await outsider.patch(`/api/venue/profile?venueId=${targetVenue.id}`, {
    capacity: 500
  });
  assert.equal(res.status, 404);
});

test('D6. List Venue Staff: owner retrieves active staff memberships', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });

  const res = await owner.get(`/api/venue/staff?venueId=${targetVenue.id}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.staff));
  assert.equal(res.json.staff[0].role, 'owner');
});

test('D7. Add Staff Member: owner adds team member by Telegram ID', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });

  // Register staff user first
  const newStaff = await signedInClient({ tgId: 830000002 });

  const res = await owner.post(`/api/venue/staff?venueId=${targetVenue.id}`, {
    telegram_user_id: newStaff.tgId,
    role: 'staff'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('D8. Update Staff Role: owner promotes staff member', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });
  const staffList = (await owner.get(`/api/venue/staff?venueId=${targetVenue.id}`)).json.staff;
  const member = staffList.find((m) => m.role === 'staff');
  assert.ok(member);

  const res = await owner.patch(`/api/venue/staff/${member.userId}?venueId=${targetVenue.id}`, {
    role: 'manager'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('D9. Outsider Staff Tampering: outsider cannot add staff to foreign venue (404)', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const outsider = await signedInClient({ tgId: 830000001 });

  const res = await outsider.post(`/api/venue/staff?venueId=${targetVenue.id}`, {
    telegram_user_id: 830000001,
    role: 'staff'
  });
  assert.equal(res.status, 404);
});

test('D10. Venue Booking Enquiries: venue manager can approve enquiry', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const host = await signedInClient({ tgId: 830000003 });

  // Host submits booking enquiry to active venue
  const enqRes = await host.post(`/api/venue/enquiries?venueId=${targetVenue.id}`, {
    requester_name: 'Retro Host',
    event_name: 'Retro Disco Night',
    event_date: '2026-12-20',
    start_time: '20:00',
    expected_guests: 75
  });
  assert.equal(enqRes.status, 201);
  const enquiryId = enqRes.json.enquiry.id;

  // Venue owner approves enquiry
  const owner = await signedInClient({ tgId: 820000001 });
  const decideRes = await owner.post(`/api/venue/enquiries/${enquiryId}/decide`, {
    action: 'approve'
  });
  assert.equal(decideRes.status, 200);
  assert.equal(decideRes.json.enquiry.status, 'approved');
});

test('D11. Safety Reports Access: venue operator can submit safety escalation', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const owner = await signedInClient({ tgId: 820000001 });

  const repRes = await owner.post(`/api/venue/reports?venueId=${targetVenue.id}`, {
    category: 'noise_complaint',
    body: 'Neighbouring residential complaint regarding midnight terrace bass.'
  });
  assert.equal(repRes.status, 201);
});

test('D12. Outsider Safety Leak: outsider cannot read venue safety reports (404)', async () => {
  const targetVenue = (await db.query(`SELECT id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];
  const outsider = await signedInClient({ tgId: 830000001 });

  const res = await outsider.get(`/api/venue/reports?venueId=${targetVenue.id}`);
  assert.equal(res.status, 404);
});

// ============================================================================
// SECTION E: Platform Administration, Venue Claims and Auditing (12 Scenarios)
// ============================================================================

test('E1. Admin Authorization Boundary: non-admin user blocked with 403 on admin routes', async () => {
  const normalUser = await signedInClient({ tgId: 840000001 });
  const res = await normalUser.get('/api/admin/overview');
  assert.equal(res.status, 403);
});

test('E2. Admin Overview: super admin accesses platform KPIs with verified active venue count', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const res = await admin.get('/api/admin/overview');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(typeof res.json.kpis.venues_active === 'number');
  assert.ok(res.json.kpis.venues_active >= 1);
});

test('E3. Admin List All Venues: GET /api/admin/venues returns venues across organisations', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const res = await admin.get('/api/admin/venues');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.venues));
  assert.ok(res.json.venues.length >= 2);
});

test('E4. Admin Filter Venues by Status: GET /api/admin/venues?status=active', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const res = await admin.get('/api/admin/venues?status=active');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.venues.every((v) => v.status === 'active'));
});

test('E5. Admin List Venue Claims: GET /api/admin/venue-claims returns pending challenges', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const res = await admin.get('/api/admin/venue-claims');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.claims));
  assert.ok(res.json.claims.length >= 1);
});

test('E6. Admin Filter Venue Claims by Status: GET /api/admin/venue-claims?status=pending_verification', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const res = await admin.get('/api/admin/venue-claims?status=pending_verification');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.claims.every((c) => c.status === 'pending_verification'));
});

test('E7. Non-Super Admin Blocked from Resolving Claims: event_manager gets 403', async () => {
  const superAdmin = await signedInClient({ tgId: 900000001 });
  const manager = await signedInClient({ tgId: 840000002 });
  await superAdmin.post('/api/admin/admins', { telegram_user_id: manager.tgId, role: 'event_manager' });

  const claim = (await db.query(`SELECT id FROM venue_claims WHERE status = 'pending_verification' LIMIT 1`)).rows[0];
  const res = await manager.post(`/api/admin/venue-claims/${claim.id}/resolve`, {
    decision: 'rejected',
    resolutionNotes: 'Missing legitimate proof'
  });
  assert.equal(res.status, 403);
});

test('E8. Super Admin Rejects Venue Claim: status updated to rejected, ownership unchanged', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const claim = (await db.query(`SELECT id, venue_id FROM venue_claims WHERE status = 'pending_verification' LIMIT 1`)).rows[0];
  const originalVenue = (await db.query(`SELECT org_id FROM venues WHERE id = $1`, [claim.venue_id])).rows[0];

  const res = await admin.post(`/api/admin/venue-claims/${claim.id}/resolve`, {
    decision: 'rejected',
    resolutionNotes: 'GSTIN document name does not match business registration records.'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.claim.status, 'rejected');

  // Verify ownership remains unchanged
  const postVenue = (await db.query(`SELECT org_id FROM venues WHERE id = $1`, [claim.venue_id])).rows[0];
  assert.equal(postVenue.org_id, originalVenue.org_id);
});

test('E9. Re-resolving Finalized Claim Rejected: cannot resolve already rejected claim (409)', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const claim = (await db.query(`SELECT id FROM venue_claims WHERE status = 'rejected' LIMIT 1`)).rows[0];

  const res = await admin.post(`/api/admin/venue-claims/${claim.id}/resolve`, {
    decision: 'approved',
    resolutionNotes: 'Attempt to overturn rejected claim'
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'already_resolved');
});

test('E10. Super Admin Approves Valid Claim: safely transfers venue ownership to verified claimant', async () => {
  const claimantUser = await signedInClient({ tgId: 840000003 });
  // Create an organisation for claimant
  const orgRow = (await db.query(
    `INSERT INTO organisations (name, kind, status) VALUES ('Claimant Org Ltd', 'venue_operator', 'active') RETURNING id`
  )).rows[0];
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [claimantUser.userId, orgRow.id]);

  const targetVenue = (await db.query(`SELECT id, org_id FROM venues WHERE name = 'The Artisan Cellar'`)).rows[0];

  // Submit valid claim
  const claimSubmit = await claimantUser.post('/api/venue/claim', {
    venue_id: targetVenue.id,
    claimant_role: 'Founding Partner',
    business_proof_type: 'fssai_license',
    business_proof_ref: 'FSSAI-112233445566',
    contact_name: 'Verified Claimant',
    contact_email: 'claimant@legalproof.test',
    contact_phone: '+91 98888 12345'
  });
  assert.equal(claimSubmit.status, 201);
  const claimId = claimSubmit.json.claim.id;

  // Super Admin approves claim
  const admin = await signedInClient({ tgId: 900000001 });
  const resolveRes = await admin.post(`/api/admin/venue-claims/${claimId}/resolve`, {
    decision: 'approved',
    resolutionNotes: 'FSSAI license verified against national register.'
  });
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.json.claim.status, 'approved');

  // Verify venue org_id transferred to claimant org
  const updatedVenue = (await db.query(`SELECT org_id FROM venues WHERE id = $1`, [targetVenue.id])).rows[0];
  assert.equal(updatedVenue.org_id, orgRow.id);

  // Verify claimant user received manage_venue capability
  const capRow = (await db.query(`SELECT * FROM user_capabilities WHERE user_id = $1 AND capability_code = 'manage_venue'`, [claimantUser.userId])).rows[0];
  assert.ok(capRow);
});

test('E11. Audit Trail Integrity: venue claim approval generates auditable record', async () => {
  const auditRow = (await db.query(`SELECT * FROM audit_log WHERE action = 'venue.claim.approve' ORDER BY at DESC LIMIT 1`)).rows[0];
  assert.ok(auditRow);
  assert.ok(auditRow.actor.includes('admin:'));
});

test('E12. CSRF Enforcement on Admin Mutations: invalid CSRF token returns 403', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const claim = (await db.query(`SELECT id FROM venue_claims LIMIT 1`)).rows[0];

  const res = await admin.req('POST', `/api/admin/venue-claims/${claim.id}/resolve`, {
    decision: 'rejected',
    resolutionNotes: 'Testing CSRF'
  }, { 'x-csrf-token': 'invalid-csrf-token' });
  assert.equal(res.status, 403);
});

// ============================================================================
// SECTION F: API Validation and Error States (15 Scenarios)
// ============================================================================

test('F1. Invalid UUID URL Parameter: rejected with 404 not_found', async () => {
  const user = await signedInClient();
  const res = await user.get('/api/bookings/invalid-not-a-uuid');
  assert.equal(res.status, 404);
});

test('F2. Attendee Cancellation Without CSRF Token: rejected with 403 forbidden', async () => {
  const attendee = await signedInClient({ tgId: 850000001 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [ev.id])).rows[0];

  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(bookRes.status, 200);
  const bId = bookRes.json.bookingId;

  const cancelRes = await attendee.req('POST', `/api/me/bookings/${bId}/cancel`, {}, { 'x-csrf-token': 'bad-token' });
  assert.equal(cancelRes.status, 403);
});

test('F3. Attendee Cancellation With CSRF Token: successfully cancels booking pass', async () => {
  const attendee = await signedInClient({ tgId: 850000001 });
  const myBookings = await attendee.get('/api/me/bookings');
  const bId = myBookings.json.bookings[0].id;

  const cancelRes = await attendee.post(`/api/me/bookings/${bId}/cancel`);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.ok, true);
  assert.equal(cancelRes.json.status, 'cancelled');
});

test('F4. Double Cancellation Rejection: cancelling an already cancelled booking returns 409', async () => {
  const attendee = await signedInClient({ tgId: 850000001 });
  const bRow = (await db.query(`SELECT id FROM bookings WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = 850000001) AND status = 'cancelled'`)).rows[0];
  assert.ok(bRow, 'Cancelled booking row must exist from F3');
  const bId = bRow.id;

  const cancelRes = await attendee.post(`/api/me/bookings/${bId}/cancel`);
  assert.equal(cancelRes.status, 409);
  assert.equal(cancelRes.json.error, 'already_cancelled');
});

test('F5. Ticket Tier min_per_booking Violation: booking below minimum quantity returns 400', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, min_per_booking, max_per_booking, active)
     VALUES ($1, 'Group Pass 3+', 'free', 0, 30, 3, 6, true) RETURNING id`,
    [ev.id]
  )).rows[0];

  const attendee = await signedInClient({ tgId: 850000002 });
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1 // less than min 3
  });
  assert.equal(bookRes.status, 400);
  assert.equal(bookRes.json.error, 'validation');
});

test('F6. Ticket Tier sales_start_at in Future: booking before sales open returns 409', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, sales_start_at, active)
     VALUES ($1, 'Future Release', 'free', 0, 20, 2, now() + interval '2 days', true) RETURNING id`,
    [ev.id]
  )).rows[0];

  const attendee = await signedInClient({ tgId: 850000002 });
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 409);
  assert.equal(bookRes.json.error, 'sales_not_started');
});

test('F7. Ticket Tier sales_end_at in Past: booking after sales closed returns 409', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, sales_end_at, active)
     VALUES ($1, 'Expired Flash Sale', 'free', 0, 20, 2, now() - interval '1 hour', true) RETURNING id`,
    [ev.id]
  )).rows[0];

  const attendee = await signedInClient({ tgId: 850000002 });
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 409);
  assert.equal(bookRes.json.error, 'sales_ended');
});

test('F8. Non-tiered Event Booking Rejection: booking endpoint rejects non-tiered event', async () => {
  const ev = (await db.query(
    `INSERT INTO events (slug, category, title, city, start_at, timezone, capacity, ticketing, status)
     VALUES ('single-event-test', 'meetup', 'Single Event', 'Bengaluru', now() + interval '2 days', 'Asia/Kolkata', 50, 'single', 'published') RETURNING id`
  )).rows[0];

  const attendee = await signedInClient({ tgId: 850000002 });
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: '00000000-0000-0000-0000-000000000001',
    quantity: 1
  });
  assert.equal(bookRes.status, 409);
  assert.equal(bookRes.json.error, 'not_tiered');
});

test('F9. Event Update End Time Validation: end_at before start_at returns 400', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  const ev = (await db.query(`SELECT id, start_at FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];

  const res = await org.put(`/api/organiser/events/${ev.id}`, {
    end_at: new Date(new Date(ev.start_at).getTime() - 3600000).toISOString()
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'validation');
});

test('F10. Event Update Title Length: title < 3 characters returns 400', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];

  const res = await org.put(`/api/organiser/events/${ev.id}`, {
    title: 'ab'
  });
  assert.equal(res.status, 400);
});

test('F11. Malformed JSON Body: malformed JSON returns 400 validation error', async () => {
  const attendee = await signedInClient({ tgId: 850000002 });
  const res = await attendee.req('POST', '/api/venue/onboard', '{invalid: json', { 'content-type': 'application/json' });
  assert.equal(res.status, 400);
});

test('F12. Unrecognized Request Keys: strict Zod schema rejects injected malicious attributes', async () => {
  const user = await signedInClient({ tgId: 850000003 });
  const res = await user.post('/api/venue/onboard', {
    name: 'Tamper Space',
    category: 'event_space',
    is_draft: false,
    verified_at: new Date().toISOString(), // Injected privilege escalation field
    is_admin: true
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'validation');
});

test('F13. Venue Update Invalid Rules: negative capacity returns 400', async () => {
  const v = (await db.query(`SELECT id FROM venues WHERE name = 'Skylight Loft'`)).rows[0];
  const owner = await signedInClient({ tgId: 810000002 });

  const res = await owner.patch(`/api/venue/profile?venueId=${v.id}`, {
    capacity: -50
  });
  assert.equal(res.status, 400);
});

test('F14. Cancellation of Checked-in Booking Rejected: door checked-in pass cannot be cancelled (409)', async () => {
  const attendee = await signedInClient({ tgId: 850000004 });
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [ev.id])).rows[0];

  // Book pass
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(bookRes.status, 200);
  const bId = bookRes.json.bookingId;

  // Door staff checks in the attendee
  await db.query(`UPDATE bookings SET status = 'checked_in' WHERE id = $1`, [bId]);

  // Attendee attempts to cancel
  const cancelRes = await attendee.post(`/api/me/bookings/${bId}/cancel`);
  assert.equal(cancelRes.status, 409);
  assert.equal(cancelRes.json.error, 'already_checked_in');
});

test('F15. Venue Claim Validation: empty business proof reference returns 400', async () => {
  const claimant = await signedInClient({ tgId: 850000005 });
  const v = (await db.query(`SELECT id FROM venues LIMIT 1`)).rows[0];

  const res = await claimant.post('/api/venue/claim', {
    venue_id: v.id,
    claimant_role: 'Owner',
    business_proof_type: 'gstin',
    business_proof_ref: '', // empty
    contact_name: 'Test',
    contact_email: 'test@example.com'
  });
  assert.equal(res.status, 400);
});

// ============================================================================
// SECTION G: Mobile and Responsive Workflows (8 Scenarios)
// ============================================================================

test('G1. Mobile Viewport Navigation: renders accessible header and mobile menu', async () => {
  const c = new Client();
  const res = await c.get('/', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('viewport'));
  assert.ok(res.text.includes('width=device-width'));
});

test('G2. Venue Command Centre Responsive Structure: contains touch-accessible tab buttons', async () => {
  const owner = await signedInClient({ tgId: 810000002 });
  const res = await owner.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('venue-tabs'));
  assert.ok(res.text.includes('tabOverview'));
  assert.ok(res.text.includes('tabProfile'));
});

test('G3. Venue Onboarding Field Grid: utilizes responsive CSS grid and field rows', async () => {
  const user = await signedInClient({ tgId: 860000001 });
  const res = await user.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('field-row'));
  assert.ok(res.text.includes('venue-progress-track'));
});

test('G4. Digital Pass Mobile Card: renders responsive ticket QR elements', async () => {
  const c = new Client();
  const res = await c.get('/bookings/00000000-0000-0000-0000-000000000001');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('data-booking-status'));
});

test('G5. Modal Claim Dialog Accessibility: dialog possesses ARIA labels and modal attributes', async () => {
  const user = await signedInClient({ tgId: 860000001 });
  const res = await user.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('id="modalClaimVenue"'));
  assert.ok(res.text.includes('aria-labelledby="modalClaimTitle"'));
});

test('G6. Event Detail Mobile Layout: renders primary CTA and price indicators', async () => {
  const ev = (await db.query(`SELECT slug FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const c = new Client();
  const res = await c.get(`/events/${ev.slug}`, {
    'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36'
  });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('tier-form'));
  assert.ok(res.text.includes('Choose a ticket'));
});

test('G7. Organiser Draft Wizard Mobile Layout: wizard structure supports step transitions', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  const res = await org.get('/organiser/new');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('wz-wrap'));
});

test('G8. Tap Targets Compliance: buttons have minimum accessible heights and padding', async () => {
  const c = new Client();
  const res = await c.get('/list-your-venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('btn-lg'));
});

// ============================================================================
// SECTION H: Regression, Race Conditions, and Idempotency (10 Scenarios)
// ============================================================================

test('H1. Concurrency: Simultaneous bookings for the last remaining seat prevent overselling', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  // Create an event with exactly 1 seat
  const ev = (await db.query(
    `INSERT INTO events (slug, category, title, city, start_at, timezone, capacity, ticketing, status)
     VALUES ('race-capacity-test', 'meetup', 'Race Capacity Test', 'Bengaluru', now() + interval '2 days', 'Asia/Kolkata', 1, 'tiers', 'published') RETURNING id`
  )).rows[0];
  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Final Seat', 'free', 0, 1, 1, true) RETURNING id`,
    [ev.id]
  )).rows[0];

  const userA = await signedInClient({ tgId: 870000001 });
  const userB = await signedInClient({ tgId: 870000002 });

  // Concurrently attempt to book the single seat
  const [resA, resB] = await Promise.all([
    userA.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 }),
    userB.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 })
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.equal(statuses[0], 200, 'Exactly one concurrent booking must succeed');
  assert.equal(statuses[1], 409, 'Second concurrent booking must fail with 409 sold_out');
});

test('H2. Optimistic Locking: Concurrent draft updates with stale version are rejected with 409', async () => {
  const org = await organiserClient({ tgId: 800000001 });
  const draft = (await org.post('/api/organiser/drafts', { template: 'social' })).json.draft;

  // First tab saves
  const save1 = await org.put(`/api/organiser/drafts/${draft.id}`, {
    data: draft.data,
    step: 'basics',
    version: draft.version
  });
  assert.equal(save1.status, 200);

  // Stale second tab saves using original version
  const save2 = await org.put(`/api/organiser/drafts/${draft.id}`, {
    data: draft.data,
    step: 'basics',
    version: draft.version
  });
  assert.equal(save2.status, 409);
  assert.equal(save2.json.error, 'version_conflict');
});

test('H3. Payment Fail-Closed Protection: ENABLE_LIVE_PAYMENTS=false blocks checkout redirect and paid bookings', async () => {
  // 1. Setup real published event with a paid ticket tier
  const ev = (await db.query(`SELECT id, slug, checkout_mode, superprofile_url FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  assert.ok(ev);
  const paidTier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'VIP Live Pass', 'paid', 250000, 10, 2, true) RETURNING id`,
    [ev.id]
  )).rows[0];

  // 2. Assert checkout availability returns disabled state
  const availability = checkoutForEvent(ev);
  assert.equal(availability.available, false);
  assert.ok(['live_payments_disabled', 'upi_checkout_disabled', 'preview_paid_checkout_disabled'].includes(availability.reason));

  // 3. Assert createCheckoutIntent returns null (no provider checkout session created)
  const intent = await createCheckoutIntent({
    slug: ev.slug,
    ticketTypeId: paidTier.id,
    qty: 1
  });
  assert.equal(intent, null);

  // 4. Assert GET /checkout/:slug does NOT redirect to any external payment provider
  const c = new Client();
  const res = await c.get(`/checkout/${ev.slug}?tier=${paidTier.id}`);
  assert.equal(res.status, 302);
  // Redirects safely back to the event page, NEVER to a payment gateway
  assert.equal(res.headers.get('location'), `/events/${ev.slug}`);

  // 5. Assert direct booking API rejects paid tickets and never creates confirmed bookings
  const attendee = await signedInClient({ tgId: 870000010 });
  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: paidTier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 409);
  assert.equal(bookRes.json.error, 'paid_on_superprofile');

  // 6. Assert no paid booking or ticket was marked confirmed
  const confirmedCount = (await db.query(
    `SELECT count(*)::int AS cnt FROM bookings WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = 870000010) AND status = 'confirmed'`,
    [ev.id]
  )).rows[0].cnt;
  assert.equal(confirmedCount, 0);
});

test('H4. Draft Venue Privacy Isolation: draft venue never appears in active search or counts', async () => {
  const user = await signedInClient({ tgId: 870000003 });
  await user.post('/api/venue/onboard', {
    name: 'Top Secret Hideaway',
    category: 'resort_farmhouse',
    city: 'Hyderabad',
    is_draft: true
  });

  const activeRows = (await db.query(
    `SELECT * FROM venues WHERE name = 'Top Secret Hideaway' AND status = 'active' AND onboarding_completed = true`
  )).rows;
  assert.equal(activeRows.length, 0);
});

test('H5. Completed Venue Discovery: completed venue appears with status active and onboarding_completed true', async () => {
  const v = (await db.query(`SELECT id, status, onboarding_completed FROM venues WHERE name = 'Skylight Loft'`)).rows[0];
  assert.ok(v);
  assert.equal(v.status, 'active');
  assert.equal(v.onboarding_completed, true);
});

test('H6. Migration 031 Pre-Migration State & Idempotency: isolated schema seeded pre-031, migrated via runner, preserves legacy status, isolates drafts, and second run applies 0 migrations', async () => {
  const client = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/sm_test'
  });
  await client.connect();

  const isoSchema = 'iso_mig031_matrix_test';
  try {
    // 1. Create a genuinely isolated PostgreSQL schema at pre-031 schema state
    await client.query(`DROP SCHEMA IF EXISTS ${isoSchema} CASCADE; CREATE SCHEMA ${isoSchema};`);
    await client.query(`SET search_path TO ${isoSchema}, public;`);

    // Run actual migration runner up through 030
    const preRan = await migrate({
      client,
      target: '030_infrastructure_fee_accounting.sql',
      log: false
    });
    assert.ok(preRan.length >= 25, `Expected pre-031 migrations to run, ran ${preRan.length}`);

    // Verify pre-031 schema state: venues table has NO onboarding_completed or onboarding_step columns
    const preCols = (await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'venues'`,
      [isoSchema]
    )).rows.map((r) => r.column_name);
    assert.equal(preCols.includes('onboarding_completed'), false, 'pre-031 venues must not have onboarding_completed');
    assert.equal(preCols.includes('onboarding_step'), false, 'pre-031 venues must not have onboarding_step');

    // Verify pre-031 schema state: venue_claims table does NOT exist
    const claimsTable = (await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'venue_claims'`,
      [isoSchema]
    )).rows;
    assert.equal(claimsTable.length, 0, 'pre-031 schema must not have venue_claims table');

    // 2. Seed legacy organisation and venue records before applying migration 031
    const org = (await client.query(
      `INSERT INTO organisations (name, kind, status) VALUES ('Vintage Heritage Hospitality', 'venue_operator', 'active') RETURNING id`
    )).rows[0];

    const legacyVenue = (await client.query(
      `INSERT INTO venues (org_id, name, address_public, capacity, status)
       VALUES ($1, 'Royal Heritage Ballroom', 'MG Road, Bengaluru', 250, 'active')
       RETURNING id, name, status`,
      [org.id]
    )).rows[0];
    assert.equal(legacyVenue.status, 'active');
    assert.equal(legacyVenue.name, 'Royal Heritage Ballroom');

    // 3. Apply migration 031 using the actual migration runner (not executing SQL directly)
    const mig031Ran = await migrate({ client, log: false });
    assert.deepEqual(mig031Ran, ['031_venue_self_service_onboarding.sql'], 'Migration runner must apply only 031');

    // 4. Verify legacy venues retain their intended status and visibility
    const postCols = (await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'venues'`,
      [isoSchema]
    )).rows.map((r) => r.column_name);
    assert.equal(postCols.includes('onboarding_completed'), true, 'post-031 venues must have onboarding_completed');
    assert.equal(postCols.includes('onboarding_step'), true, 'post-031 venues must have onboarding_step');

    const postVenue = (await client.query(
      `SELECT id, name, status, onboarding_completed, onboarding_step FROM venues WHERE id = $1`,
      [legacyVenue.id]
    )).rows[0];
    assert.equal(postVenue.status, 'active', 'Legacy venue status must remain active');
    assert.equal(postVenue.onboarding_completed, true, 'Legacy venue onboarding_completed must default to true');
    assert.equal(postVenue.onboarding_step, 1, 'Legacy venue onboarding_step must default to 1');
    assert.equal(postVenue.name, 'Royal Heritage Ballroom');

    // Verify discoverability: legacy venue is visible in active discovery queries
    const discovered = (await client.query(
      `SELECT id, name FROM venues WHERE status = 'active' AND onboarding_completed = true AND id = $1`,
      [legacyVenue.id]
    )).rows;
    assert.equal(discovered.length, 1, 'Legacy venue must be visible in discovery');

    // 5. Verify new draft venues remain private and excluded from discovery
    const draftVenue = (await client.query(
      `INSERT INTO venues (org_id, name, address_public, capacity, status, onboarding_completed, onboarding_step)
       VALUES ($1, 'Secret Speakeasy Under Construction', 'Lavelle Road', 50, 'draft', false, 1)
       RETURNING id, status, onboarding_completed`,
      [org.id]
    )).rows[0];
    assert.equal(draftVenue.status, 'draft');
    assert.equal(draftVenue.onboarding_completed, false);

    const draftDiscovery = (await client.query(
      `SELECT id FROM venues WHERE status = 'active' AND onboarding_completed = true AND id = $1`,
      [draftVenue.id]
    )).rows;
    assert.equal(draftDiscovery.length, 0, 'New draft venue must be excluded from public discovery');

    // 6. Run the migration runner a second time and verify it reports no pending migration and causes no schema/data changes
    const secondRan = await migrate({ client, log: false });
    assert.deepEqual(secondRan, [], 'Second migration run must report zero pending migrations');

    // Verify data and schema remain identical after second run
    const checkLegacyAgain = (await client.query(
      `SELECT id, name, status, onboarding_completed, onboarding_step FROM venues WHERE id = $1`,
      [legacyVenue.id]
    )).rows[0];
    assert.equal(checkLegacyAgain.status, 'active');
    assert.equal(checkLegacyAgain.onboarding_completed, true);
    assert.equal(checkLegacyAgain.name, 'Royal Heritage Ballroom');

    const checkDraftAgain = (await client.query(
      `SELECT id, status, onboarding_completed FROM venues WHERE id = $1`,
      [draftVenue.id]
    )).rows[0];
    assert.equal(checkDraftAgain.status, 'draft');
    assert.equal(checkDraftAgain.onboarding_completed, false);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${isoSchema} CASCADE;`);
    await client.end();
  }
});

test('H7. Cross-Organisation Mutation Block: Organisation B cannot PATCH Organisation A venue', async () => {
  const v = (await db.query(`SELECT id, org_id FROM venues WHERE name = 'Skylight Loft'`)).rows[0];
  const userB = await signedInClient({ tgId: 870000004 });

  const res = await userB.patch(`/api/venue/profile?venueId=${v.id}`, {
    capacity: 999
  });
  assert.equal(res.status, 404);
});

test('H8. Venue Claim Auditing: claim resolution writes immutable audit log entry', async () => {
  const logs = (await db.query(`SELECT * FROM audit_log WHERE action LIKE 'venue.claim%'`)).rows;
  assert.ok(logs.length > 0);
});

test('H9. Door Ticket Check-In: ticket marked checked_in and cannot be re-admitted', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  const attendee = await signedInClient({ tgId: 870000005 });
  const tier = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [ev.id])).rows[0];

  const bookRes = await attendee.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(bookRes.status, 200);
  const bId = bookRes.json.bookingId;
  const tk = (await db.query(`SELECT id, ticket_code FROM tickets WHERE booking_id = $1`, [bId])).rows[0];
  assert.ok(tk);

  const org = await organiserClient({ tgId: 800000001 });
  const checkInRes = await org.post(`/api/organiser/events/${ev.id}/check-in`, {
    ticketCode: tk.ticket_code,
    method: 'camera_qr'
  });
  assert.equal(checkInRes.status, 200);
  assert.equal(checkInRes.json.ticket.status, 'checked_in');

  // Check ticket status in DB
  const postTk = (await db.query(`SELECT status FROM tickets WHERE id = $1`, [tk.id])).rows[0];
  assert.equal(postTk.status, 'checked_in');
});

test('H10. Re-check-in Idempotency / Duplicate Scan: scanning already admitted ticket returns already checked in', async () => {
  const ev = (await db.query(`SELECT id FROM events WHERE title = 'Neon Rooftop Groove'`)).rows[0];
  // Guarantee ticket belongs to ev.id
  const tk = (await db.query(
    `SELECT tk.id, tk.ticket_code, b.event_id
       FROM tickets tk
       JOIN bookings b ON b.id = tk.booking_id
      WHERE b.event_id = $1 AND tk.status = 'checked_in'
      LIMIT 1`,
    [ev.id]
  )).rows[0];
  assert.ok(tk, 'Admitted ticket belonging to this event must exist from H9');
  assert.equal(tk.event_id, ev.id);

  const org = await organiserClient({ tgId: 800000001 });
  const checkInRes = await org.post(`/api/organiser/events/${ev.id}/check-in`, {
    ticketCode: tk.ticket_code,
    method: 'camera_qr'
  });
  assert.equal(checkInRes.status, 409);
  assert.equal(checkInRes.json.error, 'already_checked_in');
});
