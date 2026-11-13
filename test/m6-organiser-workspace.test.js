// test/m6-organiser-workspace.test.js - Milestone 6: Organiser workspace,
// event-scoped staff roles & permissions, server-authoritative QR tickets,
// check-in validation, duplicate scan prevention, and attendance audit trails.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, signedInClient, clearCalls } from './helpers.js';
import { generateQrPayload, parseQrPayload, verifyTicketPayload } from '../lib/services/tickets.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);
beforeEach(() => {
  clearCalls();
});

function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function organiserClient() {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

function validData(overrides = {}) {
  return {
    template: 'social',
    category: 'meetup',
    title: 'M6 Rooftop Networking & Mixer',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(10, '19:00'),
    endLocal: istLocal(10, '23:00'),
    multiDay: false,
    venue: 'Sky Deck Lounge, 80 Feet Rd',
    city: 'Bengaluru',
    area: 'Koramangala',
    privateVenue: false,
    description: 'Exclusive mixer for founders and creators in Bangalore. 21+ only.',
    tickets: [
      { id: 't_free', name: 'Free RSVP', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, validOn: 'all' },
      { id: 't_vip', name: 'VIP Pass', kind: 'free', pricePaise: 0, quantity: 5, maxPerBooking: 1, validOn: 'all' }
    ],
    features: {},
    ...overrides
  };
}

async function publishEvent(c, data = validData()) {
  const r = await c.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(r.status, 201, r.text);
  const draft = r.json.draft;

  const s = await c.req('PUT', `/api/organiser/drafts/${draft.id}`, { data, step: 'preview', version: draft.version });
  assert.equal(s.status, 200, s.text);

  const pub = await c.post(`/api/organiser/drafts/${draft.id}/publish`, { version: s.json.draft.version, confirm: true });
  assert.equal(pub.status, 200, pub.text);

  const event = await db.one('SELECT * FROM events WHERE id = $1', [pub.json.eventId]);
  const tiers = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY sort_order', [event.id])).rows;
  return { event, tiers, draftId: draft.id };
}

// =====================================================================================
// 1. Organiser Overview, Readiness & Inventory
// =====================================================================================

test('organiser overview: metrics, readiness checklist, and capacity breakdown', async () => {
  const org = await organiserClient();
  const { event } = await publishEvent(org);

  const overviewRes = await org.get(`/api/organiser/events/${event.id}/overview`);
  assert.equal(overviewRes.status, 200, overviewRes.text);
  const ov = overviewRes.json.event;
  const metrics = overviewRes.json.metrics;
  const readiness = overviewRes.json.readiness;

  assert.equal(ov.id, event.id);
  assert.equal(ov.title, 'M6 Rooftop Networking & Mixer');
  assert.equal(metrics.capacity, 15);
  assert.equal(metrics.confirmedSeats, 0);
  assert.equal(metrics.checkedInTickets, 0);
  assert.ok(Array.isArray(readiness.checklist));
  assert.ok(readiness.checklist.some((r) => r.key === 'tiers' && r.passed === true));
  assert.ok(readiness.checklist.some((r) => r.key === 'basics' && r.passed === true));

  // Inventory endpoint
  const invRes = await org.get(`/api/organiser/events/${event.id}/inventory`);
  assert.equal(invRes.status, 200, invRes.text);
  assert.equal(invRes.json.tiers.length, 2);
  assert.equal(invRes.json.capacity, 15);
  assert.equal(invRes.json.totalSold, 0);
  assert.equal(invRes.json.totalRemaining, 15);
});

// =====================================================================================
// 2. Cross-Organiser Access Denial
// =====================================================================================

test('cross-organiser access denial: Organiser B cannot inspect or manage Organiser A’s event', async () => {
  const orgA = await organiserClient();
  const orgB = await organiserClient();
  const { event } = await publishEvent(orgA);

  const endpoints = [
    orgB.get(`/api/organiser/events/${event.id}/overview`),
    orgB.get(`/api/organiser/events/${event.id}/inventory`),
    orgB.get(`/api/organiser/events/${event.id}/bookings`),
    orgB.get(`/api/organiser/events/${event.id}/staff`),
    orgB.get(`/api/organiser/events/${event.id}/attendance`),
    orgB.post(`/api/organiser/events/${event.id}/staff/invite`, { role: 'door_staff' }),
    orgB.post(`/api/organiser/events/${event.id}/announcements`, { title: 'Unauthorized', message: 'Hacked update' }),
    orgB.req('PUT', `/api/organiser/events/${event.id}`, { title: 'Hijacked Event' }),
    orgB.post(`/api/organiser/events/${event.id}/cancel`, { reason: 'Malicious cancellation' }),
    orgB.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: 'TK-FAKE-CODE' })
  ];

  const results = await Promise.all(endpoints);
  for (const r of results) {
    // Outsiders receive 404 (zero leakage of private resources) or 403
    assert.ok(
      [403, 404].includes(r.status),
      `Expected 403 or 404 access denial, got ${r.status}: ${r.text}`
    );
  }
});

// =====================================================================================
// 3. Event Staff Roles & Scoped Permissions
// =====================================================================================

test('event staff management: invite, accept, role boundaries, and audit logging', async () => {
  const org = await organiserClient();
  const { event } = await publishEvent(org);

  const staffUser = await signedInClient();
  const assistantUser = await signedInClient();

  // Organiser creates door staff invite
  const invRes = await org.post(`/api/organiser/events/${event.id}/staff/invite`, {
    role: 'door_staff',
    invitedAlias: 'Sammy Door'
  });
  assert.equal(invRes.status, 201, invRes.text);
  assert.ok(invRes.json.token);
  assert.equal(invRes.json.role, 'door_staff');

  // Verify audit log for invite creation
  const invAudit = await db.one(
    `SELECT * FROM audit_log WHERE action = 'event.staff_invite_create' AND target = $1`,
    [invRes.json.inviteId]
  );
  assert.ok(invAudit);

  // Staff accepts invite
  const acceptRes = await staffUser.post('/api/staff/accept-invite', {
    token: invRes.json.token
  });
  assert.equal(acceptRes.status, 200, acceptRes.text);
  assert.equal(acceptRes.json.eventId, event.id);
  assert.equal(acceptRes.json.role, 'door_staff');

  // Assistant invite & accept
  const invAst = await org.post(`/api/organiser/events/${event.id}/staff/invite`, {
    role: 'assistant',
    invitedAlias: 'Alex Assistant'
  });
  await assistantUser.post('/api/staff/accept-invite', { token: invAst.json.token });

  // List staff via organiser API
  const staffList = await org.get(`/api/organiser/events/${event.id}/staff`);
  assert.equal(staffList.status, 200);
  assert.equal(staffList.json.staff.length, 3); // Organiser (owner) + door_staff + assistant

  // Door Staff permission checks:
  // - CAN check attendance
  const attRes = await staffUser.get(`/api/organiser/events/${event.id}/attendance`);
  assert.equal(attRes.status, 200, attRes.text);

  // - CANNOT edit event (member lacks permission -> 403)
  const editRes = await staffUser.req('PUT', `/api/organiser/events/${event.id}`, { title: 'New Title' });
  assert.equal(editRes.status, 403);

  // - CANNOT cancel event
  const cancelRes = await staffUser.post(`/api/organiser/events/${event.id}/cancel`, { reason: 'Staff cancel' });
  assert.equal(cancelRes.status, 403);

  // - CANNOT invite staff
  const staffInviteRes = await staffUser.post(`/api/organiser/events/${event.id}/staff/invite`, { role: 'door_staff' });
  assert.equal(staffInviteRes.status, 403);

  // - CANNOT post announcements
  const annRes = await staffUser.post(`/api/organiser/events/${event.id}/announcements`, { title: 'Notice', message: 'Unauthorized staff announcement' });
  assert.equal(annRes.status, 403);

  // Assistant permission checks:
  // - CAN view overview
  assert.equal((await assistantUser.get(`/api/organiser/events/${event.id}/overview`)).status, 200);
  // - CANNOT check in
  assert.equal((await assistantUser.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: 'TK-TEST' })).status, 403);
});

// =====================================================================================
// 4. Cross-Event Staff Access Denial
// =====================================================================================

test('cross-event staff access denial: door staff for Event A cannot access Event B', async () => {
  const org = await organiserClient();
  const { event: eventA } = await publishEvent(org);
  const { event: eventB } = await publishEvent(org);

  const doorStaff = await signedInClient();
  const inv = await org.post(`/api/organiser/events/${eventA.id}/staff/invite`, { role: 'door_staff' });
  await doorStaff.post('/api/staff/accept-invite', { token: inv.json.token });

  // Accessing Event B must fail with 403 or 404
  const bOverview = await doorStaff.get(`/api/organiser/events/${eventB.id}/overview`);
  assert.ok([403, 404].includes(bOverview.status));

  const bAttendance = await doorStaff.get(`/api/organiser/events/${eventB.id}/attendance`);
  assert.ok([403, 404].includes(bAttendance.status));

  const bCheckin = await doorStaff.post(`/api/organiser/events/${eventB.id}/check-in`, { ticketCode: 'TK-TEST' });
  assert.equal(bCheckin.status, 403);
});

// =====================================================================================
// 5. Staff Revocation
// =====================================================================================

test('staff revocation: immediate termination of operational check-in access', async () => {
  const org = await organiserClient();
  const { event } = await publishEvent(org);

  const doorStaff = await signedInClient();
  const inv = await org.post(`/api/organiser/events/${event.id}/staff/invite`, { role: 'door_staff' });
  await doorStaff.post('/api/staff/accept-invite', { token: inv.json.token });

  // Confirmed working
  assert.equal((await doorStaff.get(`/api/organiser/events/${event.id}/attendance`)).status, 200);

  // Organiser revokes staff member
  const revRes = await org.del(`/api/organiser/events/${event.id}/staff/${doorStaff.userId}`);
  assert.equal(revRes.status, 200, revRes.text);

  // Verify revocation audit log
  const revAudit = await db.one(
    `SELECT * FROM audit_log WHERE action = 'event.staff_revoke' AND target = $1`,
    [revRes.json.staffId]
  );
  assert.ok(revAudit);

  // Immediately blocked
  const postRevAtt = await doorStaff.get(`/api/organiser/events/${event.id}/attendance`);
  assert.ok([403, 404].includes(postRevAtt.status));

  const postRevCheckin = await doorStaff.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: 'TK-TEST' });
  assert.equal(postRevCheckin.status, 403);
});

// =====================================================================================
// 6. Cryptographic QR Ticket Generation & Validation
// =====================================================================================

test('QR tickets: server-authoritative cryptographic issuance and privacy preservation', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const guest = await signedInClient();
  const bookRes = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  assert.equal(bookRes.status, 200, bookRes.text);
  assert.equal(bookRes.json.status, 'confirmed');

  // Verify ticket issued in DB
  const ticket = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [bookRes.json.bookingId]);
  assert.ok(ticket);
  assert.equal(ticket.status, 'valid');
  assert.match(ticket.ticket_code, /^TK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // Guest booking detail includes ticket and QR payload
  const myBooking = await guest.get(`/api/bookings/${bookRes.json.bookingId}`);
  assert.equal(myBooking.status, 200);
  assert.equal(myBooking.json.booking.tickets.length, 1);
  const myTk = myBooking.json.booking.tickets[0];

  assert.equal(myTk.ticketCode, ticket.ticket_code);
  assert.match(myTk.qrPayload, /^NLZ1:[A-Z0-9-]+:[a-f0-9]{64}$/);
  assert.ok(myTk.qrSvg.includes('<svg'));

  // Privacy invariant: QR payload MUST NOT expose guest identity or DB sequence IDs
  assert.ok(!myTk.qrPayload.includes(guest.userId));
  assert.ok(!myTk.qrPayload.includes(String(guest.tgId)));
  assert.ok(!myTk.qrPayload.includes('User'));

  // Cryptographic verification against correct and wrong event ID
  const parsed = parseQrPayload(myTk.qrPayload);
  assert.equal(parsed.ticketCode, ticket.ticket_code);
  assert.ok(verifyTicketPayload(myTk.qrPayload, event.id));
  assert.ok(!verifyTicketPayload(myTk.qrPayload, 'wrong-event-uuid'));
});

// =====================================================================================
// 7. Door Check-In Scanner & Duplicate Scan Prevention
// =====================================================================================

test('check-in workflow: valid check-in, state update, duplicate scan rejection & audit', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const doorStaff = await signedInClient();
  const inv = await org.post(`/api/organiser/events/${event.id}/staff/invite`, { role: 'door_staff' });
  await doorStaff.post('/api/staff/accept-invite', { token: inv.json.token });

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const bookingData = (await guest.get(`/api/bookings/${b.json.bookingId}`)).json.booking;
  const qrPayload = bookingData.tickets[0].qrPayload;

  // 1. Initial valid check-in via Door Staff
  const scanRes = await doorStaff.post(`/api/organiser/events/${event.id}/check-in`, {
    qrPayload,
    method: 'camera_qr'
  });
  assert.equal(scanRes.status, 200, scanRes.text);
  assert.equal(scanRes.json.ok, true);
  assert.equal(scanRes.json.ticket.status, 'checked_in');
  assert.equal(scanRes.json.attendee.ticketType, 'Free RSVP');
  // Privacy invariant: check-in result shows minimal safe data
  assert.equal(scanRes.json.attendee.phone, undefined);

  // Database verification
  const updatedTicket = await db.one('SELECT * FROM tickets WHERE id = $1', [bookingData.tickets[0].id]);
  assert.equal(updatedTicket.status, 'checked_in');
  assert.equal(updatedTicket.checked_in_by, doorStaff.userId);
  assert.ok(updatedTicket.checked_in_at);

  const updatedBooking = await db.one('SELECT * FROM bookings WHERE id = $1', [b.json.bookingId]);
  assert.equal(updatedBooking.status, 'checked_in');

  // Verify scan audit log entry
  const scanLog = await db.one(
    `SELECT * FROM ticket_scans WHERE ticket_id = $1 AND scan_result = 'success'`,
    [updatedTicket.id]
  );
  assert.equal(scanLog.event_id, event.id);
  assert.equal(scanLog.scanned_by, doorStaff.userId);
  assert.equal(scanLog.scan_method, 'camera_qr');

  // 2. Duplicate scan attempt: MUST return 409 Conflict with prior check-in details
  const dupRes = await doorStaff.post(`/api/organiser/events/${event.id}/check-in`, {
    qrPayload,
    method: 'camera_qr'
  });
  assert.equal(dupRes.status, 409, dupRes.text);
  assert.equal(dupRes.json.error, 'already_checked_in');
  assert.ok(dupRes.json.firstCheckIn);
  assert.ok(dupRes.json.firstCheckIn.checkedInAt);

  // Duplicate scan audit log recorded
  const dupLog = await db.one(
    `SELECT * FROM ticket_scans WHERE ticket_id = $1 AND scan_result = 'already_checked_in'`,
    [updatedTicket.id]
  );
  assert.ok(dupLog);
});

// =====================================================================================
// 8. Forged QR & Cross-Event Rejections
// =====================================================================================

test('security checks: forged QR payload, invalid signature, and cross-event ticket rejection', async () => {
  const org = await organiserClient();
  const { event: eventA, tiers } = await publishEvent(org);
  const { event: eventB } = await publishEvent(org);

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${eventA.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const booking = (await guest.get(`/api/bookings/${b.json.bookingId}`)).json.booking;
  const validPayload = booking.tickets[0].qrPayload;
  const validCode = booking.tickets[0].ticketCode;

  // 1. Forged signature: caught by cryptographic verification
  const parts = validPayload.split(':');
  const forgedPayload = `NLZ1:${parts[1]}:${'0'.repeat(64)}`;
  const forgedRes = await org.post(`/api/organiser/events/${eventA.id}/check-in`, { qrPayload: forgedPayload });
  assert.equal(forgedRes.status, 400);
  assert.equal(forgedRes.json.error, 'invalid_ticket');

  // 2. Cross-event scan with QR payload: signature verification bound to eventB fails
  const crossQrRes = await org.post(`/api/organiser/events/${eventB.id}/check-in`, { qrPayload: validPayload });
  assert.equal(crossQrRes.status, 400);
  assert.equal(crossQrRes.json.error, 'invalid_ticket');

  // 3. Cross-event manual code entry: detected against database event ownership
  const crossCodeRes = await org.post(`/api/organiser/events/${eventB.id}/check-in`, { ticketCode: validCode });
  assert.equal(crossCodeRes.status, 400);
  assert.equal(crossCodeRes.json.error, 'event_mismatch');

  // 4. Non-existent ticket code
  const notFoundRes = await org.post(`/api/organiser/events/${eventA.id}/check-in`, { ticketCode: 'TK-XXXX-YYYY' });
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.json.error, 'ticket_not_found');
});

// =====================================================================================
// 9. Cancelled and Refunded Tickets Rejected at Check-In
// =====================================================================================

test('check-in rejection: cancelled and refunded tickets are rejected with clear errors', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const bId = b.json.bookingId;
  const tk = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [bId]);

  // Organiser cancels booking
  const cancelRes = await org.post(`/api/organiser/bookings/${bId}/cancel`, {
    reason: 'Attendee requested cancellation'
  });
  assert.equal(cancelRes.status, 200, cancelRes.text);

  // Scan cancelled ticket: rejected with 409
  const scanCancel = await org.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: tk.ticket_code });
  assert.equal(scanCancel.status, 409);
  assert.equal(scanCancel.json.error, 'ticket_cancelled');

  // Test refunded ticket status: rejected with 409
  const guest2 = await signedInClient();
  const b2 = await guest2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const tk2 = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [b2.json.bookingId]);
  await db.query(`UPDATE bookings SET status = 'refunded' WHERE id = $1`, [b2.json.bookingId]);

  const scanRefund = await org.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: tk2.ticket_code });
  assert.equal(scanRefund.status, 409);
  assert.equal(scanRefund.json.error, 'ticket_refunded');
});

// =====================================================================================
// 10. Ticket Reissue and Old Ticket Revocation
// =====================================================================================

test('ticket reissue: invalidates old ticket, creates new valid ticket with audit trail', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const originalTk = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [b.json.bookingId]);

  // Reissue ticket via Organiser API
  const reissueRes = await org.post(`/api/organiser/tickets/${originalTk.id}/reissue`, {
    reason: 'Lost phone, reissuing to new pass'
  });
  assert.equal(reissueRes.status, 200, reissueRes.text);
  assert.equal(reissueRes.json.ok, true);
  const newTk = reissueRes.json.newTicket;

  assert.notEqual(newTk.ticketCode, originalTk.ticket_code);
  assert.equal(newTk.status, 'valid');

  // Check database linkage
  const oldTkInDb = await db.one('SELECT * FROM tickets WHERE id = $1', [originalTk.id]);
  assert.equal(oldTkInDb.status, 'reissued');
  assert.equal(oldTkInDb.reissued_to_ticket_id, newTk.id);

  // Scanning old ticket MUST be rejected as reissued
  const scanOld = await org.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: originalTk.ticket_code });
  assert.equal(scanOld.status, 409);
  assert.equal(scanOld.json.error, 'ticket_reissued');

  // Scanning new ticket succeeds
  const scanNew = await org.post(`/api/organiser/events/${event.id}/check-in`, { ticketCode: newTk.ticketCode });
  assert.equal(scanNew.status, 200);
  assert.equal(scanNew.json.ticket.status, 'checked_in');
});

// =====================================================================================
// 11. Concurrent Scan Attempts (Atomic Protection)
// =====================================================================================

test('concurrent scans: exactly one check-in succeeds under parallel scan requests', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const tk = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [b.json.bookingId]);
  const qrPayload = generateQrPayload(tk.ticket_code, event.id);

  // Send two parallel check-in requests
  const [res1, res2] = await Promise.all([
    org.post(`/api/organiser/events/${event.id}/check-in`, { qrPayload }),
    org.post(`/api/organiser/events/${event.id}/check-in`, { qrPayload })
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'Exactly one check-in succeeds, parallel scan rejected with 409');
});

// =====================================================================================
// 12. Manual Check-In Overrides
// =====================================================================================

test('manual check-in overrides: requires permission, reason, and records immutable audit', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  const guest = await signedInClient();
  const b = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  const tk = await db.one('SELECT * FROM tickets WHERE booking_id = $1', [b.json.bookingId]);

  // Mark ticket as revoked
  await db.query(`UPDATE tickets SET status = 'revoked' WHERE id = $1`, [tk.id]);

  // Manual override attempt WITHOUT reason fails
  const noReason = await org.post(`/api/organiser/events/${event.id}/check-in`, {
    ticketCode: tk.ticket_code,
    method: 'manual_override',
    overrideReason: '   '
  });
  assert.equal(noReason.status, 400);

  // Valid manual override by Organiser
  const overrideRes = await org.post(`/api/organiser/events/${event.id}/check-in`, {
    ticketCode: tk.ticket_code,
    method: 'manual_override',
    overrideReason: 'Guest present with government ID and valid SuperProfile receipt'
  });
  assert.equal(overrideRes.status, 200, overrideRes.text);
  assert.equal(overrideRes.json.ticket.status, 'checked_in');

  // Verify scan log and audit entry
  const scanLog = await db.one(
    `SELECT * FROM ticket_scans WHERE ticket_id = $1 AND scan_method = 'manual_override'`,
    [tk.id]
  );
  assert.equal(scanLog.scan_result, 'manual_override');
  assert.match(scanLog.override_reason, /government ID/);

  const auditEntry = await db.one(
    `SELECT * FROM audit_log WHERE action = 'ticket.manual_override' AND target = $1`,
    [tk.id]
  );
  assert.ok(auditEntry);
});

// =====================================================================================
// 13. Event Announcements
// =====================================================================================

test('event announcements: posting, pinned updates, and attendee notifications queue', async () => {
  const org = await organiserClient();
  const { event } = await publishEvent(org);

  const postRes = await org.post(`/api/organiser/events/${event.id}/announcements`, {
    title: 'Rain Plan: Moved Undercover',
    message: 'The mixer is moving to the covered terrace on Floor 4 due to light drizzle.',
    isPinned: true,
    notifyAttendees: true
  });
  assert.equal(postRes.status, 201, postRes.text);
  assert.equal(postRes.json.announcement.title, 'Rain Plan: Moved Undercover');
  assert.equal(postRes.json.announcement.isPinned, true);

  // List announcements
  const listRes = await org.get(`/api/organiser/events/${event.id}/announcements`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.announcements.length, 1);
  assert.equal(listRes.json.announcements[0].title, 'Rain Plan: Moved Undercover');
});

// =====================================================================================
// 14. Capacity Editing Invariant
// =====================================================================================

test('capacity constraint: organiser cannot lower capacity below confirmed attendee count', async () => {
  const org = await organiserClient();
  const { event, tiers } = await publishEvent(org);

  // 2 guests book
  const g1 = await signedInClient();
  const g2 = await signedInClient();
  await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  await g2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });

  // Organiser attempts to lower capacity to 1 (below 2 confirmed)
  const lowRes = await org.req('PUT', `/api/organiser/events/${event.id}`, { capacity: 1 });
  assert.equal(lowRes.status, 409);
  assert.equal(lowRes.json.error, 'capacity_too_low');

  // Updating capacity to 20 succeeds
  const okRes = await org.req('PUT', `/api/organiser/events/${event.id}`, { capacity: 20 });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.event.capacity, 20);
});

// =====================================================================================
// 15. Door Check-In Scanner Page UI & Fallback
// =====================================================================================

test('scanner page: renders mobile scanner container and access gating', async () => {
  const org = await organiserClient();
  const { event } = await publishEvent(org);

  const scanPage = await org.get(`/organiser/events/${event.id}/scan`);
  assert.equal(scanPage.status, 200);
  assert.match(scanPage.text, /data-org-scan/);
  assert.match(scanPage.text, /org-scan-wrap/);
  assert.match(scanPage.text, /door check-in scanner/i);
  assert.match(scanPage.text, /noindex/);

  // Unauthorised stranger access is gated
  const stranger = await signedInClient();
  const gated = await stranger.get(`/organiser/events/${event.id}/scan`);
  assert.equal(gated.status, 200);
  assert.match(gated.text, /Organiser access is by invitation/);
});
