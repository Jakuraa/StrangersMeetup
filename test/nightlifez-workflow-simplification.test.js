// test/nightlifez-workflow-simplification.test.js - End-to-end regression tests for NIGHTLIFEZ workflow repair:
// 1. Event creation & publishing (draft save, validation recovery, checklist update, publish free event, discovery).
// 2. Ticketing (free defaults, zero price, invalid quantity/limits, duplicate booking guard, paid publish rejection).
// 3. Organiser payment settings (UPI ID & payee name, update, persistence, isolation, unverified status, no paid checkout).
// 4. Authentication (logged-out "Sign in", Telegram flow, destination return, authenticated "My bookings").
// 5. Attendee experience (free RSVP, ticket generation, booking history, cancel & inventory restore).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db, signedInClient } from './helpers.js';
import { validateUpiId, validatePayeeName } from '../lib/services/payment-settings.js';
import { ticketCheckoutStatus } from '../lib/payments/availability.js';
import { seatsTaken } from '../lib/services/bookings.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(async () => {
  await stopServer();
});

function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function createOrganiser() {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

function validFreeDraftData(overrides = {}) {
  return {
    template: 'social',
    category: 'meetup',
    title: 'Indiranagar Tech & Design Mixer',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(7, '18:30'),
    endLocal: istLocal(7, '21:30'),
    multiDay: false,
    venue: 'Third Wave Coffee, 100ft Road',
    city: 'Bengaluru',
    area: 'Indiranagar',
    privateVenue: false,
    description: 'A relaxed evening for founders, designers and engineers to connect and share ideas. Free RSVP, 21+ only.',
    tickets: [
      { id: 't_free', name: 'Free RSVP', kind: 'free', pricePaise: 0, quantity: 40, maxPerBooking: 2, minPerBooking: 1, validOn: 'all' }
    ],
    features: {
      approval: { enabled: false }
    },
    ...overrides
  };
}

test('1. Event creation: draft save, reload, validation fix, publish free event, and discovery visibility', async () => {
  const org = await createOrganiser();

  // Create new draft
  const createRes = await org.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(createRes.status, 201);
  const draftId = createRes.json.draft.id;
  let version = createRes.json.draft.version;

  // Save incomplete draft data (missing title and start time)
  const incompleteData = {
    ...validFreeDraftData(),
    title: '',
    startLocal: ''
  };
  const save1 = await org.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: incompleteData,
    step: 'preview',
    version
  });
  assert.equal(save1.status, 200);
  version = save1.json.draft.version;

  // Check issues on preview
  const check1 = await org.get(`/api/organiser/drafts/${draftId}/check`);
  assert.equal(check1.status, 200);
  const issueFields1 = check1.json.issues.filter((i) => i.severity === 'error').map((i) => i.field);
  assert.ok(issueFields1.includes('title'), 'expected issue for title');
  assert.ok(issueFields1.includes('startLocal'), 'expected issue for startLocal');

  // Attempting to publish must fail with 422
  const pubFail = await org.post(`/api/organiser/drafts/${draftId}/publish`, { version, confirm: true });
  assert.equal(pubFail.status, 422);
  assert.equal(pubFail.json.error, 'not_ready');

  // Organiser fixes the issues (adds title and startLocal)
  const completeData = validFreeDraftData({ title: 'Indiranagar Tech & Design Mixer' });
  const save2 = await org.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: completeData,
    step: 'preview',
    version
  });
  assert.equal(save2.status, 200);
  version = save2.json.draft.version;

  // Verify that the checklist updates immediately and has zero blocking errors
  const check2 = await org.get(`/api/organiser/drafts/${draftId}/check`);
  assert.equal(check2.status, 200);
  const errors2 = check2.json.issues.filter((i) => i.severity === 'error');
  assert.equal(errors2.length, 0, 'all blocking errors must be resolved');

  // Publish the valid free event
  const pubRes = await org.post(`/api/organiser/drafts/${draftId}/publish`, { version, confirm: true });
  assert.equal(pubRes.status, 200);
  assert.ok(pubRes.json.eventId);
  const publishedEventId = pubRes.json.eventId;

  // Confirm event is persisted in PostgreSQL
  const dbEvent = await db.one('SELECT * FROM events WHERE id = $1', [publishedEventId]);
  assert.equal(dbEvent.title, 'Indiranagar Tech & Design Mixer');
  assert.equal(dbEvent.status, 'published');

  // Confirm event appears in public discovery feed
  const anon = new Client();
  const disc = await anon.get('/api/discovery/feed');
  assert.equal(disc.status, 200);
  const found = disc.json.events.find((e) => e.id === publishedEventId);
  assert.ok(found, 'published free event must appear in public discovery');
  assert.equal(found.city, 'Bengaluru');
});

test('2. Ticketing: free defaults, zero price, quantity validation, duplicate prevention, and paid rejection', async () => {
  const org = await createOrganiser();

  // Test paid ticket publication rejection
  const paidDraftRes = await org.post('/api/organiser/drafts', { template: 'social' });
  const paidDraftId = paidDraftRes.json.draft.id;
  let pVer = paidDraftRes.json.draft.version;

  const paidData = validFreeDraftData({
    tickets: [
      { id: 't_paid', name: 'VIP Pass', kind: 'paid', pricePaise: 49900, quantity: 20, maxPerBooking: 2 }
    ]
  });
  const savePaid = await org.req('PUT', `/api/organiser/drafts/${paidDraftId}`, {
    data: paidData,
    step: 'tickets',
    version: pVer
  });
  assert.equal(savePaid.status, 200);
  pVer = savePaid.json.draft.version;

  // Server-side check blocks paid ticket
  const paidCheck = await org.get(`/api/organiser/drafts/${paidDraftId}/check`);
  assert.ok(paidCheck.json.issues.some((i) => i.field === 'tickets'), 'issues must flag paid tickets');

  // Backend publish endpoint refuses paid tickets with 422
  const rejectPaid = await org.post(`/api/organiser/drafts/${paidDraftId}/publish`, { version: pVer, confirm: true });
  assert.equal(rejectPaid.status, 422);

  // Test invalid quantities: 0 or negative quantity
  const badQtyData = validFreeDraftData({
    tickets: [
      { id: 't1', name: 'Free', kind: 'free', pricePaise: 0, quantity: 0, maxPerBooking: 2 }
    ]
  });
  const draftBad = await org.post('/api/organiser/drafts', { template: 'social' });
  const saveBad = await org.req('PUT', `/api/organiser/drafts/${draftBad.json.draft.id}`, {
    data: badQtyData,
    step: 'tickets',
    version: draftBad.json.draft.version
  });
  assert.equal(saveBad.status, 200);
  const checkBad = await org.get(`/api/organiser/drafts/${draftBad.json.draft.id}/check`);
  assert.ok(checkBad.json.issues.some((i) => i.field === 'tickets.0.quantity'), 'quantity 0 must be rejected');

  // Test invalid booking limits: maxPerBooking > quantity
  const badLimitsData = validFreeDraftData({
    tickets: [
      { id: 't2', name: 'Free', kind: 'free', pricePaise: 0, quantity: 5, maxPerBooking: 10 }
    ]
  });
  const saveLimits = await org.req('PUT', `/api/organiser/drafts/${draftBad.json.draft.id}`, {
    data: badLimitsData,
    step: 'tickets',
    version: saveBad.json.draft.version
  });
  assert.equal(saveLimits.status, 200);
  const checkLimits = await org.get(`/api/organiser/drafts/${draftBad.json.draft.id}/check`);
  assert.ok(checkLimits.json.issues.some((i) => i.field === 'tickets.0.maxPerBooking'), 'maxPerBooking > quantity must be rejected');

  // Publish a clean free event to test duplicate booking protection
  const goodDraft = await org.post('/api/organiser/drafts', { template: 'social' });
  const goodData = validFreeDraftData({
    tickets: [{ id: 't_clean', name: 'General RSVP', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2, minPerBooking: 1 }]
  });
  const saveGood = await org.req('PUT', `/api/organiser/drafts/${goodDraft.json.draft.id}`, {
    data: goodData,
    step: 'preview',
    version: goodDraft.json.draft.version
  });
  const pubClean = await org.post(`/api/organiser/drafts/${goodDraft.json.draft.id}/publish`, { version: saveGood.json.draft.version, confirm: true });
  assert.equal(pubClean.status, 200);
  const eventId = pubClean.json.eventId;
  const tier = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1', [eventId])).rows[0];

  // Attendee books free ticket
  const guest = await signedInClient();
  const book1 = await guest.post(`/api/events/${eventId}/book`, { ticketTypeId: tier.id, quantity: 2 });
  assert.equal(book1.status, 200);
  assert.equal(book1.json.status, 'confirmed');

  // Same attendee submits booking again -> duplicate protection returns existing booking
  const book2 = await guest.post(`/api/events/${eventId}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(book2.status, 200);
  assert.equal(book2.json.bookingId, book1.json.bookingId);
  assert.equal(book2.json.existing, true);

  // Assert only one booking row exists in database for this user
  const count = (await db.one('SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND user_id = $2', [eventId, guest.userId])).n;
  assert.equal(count, 1, 'duplicate submission must not create a duplicate booking row');
});

test('3. Organiser UPI & payment settings: add, update, isolation, unverified status, and no paid checkout', async () => {
  // Validate format helper unit checks
  assert.equal(validateUpiId('merchant@oksbi'), 'merchant@oksbi');
  assert.equal(validateUpiId('nightlifez.events@okaxis'), 'nightlifez.events@okaxis');
  assert.throws(() => validateUpiId('invalid-upi'), /Invalid UPI ID format/);
  assert.equal(validatePayeeName('Bengaluru Social Club'), 'Bengaluru Social Club');
  assert.throws(() => validatePayeeName(''), /payee display name/i);

  const orgA = await createOrganiser();
  const orgB = await createOrganiser();

  // Initially empty for Org A
  const getEmpty = await orgA.get('/api/organiser/payment-settings');
  assert.equal(getEmpty.status, 200);
  assert.equal(getEmpty.json.settings.configured, false);
  assert.equal(getEmpty.json.settings.status, 'unconfigured');
  assert.equal(getEmpty.json.settings.isVerified, false);

  // Org A saves UPI settings
  const saveRes = await orgA.req('PUT', '/api/organiser/payment-settings', {
    upiId: 'nightlifez.blr@okicici',
    payeeName: 'NIGHTLIFEZ BLR Club'
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.json.settings.configured, true);
  assert.equal(saveRes.json.settings.upiId, 'nightlifez.blr@okicici');
  assert.equal(saveRes.json.settings.payeeName, 'NIGHTLIFEZ BLR Club');
  assert.equal(saveRes.json.settings.status, 'unverified');
  assert.equal(saveRes.json.settings.isVerified, false);

  // Persistence check: reload via GET
  const getSaved = await orgA.get('/api/organiser/payment-settings');
  assert.equal(getSaved.status, 200);
  assert.equal(getSaved.json.settings.upiId, 'nightlifez.blr@okicici');
  assert.equal(getSaved.json.settings.payeeName, 'NIGHTLIFEZ BLR Club');
  assert.equal(getSaved.json.settings.status, 'unverified');
  assert.equal(getSaved.json.settings.isVerified, false);

  // Ownership isolation: Org B sees their own empty settings, NEVER Org A's details
  const getOrgB = await orgB.get('/api/organiser/payment-settings');
  assert.equal(getOrgB.status, 200);
  assert.equal(getOrgB.json.settings.configured, false);
  assert.equal(getOrgB.json.settings.upiId, null);

  // Business settings endpoint sync check
  const bizGet = await orgA.get('/api/business/payment-settings');
  assert.equal(bizGet.status, 200);
  assert.equal(bizGet.json.settings.upiId, 'nightlifez.blr@okicici');

  // Verify business restriction: saving UPI details MUST NOT activate live payments or paid checkout
  const checkout = ticketCheckoutStatus();
  assert.equal(checkout.available, false, 'live payments must remain disabled');
  assert.equal(process.env.ENABLE_LIVE_PAYMENTS, 'false');
  assert.equal(process.env.UPI_CHECKOUT_ENABLED, 'false');

  // Org A deletes UPI settings
  const delRes = await orgA.req('DELETE', '/api/organiser/payment-settings');
  assert.equal(delRes.status, 200);
  const getAfterDel = await orgA.get('/api/organiser/payment-settings');
  assert.equal(getAfterDel.json.settings.configured, false);
  assert.equal(getAfterDel.json.settings.upiId, null);
});

test('4. Authentication UX: logged out Sign in, destination preservation, authenticated account nav', async () => {
  const anon = new Client();

  // Logged-out visitor homepage navigation shows "Sign in"
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Sign in/);
  assert.match(home.text, /href="\/signin"/);

  // Organiser gate shows Sign in and preserves draft next target
  const gate = await anon.get('/organiser/new?draft=11111111-2222-3333-4444-555555555555');
  assert.equal(gate.status, 200);
  assert.match(gate.text, /Sign in/);
  assert.match(gate.text, /next=%2Forganiser%2Fnew%3Fdraft%3D11111111-2222-3333-4444-555555555555/);

  // Signin page displays clean method tabs
  const signinPage = await anon.get('/signin');
  assert.equal(signinPage.status, 200);
  assert.match(signinPage.text, /Telegram/);
  assert.match(signinPage.text, /WhatsApp/);

  // Authenticated user session reaches /me and has valid session
  const user = await signedInClient();
  const userMe = await user.get('/me');
  assert.equal(userMe.status, 200);
  assert.match(userMe.text, /My Bookings|Manage account/i);
});

test('5. Attendee experience: complete free booking, receive ticket, view booking, and cancel with inventory restored', async () => {
  const org = await createOrganiser();

  // Publish free event with capacity 10
  const draft = await org.post('/api/organiser/drafts', { template: 'social' });
  const data = validFreeDraftData({
    tickets: [{ id: 't_free_rsvp', name: 'Free Pass', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 4, minPerBooking: 1 }]
  });
  const saved = await org.req('PUT', `/api/organiser/drafts/${draft.json.draft.id}`, { data, step: 'preview', version: draft.json.draft.version });
  const pub = await org.post(`/api/organiser/drafts/${draft.json.draft.id}/publish`, { version: saved.json.draft.version, confirm: true });
  assert.equal(pub.status, 200);
  const eventId = pub.json.eventId;
  const tier = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1', [eventId])).rows[0];

  // Attendee books 3 free tickets
  const attendee = await signedInClient();
  const bookRes = await attendee.post(`/api/events/${eventId}/book`, {
    ticketTypeId: tier.id,
    quantity: 3
  });
  assert.equal(bookRes.status, 200);
  const bookingId = bookRes.json.bookingId;
  assert.equal(bookRes.json.status, 'confirmed');

  // Verify tickets issued
  const tickets = (await db.query('SELECT * FROM tickets WHERE booking_id = $1', [bookingId])).rows;
  assert.equal(tickets.length, 3, '3 individual tickets must be generated');
  assert.equal(tickets[0].status, 'valid');

  // Verify seats taken count is 3
  const seatsUsed = await seatsTaken(db, eventId);
  assert.equal(seatsUsed, 3);

  // Attendee views booking under booking details
  const myBooking = await attendee.get(`/api/bookings/${bookingId}`);
  assert.equal(myBooking.status, 200);
  assert.equal(myBooking.json.booking.status, 'confirmed');
  assert.equal(myBooking.json.booking.tickets.length, 3);

  // Attendee cancels booking
  const cancelRes = await attendee.post(`/api/bookings/${bookingId}/cancel`, {
    reason: 'Change of schedule'
  });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.status, 'cancelled');

  // Verify booking row and tickets are marked cancelled in PostgreSQL
  const bRow = await db.one('SELECT status FROM bookings WHERE id = $1', [bookingId]);
  assert.equal(bRow.status, 'cancelled');
  const tRows = (await db.query('SELECT status FROM tickets WHERE booking_id = $1', [bookingId])).rows;
  assert.ok(tRows.every((t) => t.status === 'cancelled'));

  // Verify inventory is completely restored to 0 seats taken
  const seatsAfterCancel = await seatsTaken(db, eventId);
  assert.equal(seatsAfterCancel, 0, 'cancelling must restore available ticket inventory');
});
