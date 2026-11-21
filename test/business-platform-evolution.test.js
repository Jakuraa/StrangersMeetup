// test/business-platform-evolution.test.js - Comprehensive tests for NIGHTLIFEZ Master Platform Evolution
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, startServer, stopServer, signedInClient, Client } from './helpers.js';

let tgSeq = 850000000 + crypto.randomInt(1000000);
async function freshClient(opts = {}) {
  return await signedInClient({ tgId: ++tgSeq, ageConfirmed: true, onboarded: true, ...opts });
}

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
});

test('Mode switching: toggle active mode between attendee and business', async () => {
  const client = await freshClient();

  // Initial mode should be attendee
  const meRes1 = await client.get('/api/me');
  assert.equal(meRes1.status, 200);
  assert.equal(meRes1.json.user.activeMode, 'attendee');

  // Switch to business mode
  const switchRes = await client.post('/api/me/switch-mode', { mode: 'business' });
  assert.equal(switchRes.status, 200);
  assert.equal(switchRes.json.ok, true);
  assert.equal(switchRes.json.activeMode, 'business');

  // Check me API reflects business mode
  const meRes2 = await client.get('/api/me');
  assert.equal(meRes2.json.user.activeMode, 'business');

  // Switch back to attendee
  const switchBack = await client.post('/api/me/switch-mode', { mode: 'attendee' });
  assert.equal(switchBack.status, 200);
  assert.equal(switchBack.json.activeMode, 'attendee');
});

test('Self-service business onboarding: create workspace and complete flow', async () => {
  const client = await freshClient();

  // 1. Create Business Workspace
  const wsRes = await client.post('/api/onboarding/business/workspace', {
    name: 'Pulse Underground Collective',
    businessType: 'organiser',
    primaryCity: 'Bengaluru',
    secondaryCities: ['Chennai', 'Goa'],
    contactEmail: 'pulse@example.com',
    contactPhone: '+919876543210',
    tagline: 'Underground electronic music nights',
    bio: 'Curating boutique techno and house experiences.'
  });
  assert.equal(wsRes.status, 201);
  assert.equal(wsRes.json.ok, true);
  assert.ok(wsRes.json.workspace.id);
  assert.equal(wsRes.json.workspace.business_type, 'organiser');

  // Verify business workspace is mapped to an organisation and user has owner membership
  const orgMem = (await db.query(
    `SELECT m.role FROM org_memberships m WHERE m.org_id = $1 AND m.user_id = $2`,
    [wsRes.json.workspace.org_id, client.userId]
  )).rows[0];
  assert.ok(orgMem, 'membership must exist');
  assert.equal(orgMem.role, 'owner');

  // 2. Complete Business Onboarding
  const compRes = await client.post('/api/onboarding/business/complete', {});
  assert.equal(compRes.status, 200);
  assert.equal(compRes.json.ok, true);
  assert.equal(compRes.json.onboardingFlow, 'business');
  assert.equal(compRes.json.activeMode, 'business');

  // 3. GET /business dashboard loads successfully
  const dashRes = await client.get('/business');
  assert.equal(dashRes.status, 200);
  assert.ok(dashRes.text.includes('Pulse Underground Collective'));
  assert.ok(dashRes.text.includes('Business Command Centre'));
});

test('Business overview API: returns operational telemetry and metrics', async () => {
  const client = await freshClient();

  // Setup workspace
  await client.post('/api/onboarding/business/workspace', {
    name: 'Telemetry Lounge',
    businessType: 'venue',
    primaryCity: 'Bengaluru'
  });

  const overviewRes = await client.get('/api/business/overview');
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewRes.json.ok, true);
  assert.ok(overviewRes.json.workspace);
  assert.ok(overviewRes.json.metrics);
  assert.equal(typeof overviewRes.json.metrics.totalEvents, 'number');
  assert.equal(typeof overviewRes.json.metrics.upcomingEvents, 'number');
});

test('Event lifecycle: duplicate, cancel with mandatory reason, and soft-delete safeguards', async () => {
  const client = await freshClient();

  // Create workspace
  const wsRes = await client.post('/api/onboarding/business/workspace', {
    name: 'Lifecycle Productions',
    businessType: 'organiser',
    primaryCity: 'Chennai'
  });
  const orgId = wsRes.json.workspace.org_id;

  // Insert test event
  const event = (await db.query(
    `INSERT INTO events (organiser_user_id, organiser_org_id, slug, title, category, city, start_at, end_at, status, capacity, ticket_price_paise, price_status)
     VALUES ($1, $2, 'test-nightlife-party-${Date.now()}', 'Neon Sunset Party', 'nightlife', 'Chennai', now() + interval '5 days', now() + interval '5 days 4 hours', 'published', 100, 50000, 'set')
     RETURNING *`,
    [client.userId, orgId]
  )).rows[0];

  // 1. Duplicate Event
  const dupRes = await client.post(`/api/business/events/${event.id}/duplicate`, {});
  assert.equal(dupRes.status, 201);
  assert.equal(dupRes.json.ok, true);
  assert.ok(dupRes.json.event.title.includes('Copy of Neon Sunset Party'));
  assert.equal(dupRes.json.event.status, 'draft');

  // 2. Cancellation validation: rejecting short reason
  const emptyCancel = await client.post(`/api/business/events/${event.id}/cancel`, { reason: 'tiny' });
  assert.equal(emptyCancel.status, 400);

  // 3. Explicit Event Cancellation with mandatory reason
  const cancelRes = await client.post(`/api/business/events/${event.id}/cancel`, {
    reason: 'Artist unable to travel due to flight cancellations',
    refundNotes: 'Full refund processed via UPI within 24h'
  });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.cancelled, true);

  // Check event_cancellations record
  const cancelRec = (await db.query(`SELECT * FROM event_cancellations WHERE event_id = $1`, [event.id])).rows[0];
  assert.ok(cancelRec);
  assert.equal(cancelRec.cancelled_by_user_id, client.userId);
  assert.ok(cancelRec.reason.includes('flight cancellations'));

  // 4. Soft-delete cancelled event
  const delRes = await client.del(`/api/business/events/${event.id}`);
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.deleted, true);

  // Verify soft-deletion flag
  const checkEvent = (await db.query(`SELECT is_deleted, deleted_at FROM events WHERE id = $1`, [event.id])).rows[0];
  assert.equal(checkEvent.is_deleted, true);
  assert.ok(checkEvent.deleted_at);
});

test('Soft-deletion dependency safeguard: blocks deletion if confirmed bookings exist on non-cancelled event', async () => {
  const client = await freshClient();
  const guest = await freshClient();

  const wsRes = await client.post('/api/onboarding/business/workspace', {
    name: 'Safeguard Events',
    businessType: 'organiser',
    primaryCity: 'Hyderabad'
  });
  const orgId = wsRes.json.workspace.org_id;

  const event = (await db.query(
    `INSERT INTO events (organiser_user_id, organiser_org_id, slug, title, category, city, start_at, status, capacity, ticket_price_paise, price_status)
     VALUES ($1, $2, 'active-booked-event-${Date.now()}', 'Active Booked Event', 'nightlife', 'Hyderabad', now() + interval '2 days', 'published', 50, 49900, 'set')
     RETURNING *`,
    [client.userId, orgId]
  )).rows[0];

  // Insert confirmed booking
  await db.query(
    `INSERT INTO bookings (event_id, user_id, status)
     VALUES ($1, $2, 'confirmed')`,
    [event.id, guest.userId]
  );

  // Attempt to delete active event with confirmed booking -> must fail with 409 unsettled_bookings
  const delAttempt = await client.del(`/api/business/events/${event.id}`);
  assert.equal(delAttempt.status, 409);
  assert.equal(delAttempt.json.error, 'unsettled_bookings');
});

test('Media lifecycle: preview reclaimable media and perform on-demand cleanup', async () => {
  const client = await freshClient();

  const wsRes = await client.post('/api/onboarding/business/workspace', {
    name: 'Media Studio',
    businessType: 'supplier',
    primaryCity: 'Kochi'
  });
  const orgId = wsRes.json.workspace.org_id;

  // Insert past event with draft image
  const draft = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status) VALUES ($1, 'active') RETURNING id`,
    [client.userId]
  )).rows[0];

  await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, byte_size, content_type, bytes)
     VALUES ($1, $2, 204800, 'image/jpeg', decode('deadbeef', 'hex'))
     RETURNING id, byte_size`,
    [client.userId, draft.id]
  );

  const pastEvent = (await db.query(
    `INSERT INTO events (organiser_user_id, organiser_org_id, draft_id, slug, title, category, city, start_at, end_at, status, capacity, price_status)
     VALUES ($1, $2, $3, 'past-completed-party-${Date.now()}', 'Past Party', 'nightlife', 'Kochi', now() - interval '40 days', now() - interval '40 days' + interval '3 hours', 'published', 50, 'tbd')
     RETURNING id`,
    [client.userId, orgId, draft.id]
  )).rows[0];

  // 1. Calculate Reclaimable Storage Preview
  const previewRes = await client.get(`/api/business/media/cleanup-preview?eventId=${pastEvent.id}`);
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.json.ok, true);
  assert.equal(previewRes.json.imageCount, 1);
  assert.equal(previewRes.json.reclaimableBytes, 204800);

  // 2. Perform On-Demand Cleanup
  const cleanupRes = await client.post('/api/business/media/cleanup-now', { eventId: pastEvent.id });
  assert.equal(cleanupRes.status, 200);
  assert.equal(cleanupRes.json.ok, true);
  assert.equal(cleanupRes.json.deletedCount, 1);
  assert.equal(cleanupRes.json.deletedBytes, 204800);

  // Verify event record updated
  const evUpdated = (await db.query(`SELECT media_cleaned_up FROM events WHERE id = $1`, [pastEvent.id])).rows[0];
  assert.equal(evUpdated.media_cleaned_up, true);

  // Verify audit record in media_cleanup_jobs
  const job = (await db.query(`SELECT * FROM media_cleanup_jobs WHERE event_id = $1`, [pastEvent.id])).rows[0];
  assert.ok(job);
  assert.equal(job.bytes_reclaimed, 204800);
});

test('Attendee recommendations and social connections APIs', async () => {
  const alice = await freshClient();
  const bob = await freshClient();

  await db.query(`UPDATE users SET city = 'Bengaluru' WHERE id = $1`, [alice.userId]);
  await db.query(`UPDATE users SET city = 'Bengaluru' WHERE id = $1`, [bob.userId]);

  // 1. Recommendations API
  const recRes = await alice.get('/api/me/recommendations');
  assert.equal(recRes.status, 200);
  assert.equal(recRes.json.ok, true);
  assert.ok(Array.isArray(recRes.json.recommendations));

  // 2. Send Connection Request from Alice to Bob
  const connReq = await alice.post('/api/me/connections/request', { targetUserId: bob.userId });
  assert.equal(connReq.status, 201);
  assert.equal(connReq.json.ok, true);
  assert.equal(connReq.json.connection.status, 'pending');

  // 3. Bob checks pending incoming requests
  const bobConns = await bob.get('/api/me/connections');
  assert.equal(bobConns.status, 200);
  assert.equal(bobConns.json.pendingRequests.length, 1);
  assert.equal(bobConns.json.pendingRequests[0].requester_id, alice.userId);

  // 4. Bob accepts connection request
  const acceptRes = await bob.post(`/api/me/connections/${bobConns.json.pendingRequests[0].id}/accept`, {});
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.json.accepted, true);

  // 5. Verify Alice now sees Bob in active connections
  const aliceConns = await alice.get('/api/me/connections');
  assert.equal(aliceConns.json.connections.length, 1);
  assert.equal(aliceConns.json.connections[0].partner_id, bob.userId);
});

test('Retirement & upgraded CTAs on legacy waitlist forms', async () => {
  const client = new Client();

  // /become-a-host serves 200 with upgraded self-service CTA
  const hostRes = await client.get('/become-a-host');
  assert.equal(hostRes.status, 200);
  assert.ok(hostRes.text.includes('/business/new?type=host'));

  // /list-your-venue serves 200 with upgraded self-service CTA
  const venueRes = await client.get('/list-your-venue');
  assert.equal(venueRes.status, 200);
  assert.ok(venueRes.text.includes('/business/new?type=venue'));

  // /partner-with-us serves 200 with upgraded self-service CTA
  const partnerRes = await client.get('/partner-with-us');
  assert.equal(partnerRes.status, 200);
  assert.ok(partnerRes.text.includes('/business/new?type=supplier'));
});
