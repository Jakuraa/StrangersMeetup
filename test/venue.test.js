// test/venue.test.js - Comprehensive integration tests for the Venue Owner Dashboard.
// Tests authentication, role-based access control, cross-venue isolation, attendee PII protection,
// profile management, booking enquiries, staff coordination, and incident escalations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, signedInClient, Client, createEvent } from './helpers.js';

let serverUrl = '';
let venueOwner = null;
let venueManager = null;
let venueStaff = null;
let outsider = null;
let superAdmin = null;

let venueOrgId = null;
let venueId = null;
let outsiderOrgId = null;
let outsiderVenueId = null;
let eventId = null;

before(async () => {
  await resetDb();
  serverUrl = await startServer();

  venueOwner = await signedInClient();
  venueManager = await signedInClient();
  venueStaff = await signedInClient();
  outsider = await signedInClient();
  superAdmin = await signedInClient();

  // Super admin platform role
  await db.query(`INSERT INTO admin_users (telegram_user_id, role, active) VALUES ($1, 'super_admin', true)`, [superAdmin.tgId]);

  // Create Venue Operator Org A
  const orgRow = (await db.one(
    `INSERT INTO organisations (kind, name, verified_at) VALUES ('venue_operator', 'Test Venue Group', now()) RETURNING id`
  ));
  venueOrgId = orgRow.id;

  // Add memberships for Org A
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [venueOwner.userId, venueOrgId]);
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'manager', 'active')`, [venueManager.userId, venueOrgId]);
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'staff', 'active')`, [venueStaff.userId, venueOrgId]);

  // Create Venue in Org A
  const vRow = (await db.one(
    `INSERT INTO venues (org_id, name, capacity, address_public, address_private, lat, lng, facilities, operating_hours)
     VALUES ($1, 'The Neon Skylounge', 120, 'Koramangala, Bengaluru', '4th Floor, 100ft Road, Gate 3 (private)', 12.93, 77.62,
             '["sound_system", "bar_license", "outdoor_terrace"]'::jsonb,
             '{"friday": "18:00 - 02:00", "saturday": "18:00 - 02:00"}'::jsonb)
     RETURNING id`
    , [venueOrgId]
  ));
  venueId = vRow.id;

  // Create Outsider Org B & Venue B
  const outOrg = (await db.one(
    `INSERT INTO organisations (kind, name, verified_at) VALUES ('venue_operator', 'Outsider Venues', now()) RETURNING id`
  ));
  outsiderOrgId = outOrg.id;
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [outsider.userId, outsiderOrgId]);
  const outVenue = (await db.one(
    `INSERT INTO venues (org_id, name, capacity, address_private) VALUES ($1, 'Outsider Secret Hall', 80, 'Private road') RETURNING id`,
    [outsiderOrgId]
  ));
  outsiderVenueId = outVenue.id;

  // Create an event hosted at Venue A
  const ev = await createEvent({ title: 'Neon Disco Night', capacity: 100 });
  eventId = ev.id;
  await db.query(`UPDATE events SET venue_id = $1 WHERE id = $2`, [venueId, eventId]);

  // Create 2 confirmed bookings for this event (simulate attendees)
  await db.query(
    `INSERT INTO bookings (event_id, user_id, quantity, amount_paise, status, payment_mode)
     VALUES ($1, $2, 1, 0, 'confirmed', 'free'),
            ($1, $3, 1, 0, 'checked_in', 'free')`,
    [eventId, outsider.userId, venueStaff.userId]
  );
});

after(async () => {
  await stopServer();
});

// ---------- 1. Page Access & Gates ----------

test('GET /venue: unauthenticated request renders sign-in gate with Telegram button', async () => {
  const c = new Client();
  const res = await c.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Sign in to manage your venue'));
  assert.ok(res.text.includes('/signin?next=%2Fvenue'));
});

test('GET /venue: authenticated user without venue org renders onboarding and application form', async () => {
  const nonVenue = await signedInClient();
  const res = await nonVenue.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Submit Venue Application'));
  assert.ok(res.text.includes('venueApplyForm'));
});

test('GET /venue: venue operator owner renders Venue Command Centre shell and assets', async () => {
  const res = await venueOwner.get('/venue');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Venue Command Centre'));
  assert.ok(res.text.includes('/css/venue.css'));
  assert.ok(res.text.includes('/js/venue.js'));
  assert.ok(res.text.includes('Overview &amp; KPIs'));
  assert.ok(res.text.includes('Event Schedule'));
});

// ---------- 2. Context & Profile API ----------

test('GET /api/venue/context: unauthenticated returns 401', async () => {
  const c = new Client();
  const res = await c.get('/api/venue/context');
  assert.equal(res.status, 401);
});

test('GET /api/venue/context: venue owner gets hasVenue: true, activeVenue, and permissions', async () => {
  const res = await venueOwner.get('/api/venue/context');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.context.hasVenue, true);
  assert.equal(res.json.context.activeVenueId, venueId);
  assert.equal(res.json.context.userRole, 'owner');
  assert.equal(res.json.context.permissions.canManage, true);
  assert.equal(res.json.context.permissions.canManageEnquiries, true);
  assert.equal(res.json.context.permissions.canViewEvents, true);
});

test('GET /api/venue/profile: owner gets complete venue profile including private address', async () => {
  const res = await venueOwner.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.profile.name, 'The Neon Skylounge');
  assert.equal(res.json.profile.capacity, 120);
  assert.equal(res.json.profile.addressPrivate, '4th Floor, 100ft Road, Gate 3 (private)');
  assert.ok(res.json.profile.facilities.includes('sound_system'));
});

test('GET /api/venue/profile: outsider gets 404 (not revealed)', async () => {
  const res = await outsider.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(res.status, 404);
});

// ---------- 3. Profile Updates & Validation ----------

test('PATCH /api/venue/profile: owner updates capacity, facilities, and house rules with CSRF', async () => {
  const patchData = {
    capacity: 150,
    facilities: ['sound_system', 'bar_license', 'valet_parking', 'projector_av'],
    rules: '21+ strictly enforced. Smart casuals.'
  };

  const res = await venueOwner.patch(`/api/venue/profile?venueId=${venueId}`, patchData);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.venue.capacity, 150);

  // Verify updated state
  const verify = await venueOwner.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(verify.json.profile.capacity, 150);
  assert.ok(verify.json.profile.facilities.includes('projector_av'));
  assert.equal(verify.json.profile.rules, '21+ strictly enforced. Smart casuals.');
});

test('PATCH /api/venue/profile: staff role gets 403 forbidden', async () => {
  const res = await venueStaff.patch(`/api/venue/profile?venueId=${venueId}`, { capacity: 200 });
  assert.equal(res.status, 403);
});

test('PATCH /api/venue/profile: outsider gets 404', async () => {
  const res = await outsider.patch(`/api/venue/profile?venueId=${venueId}`, { capacity: 200 });
  assert.equal(res.status, 404);
});

test('PATCH /api/venue/profile: write without CSRF token returns 403', async () => {
  const res = await venueOwner.patch(`/api/venue/profile?venueId=${venueId}`, { capacity: 180 }, { 'x-csrf-token': 'bad' });
  assert.equal(res.status, 403);
});

test('PATCH /api/venue/profile: invalid input (negative capacity) returns 400', async () => {
  const res = await venueOwner.patch(`/api/venue/profile?venueId=${venueId}`, { capacity: -50 });
  assert.equal(res.status, 400);
});

// ---------- 4. Event Schedule & Attendee PII Protection ----------

test('GET /api/venue/events: returns events with aggregated attendance; strictly protects attendee PII', async () => {
  const res = await venueOwner.get(`/api/venue/events?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.events));
  assert.ok(res.json.events.length >= 1);

  const evItem = res.json.events.find((e) => e.id === eventId);
  assert.ok(evItem);
  assert.equal(evItem.title, 'Neon Disco Night');
  assert.equal(evItem.totalBooked, 1);
  assert.equal(evItem.totalCheckedIn, 1);
  assert.ok(typeof evItem.utilizationRate === 'number');

  // Verify NO individual attendee PII fields exist
  assert.equal(evItem.attendees, undefined);
  assert.equal(evItem.guests, undefined);
  assert.equal(evItem.phone, undefined);
  assert.equal(evItem.email, undefined);
  assert.equal(evItem.user_id, undefined);
});

test('GET /api/venue/events: outsider gets 404', async () => {
  const res = await outsider.get(`/api/venue/events?venueId=${venueId}`);
  assert.equal(res.status, 404);
});

// ---------- 5. Analytics & Telemetry ----------

test('GET /api/venue/analytics: owner gets venue capacity utilization, event counts, and footfall', async () => {
  const res = await venueOwner.get(`/api/venue/analytics?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(typeof res.json.analytics.totalEvents === 'number');
  assert.ok(typeof res.json.analytics.totalAttendees === 'number');
  assert.ok(typeof res.json.analytics.avgUtilization === 'number');
});

test('GET /api/venue/analytics: outsider gets 404', async () => {
  const res = await outsider.get(`/api/venue/analytics?venueId=${venueId}`);
  assert.equal(res.status, 404);
});

// ---------- 6. Organiser Requests & Booking Enquiries ----------

let testEnquiryId = null;

test('POST /api/venue/enquiries: creates an organiser booking enquiry', async () => {
  const enquiryData = {
    requester_name: 'Varun Rao',
    requester_email: 'varun@indieclub.test',
    requester_phone: '+91 98888 77777',
    event_name: 'Indie Fusion Live',
    event_date: '2027-01-20',
    start_time: '19:00',
    end_time: '23:00',
    expected_guests: 75,
    budget_notes: '₹50k F&B minimum guarantee',
    notes: 'Requires stage setup and sound check at 17:00.'
  };

  const res = await outsider.post(`/api/venue/enquiries?venueId=${venueId}`, enquiryData);
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.enquiry.id);
  assert.equal(res.json.enquiry.status, 'pending');
  testEnquiryId = res.json.enquiry.id;
});

test('GET /api/venue/enquiries: owner and manager can view booking enquiries', async () => {
  const res = await venueOwner.get(`/api/venue/enquiries?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const found = res.json.enquiries.find((e) => e.id === testEnquiryId);
  assert.ok(found);
  assert.equal(found.eventName, 'Indie Fusion Live');
  assert.equal(found.expectedGuests, 75);
});

test('POST /api/venue/enquiries/:id/decide: manager approves enquiry', async () => {
  const res = await venueManager.post(`/api/venue/enquiries/${testEnquiryId}/decide`, { action: 'approve' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.enquiry.status, 'approved');
});

test('POST /api/venue/enquiries/:id/decide: declining enquiry records reason', async () => {
  // Create another enquiry to decline
  const cRes = await venueOwner.post(`/api/venue/enquiries?venueId=${venueId}`, {
    requester_name: 'Karan Mehra',
    event_name: 'Private Birthday Bash',
    event_date: '2027-02-14',
    expected_guests: 40
  });
  const enqId = cRes.json.enquiry.id;

  const dRes = await venueOwner.post(`/api/venue/enquiries/${enqId}/decide`, {
    action: 'decline',
    reason: 'Fully booked for Valentine gala'
  });
  assert.equal(dRes.status, 200);
  assert.equal(dRes.json.enquiry.status, 'declined');
  assert.equal(dRes.json.enquiry.decline_reason, 'Fully booked for Valentine gala');
});

test('POST /api/venue/enquiries/:id/decide: outsider gets 404', async () => {
  const res = await outsider.post(`/api/venue/enquiries/${testEnquiryId}/decide`, { action: 'approve' });
  assert.equal(res.status, 404);
});

// ---------- 7. Staff Coordination ----------

test('GET /api/venue/staff: lists team members for venue organisation', async () => {
  const res = await venueOwner.get(`/api/venue/staff?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.staff.length >= 3);
  const ownerMem = res.json.staff.find((m) => m.role === 'owner');
  assert.ok(ownerMem);
});

test('POST /api/venue/staff: owner adds staff member by Telegram ID', async () => {
  const newStaffUser = await signedInClient();
  const res = await venueOwner.post(`/api/venue/staff?venueId=${venueId}`, {
    telegram_user_id: newStaffUser.tgId,
    role: 'staff'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  // Verify staff list contains new member
  const check = await venueOwner.get(`/api/venue/staff?venueId=${venueId}`);
  assert.ok(check.json.staff.some((m) => m.userId === newStaffUser.userId));
});

test('PATCH /api/venue/staff/:memberId: owner updates member role', async () => {
  const res = await venueOwner.patch(`/api/venue/staff/${venueStaff.userId}?venueId=${venueId}`, {
    role: 'manager'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('POST /api/venue/staff: outsider gets 404', async () => {
  const dummy = await signedInClient();
  const res = await outsider.post(`/api/venue/staff?venueId=${venueId}`, {
    telegram_user_id: dummy.tgId,
    role: 'staff'
  });
  assert.equal(res.status, 404);
});

// ---------- 8. Trust, Safety & Incident Reports ----------

test('POST /api/venue/reports: manager submits safety report / escalation', async () => {
  const reportData = {
    category: 'noise_complaint',
    body: 'Local resident raised noise concern past 23:00. Sound volume adjusted immediately.'
  };

  const res = await venueManager.post(`/api/venue/reports?venueId=${venueId}`, reportData);
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.report.id);
  assert.equal(res.json.report.category, 'noise_complaint');
});

test('GET /api/venue/reports: owner views venue safety reports', async () => {
  const res = await venueOwner.get(`/api/venue/reports?venueId=${venueId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.reports.length >= 1);
  assert.equal(res.json.reports[0].category, 'noise_complaint');
});

test('GET /api/venue/reports: outsider gets 404', async () => {
  const res = await outsider.get(`/api/venue/reports?venueId=${venueId}`);
  assert.equal(res.status, 404);
});

// ---------- 9. Venue Application Flow ----------

test('POST /api/venue/apply: signed-in user submits venue application', async () => {
  const applicant = await signedInClient();
  const appData = {
    name: 'Vikram Seth',
    venue_name: 'The Glasshouse Studio',
    email: 'vikram@glasshouse.test',
    city: 'Chennai',
    area: 'Alwarpet',
    capacity: 90,
    message: 'Boutique art gallery and social lounge available for dinners and mixers.'
  };

  const res = await applicant.post('/api/venue/apply', appData);
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.leadId);

  // Context now includes pending application
  const ctxRes = await applicant.get('/api/venue/context');
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxRes.json.context.hasVenue, false);
  assert.ok(ctxRes.json.context.applications.length >= 1);
  assert.equal(ctxRes.json.context.applications[0].venueName, 'The Glasshouse Studio');
  assert.equal(ctxRes.json.context.applications[0].status, 'new');
});
