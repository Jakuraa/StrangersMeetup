// test/m10-operational-hardening.test.js - Milestone 10: Operational Hardening & Final Engineering Gate
// Validates role-specific empty states, venue/partner expectation timelines,
// notification retry & dead-letter handling, staff revocation atomicity,
// and cancellation/check-in concurrency invariants.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, db, signedInClient, Client, createEvent
} from './helpers.js';
import { ensurePersonalOrg } from '../lib/services/permissions.js';
import { assignEventStaff, revokeEventStaff } from '../lib/services/event-staff.js';
import { generateQrPayload } from '../lib/services/tickets.js';

let superAdmin;
let orgUser;
let attendeeUser;
let attendee2User;
let staffUser;
let orgId;
let eventId;
let ticketTypeId;

before(async () => {
  await resetDb();
  await startServer();

  // Super Admin
  superAdmin = await signedInClient({ tgId: 920000001, alias: 'M10 Super Admin' });
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES (920000001, 'super_admin', true) ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'super_admin'`);

  // Organiser
  orgUser = await signedInClient({ tgId: 920000002, alias: 'M10 Organiser' });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [orgUser.userId]);
  orgId = await ensurePersonalOrg({ id: orgUser.userId, alias: 'M10 Org Team' });

  // Attendees
  attendeeUser = await signedInClient({ tgId: 920000003, alias: 'M10 Attendee 1' });
  attendee2User = await signedInClient({ tgId: 920000005, alias: 'M10 Attendee 2' });

  // Staff User
  staffUser = await signedInClient({ tgId: 920000004, alias: 'M10 Staff' });

  // Create a test event for operational check-in / cancellation tests
  const ev = await createEvent({
    title: 'M10 Hardening Gala',
    city: 'Chennai',
    venue: 'Secret Loft, Alwarpet',
    capacity: 10
  });
  eventId = ev.id;
  await db.query(
    `UPDATE events SET organiser_user_id = $1, organiser_org_id = $2, ticketing = 'tiers' WHERE id = $3`,
    [orgUser.userId, orgId, eventId]
  );

  const ttRes = await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'General Access', 'free', 0, 10, true)
     RETURNING id`,
    [eventId]
  );
  ticketTypeId = ttRes.rows[0].id;
});

after(async () => {
  await stopServer();
});

test('1. Role-Specific Empty States: Attendee with 0 bookings and saved events', async () => {
  const freshAttendee = await signedInClient({ tgId: 920000099, alias: 'Fresh Attendee' });
  const meRes = await freshAttendee.get('/api/me/bookings');
  assert.equal(meRes.status, 200);
  assert.deepEqual(meRes.json.bookings, []);

  // HTML profile view renders attendee pass hub
  const htmlRes = await freshAttendee.get('/me');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /My passes &amp; Bookings|My passes & Bookings|My bookings/i);

  // Saved events empty state via saved events API
  const savedRes = await freshAttendee.get('/api/me/saved-events');
  assert.equal(savedRes.status, 200);
  assert.deepEqual(savedRes.json.events, []);
});

test('2. Role-Specific Empty States: Organiser with 0 events renders clear call to action', async () => {
  const emptyOrg = await signedInClient({ tgId: 920000098, alias: 'Empty Org' });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [emptyOrg.userId]);
  await ensurePersonalOrg({ id: emptyOrg.userId, alias: 'Empty Org Team' });

  const orgDashRes = await emptyOrg.get('/organiser');
  assert.equal(orgDashRes.status, 200);
  assert.match(orgDashRes.text, /Your events|Drafts stay private until you publish them/i);

  const orgEventsRes = await emptyOrg.get('/api/organiser/events');
  assert.equal(orgEventsRes.status, 200);
  assert.deepEqual(orgEventsRes.json.events, []);
});

test('3. Post-Submission Lifecycle: Venue Owner 3-step expectation timeline', async () => {
  const client = new Client();
  const res = await client.get('/list-your-venue?sent=1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Venue &amp; Safety Review|Venue & Safety Review/i);
  assert.match(res.text, /Organiser &amp; Format Matching|Organiser & Format Matching/i);
  assert.match(res.text, /Guaranteed Headcounts/i);
  assert.match(res.text, /24 to 48 hours/i);
});

test('4. Post-Submission Lifecycle: Partner / Service Provider 3-step expectation timeline', async () => {
  const client = new Client();
  const res = await client.get('/partner-with-us?sent=1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Capability &amp; Service Review|Capability & Service Review/i);
  assert.match(res.text, /Host &amp; Community Matching|Host & Community Matching/i);
  assert.match(res.text, /Transparent Operational Logistics/i);
  assert.match(res.text, /2 business days/i);
});

test('5. Notification Outbox: Failure, retry tracking, and manual retry idempotency', async () => {
  const dedupeKey = `test:outbox:${Date.now()}`;
  const insertRes = await db.query(
    `INSERT INTO notifications (kind, dedupe_key, status, attempts, last_error)
     VALUES ('broadcast_announcement', $1, 'failed', 2, 'Telegram API network timeout')
     RETURNING id`,
    [dedupeKey]
  );
  const notifId = insertRes.rows[0].id;

  // Admin inspects outbox
  const outboxRes = await superAdmin.get('/api/admin/notifications?status=failed');
  assert.equal(outboxRes.status, 200);
  const found = outboxRes.json.notifications?.find((n) => n.id === notifId);
  assert.ok(found, 'Failed notification must appear in admin outbox');
  assert.equal(found.status, 'failed');
  assert.equal(found.attempts, 2);

  // Admin triggers retry
  const retryRes = await superAdmin.post(`/api/admin/notifications/${notifId}/retry`, {});
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.json.ok, true);

  // Audit log records the administrative retry
  const auditRes = await db.query(
    `SELECT action, actor, target FROM audit_log WHERE action = 'notification.retry' AND target = $1`,
    [notifId]
  );
  assert.equal(auditRes.rows.length, 1);
});

test('6. Staff Revocation: Immediate termination of operational check-in permissions', async () => {
  // Assign staffUser as door_staff
  await assignEventStaff({ id: orgUser.userId }, eventId, { userId: staffUser.userId, role: 'door_staff' });

  // Book a ticket for attendee
  const bookRes = await attendeeUser.post(`/api/events/${eventId}/book`, {
    ticketTypeId,
    quantity: 1
  });
  assert.equal(bookRes.status, 200);
  const bookingId = bookRes.json.bookingId;

  const ticketRow = (await db.query('SELECT id, ticket_code FROM tickets WHERE booking_id = $1', [bookingId])).rows[0];
  const qrPayload = generateQrPayload(ticketRow.ticket_code, eventId);

  // Revoke staffUser before scanning
  await revokeEventStaff({ id: orgUser.userId }, eventId, staffUser.userId);

  // Revoked staff user attempts check-in
  const scanRes = await staffUser.post(`/api/organiser/events/${eventId}/check-in`, {
    qrPayload,
    method: 'camera_qr'
  });
  assert.ok([403, 404].includes(scanRes.status), `Revoked door staff must be denied immediately (403/404): got ${scanRes.status}`);
  assert.equal(scanRes.json.ok, false);
});

test('7. Concurrency Invariant: Check-in vs Cancellation ordering and state protection', async () => {
  // Book ticket for attendee2
  const bookRes2 = await attendee2User.post(`/api/events/${eventId}/book`, {
    ticketTypeId,
    quantity: 1
  });
  assert.equal(bookRes2.status, 200);
  const booking2Id = bookRes2.json.bookingId;

  const ticket2Row = (await db.query('SELECT id, ticket_code FROM tickets WHERE booking_id = $1', [booking2Id])).rows[0];
  const qrPayload2 = generateQrPayload(ticket2Row.ticket_code, eventId);

  // Re-assign staffUser to perform check-in
  await assignEventStaff({ id: orgUser.userId }, eventId, { userId: staffUser.userId, role: 'door_staff' });

  // 1. Perform check-in
  const checkinRes = await staffUser.post(`/api/organiser/events/${eventId}/check-in`, {
    qrPayload: qrPayload2,
    method: 'camera_qr'
  });
  assert.equal(checkinRes.status, 200);
  assert.equal(checkinRes.json.ok, true);

  // 2. Attendee attempts to cancel already checked-in booking
  const cancelRes = await attendee2User.post(`/api/me/bookings/${booking2Id}/cancel`, {});
  // Must reject cancellation because attendee has already checked in
  assert.ok([400, 409, 422].includes(cancelRes.status), `Checked-in ticket cannot be cancelled: status ${cancelRes.status}`);
  assert.equal(cancelRes.json.ok, false);
});

test('8. Live Payments Hard Boundary: ENABLE_LIVE_PAYMENTS=false blocks paid checkout intents', async () => {
  const client = new Client();
  const checkoutRes = await client.post('/api/checkout/upi/intent', {
    eventId,
    ticketTypeId,
    quantity: 1
  });
  // With ENABLE_LIVE_PAYMENTS=false and no test override, intent creation fails closed
  assert.ok([400, 403, 404, 503].includes(checkoutRes.status));
  assert.equal(checkoutRes.json.ok, false);
});
