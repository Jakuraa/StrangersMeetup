// test/venue-self-service-onboarding.test.js - Comprehensive tests for Venue Self-Service Onboarding.
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

test('3. POST /api/venue/onboard: complete self-service launch activates venue immediately', async () => {
  const user = await signedInClient();

  const payload = {
    name: 'Aura Skybar & Lounge',
    category: 'rooftop_lounge',
    description: 'High-energy rooftop terrace with panoramic city views and curated house music.',
    city: 'Bengaluru',
    neighbourhood: 'Indiranagar',
    address_public: '100 Feet Road, Indiranagar',
    address_private: 'Private VIP Elevator behind Ground Floor Entrance, 5th Floor Terrace',
    capacity: 250,
    contact_name: 'Aditya Rao',
    contact_phone: '+91 98765 00001',
    contact_email: 'aditya@auraskybar.test',
    facilities: ['sound_system', 'bar_license', 'outdoor_terrace', 'valet_parking'],
    operating_hours: { friday: '18:00 - 01:00', saturday: '18:00 - 01:00' },
    rules: '21+ only, Smart casuals required, Outside liquor prohibited.',
    photos: ['https://images.unsplash.com/photo-1517457373958-b7bdd4587205'],
    is_draft: false
  };

  const res = await user.post('/api/venue/onboard', payload);
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.isDraft, false);
  assert.ok(res.json.venue.id);
  assert.equal(res.json.venue.name, 'Aura Skybar & Lounge');
  assert.equal(res.json.venue.category, 'rooftop_lounge');
  assert.equal(res.json.completionPercentage >= 90, true);

  // User is now recognized as active venue operator
  const ctxRes = await user.get('/api/venue/context');
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxRes.json.context.hasVenue, true);
  assert.equal(ctxRes.json.context.activeVenue.name, 'Aura Skybar & Lounge');

  // Verify dashboard shell renders active command centre
  const pageRes = await user.get('/venue');
  assert.equal(pageRes.status, 200);
  assert.ok(pageRes.text.includes('Venue Command Centre'));
  assert.ok(!pageRes.text.includes('venueOnboardForm'));
});

test('4. POST /api/venue/onboard: saving progress (draft) preserves partial data', async () => {
  const draftUser = await signedInClient();

  const draftPayload = {
    name: 'Velvet Speakeasy Lounge',
    category: 'cocktail_speakeasy',
    city: 'Chennai',
    is_draft: true
  };

  const res = await draftUser.post('/api/venue/onboard', draftPayload);
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.isDraft, true);
  assert.equal(res.json.venue.name, 'Velvet Speakeasy Lounge');
  assert.ok(res.json.missingFields.length > 0);
  assert.ok(res.json.completionPercentage > 0 && res.json.completionPercentage < 100);

  // Draft venue is stored in database with onboarding_completed = false
  const rows = await db.query('SELECT * FROM venues WHERE id = $1', [res.json.venue.id]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].onboarding_completed, false);
  assert.equal(rows.rows[0].category, 'cocktail_speakeasy');
});

test('5. Anti-hijacking: duplicate venue name and location in another org returns 409 Conflict', async () => {
  const ownerA = await signedInClient();
  const ownerB = await signedInClient();

  // Owner A launches a venue
  await ownerA.post('/api/venue/onboard', {
    name: 'The Secret Vault Club',
    category: 'nightclub',
    city: 'Hyderabad',
    capacity: 300,
    is_draft: false
  });

  // Owner B attempts to claim the exact same venue name and city in another organisation
  const clashRes = await ownerB.post('/api/venue/onboard', {
    name: 'The Secret Vault Club',
    category: 'nightclub',
    city: 'Hyderabad',
    capacity: 200,
    is_draft: false
  });

  assert.equal(clashRes.status, 409);
  assert.equal(clashRes.json.ok, false);
  assert.ok(clashRes.json.message.includes('already registered'));
});

test('6. Ownership isolation: user cannot update or read another owner venue', async () => {
  const owner = await signedInClient();
  const intruder = await signedInClient();

  const onboardRes = await owner.post('/api/venue/onboard', {
    name: 'Sanctuary Lounge',
    category: 'cocktail_speakeasy',
    city: 'Kochi',
    capacity: 80,
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

test('7. Profile management: owner updates category, neighbourhood, and photos', async () => {
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

test('8. Cross-functional enablement: venue operator has organiser capabilities', async () => {
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
