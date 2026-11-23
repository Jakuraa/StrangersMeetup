// test/venue-self-service-onboarding.test.js - Comprehensive tests for Venue Self-Service Onboarding,
// Draft Isolation, Organization Verification Protection, and Safe Ownership Recovery.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, signedInClient, Client } from './helpers.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(async () => {
  await stopServer();
});

test('1. GET /list-your-venue: renders self-service landing page with no legacy form', async () => {
  const c = new Client();
  const res = await c.get('/list-your-venue');
  assert.equal(res.status, 200);

  // Must have primary and secondary CTAs
  assert.ok(res.text.includes('Get Started'));
  assert.ok(res.text.includes('Sign In'));
  assert.ok(res.text.includes('Instant Venue Partner Command Centre'));
  assert.ok(res.text.includes('100% Self-Service Onboarding'));

  // Must NOT have legacy enquiry form or consent checkbox
  assert.ok(!res.text.includes('id="leadForm"'));
  assert.ok(!res.text.includes('id="venueApplyForm"'));
  assert.ok(!res.text.includes('I consent to NIGHTLIFEZ'));
  assert.ok(!res.text.includes('Send submission'));
  assert.ok(!res.text.includes('Our venue curation team reviews every application'));
});

test('2. GET /venue: unauthenticated vs authenticated onboarding gate', async () => {
  const anon = new Client();
  const anonRes = await anon.get('/venue');
  assert.equal(anonRes.status, 200);
  assert.ok(anonRes.text.includes('Sign in to manage your venue'));
  assert.ok(anonRes.text.includes('/signin?next=%2Fvenue'));

  const authed = await signedInClient();
  const authedRes = await authed.get('/venue');
  assert.equal(authedRes.status, 200);
  assert.ok(authedRes.text.includes('Launch Your Venue on NIGHTLIFEZ'));
  assert.ok(authedRes.text.includes('venueOnboardForm'));
  assert.ok(authedRes.text.includes('Profile Completion:'));
  assert.ok(authedRes.text.includes('Zero waitlists or manual approvals'));
});

test('3. Draft publication isolation: draft venue is isolated, not discoverable, and not bookable', async () => {
  const draftUser = await signedInClient();
  const outsider = await signedInClient();

  // Save an incomplete draft
  const draftRes = await draftUser.post('/api/venue/onboard', {
    name: 'Secret Speakeasy Draft',
    category: 'cocktail_speakeasy',
    city: 'Bengaluru',
    is_draft: true
  });
  assert.equal(draftRes.status, 201);
  assert.equal(draftRes.json.isDraft, true);
  const draftId = draftRes.json.venue.id;

  // DB verification: status must be 'draft' and onboarding_completed = false
  const dbVenue = await db.one('SELECT * FROM venues WHERE id = $1', [draftId]);
  assert.equal(dbVenue.status, 'draft', 'Draft venue status must be draft');
  assert.equal(dbVenue.onboarding_completed, false, 'onboarding_completed must be false for draft');

  // Must NOT appear in active venues discovery query
  const activeCount = await db.one("SELECT count(*)::int AS cnt FROM venues WHERE status = 'active' AND id = $1", [draftId]);
  assert.equal(activeCount.cnt, 0, 'Draft venue must not be counted among active venues');

  // Draft owner context: hasVenue is false, but draftVenue is populated for resuming
  const ownerCtx = await draftUser.get('/api/venue/context');
  assert.equal(ownerCtx.status, 200);
  assert.equal(ownerCtx.json.context.hasVenue, false, 'Draft venue must not set hasVenue to true');
  assert.equal(ownerCtx.json.context.venues.length, 0, 'Draft venue must not appear in published venues list');
  assert.ok(ownerCtx.json.context.draftVenue, 'Draft venue must be attached as draftVenue for owner');
  assert.equal(ownerCtx.json.context.draftVenue.id, draftId);
  assert.equal(ownerCtx.json.context.draftVenue.name, 'Secret Speakeasy Draft');

  // Draft venue page: owner visiting /venue still renders onboarding wizard so they can resume
  const ownerPage = await draftUser.get('/venue');
  assert.equal(ownerPage.status, 200);
  assert.ok(ownerPage.text.includes('venueOnboardForm'), 'Owner must see onboarding form to resume draft');
  assert.ok(!ownerPage.text.includes('Venue Command Centre'), 'Command centre must not render for incomplete draft');

  // Outsider / attendee cannot book or submit enquiry on a draft venue
  const enqRes = await outsider.post(`/api/venue/enquiries?venueId=${draftId}`, {
    event_name: 'Private Party',
    event_date: '2026-12-31',
    requester_name: 'Outsider Test',
    expected_guests: 50
  });
  assert.equal(enqRes.status, 404, 'Enquiries on draft venue must return 404');

  // Draft events and analytics queries must return 404
  const evRes = await draftUser.get(`/api/venue/events?venueId=${draftId}`);
  assert.equal(evRes.status, 404, 'Events on draft venue must return 404');
  const anaRes = await draftUser.get(`/api/venue/analytics?venueId=${draftId}`);
  assert.equal(anaRes.status, 404, 'Analytics on draft venue must return 404');
});

test('4. Resuming and completing draft publishes venue to active state', async () => {
  const user = await signedInClient();

  // 1. Save draft
  const draftRes = await user.post('/api/venue/onboard', {
    name: 'The Glasshouse Terrace',
    category: 'rooftop_lounge',
    city: 'Hyderabad',
    is_draft: true
  });
  const venueId = draftRes.json.venue.id;

  // 2. Resume and complete onboarding
  const completeRes = await user.post('/api/venue/onboard', {
    venue_id: venueId,
    name: 'The Glasshouse Terrace',
    category: 'rooftop_lounge',
    city: 'Hyderabad',
    neighbourhood: 'Jubilee Hills',
    address_public: 'Road 36, Jubilee Hills',
    capacity: 180,
    facilities: ['sound_system', 'outdoor_terrace', 'valet_parking'],
    photos: ['https://images.unsplash.com/photo-1517457373958-b7bdd4587205'],
    is_draft: false
  });
  assert.equal(completeRes.status, 201);
  assert.equal(completeRes.json.isDraft, false);

  // DB verification: status becomes 'active', onboarding_completed becomes true
  const updatedVenue = await db.one('SELECT * FROM venues WHERE id = $1', [venueId]);
  assert.equal(updatedVenue.status, 'active', 'Published venue status must be active');
  assert.equal(updatedVenue.onboarding_completed, true, 'Published venue onboarding_completed must be true');

  // User context now has hasVenue: true
  const ctxRes = await user.get('/api/venue/context');
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxRes.json.context.hasVenue, true);
  assert.equal(ctxRes.json.context.activeVenue.name, 'The Glasshouse Terrace');

  // Venue page now renders Venue Command Centre shell
  const pageRes = await user.get('/venue');
  assert.equal(pageRes.status, 200);
  assert.ok(pageRes.text.includes('Venue Command Centre'));
  assert.ok(!pageRes.text.includes('venueOnboardForm'));
});

test('5. Organisation verification protection: new organisations are unverified; verified cannot be self-assigned', async () => {
  const user = await signedInClient();

  // Complete self-service onboarding
  const onboardRes = await user.post('/api/venue/onboard', {
    name: 'Pinnacle Club',
    category: 'nightclub',
    city: 'Bengaluru',
    capacity: 200,
    is_draft: false
  });
  assert.equal(onboardRes.status, 201);
  const venueId = onboardRes.json.venue.id;
  const orgId = onboardRes.json.venue.org_id;

  // 1. Verify in database: organisation.verified_at MUST be NULL
  const orgRow = await db.one('SELECT verified_at FROM organisations WHERE id = $1', [orgId]);
  assert.equal(orgRow.verified_at, null, 'New self-service organisation MUST NOT be automatically verified');

  // 2. Context verification: org_verified must be false
  const ctxRes = await user.get('/api/venue/context');
  assert.equal(ctxRes.json.context.activeVenue.orgVerified, false, 'activeVenue.orgVerified must be false');
  assert.equal(ctxRes.json.context.orgs[0].verified, false, 'org.verified must be false');

  // 3. Profile verification: orgVerified must be false
  const profRes = await user.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(profRes.json.profile.orgVerified, false, 'profile.orgVerified must be false');

  // 4. Attack: Attempt to self-assign verified status via PATCH /api/venue/profile
  const hackPatch = await user.patch(`/api/venue/profile?venueId=${venueId}`, {
    verified_at: new Date().toISOString()
  });
  assert.equal(hackPatch.status, 400, 'Zod strict schema must reject extra verified_at field');

  // Verify in DB that verified_at is still NULL
  const orgAfterAttack = await db.one('SELECT verified_at FROM organisations WHERE id = $1', [orgId]);
  assert.equal(orgAfterAttack.verified_at, null, 'Organisation verified_at must remain NULL');
});

test('6. Existing verified organisations and venues remain verified', async () => {
  const client = await signedInClient();

  // Create an admin-verified organization
  const verifiedOrg = await db.one(
    `INSERT INTO organisations (kind, name, status, verified_at)
     VALUES ('venue_operator', 'Royal Heritage Spaces', 'active', now())
     RETURNING id`
  );
  await db.query(
    `INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
    [client.userId, verifiedOrg.id]
  );
  const venue = await db.one(
    `INSERT INTO venues (org_id, name, category, capacity, status, onboarding_completed)
     VALUES ($1, 'The Grand Ballroom', 'event_space', 500, 'active', true)
     RETURNING id`,
    [verifiedOrg.id]
  );

  // Context must report verified = true
  const ctx = await client.get('/api/venue/context');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.json.context.activeVenue.orgVerified, true, 'Pre-verified venue must report orgVerified = true');

  // Profile must report verified = true
  const prof = await client.get(`/api/venue/profile?venueId=${venue.id}`);
  assert.equal(prof.status, 200);
  assert.equal(prof.json.profile.orgVerified, true);
});

test('7. Duplicate venue protection: triggers 409 and safe self-service ownership claim', async () => {
  const originalOwner = await signedInClient();
  const legitimateClaimant = await signedInClient();

  // 1. Original owner onboards venue
  const origRes = await originalOwner.post('/api/venue/onboard', {
    name: 'Celestial Sky Deck',
    category: 'rooftop_lounge',
    city: 'Kochi',
    address_public: 'Marine Drive, Kochi',
    capacity: 150,
    is_draft: false
  });
  assert.equal(origRes.status, 201);
  const targetVenueId = origRes.json.venue.id;
  const originalOrgId = origRes.json.venue.org_id;

  // 2. Duplicate registration attempt by claimant triggers 409 Conflict with claim challenge info
  const clashRes = await legitimateClaimant.post('/api/venue/onboard', {
    name: 'Celestial Sky Deck',
    category: 'rooftop_lounge',
    city: 'Kochi',
    address_public: 'Marine Drive, Kochi',
    capacity: 150,
    is_draft: false
  });
  assert.equal(clashRes.status, 409);
  assert.equal(clashRes.json.ok, false);
  assert.equal(clashRes.json.error, 'duplicate_venue');
  assert.equal(clashRes.json.existingVenueId, targetVenueId);
  assert.equal(clashRes.json.claimAllowed, true);

  // 3. INVARIANT: Ownership is NOT transferred automatically!
  const venueCheck1 = await db.one('SELECT org_id FROM venues WHERE id = $1', [targetVenueId]);
  assert.equal(venueCheck1.org_id, originalOrgId, 'Venue MUST remain owned by original organisation');

  // 4. Claimant files a structured self-service ownership claim with business proof
  const claimRes = await legitimateClaimant.post('/api/venue/claim', {
    venue_id: targetVenueId,
    claimant_role: 'Managing Partner',
    business_proof_type: 'gstin',
    business_proof_ref: '32AABCC1234D1Z9',
    contact_name: 'Rahul Nair',
    contact_email: 'rahul@celestialdeck.test',
    contact_phone: '+91 98450 12345',
    notes: 'Registered business partner with physical lease agreement for 5th floor terrace.'
  });
  assert.equal(claimRes.status, 201);
  assert.equal(claimRes.json.ok, true);
  assert.equal(claimRes.json.claim.status, 'pending_verification');
  assert.equal(claimRes.json.claim.business_proof_ref, '32AABCC1234D1Z9');

  // 5. INVARIANT: Even after claim submission, ownership is NEVER transferred automatically!
  const venueCheck2 = await db.one('SELECT org_id FROM venues WHERE id = $1', [targetVenueId]);
  assert.equal(venueCheck2.org_id, originalOrgId, 'Ownership must NOT transfer automatically upon claim submission');

  // 6. Claimant can list their active claims self-service
  const claimsList = await legitimateClaimant.get('/api/venue/claims');
  assert.equal(claimsList.status, 200);
  assert.equal(claimsList.json.ok, true);
  assert.equal(claimsList.json.claims.length, 1);
  assert.equal(claimsList.json.claims[0].venueId, targetVenueId);
  assert.equal(claimsList.json.claims[0].status, 'pending_verification');

  // 7. Duplicate claim spam prevention: submitting second claim for same venue returns 409
  const dupClaim = await legitimateClaimant.post('/api/venue/claim', {
    venue_id: targetVenueId,
    claimant_role: 'Managing Partner',
    business_proof_type: 'gstin',
    business_proof_ref: '32AABCC1234D1Z9',
    contact_name: 'Rahul Nair',
    contact_email: 'rahul@celestialdeck.test'
  });
  assert.equal(dupClaim.status, 409);
  assert.equal(dupClaim.json.error, 'claim_already_pending');

  // 8. Existing owner cannot claim their own venue
  const selfClaim = await originalOwner.post('/api/venue/claim', {
    venue_id: targetVenueId,
    claimant_role: 'Owner',
    business_proof_type: 'gstin',
    business_proof_ref: '32AABCC1234D1Z9',
    contact_name: 'Self',
    contact_email: 'self@celestialdeck.test'
  });
  assert.equal(selfClaim.status, 400);
  assert.equal(selfClaim.json.error, 'already_owned');
});

test('8. Cross-organisation ownership isolation: outsiders cannot read or edit other venues', async () => {
  const owner = await signedInClient();
  const intruder = await signedInClient();

  const onboardRes = await owner.post('/api/venue/onboard', {
    name: 'Sanctuary Lounge',
    category: 'cocktail_speakeasy',
    city: 'Chennai',
    capacity: 90,
    is_draft: false
  });
  const venueId = onboardRes.json.venue.id;

  // Intruder cannot view profile
  const getRes = await intruder.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(getRes.status, 404);

  // Intruder cannot patch profile
  const patchRes = await intruder.patch(`/api/venue/profile?venueId=${venueId}`, {
    name: 'Hacked Sanctuary'
  });
  assert.equal(patchRes.status, 404);

  // Verify name in DB remains unaltered
  const v = await db.one('SELECT name FROM venues WHERE id = $1', [venueId]);
  assert.equal(v.name, 'Sanctuary Lounge');
});

test('9. Profile management: owner updates category, neighbourhood, and photos', async () => {
  const owner = await signedInClient();

  const onboardRes = await owner.post('/api/venue/onboard', {
    name: 'Loft 42',
    category: 'studio_loft',
    city: 'Bengaluru',
    capacity: 60,
    is_draft: false
  });
  const venueId = onboardRes.json.venue.id;

  const patchRes = await owner.patch(`/api/venue/profile?venueId=${venueId}`, {
    category: 'event_space',
    neighbourhood: 'Koramangala 4th Block',
    facilities: ['wifi_highspeed', 'projector_av'],
    photos: [
      'https://images.unsplash.com/photo-1522158637959-30385a09e0da',
      'https://images.unsplash.com/photo-1543007630-9710e4a00a20'
    ]
  });

  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.ok, true);

  const profileRes = await owner.get(`/api/venue/profile?venueId=${venueId}`);
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.json.profile.category, 'event_space');
  assert.equal(profileRes.json.profile.neighbourhood, 'Koramangala 4th Block');
  assert.equal(profileRes.json.profile.photos.length, 2);
});

test('10. Cross-functional enablement: venue operator has organiser capabilities', async () => {
  const owner = await signedInClient();

  await owner.post('/api/venue/onboard', {
    name: 'The Terrace Bistro',
    category: 'cafe_bistro',
    city: 'Chennai',
    capacity: 120,
    is_draft: false
  });

  // Check organiser permissions in DB
  const userRow = await db.one('SELECT organiser_enabled FROM users WHERE id = $1', [owner.userId]);
  assert.equal(userRow.organiser_enabled, true);

  // User can access organiser draft creation
  const orgPageRes = await owner.get('/organiser/new');
  assert.equal(orgPageRes.status, 200);
  assert.ok(orgPageRes.text.includes('Event') || orgPageRes.text.includes('Host'));
});
