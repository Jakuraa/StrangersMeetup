// test/m8-realtime-notifications.test.js - Milestone 8: Real-time Notifications & Operational Comms
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, Client, signedInClient, clearCalls, callsTo, createEvent } from './helpers.js';
import { ensurePersonalOrg } from '../lib/services/permissions.js';
import { isQuietHours, quietHoursNextAttempt, deliver, enqueue } from '../lib/services/notifications.js';
import { cancelUserBooking, getUserBooking, listUserBookings } from '../lib/services/bookings.js';
import { createEventAnnouncement } from '../lib/services/event-announcements.js';
import { issueTicketsForBooking, checkInTicket } from '../lib/services/tickets.js';
import { listOrganiserEvents, getEventOverview, listOrganiserBookings } from '../lib/services/organiser.js';
import { assignEventStaff } from '../lib/services/event-staff.js';

let adminUser;
let organiserUser;
let doorStaffUser;
let attendeeUser;
let otherAttendee;
let testEventId;
let freeTicketTypeId;

before(async () => {
  await resetDb();
  await startServer();

  // Admin client
  adminUser = await signedInClient({ tgId: 900000001 });
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES (900000001, 'super_admin', true) ON CONFLICT DO NOTHING`);

  // Organiser client
  organiserUser = await signedInClient({ tgId: 910000001 });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [organiserUser.userId]);
  const orgId = await ensurePersonalOrg({ id: organiserUser.userId, alias: 'HostOrg' });

  // Event staff (door staff)
  doorStaffUser = await signedInClient({ tgId: 915000001 });

  // Attendees
  attendeeUser = await signedInClient({ tgId: 920000001, alias: 'Alice' });
  otherAttendee = await signedInClient({ tgId: 930000001, alias: 'Bob' });

  // Create published test event
  const ev = await createEvent({
    title: 'M8 Rooftop Social & Cocktails',
    category: 'nightlife',
    city: 'Bengaluru',
    area_public: 'Indiranagar',
    capacity: 25,
    status: 'published'
  });
  testEventId = ev.id;
  await db.query('UPDATE events SET organiser_user_id = $1, organiser_org_id = $2 WHERE id = $3', [organiserUser.userId, orgId, testEventId]);

  // Add free ticket type
  const tt = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'General Admission', 'free', 0, 25, true)
     RETURNING id`,
    [testEventId]
  )).rows[0];
  freeTicketTypeId = tt.id;
});

after(stopServer);

beforeEach(() => {
  clearCalls();
});

test('1. Quiet hours evaluation and next attempt calculation in Asia/Kolkata timezone', () => {
  const user = {
    quiet_hours_enabled: true,
    quiet_hours_start: '23:00',
    quiet_hours_end: '08:00'
  };

  // 23:30 IST -> UTC 18:00
  const lateNight = new Date('2026-11-06T18:00:00.000Z');
  assert.equal(isQuietHours(user, lateNight), true, '23:30 IST should be quiet hours');

  // 02:00 IST -> UTC 20:30 (previous day)
  const earlyHours = new Date('2026-11-06T20:30:00.000Z');
  assert.equal(isQuietHours(user, earlyHours), true, '02:00 IST should be quiet hours');

  // 14:00 IST -> UTC 08:30
  const afternoon = new Date('2026-11-06T08:30:00.000Z');
  assert.equal(isQuietHours(user, afternoon), false, '14:00 IST should not be quiet hours');

  // Disabled quiet hours
  assert.equal(isQuietHours({ quiet_hours_enabled: false }, lateNight), false);

  // quietHoursNextAttempt returns Date in the future
  const nextAt = quietHoursNextAttempt(user, lateNight);
  assert.ok(nextAt instanceof Date);
  assert.ok(nextAt.getTime() > lateNight.getTime());
});

test('2. Non-urgent notification deferral during quiet hours', async () => {
  // Update attendee to have quiet hours enabled right now
  const now = new Date();
  const istParts = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const curH = parseInt(istParts.find((p) => p.type === 'hour').value, 10);
  const startStr = `${String(curH).padStart(2, '0')}:00`;
  const endStr = `${String((curH + 2) % 24).padStart(2, '0')}:00`;

  await db.query(
    `UPDATE users
        SET quiet_hours_enabled = true,
            quiet_hours_start = $2,
            quiet_hours_end = $3
      WHERE id = $1`,
    [attendeeUser.userId, startStr, endStr]
  );

  // Enqueue a non-urgent announcement
  const nId = await enqueue(db, {
    kind: 'event_announcement',
    userId: attendeeUser.userId,
    eventId: testEventId,
    dedupeKey: `test:qh:${Date.now()}`
  });
  assert.ok(nId);

  // Deliver should defer
  const outcome = await deliver(nId);
  assert.equal(outcome, 'deferred_quiet_hours');

  // Verify next_attempt_at was advanced
  const row = await db.one(`SELECT status, next_attempt_at FROM notifications WHERE id = $1`, [nId]);
  assert.equal(row.status, 'pending');
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now());

  // Disable quiet hours again
  await db.query(`UPDATE users SET quiet_hours_enabled = false WHERE id = $1`, [attendeeUser.userId]);
});

test('3. Attendee self-cancellation: releases seat holds, cancels tickets, revokes invites & sends notice', async () => {
  // 1. Book a ticket for attendeeUser
  const booking = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, status, quantity, payment_mode, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', 1, 'free', now())
     RETURNING id`,
    [testEventId, attendeeUser.userId, freeTicketTypeId]
  )).rows[0];

  // 2. Issue tickets
  const issued = await issueTicketsForBooking(booking.id);
  assert.equal(issued.length, 1);
  const ticketId = issued[0].id;

  // 3. Create dummy invite link
  await db.query(
    `INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at)
     VALUES ($1, $2, -100123456789, 'https://t.me/+testinvite', now() + interval '24 hours')`,
    [booking.id, attendeeUser.userId]
  );

  // 4. Attendee self-cancels via service
  const res = await cancelUserBooking(attendeeUser.userId, booking.id, { reason: 'Schedule clash' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'cancelled');

  // 5. Verify booking status
  const bRow = await db.one(`SELECT status, cancel_reason, cancelled_at FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(bRow.status, 'cancelled');
  assert.equal(bRow.cancel_reason, 'Schedule clash');
  assert.ok(bRow.cancelled_at);

  // 6. Verify ticket status is cancelled
  const tRow = await db.one(`SELECT status, revoked_by, revocation_reason FROM tickets WHERE id = $1`, [ticketId]);
  assert.equal(tRow.status, 'cancelled');
  assert.equal(tRow.revoked_by, attendeeUser.userId);

  // 7. Verify invite link is revoked
  const invRow = await db.one(`SELECT revoked_at FROM invite_links WHERE booking_id = $1`, [booking.id]);
  assert.ok(invRow.revoked_at);

  // 8. Verify audit log entry
  const auditRow = await db.one(
    `SELECT action, target FROM audit_log WHERE action = 'booking.attendee_cancel' AND target = $1`,
    [booking.id]
  );
  assert.ok(auditRow);

  // 9. Deliver notifications and verify cancellation notice sent to attendee
  const notif = await db.one(
    `SELECT id FROM notifications WHERE kind = 'booking_cancelled_by_user' AND booking_id = $1`,
    [booking.id]
  );
  assert.ok(notif);
  const deliverOutcome = await deliver(notif.id);
  assert.equal(deliverOutcome, 'sent');

  const tgMessages = callsTo('sendMessage');
  assert.ok(tgMessages.some((m) => m.params.text.includes('cancelled') && Number(m.params.chat_id) === 920000001));

  // 10. Check getUserBooking returns cancelled booking
  const bDetail = await getUserBooking(attendeeUser.userId, booking.id);
  assert.ok(bDetail);
  assert.equal(bDetail.status, 'cancelled');
});

test('4. Cancellation guardrails: rejects checked-in, duplicate, or unauthorized requests', async () => {
  // Create another confirmed booking
  const b = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, status, quantity, payment_mode, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', 1, 'free', now())
     RETURNING id`,
    [testEventId, otherAttendee.userId, freeTicketTypeId]
  )).rows[0];
  const [tk] = await issueTicketsForBooking(b.id);

  // Check-in the ticket at the door
  await checkInTicket({ id: organiserUser.userId }, testEventId, { ticketCode: tk.ticket_code });

  // Update booking to checked_in
  await db.query(`UPDATE bookings SET status = 'checked_in' WHERE id = $1`, [b.id]);

  // Attempt attendee self-cancellation -> 409 already_checked_in
  await assert.rejects(
    cancelUserBooking(otherAttendee.userId, b.id),
    (err) => err.status === 409 && err.code === 'already_checked_in'
  );

  // Create another confirmed booking with a new user and cancel it
  const tempUser = await signedInClient({ tgId: 950000001, alias: 'TempAttendee' });
  const b2 = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, status, quantity, payment_mode, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', 1, 'free', now())
     RETURNING id`,
    [testEventId, tempUser.userId, freeTicketTypeId]
  )).rows[0];
  await cancelUserBooking(tempUser.userId, b2.id);

  // Duplicate cancellation -> 409 already_cancelled
  await assert.rejects(
    cancelUserBooking(tempUser.userId, b2.id),
    (err) => err.status === 409 && err.code === 'already_cancelled'
  );

  // Attempt cancellation by different user -> 404 not_found
  await assert.rejects(
    cancelUserBooking(attendeeUser.userId, b2.id),
    (err) => err.status === 404 && err.code === 'not_found'
  );
});

test('5. Attendee cancellation HTTP endpoints: POST /api/me/bookings/:id/cancel', async () => {
  const b = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, status, quantity, payment_mode, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', 1, 'free', now())
     RETURNING id`,
    [testEventId, attendeeUser.userId, freeTicketTypeId]
  )).rows[0];
  await issueTicketsForBooking(b.id);

  const res = await attendeeUser.post(`/api/me/bookings/${b.id}/cancel`, {
    reason: 'Plans changed'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.status, 'cancelled');

  const after = await attendeeUser.get(`/api/bookings/${b.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.json.booking.status, 'cancelled');
});

test('6. Organiser announcement broadcast delivers formatted message with deep link', async () => {
  // Confirm attendee has a confirmed booking for testEventId
  const b = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, status, quantity, payment_mode, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', 1, 'free', now())
     RETURNING id`,
    [testEventId, attendeeUser.userId, freeTicketTypeId]
  )).rows[0];

  clearCalls();

  // Create announcement
  const annRes = await createEventAnnouncement({ id: organiserUser.userId }, testEventId, {
    title: 'Secret Cocktail Lounge Open',
    message: 'Doors are open. Show your digital pass at the entrance.',
    isPinned: true,
    notifyAttendees: true
  });
  assert.equal(annRes.ok, true);
  assert.equal(annRes.notifiedAttendees >= 1, true);

  // Find the enqueued event_update notification
  const notif = await db.one(
    `SELECT id FROM notifications WHERE kind = 'event_update' AND event_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [testEventId, attendeeUser.userId]
  );
  assert.ok(notif);

  // Deliver notification
  const outcome = await deliver(notif.id);
  assert.equal(outcome, 'sent');

  // Check Telegram sendMessage
  const sent = callsTo('sendMessage').filter((m) => Number(m.params.chat_id) === 920000001);
  assert.ok(sent.length >= 1);
  const msg = sent[sent.length - 1].params;
  assert.ok(msg.text.includes('Secret Cocktail Lounge Open'));
  assert.ok(msg.text.includes('Doors are open'));
  assert.ok(msg.reply_markup?.inline_keyboard?.[0]?.[0]?.url.includes('/bookings/'));
});

test('7. Host approval via setOrganiser enqueues host_approved and delivers congratulations', async () => {
  const applicant = await signedInClient({ tgId: 940000001, alias: 'NewHost' });
  clearCalls();

  const res = await adminUser.post('/api/admin/organisers', {
    telegram_user_id: 940000001,
    enabled: true
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  // Check notification was enqueued
  const n = await db.one(
    `SELECT id FROM notifications WHERE kind = 'host_approved' AND user_id = $1`,
    [applicant.userId]
  );
  assert.ok(n);

  const deliverRes = await deliver(n.id);
  assert.equal(deliverRes, 'sent');

  const msgs = callsTo('sendMessage').filter((m) => Number(m.params.chat_id) === 940000001);
  assert.ok(msgs.length >= 1);
  assert.ok(msgs[0].params.text.includes('Congratulations! Your host application has been approved'));
  assert.ok(msgs[0].params.reply_markup.inline_keyboard[0][0].url.includes('/organiser'));
});

test('8. Event staff scoping: door_staff sees assigned event on /organiser and can check in, but cannot browse guest list PII', async () => {
  // Add door staff to testEventId
  await assignEventStaff({ id: organiserUser.userId }, testEventId, {
    userId: doorStaffUser.userId,
    role: 'door_staff'
  });

  // 1. door_staff calls listOrganiserEvents -> sees assigned event
  const events = await listOrganiserEvents({ id: doorStaffUser.userId });
  const found = events.find((e) => e.id === testEventId);
  assert.ok(found, 'door_staff must see assigned event in event list');
  assert.ok(found.scanUrl.includes('/scan'));

  // 2. door_staff calls getEventOverview -> succeeds
  const overview = await getEventOverview({ id: doorStaffUser.userId }, testEventId);
  assert.equal(overview.event.id, testEventId);
  assert.equal(overview.permissions.canCheckIn, true);

  // 3. door_staff calls listOrganiserBookings -> 403 Forbidden (PII protection)
  await assert.rejects(
    listOrganiserBookings({ id: doorStaffUser.userId }, testEventId),
    (err) => err.status === 403 && err.code === 'forbidden'
  );
});

test('9. Admin notifications outbox API: listing, filtering, and manual retry', async () => {
  // 1. Create a failed notification
  const failNotifId = await enqueue(db, {
    kind: 'event_announcement',
    userId: otherAttendee.userId,
    eventId: testEventId,
    dedupeKey: `outbox:test:${Date.now()}`
  });
  await db.query(`UPDATE notifications SET status = 'failed', attempts = 2, last_error = 'Simulated timeout' WHERE id = $1`, [failNotifId]);

  // 2. GET /api/admin/notifications
  const listRes = await adminUser.get('/api/admin/notifications');
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.ok, true);
  assert.ok(listRes.json.notifications.length >= 1);
  assert.ok(listRes.json.stats.failed_count >= 1);

  // 3. GET /api/admin/notifications?status=failed
  const failedRes = await adminUser.get('/api/admin/notifications?status=failed');
  assert.equal(failedRes.status, 200);
  const failedList = failedRes.json.notifications;
  assert.ok(failedList.every((n) => n.status === 'failed'));

  // 4. POST /api/admin/notifications/:id/retry
  const retryRes = await adminUser.post(`/api/admin/notifications/${failNotifId}/retry`, {});
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.json.ok, true);
  assert.equal(retryRes.json.id, failNotifId);

  // 5. Verify audit log for retry
  const auditEntry = await db.one(
    `SELECT action, target FROM audit_log WHERE action = 'notification.retry' AND target = $1`,
    [failNotifId]
  );
  assert.ok(auditEntry);
});
