// test/m9-security-audit.test.js - Milestone 9: Security, Authorization, Concurrency & Resilience Audit
// Exhaustive verification of IDOR/BOLA, session security, tenant isolation, event staff least-privilege,
// admin role boundaries, input sanitization, QR cryptographic integrity, cancellation/refund separation,
// and concurrency race conditions.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, db, Client, signedInClient, clearCalls, createEvent
} from './helpers.js';
import { ensurePersonalOrg } from '../lib/services/permissions.js';
import { generateQrPayload } from '../lib/services/tickets.js';
import { assignEventStaff, revokeEventStaff } from '../lib/services/event-staff.js';

let superAdmin;
let supportAdmin;
let financeAdmin;
let orgA;
let orgB;
let userA;
let userB;
let doorStaffUser;
let unassignedUser;

let eventAId;
let eventBId;
let ticketTypeAId;
let ticketTypeBId;
let orgAId;
let orgBId;

before(async () => {
  await resetDb();
  await startServer();

  // Super Admin
  superAdmin = await signedInClient({ tgId: 900000001 });
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES (900000001, 'super_admin', true) ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'super_admin'`);

  // Support Admin (staff role)
  supportAdmin = await signedInClient({ tgId: 900000002 });
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES (900000002, 'support', true) ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'support'`);

  // Finance Admin
  financeAdmin = await signedInClient({ tgId: 900000003 });
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES (900000003, 'finance', true) ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'finance'`);

  // Organiser A
  orgA = await signedInClient({ tgId: 910000001, alias: 'Organiser A' });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [orgA.userId]);
  orgAId = await ensurePersonalOrg({ id: orgA.userId, alias: 'Org A Team' });

  // Organiser B
  orgB = await signedInClient({ tgId: 910000002, alias: 'Organiser B' });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [orgB.userId]);
  orgBId = await ensurePersonalOrg({ id: orgB.userId, alias: 'Org B Team' });

  // Attendees
  userA = await signedInClient({ tgId: 920000001, alias: 'Attendee Alice' });
  userB = await signedInClient({ tgId: 920000002, alias: 'Attendee Bob' });

  // Staff members
  doorStaffUser = await signedInClient({ tgId: 930000001, alias: 'Door Staff David' });
  unassignedUser = await signedInClient({ tgId: 940000001, alias: 'Unassigned Uma' });

  // Create Event A with a private mystery venue
  const evA = await createEvent({
    title: 'M9 Secret Rooftop Gala',
    category: 'nightlife',
    city: 'Bengaluru',
    area_public: 'Indiranagar',
    venue_name: 'Top Secret Penthouse, 100 Ft Rd (Private)',
    capacity: 20,
    status: 'published',
    private_venue: true
  });
  eventAId = evA.id;
  await db.query(`UPDATE events SET organiser_user_id = $1, organiser_org_id = $2, ticketing = 'tiers' WHERE id = $3`, [orgA.userId, orgAId, eventAId]);

  const ttA = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'General Admission', 'free', 0, 20, true)
     RETURNING id`,
    [eventAId]
  )).rows[0];
  ticketTypeAId = ttA.id;

  // Create Event B
  const evB = await createEvent({
    title: 'M9 Organiser B Art Social',
    category: 'meetup',
    city: 'Chennai',
    area_public: 'Besant Nagar',
    venue_name: 'Besant Beachside Villa',
    capacity: 15,
    status: 'published',
    private_venue: false
  });
  eventBId = evB.id;
  await db.query(`UPDATE events SET organiser_user_id = $1, organiser_org_id = $2, ticketing = 'tiers' WHERE id = $3`, [orgB.userId, orgBId, eventBId]);

  const ttB = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'Standard Entry', 'free', 0, 15, true)
     RETURNING id`,
    [eventBId]
  )).rows[0];
  ticketTypeBId = ttB.id;

  // Assign door staff to Event A
  await assignEventStaff({ id: orgA.userId }, eventAId, {
    userId: doorStaffUser.userId,
    role: 'door_staff'
  });
});

after(stopServer);

beforeEach(() => {
  clearCalls();
});

// =====================================================================================
// 1. Session & Auth Security
// =====================================================================================

test('1. Session security: tampered session cookie signature is rejected with 401', async () => {
  const c = new Client();
  const badCookie = 'sm_session=s%3A999999.invalid_signature_that_does_not_match';
  const res = await c.get('/api/me/bookings', { cookie: badCookie });
  assert.equal(res.status, 401, 'Tampered session cookie must be rejected with 401');
});

test('2. CSRF security: mutating requests require a valid CSRF token', async () => {
  const res = await userA.req('POST', '/api/reports', {
    category: 'harassment',
    body: 'Spam test report body text'
  }, { 'x-csrf-token': 'invalid_csrf_token' });
  assert.equal(res.status, 403, 'Mutation with bad CSRF token must return 403');
});

// =====================================================================================
// 2. IDOR / BOLA Prevention
// =====================================================================================

test('3. IDOR / BOLA: Attendee A cannot access or cancel Attendee B’s booking', async () => {
  // Book ticket for User B on Event A
  const bookResB = await userB.post(`/api/events/${eventAId}/book`, {
    ticketTypeId: ticketTypeAId,
    quantity: 1
  });
  assert.equal(bookResB.status, 200, bookResB.text);
  const bookingIdB = bookResB.json.bookingId;

  // User A attempts to view User B's booking
  const getRes = await userA.get(`/api/bookings/${bookingIdB}`);
  assert.ok(getRes.status === 403 || getRes.status === 404, `User A should not view User B booking: status ${getRes.status}`);

  // User A attempts to cancel User B's booking
  const cancelRes = await userA.post(`/api/me/bookings/${bookingIdB}/cancel`);
  assert.ok(cancelRes.status === 403 || cancelRes.status === 404, `User A should not cancel User B booking: status ${cancelRes.status}`);

  // User A attempts to access User B's ticket QR payload
  const ticketRes = await userA.get(`/api/me/bookings/${bookingIdB}/ticket`);
  assert.ok(ticketRes.status === 403 || ticketRes.status === 404, `User A should not access User B ticket: status ${ticketRes.status}`);
});

test('4. IDOR / BOLA: Organiser B cannot inspect, update or cancel Organiser A’s event', async () => {
  // Organiser B attempts to get Event A overview
  const ovRes = await orgB.get(`/api/organiser/events/${eventAId}/overview`);
  assert.ok(ovRes.status === 403 || ovRes.status === 404, `Organiser B should not see Organiser A event overview: status ${ovRes.status}`);

  // Organiser B attempts to view Event A attendees / bookings
  const guestsRes = await orgB.get(`/api/organiser/events/${eventAId}/guests`);
  assert.ok(guestsRes.status === 403 || guestsRes.status === 404, `Organiser B should not see Organiser A guests: status ${guestsRes.status}`);

  // Organiser B attempts to cancel Event A
  const cancelRes = await orgB.post(`/api/organiser/events/${eventAId}/cancel`);
  assert.ok(cancelRes.status === 403 || cancelRes.status === 404, `Organiser B should not cancel Organiser A event: status ${cancelRes.status}`);
});

// =====================================================================================
// 3. Multi-Org & Tenant Isolation
// =====================================================================================

test('5. Multi-Org Isolation: Organiser B cannot mutate Org A venues or members', async () => {
  const getRes = await orgB.get(`/api/orgs/${orgAId}`);
  assert.equal(getRes.status, 404, 'Outsider querying Org A must get 404');

  const addMemberRes = await orgB.post(`/api/orgs/${orgAId}/members`, { userId: orgB.userId, role: 'owner' });
  assert.ok([400, 403, 404].includes(addMemberRes.status), `Org B cannot add member to Org A: status ${addMemberRes.status}`);
});

// =====================================================================================
// 4. Event Staff Least-Privilege & Scoping
// =====================================================================================

test('6. Event Staff Least-Privilege: Door staff can check in but cannot browse guest list PII or manage event', async () => {
  // Door staff accesses scanner
  const scanPageRes = await doorStaffUser.get(`/organiser/events/${eventAId}/scan`);
  assert.equal(scanPageRes.status, 200, 'Door staff should access scan page for assigned event');

  // Door staff attempts to browse guest list PII
  const guestListRes = await doorStaffUser.get(`/api/organiser/events/${eventAId}/guests`);
  assert.equal(guestListRes.status, 403, 'Door staff must be forbidden from browsing full attendee guest list PII');

  // Door staff attempts to post announcement
  const annRes = await doorStaffUser.post(`/api/organiser/events/${eventAId}/announcements`, {
    title: 'Unauthorized announcement',
    message: 'Door staff posting broadcast message'
  });
  assert.equal(annRes.status, 403, 'Door staff cannot post event announcements');

  // Door staff attempts to cancel event
  const cancelEv = await doorStaffUser.post(`/api/organiser/events/${eventAId}/cancel`);
  assert.equal(cancelEv.status, 403, 'Door staff cannot cancel event');

  // Door staff on unassigned Event B is rejected
  const scanBRes = await doorStaffUser.get(`/api/organiser/events/${eventBId}/scans`);
  assert.ok([403, 404].includes(scanBRes.status), 'Door staff cannot access scan API for unassigned event');
});

test('7. Staff Revocation: Revoked staff member is denied immediately', async () => {
  // Revoke doorStaffUser from Event A
  await revokeEventStaff({ id: orgA.userId }, eventAId, doorStaffUser.userId);

  // Attempt to access scan API now
  const scansRes = await doorStaffUser.get(`/api/organiser/events/${eventAId}/scans`);
  assert.ok([403, 404].includes(scansRes.status), 'Revoked staff must be denied access immediately');

  // Re-assign for subsequent tests
  await assignEventStaff({ id: orgA.userId }, eventAId, {
    userId: doorStaffUser.userId,
    role: 'door_staff'
  });
});

// =====================================================================================
// 5. Admin Role Boundaries & Least-Privilege
// =====================================================================================

test('8. Admin Least-Privilege: Support admin cannot execute refunds, grant organiser, or manage admins', async () => {
  // Support admin attempts to refund
  const refundRes = await supportAdmin.post('/api/admin/payments/dummy_payment_id/refund', {
    reason: 'Unauthorized support refund'
  });
  assert.equal(refundRes.status, 403, 'Support admin cannot issue refunds');

  // Support admin attempts to grant organiser
  const orgGrantRes = await supportAdmin.post('/api/admin/organisers', {
    userId: unassignedUser.userId,
    enabled: true
  });
  assert.equal(orgGrantRes.status, 403, 'Support admin cannot grant organiser privileges');

  // Support admin attempts to upsert admin
  const adminUpsertRes = await supportAdmin.post('/api/admin/admins', {
    telegramUserId: 999999999,
    role: 'super_admin'
  });
  assert.equal(adminUpsertRes.status, 403, 'Support admin cannot create admin users');
});

test('9. Admin Least-Privilege: Finance admin can access payments but cannot manage admins or tiers', async () => {
  const adminUpsertRes = await financeAdmin.post('/api/admin/admins', {
    telegramUserId: 999999999,
    role: 'finance'
  });
  assert.equal(adminUpsertRes.status, 403, 'Finance admin cannot create admin users');

  const tierRes = await financeAdmin.req('PATCH', '/api/admin/tiers/supporter_plus', {
    starsPrice: 500
  });
  assert.equal(tierRes.status, 403, 'Finance admin cannot alter Stars tier pricing');
});

// =====================================================================================
// 6. Input Validation, Injection & Tampering Guards
// =====================================================================================

test('10. Input Validation: SQL injection payloads in search and discovery are safely parameterized', async () => {
  const c = new Client();
  const sqlInjectionCity = "Bengaluru' OR 1=1; --";
  const res = await c.get(`/api/discovery/feed?city=${encodeURIComponent(sqlInjectionCity)}`);
  assert.equal(res.status, 200, 'SQL injection in query param must be safely handled without database crash');
  assert.ok(Array.isArray(res.json.items) || Array.isArray(res.json.events), 'Feed response returns valid array');

  // Test SQL injection in nearby events
  const nearbyRes = await c.get(`/api/events/nearby?lat=12.9716&lng=77.5946&category=${encodeURIComponent("nightlife' OR '1'='1")}`);
  assert.equal(nearbyRes.status, 400, 'Nearby events rejects invalid category filter with 400');
});

test('11. Input Validation: Overlong inputs and illegal types are rejected with 400', async () => {
  // Announcement with 5000 character title (schema limit is 120)
  const hugeTitle = 'A'.repeat(5000);
  const res = await orgA.post(`/api/organiser/events/${eventAId}/announcements`, {
    title: hugeTitle,
    message: 'Valid message body'
  });
  assert.equal(res.status, 400, 'Overlong announcement title must be rejected with 400');
});

// =====================================================================================
// 7. Mystery / Private Venue Secrecy
// =====================================================================================

test('12. Privacy Boundary: Unconfirmed visitors and unbooked attendees never receive private venue address', async () => {
  const c = new Client();
  const evRow = await db.one('SELECT slug FROM events WHERE id = $1', [eventAId]);
  const pageRes = await c.get(`/events/${evRow.slug}`);
  assert.equal(pageRes.status, 200);
  assert.ok(!pageRes.text.includes('Top Secret Penthouse'), 'Public event page must never leak private venue address');
  assert.ok(!pageRes.text.includes('100 Ft Rd (Private)'), 'Public event page must never leak private address details');

  // Public events API
  const apiRes = await c.get('/api/events');
  const found = apiRes.json.events.find((e) => e.id === eventAId);
  if (found) {
    assert.equal(found.venue || '', '', 'Public events API must scrub private venue');
  }

  // Discovery feed API
  const feedRes = await c.get('/api/discovery/feed');
  const items = feedRes.json.items || feedRes.json.events || [];
  const feedEvent = items.find((e) => e.id === eventAId);
  if (feedEvent) {
    assert.ok(!feedEvent.venue?.includes('Top Secret Penthouse'), 'Feed item must not leak private venue address');
  }
});

// =====================================================================================
// 8. QR Ticket Cryptographic Integrity & Replay Defense
// =====================================================================================

test('13. QR Cryptography: Tampered payload signature is rejected with 400/422', async () => {
  // Create booking for Alice on Event A
  const bookRes = await userA.post(`/api/events/${eventAId}/book`, {
    ticketTypeId: ticketTypeAId,
    quantity: 1
  });
  assert.equal(bookRes.status, 200, bookRes.text);

  const tks = await db.query('SELECT * FROM tickets WHERE booking_id = $1', [bookRes.json.bookingId]);
  assert.ok(tks.rows.length > 0);
  const ticket = tks.rows[0];

  const validQr = generateQrPayload(ticket.ticket_code, eventAId);

  // Tamper with the QR payload signature (last 8 characters)
  const tamperedQr = validQr.slice(0, -8) + 'deadbeef';

  const checkInRes = await doorStaffUser.post(`/api/organiser/events/${eventAId}/check-in`, {
    qrPayload: tamperedQr
  });
  assert.ok([400, 422].includes(checkInRes.status), `Tampered QR must be rejected: status ${checkInRes.status}`);
});

test('14. Cross-Event Substitution: Valid QR ticket for Event A presented at Event B is rejected', async () => {
  const tks = await db.query('SELECT * FROM tickets WHERE event_id = $1 LIMIT 1', [eventAId]);
  assert.ok(tks.rows.length > 0, 'Must have at least one ticket for Event A');
  const ticketA = tks.rows[0];

  const qrA = generateQrPayload(ticketA.ticket_code, eventAId);

  // Present QR A at Event B check-in
  const checkInRes = await orgB.post(`/api/organiser/events/${eventBId}/check-in`, {
    qrPayload: qrA
  });
  assert.ok([400, 404, 409, 422].includes(checkInRes.status),
    `Cross-event ticket scan must be rejected: status ${checkInRes.status}`);
});

test('15. Duplicate Scan Replay: Scanning a ticket twice is rejected as duplicate', async () => {
  // Fresh attendee for duplicate scan test
  const freshAttendee = await signedInClient({ tgId: 920000088, alias: 'Attendee Fresh' });
  const bookRes = await freshAttendee.post(`/api/events/${eventAId}/book`, {
    ticketTypeId: ticketTypeAId,
    quantity: 1
  });
  assert.equal(bookRes.status, 200, bookRes.text);

  const tks = await db.query('SELECT * FROM tickets WHERE booking_id = $1', [bookRes.json.bookingId]);
  const ticket = tks.rows[0];

  const qr = generateQrPayload(ticket.ticket_code, eventAId);

  // First scan: should succeed
  const scan1 = await doorStaffUser.post(`/api/organiser/events/${eventAId}/check-in`, {
    qrPayload: qr,
    method: 'camera_qr'
  });
  assert.equal(scan1.status, 200, `First scan should succeed: ${scan1.text}`);
  assert.equal(scan1.json.ok, true);

  // Second scan: duplicate replay must be rejected with 409
  const scan2 = await doorStaffUser.post(`/api/organiser/events/${eventAId}/check-in`, {
    qrPayload: qr,
    method: 'camera_qr'
  });
  assert.equal(scan2.status, 409, `Second scan must be rejected with 409: ${scan2.text}`);
  assert.ok(scan2.json.error === 'already_checked_in' || scan2.text.includes('already'), 'Error should indicate already checked in');
});

// =====================================================================================
// 9. Cancellation vs Refund Separation & Safeguards
// =====================================================================================

test('16. Cancellation Separation: Attendee self-cancellation revokes ticket and releases capacity without financial refund', async () => {
  // Book ticket for Bob on Event B
  const bookRes = await userB.post(`/api/events/${eventBId}/book`, {
    ticketTypeId: ticketTypeBId,
    quantity: 1
  });
  assert.equal(bookRes.status, 200, bookRes.text);
  const bookingId = bookRes.json.bookingId;

  // Confirm booking is confirmed
  const bRow = await db.one('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  assert.equal(bRow.status, 'confirmed');

  // Cancel booking
  const cancelRes = await userB.post(`/api/me/bookings/${bookingId}/cancel`, {
    reason: 'Change of plans'
  });
  assert.equal(cancelRes.status, 200, cancelRes.text);

  // Verify booking row updated to cancelled
  const updatedB = await db.one('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  assert.equal(updatedB.status, 'cancelled');

  // Verify tickets cancelled or revoked
  const tkRows = await db.query('SELECT * FROM tickets WHERE booking_id = $1', [bookingId]);
  for (const tk of tkRows.rows) {
    assert.ok(['cancelled', 'revoked'].includes(tk.status), `Ticket status should be cancelled or revoked (got ${tk.status})`);
  }

  // Attempting to scan cancelled ticket must fail
  const qr = generateQrPayload(tkRows.rows[0].ticket_code, eventBId);
  const scanCancelled = await orgB.post(`/api/organiser/events/${eventBId}/check-in`, {
    qrPayload: qr
  });
  assert.ok([400, 409].includes(scanCancelled.status), 'Scanning revoked ticket must be rejected');

  // Invariant check: No payment or refund row was generated or modified
  const paymentRows = await db.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId]);
  assert.equal(paymentRows.rows.length, 0, 'Free cancellation must never generate payment/refund rows');
});

// =====================================================================================
// 10. Concurrency & Race Condition Stress Testing
// =====================================================================================

test('17. Concurrency: Simultaneous bookings for the last remaining seat prevent overselling', async () => {
  const scarceEv = await createEvent({
    title: 'Scarce Single Ticket Event',
    capacity: 1,
    status: 'published'
  });
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [scarceEv.id]);

  const scarceTier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'Final Seat', 'free', 0, 1, true)
     RETURNING id`,
    [scarceEv.id]
  )).rows[0];

  // Two different attendees attempt to book the last seat simultaneously
  const attendee1 = await signedInClient({ tgId: 920000091 });
  const attendee2 = await signedInClient({ tgId: 920000092 });

  const [res1, res2] = await Promise.all([
    attendee1.post(`/api/events/${scarceEv.id}/book`, { ticketTypeId: scarceTier.id, quantity: 1 }),
    attendee2.post(`/api/events/${scarceEv.id}/book`, { ticketTypeId: scarceTier.id, quantity: 1 })
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'Exactly one booking succeeds (200) and the other is rejected as sold out (409)');

  // Verify database record has exactly 1 confirmed booking
  const confirmed = await db.query(
    `SELECT count(*) FROM bookings WHERE event_id = $1 AND status = 'confirmed'`,
    [scarceEv.id]
  );
  assert.equal(Number(confirmed.rows[0].count), 1, 'Total confirmed bookings in DB must equal exactly 1');
});

test('18. Concurrency: Check-in vs Cancellation race condition', async () => {
  const raceEv = await createEvent({
    title: 'Race Condition Test Event',
    capacity: 5,
    status: 'published'
  });
  await db.query(`UPDATE events SET organiser_user_id = $1, organiser_org_id = $2, ticketing = 'tiers' WHERE id = $3`, [orgA.userId, orgAId, raceEv.id]);

  const raceTier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'Race Entry', 'free', 0, 5, true)
     RETURNING id`,
    [raceEv.id]
  )).rows[0];

  const raceAttendee = await signedInClient({ tgId: 920000093 });
  const bookRes = await raceAttendee.post(`/api/events/${raceEv.id}/book`, {
    ticketTypeId: raceTier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 200, bookRes.text);
  const bookingId = bookRes.json.bookingId;

  const tks = await db.query('SELECT * FROM tickets WHERE booking_id = $1', [bookingId]);
  const tk = tks.rows[0];

  const qr = generateQrPayload(tk.ticket_code, raceEv.id);

  // Assign staff to raceEv
  await assignEventStaff({ id: orgA.userId }, raceEv.id, {
    userId: doorStaffUser.userId,
    role: 'door_staff'
  });

  // Execute check-in and cancellation concurrently
  const [checkInRes, cancelRes] = await Promise.all([
    doorStaffUser.post(`/api/organiser/events/${raceEv.id}/check-in`, { qrPayload: qr }),
    raceAttendee.post(`/api/me/bookings/${bookingId}/cancel`, { reason: 'Late change' })
  ]);

  // Either check-in succeeded first (then cancellation is blocked with 409),
  // OR cancellation succeeded first (then check-in is blocked with 409).
  // Under no circumstance should both succeed!
  const bothSucceeded = (checkInRes.status === 200 && cancelRes.status === 200);
  assert.equal(bothSucceeded, false, 'Check-in and Cancellation cannot both succeed on the same booking');

  // Verify final database state is consistent
  const finalBooking = await db.one('SELECT status FROM bookings WHERE id = $1', [bookingId]);
  assert.ok(['checked_in', 'cancelled'].includes(finalBooking.status), `Final status must be checked_in or cancelled (got ${finalBooking.status})`);
});

// =====================================================================================
// 11. Audit Log Ledger Integrity
// =====================================================================================

test('19. Audit Log Integrity: Sensitive operations are recorded in the audit log', async () => {
  // Query recent audit logs for staff assignments and announcements
  const logs = await db.query(
    `SELECT action, actor, target, details, at FROM audit_log
     WHERE action IN ('event.staff_assign', 'event_announcement.created', 'ticket.check_in')
     ORDER BY at DESC LIMIT 10`
  );
  assert.ok(logs.rows.length > 0, 'Audit log entries must exist for sensitive actions');

  // Verify the audit rows have non-empty actor and action
  for (const r of logs.rows) {
    assert.ok(r.action, 'Action must be populated');
    assert.ok(r.actor, 'Actor must be populated');
  }
});
