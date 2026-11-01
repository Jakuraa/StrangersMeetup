// test/trust-safety-remediation.test.js - Trust & Safety: website safety reports, attendee blocking, and moderation integrity.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, Client, db, clearCalls,
  signedInClient
} from './helpers.js';

before(async () => {
  await resetDb();
  await startServer();
});
after(stopServer);
beforeEach(clearCalls);

function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function organiserClient() {
  const c = await signedInClient({ ageConfirmed: true });
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

function validData(overrides = {}) {
  return {
    template: 'social', category: 'meetup', title: 'Sunday Board Games Social', timezone: 'Asia/Kolkata',
    startLocal: istLocal(10, '17:00'), endLocal: istLocal(10, '21:00'), multiDay: false,
    venue: 'Cafe Tabletop, 4th Cross', city: 'Bengaluru', area: 'Indiranagar', privateVenue: false,
    description: 'Board games with strangers. Arrive by 5, games till 9. Snacks available to buy. 21+ only, photo ID needed.',
    tickets: [{ id: 'free1', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2, validOn: 'all' }],
    features: {},
    ...overrides
  };
}

async function newDraft(c, data) {
  const r = await c.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(r.status, 201, r.text);
  let draft = r.json.draft;
  if (data) {
    const s = await c.req('PUT', `/api/organiser/drafts/${draft.id}`, { data, step: 'preview', version: draft.version });
    assert.equal(s.status, 200, s.text);
    draft = s.json.draft;
  }
  return draft;
}

async function publish(c, data) {
  const d = await newDraft(c, data);
  const r = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: true });
  assert.equal(r.status, 200, r.text);
  const event = await db.one('SELECT * FROM events WHERE id = $1', [r.json.eventId]);
  const tiers = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY sort_order', [event.id])).rows;
  return { ...r.json, event, tiers, draft: d };
}

test('safety reporting: unauthenticated request is rejected with 401', async () => {
  const anon = new Client();
  const res = await anon.post('/api/reports', {
    category: 'harassment',
    body: 'Someone was behaving inappropriately'
  });
  assert.equal(res.status, 401);
});

test('safety reporting: validates category and body length', async () => {
  const user = await signedInClient({ ageConfirmed: true });

  // Invalid category
  const badCat = await user.post('/api/reports', {
    category: 'invalid_category_name',
    body: 'Valid length report description'
  });
  assert.equal(badCat.status, 400);

  // Too short body (<10 chars)
  const tooShort = await user.post('/api/reports', {
    category: 'harassment',
    body: 'short'
  });
  assert.equal(tooShort.status, 400);
});

test('safety reporting: self-reporting is rejected with 400', async () => {
  const user = await signedInClient({ ageConfirmed: true });

  const selfReport = await user.post('/api/reports', {
    category: 'unwanted_contact',
    body: 'Trying to report myself as a test case',
    reportedUserId: user.userId
  });
  assert.equal(selfReport.status, 400);
  assert.equal(selfReport.json.error, 'self_report');
});

test('safety reporting: non-existent event or reported user returns 404', async () => {
  const user = await signedInClient({ ageConfirmed: true });

  const fakeEvent = await user.post('/api/reports', {
    category: 'safety_concern',
    body: 'Reporting against a non-existent event',
    eventId: '00000000-0000-0000-0000-000000000000'
  });
  assert.equal(fakeEvent.status, 404);
  assert.equal(fakeEvent.json.error, 'event_not_found');

  const fakeUser = await user.post('/api/reports', {
    category: 'safety_concern',
    body: 'Reporting against a non-existent user',
    reportedUserId: '00000000-0000-0000-0000-000000000000'
  });
  assert.equal(fakeUser.status, 404);
  assert.equal(fakeUser.json.error, 'user_not_found');
});

test('safety reporting: valid submission, isolation, and admin review lifecycle', async () => {
  const reporter = await signedInClient({ ageConfirmed: true });
  const bystander = await signedInClient({ ageConfirmed: true });
  const admin = await signedInClient({ tgId: 900000001 });

  // Submit valid report
  const submitRes = await reporter.post('/api/reports', {
    category: 'harassment',
    body: 'An attendee made multiple offensive and threatening comments during the social hour.'
  });
  assert.equal(submitRes.status, 201);
  assert.equal(submitRes.json.ok, true);
  assert.equal(submitRes.json.status, 'new');
  assert.match(submitRes.json.message, /reviewed confidentially/);
  const reportId = submitRes.json.reportId;
  assert.ok(reportId);

  // Reporter can view their own reports
  const myReports = await reporter.get('/api/me/reports');
  assert.equal(myReports.status, 200);
  assert.equal(myReports.json.ok, true);
  assert.ok(myReports.json.reports.some((r) => r.id === reportId && r.category === 'harassment'));

  // IDOR Isolation: bystander cannot see reporter's reports
  const bystanderReports = await bystander.get('/api/me/reports');
  assert.equal(bystanderReports.status, 200);
  assert.ok(!bystanderReports.json.reports.some((r) => r.id === reportId));

  // Admin sees report in leads & reports
  const leadsRes = await admin.get('/api/admin/leads');
  assert.equal(leadsRes.status, 200);
  const reportInAdmin = leadsRes.json.reports.find((r) => r.id === reportId);
  assert.ok(reportInAdmin, 'report appears in admin leads & reports');
  assert.equal(reportInAdmin.category, 'harassment');
  assert.equal(reportInAdmin.status, 'new');

  // Admin updates report status with audit log
  const patchRes = await admin.patch(`/api/admin/reports/${reportId}`, { status: 'reviewing' });
  assert.equal(patchRes.status, 200);

  // Check audit log
  const auditRow = (await db.query(
    `SELECT * FROM audit_log WHERE target = $1 AND action = 'report.status'`,
    [reportId]
  )).rows[0];
  assert.ok(auditRow, 'audit log entry created for report status change');
  assert.deepEqual(auditRow.details, { status: 'reviewing' });
});

test('attendee blocking: authorization, self-block protection, and idempotent blocking', async () => {
  const userA = await signedInClient({ ageConfirmed: true });
  const userB = await signedInClient({ ageConfirmed: true });

  // Unauthenticated blocked request is 401
  const anon = new Client();
  const anonBlock = await anon.post('/api/me/blocks', { blockedUserId: userB.userId });
  assert.equal(anonBlock.status, 401);

  // Cannot block oneself -> 400 self_block
  const selfBlock = await userA.post('/api/me/blocks', { blockedUserId: userA.userId });
  assert.equal(selfBlock.status, 400);
  assert.equal(selfBlock.json.error, 'self_block');

  // User A blocks User B
  const blockRes = await userA.post('/api/me/blocks', { blockedUserId: userB.userId });
  assert.equal(blockRes.status, 200);
  assert.equal(blockRes.json.ok, true);

  // List blocks for User A shows User B
  const listA = await userA.get('/api/me/blocks');
  assert.equal(listA.status, 200);
  assert.ok(listA.json.blocks.some((b) => b.blockedUserId === userB.userId));

  // Idempotent block -> returns ok without error
  const dupBlock = await userA.post('/api/me/blocks', { blockedUserId: userB.userId });
  assert.equal(dupBlock.status, 200);

  // Privacy-preserving: User B cannot see that User A blocked them
  const listB = await userB.get('/api/me/blocks');
  assert.equal(listB.status, 200);
  assert.ok(!listB.json.blocks.some((b) => b.blockedUserId === userA.userId), 'User B does not see User A on their list');

  // Unblock
  const unblockRes = await userA.del(`/api/me/blocks/${userB.userId}`);
  assert.equal(unblockRes.status, 200);
  assert.equal(unblockRes.json.ok, true);

  // List blocks after unblock is empty
  const listAAfter = await userA.get('/api/me/blocks');
  assert.ok(!listAAfter.json.blocks.some((b) => b.blockedUserId === userB.userId));
});

test('attendee blocking: booking enforcement prevents blocked users from booking organiser events', async () => {
  const org = await organiserClient();
  const attendee = await signedInClient({ ageConfirmed: true });

  // Organiser publishes an event
  const pub = await publish(org, validData({ title: 'Safety Mixer Indiranagar' }));
  const eventRow = await db.one(`SELECT id, slug FROM events WHERE id = $1`, [pub.eventId]);
  const tier = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [eventRow.id]);

  // Attendee books freely before block
  // First test block enforcement: Organiser blocks Attendee
  await org.post('/api/me/blocks', { blockedUserId: attendee.userId });

  // Attendee attempts to book Organiser's event -> rejected with 403 booking_unavailable
  const blockedAttempt = await attendee.post(`/api/events/${eventRow.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(blockedAttempt.status, 403);
  assert.equal(blockedAttempt.json.error, 'booking_unavailable');
  assert.match(blockedAttempt.json.message, /currently unavailable/);

  // Organiser unblocks Attendee
  await org.del(`/api/me/blocks/${attendee.userId}`);

  // Attendee can now book successfully
  const allowedAttempt = await attendee.post(`/api/events/${eventRow.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(allowedAttempt.status, 200);
  assert.equal(allowedAttempt.json.ok, true);

  // Reverse block test: Attendee blocks Organiser
  const attendee2 = await signedInClient({ ageConfirmed: true });
  await attendee2.post('/api/me/blocks', { blockedUserId: org.userId });

  const reverseAttempt = await attendee2.post(`/api/events/${eventRow.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(reverseAttempt.status, 403);
  assert.equal(reverseAttempt.json.error, 'booking_unavailable');
  assert.match(reverseAttempt.json.message, /blocked this event organiser/);
});

test('attendee blocking: organiser guest list reflects blocked status and user id', async () => {
  const org = await organiserClient();
  const attendee = await signedInClient({ ageConfirmed: true });

  const pub = await publish(org, validData({ title: 'Exclusive Circle' }));
  const tier = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [pub.eventId]);

  // Attendee books
  const b = await attendee.post(`/api/events/${pub.eventId}/book`, {
    ticketTypeId: tier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(b.status, 200);

  // Organiser inspects guest list -> attendee is not blocked
  const guestsBefore = await org.get(`/api/organiser/events/${pub.eventId}/guests`);
  assert.equal(guestsBefore.status, 200);
  const guestItem = guestsBefore.json.guests.find((g) => g.id === b.json.bookingId);
  assert.ok(guestItem);
  assert.equal(guestItem.userId, attendee.userId);
  assert.equal(guestItem.isBlocked, false);

  // Organiser blocks attendee
  await org.post('/api/me/blocks', { blockedUserId: attendee.userId });

  // Organiser inspects guest list -> attendee is now flagged as blocked
  const guestsAfter = await org.get(`/api/organiser/events/${pub.eventId}/guests`);
  const guestItemAfter = guestsAfter.json.guests.find((g) => g.id === b.json.bookingId);
  assert.equal(guestItemAfter.isBlocked, true);
});

test('host application: submission creates internal notification in queue', async () => {
  const anon = new Client();
  const res = await anon.post('/api/leads/host', {
    name: 'Suresh Kumar',
    telegram: '@suresh_host',
    city: 'Bengaluru',
    experience: 'Organised over 20 outdoor mixers and cultural walks over 3 years.',
    idea: 'Secret rooftop acoustic music sessions in Koramangala.',
    consent: 'yes'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  // Check that internal notification was enqueued with external delivery pending/disabled
  const notif = (await db.query(
    `SELECT * FROM notifications WHERE kind = 'host_application_received' ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  assert.ok(notif, 'internal notification created for host application');
  assert.equal(notif.status, 'pending');
});
