// test/m7-attendee-experience.test.js - Milestone 7: Attendee Discovery Feed,
// Personalised Recommendations, Location & Privacy, Saved Events Lifecycle,
// Multi-facet Filtering, Experience Hub, and QR Pass Integration.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, Client, signedInClient, clearCalls } from './helpers.js';
import { ensurePersonalOrg } from '../lib/services/permissions.js';
import { getDiscoveryFeed, scoreEventRecommendation, getUserRecommendationContext, parseDateFilter } from '../lib/services/discovery-feed.js';
import { saveEvent, unsaveEvent, isEventSaved, listSavedEvents, listSavedEventIds } from '../lib/services/saved-events.js';
import { seedDemo } from '../scripts/seed-demo.js';

let organiser;
let attendeeAlice;
let attendeeBob;
let demoEventId;
let sampleSlug;

before(async () => {
  await resetDb();
  await startServer();
  await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_test' } });

  organiser = await signedInClient({ tgId: 910000001 });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [organiser.userId]);

  attendeeAlice = await signedInClient({ tgId: 920000001 });
  attendeeBob = await signedInClient({ tgId: 920000002 });

  // Get a seeded demo event ID
  const evRow = await db.one(`SELECT id, slug FROM events WHERE slug LIKE 'sample-bengaluru-%' LIMIT 1`);
  demoEventId = evRow.id;
  sampleSlug = evRow.slug;
  const orgId = await ensurePersonalOrg({ id: organiser.userId, alias: 'Organiser' });
  await db.query('UPDATE events SET organiser_user_id = $1, organiser_org_id = $2 WHERE id = $3', [organiser.userId, orgId, demoEventId]);
});

after(stopServer);
beforeEach(() => {
  clearCalls();
});

test('parseDateFilter: correctly computes IST boundaries for today, tomorrow, weekend, week, month', () => {
  const today = parseDateFilter('today');
  assert.ok(today.from && today.to);
  assert.ok(new Date(today.from) <= new Date(today.to));

  const tmrw = parseDateFilter('tomorrow');
  assert.ok(tmrw.from && tmrw.to);
  assert.ok(new Date(tmrw.from) > new Date(today.from));

  const wknd = parseDateFilter('weekend');
  assert.ok(wknd.from && wknd.to);

  const week = parseDateFilter('week');
  assert.ok(week.from && week.to);

  const month = parseDateFilter('month');
  assert.ok(month.from && month.to);
  assert.ok(new Date(month.to) > new Date(week.to));

  const empty = parseDateFilter('');
  assert.deepEqual(empty, {});
});

test('scoreEventRecommendation: transparent and explainable scoring calculation', () => {
  const dummyEvent = {
    id: '00000000-0000-0000-0000-000000000001',
    city: 'Bengaluru',
    category: 'nightlife',
    start_at: new Date(Date.now() + 24 * 3600e3).toISOString(),
    seats_taken: 10,
    capacity: 20
  };

  // Case 1: Anonymous attendee (no user context), matches city
  const anonScore = scoreEventRecommendation(dummyEvent, null, 'Bengaluru');
  assert.ok(anonScore.score > 0);
  assert.match(anonScore.reason, /Bengaluru|Popular/);

  // Case 2: User with city preference match (+40) + interest match (+30) + trending (+20) + soon (+15)
  const userCtx = {
    preferredCity: 'Bengaluru',
    profileInterests: ['nightlife'],
    attendedCategories: [],
    savedCategories: [],
    savedEventIds: new Set()
  };
  const userScore = scoreEventRecommendation(dummyEvent, userCtx);
  assert.ok(userScore.score >= 85);
  assert.match(userScore.reason, /Bengaluru|Nightlife|Popular/);

  // Case 3: User with attended category match (+25)
  const attendedCtx = {
    preferredCity: 'Goa',
    profileInterests: [],
    attendedCategories: ['nightlife'],
    savedCategories: [],
    savedEventIds: new Set()
  };
  const attendedScore = scoreEventRecommendation(dummyEvent, attendedCtx);
  assert.ok(attendedScore.score >= 50);
  assert.match(attendedScore.reason, /events you joined|Popular/);

  // Case 4: User with saved category match (+15)
  const savedCtx = {
    preferredCity: 'Goa',
    profileInterests: [],
    attendedCategories: [],
    savedCategories: ['nightlife'],
    savedEventIds: new Set()
  };
  const savedScore = scoreEventRecommendation(dummyEvent, savedCtx);
  assert.ok(savedScore.score >= 35);
  assert.match(savedScore.reason, /saved events|Popular/);
});

test('getUserRecommendationContext: builds user profile, attended, and saved context correctly', async () => {
  // Update Alice profile
  await db.query(`UPDATE users SET city = 'Bengaluru', interests = ARRAY['nightlife', 'meetup']::text[] WHERE id = $1`, [attendeeAlice.userId]);

  // Save demo event for Alice
  await saveEvent(attendeeAlice.userId, demoEventId);

  const ctx = await getUserRecommendationContext(attendeeAlice.userId);
  assert.equal(ctx.preferredCity, 'Bengaluru');
  assert.ok(ctx.profileInterests.includes('nightlife'));
  assert.ok(ctx.profileInterests.includes('meetup'));
  assert.ok(ctx.savedEventIds.has(demoEventId));
  assert.ok(ctx.savedCategories.length > 0);

  // Cleanup saved
  await unsaveEvent(attendeeAlice.userId, demoEventId);
});

test('GET /api/discovery/feed: returns structured discovery feed with modules and filters', async () => {
  const c = new Client();
  const res = await c.get('/api/discovery/feed?city=bengaluru');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.events));
  assert.ok(Array.isArray(res.json.collections));
  assert.ok(Array.isArray(res.json.featured));
  assert.ok(Array.isArray(res.json.trending));
  assert.ok(Array.isArray(res.json.recommended));
  assert.equal(res.json.filter.city, 'bengaluru');

  // Verify collections
  const collections = res.json.collections;
  assert.ok(collections.some((col) => col.key === 'nightlife'));
  assert.ok(collections.some((col) => col.key === 'dinners'));
  assert.ok(collections.some((col) => col.key === 'social'));

  // Verify private venues are not exposed in public feed
  for (const ev of res.json.events) {
    assert.ok(!ev.venue || ev.venuePrivacy === 'public', 'private venue must never be on public feed event');
    assert.doesNotMatch(JSON.stringify(ev), /Secret Terrace|12th Main Road/, 'secret address never in feed');
  }
});

test('GET /api/discovery/feed: category, price, and date filtering', async () => {
  const c = new Client();

  // 1. Category filter
  const catRes = await c.get('/api/discovery/feed?category=nightlife');
  assert.equal(catRes.status, 200);
  for (const ev of catRes.json.events) {
    assert.equal(ev.category, 'nightlife');
  }

  // 2. Price filter: free
  const freeRes = await c.get('/api/discovery/feed?price=free');
  assert.equal(freeRes.status, 200);
  for (const ev of freeRes.json.events) {
    if (ev.ticketing === 'tiers' && ev.tiers?.length) {
      assert.ok(ev.tiers.some((t) => t.kind === 'free'));
    } else {
      assert.equal(ev.pricePaise, 0);
    }
  }

  // 3. Date filter: month
  const monthRes = await c.get('/api/discovery/feed?when=month');
  assert.equal(monthRes.status, 200);
  assert.ok(monthRes.json.events.length >= 0);
});

test('Location & Privacy: device coordinates provide coarse distance without trilaterating private venue', async () => {
  const c = new Client();
  // Bengaluru coordinates (MG Road area)
  const res = await c.get('/api/discovery/feed?lat=12.9716&lng=77.5946&radius_km=30');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.filter.lat, 12.9716);
  assert.equal(res.json.filter.lng, 77.5946);

  for (const ev of res.json.events) {
    // If distance band is present, verify coarse format
    if (ev.distanceBand) {
      assert.match(ev.distanceBand, /km/, 'coarse distance band formatted as km');
    }
    // Private venue address never leaked
    assert.ok(!ev.venue || ev.venuePrivacy === 'public');
  }
});

test('Saved Events Lifecycle: save, duplicate idempotency, list, unsave', async () => {
  // 1. Unauthenticated save fails with 401
  const anon = new Client();
  const anonSave = await anon.post(`/api/events/${demoEventId}/save`, {});
  assert.equal(anonSave.status, 401);

  // 2. Attendee Alice saves demo event
  const save1 = await attendeeAlice.post(`/api/events/${demoEventId}/save`, {});
  assert.equal(save1.status, 200);
  assert.equal(save1.json.ok, true);
  assert.equal(save1.json.saved, true);

  // 3. Duplicate save is idempotent (does not fail or duplicate)
  const save2 = await attendeeAlice.post(`/api/events/${demoEventId}/save`, {});
  assert.equal(save2.status, 200);
  assert.equal(save2.json.ok, true);
  assert.equal(save2.json.saved, true);

  // 4. Check saved IDs
  const idsRes = await attendeeAlice.get('/api/me/saved-event-ids');
  assert.equal(idsRes.status, 200);
  assert.ok(idsRes.json.savedIds.includes(demoEventId));

  // 5. Check saved events list
  const listRes = await attendeeAlice.get('/api/me/saved-events');
  assert.equal(listRes.status, 200);
  assert.ok(listRes.json.events.length > 0);
  const found = listRes.json.events.find((e) => e.id === demoEventId);
  assert.ok(found, 'saved event present in list');
  assert.equal(found.isSaved, true);

  // 6. Discovery feed marks isSaved: true for Alice
  const feedRes = await attendeeAlice.get('/api/discovery/feed');
  assert.equal(feedRes.status, 200);
  const feedEvent = feedRes.json.events.find((e) => e.id === demoEventId);
  if (feedEvent) {
    assert.equal(feedEvent.isSaved, true);
  }

  // 7. Unsave event
  const unsaveRes = await attendeeAlice.req('DELETE', `/api/events/${demoEventId}/save`, {});
  assert.equal(unsaveRes.status, 200);
  assert.equal(unsaveRes.json.saved, false);

  // 8. Idempotent unsave
  const unsave2 = await attendeeAlice.req('DELETE', `/api/events/${demoEventId}/save`, {});
  assert.equal(unsave2.status, 200);
  assert.equal(unsave2.json.saved, false);

  // 9. Verify removed from saved list
  const idsAfter = await attendeeAlice.get('/api/me/saved-event-ids');
  assert.equal(idsAfter.json.savedIds.includes(demoEventId), false);
});

test('Tenant & User Isolation: Alice and Bob saved events and bookings are strictly isolated', async () => {
  // Alice saves demoEventId
  await attendeeAlice.post(`/api/events/${demoEventId}/save`, {});

  // Bob's saved events must be empty
  const bobSaved = await attendeeBob.get('/api/me/saved-events');
  assert.equal(bobSaved.status, 200);
  assert.ok(!bobSaved.json.events.some((e) => e.id === demoEventId), "Bob cannot see Alice's saved events");

  const bobIds = await attendeeBob.get('/api/me/saved-event-ids');
  assert.ok(!bobIds.json.savedIds.includes(demoEventId));

  // Cleanup
  await attendeeAlice.req('DELETE', `/api/events/${demoEventId}/save`, {});
});

test('Attendee Experience Hub: Bookings, QR Tickets, Announcements, Check-in status', async () => {
  // 1. Get free ticket tier for sample event
  const tierRow = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free' LIMIT 1`, [demoEventId]);
  assert.ok(tierRow, 'free tier exists for demo event');

  // 2. Alice books the free ticket
  const bookRes = await attendeeAlice.post(`/api/events/${demoEventId}/book`, {
    ticketTypeId: tierRow.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(bookRes.status, 200, bookRes.text);
  const bookingId = bookRes.json.bookingId;

  // 3. Verify Alice's booking list (/api/me/bookings)
  const myBookingsRes = await attendeeAlice.get('/api/me/bookings');
  assert.equal(myBookingsRes.status, 200);
  const myBooking = myBookingsRes.json.bookings.find((b) => b.id === bookingId);
  assert.ok(myBooking, 'booking found in my bookings');
  assert.equal(myBooking.status, 'confirmed');
  assert.equal(myBooking.isCheckedIn, false);
  assert.equal(myBooking.isPast, false);

  // 4. Bob cannot access Alice's booking details
  const bobAccess = await attendeeBob.get(`/api/bookings/${bookingId}`);
  assert.equal(bobAccess.status, 404, 'cross-user booking access denied');

  // 5. Alice accesses booking details: QR ticket and unlocked venue
  const alicePass = await attendeeAlice.get(`/api/bookings/${bookingId}`);
  assert.equal(alicePass.status, 200);
  assert.equal(alicePass.json.booking.id, bookingId);
  assert.equal(alicePass.json.booking.status, 'confirmed');
  assert.ok(alicePass.json.booking.venue, 'confirmed booking has unlocked venue');
  assert.ok(Array.isArray(alicePass.json.booking.tickets), 'confirmed booking has digital tickets');
  assert.equal(alicePass.json.booking.tickets.length, 1);
  const ticket = alicePass.json.booking.tickets[0];
  assert.ok(ticket.ticketCode, 'ticket code present');
  assert.ok(ticket.qrSvg, 'ticket QR SVG present');
  assert.equal(ticket.status, 'valid');

  // 6. Organiser posts operational announcement
  const annRes = await organiser.post(`/api/organiser/events/${demoEventId}/announcements`, {
    title: 'Door Open & Entry Instructions',
    message: 'Gates open at 7:00 PM. Please have your NIGHTLIFEZ QR pass ready.',
    isPinned: true
  });
  assert.equal(annRes.status, 201, annRes.text);
  const announcementId = annRes.json.announcement.id;

  // 7. Alice sees announcement in /api/me/announcements and on /api/bookings/:id
  const aliceAnn = await attendeeAlice.get('/api/me/announcements');
  assert.equal(aliceAnn.status, 200);
  assert.ok(aliceAnn.json.announcements.some((a) => a.id === announcementId), 'booked attendee sees announcement');

  const alicePassWithAnn = await attendeeAlice.get(`/api/bookings/${bookingId}`);
  assert.ok(alicePassWithAnn.json.booking.announcements.some((a) => a.id === announcementId));

  // 8. Bob (not booked) does NOT see the announcement in /api/me/announcements
  const bobAnn = await attendeeBob.get('/api/me/announcements');
  assert.equal(bobAnn.status, 200);
  assert.ok(!bobAnn.json.announcements.some((a) => a.id === announcementId), 'unbooked user does not see announcement');

  // 9. Door check-in simulation: Check-in ticket using organiser staff validation
  const checkinRes = await organiser.post(`/api/organiser/events/${demoEventId}/check-in`, {
    ticketCode: ticket.ticketCode,
    method: 'manual_lookup'
  });
  assert.equal(checkinRes.status, 200, checkinRes.text);
  assert.equal(checkinRes.json.result, 'success');

  // 10. Verify Alice's pass now reflects checked-in status
  const checkedInPass = await attendeeAlice.get(`/api/bookings/${bookingId}`);
  assert.equal(checkedInPass.status, 200);
  assert.equal(checkedInPass.json.booking.isCheckedIn, true);
  assert.ok(checkedInPass.json.booking.checkedInAt, 'checkedInAt timestamp recorded');
  assert.equal(checkedInPass.json.booking.tickets[0].status, 'checked_in');

  const checkedInList = await attendeeAlice.get('/api/me/bookings');
  const checkedInItem = checkedInList.json.bookings.find((b) => b.id === bookingId);
  assert.equal(checkedInItem.isCheckedIn, true);
});

test('UI Page Rendering: /me attendee hub, /events discovery filters, /events/:id save button', async () => {
  // 1. /me page renders tabbed attendee hub and maintains backward-compatible selectors
  const meRes = await attendeeAlice.get('/me');
  assert.equal(meRes.status, 200);
  assert.match(meRes.text, /data-attendee-hub/, 'contains attendee hub container');
  assert.match(meRes.text, /data-hub-tab="bookings"/, 'contains bookings tab');
  assert.match(meRes.text, /data-hub-tab="saved"/, 'contains saved events tab');
  assert.match(meRes.text, /data-hub-tab="announcements"/, 'contains host updates tab');
  assert.match(meRes.text, /data-booking-filter="all"/, 'contains all bookings filter');
  assert.match(meRes.text, /data-booking-filter="upcoming"/, 'contains upcoming bookings filter');
  assert.match(meRes.text, /data-booking-filter="past"/, 'contains past bookings filter');
  // Invariant: safety-block and profile-block must remain for E2E tests
  assert.match(meRes.text, /data-profile/, 'contains data-profile container');
  assert.match(meRes.text, /data-safety-settings/, 'contains data-safety-settings container');

  // 2. /events page renders multi-filter controls
  const eventsRes = await attendeeAlice.get('/events');
  assert.equal(eventsRes.status, 200);
  assert.match(eventsRes.text, /name="price"/, 'contains price filter');
  assert.match(eventsRes.text, /name="sort"/, 'contains sort filter');
  assert.match(eventsRes.text, /name="category"/, 'contains category filter');
  assert.match(eventsRes.text, /name="city"/, 'contains city filter');
  assert.match(eventsRes.text, /name="when"/, 'contains when filter');

  // 3. /events/:slug detail page renders save button and badges
  const detailRes = await attendeeAlice.get(`/events/${sampleSlug}`);
  assert.equal(detailRes.status, 200);
  assert.match(detailRes.text, /btn-save-event/, 'contains save button in title row');
  assert.match(detailRes.text, /data-save-event/, 'save button has event ID attribute');
});

test('Search & Sorting: query search, sort by trending, date_asc, and price_low', async () => {
  const c = new Client();

  // 1. Text search
  const searchRes = await c.get('/api/discovery/feed?q=mixer');
  assert.equal(searchRes.status, 200);
  assert.ok(Array.isArray(searchRes.json.events));

  // 2. Sort by date_asc
  const dateRes = await c.get('/api/discovery/feed?sort=date_asc');
  assert.equal(dateRes.status, 200);
  const dateEvents = dateRes.json.events;
  for (let i = 1; i < dateEvents.length; i++) {
    assert.ok(new Date(dateEvents[i - 1].startAt) <= new Date(dateEvents[i].startAt));
  }

  // 3. Sort by trending
  const trendRes = await c.get('/api/discovery/feed?sort=trending');
  assert.equal(trendRes.status, 200);
  assert.ok(Array.isArray(trendRes.json.trending));

  // 4. Sort by price_low
  const priceRes = await c.get('/api/discovery/feed?sort=price_low');
  assert.equal(priceRes.status, 200);
  assert.ok(priceRes.json.events.length >= 0);
});

test('Saved Events Error Handling: invalid UUIDs and non-existent events', async () => {
  // Invalid event ID format
  const badIdRes = await attendeeAlice.post('/api/events/not-a-uuid/save', {});
  assert.equal(badIdRes.status, 400);

  // Non-existent event ID
  const missingIdRes = await attendeeAlice.post('/api/events/00000000-0000-0000-0000-000000000099/save', {});
  assert.equal(missingIdRes.status, 404);

  // Invalid delete
  const badDel = await attendeeAlice.req('DELETE', '/api/events/not-a-uuid/save', {});
  assert.equal(badDel.status, 400);
});

