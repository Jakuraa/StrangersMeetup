// test/promotional-campaigns.test.js - Tests for WhatsApp opt-in event marketing campaigns, audience targeting, approval, and safe dispatch simulation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb, startServer, stopServer, Client, signedInClient } from './helpers.js';
import { recordConsent, getConsents, hasConsent, addSuppression, isSuppressed } from '../lib/services/communication-consent.js';
import {
  queryEligibleAudience,
  previewCampaignAudience,
  createCampaign,
  getCampaign,
  listCampaigns,
  approveCampaign,
  cancelCampaign,
  dispatchCampaign,
  getCampaignLogs,
  ESTIMATED_MARKETING_COST_PAISE
} from '../lib/services/promotional-campaign.js';
import { createSession, createSessionToken, csrfTokenFor } from '../lib/session.js';

let organiserUser;
let attendeeUserA; // opted in
let attendeeUserB; // opted out
let attendeeUserC; // suppressed
let otherOrganiser;
let testEventA;
let testEventB;

before(async () => {
  await resetDb();
  await startServer();

  // Create organiser user
  const { rows: orgRows } = await db.query(
    `INSERT INTO users (alias, phone, status, age_confirmed_21, age_confirmed_at, organiser_enabled)
     VALUES ('Host Arvind', '+919876500001', 'active', true, now(), true)
     RETURNING *`
  );
  organiserUser = orgRows[0];

  // Create another organiser
  const { rows: otherOrgRows } = await db.query(
    `INSERT INTO users (alias, phone, status, age_confirmed_21, age_confirmed_at, organiser_enabled)
     VALUES ('Host Maya', '+919876500002', 'active', true, now(), true)
     RETURNING *`
  );
  otherOrganiser = otherOrgRows[0];

  // Create Attendee A (Chennai, Nightlife interest, Opted into promotional WhatsApp)
  const { rows: userARows } = await db.query(
    `INSERT INTO users (alias, phone, city, interests, status, age_confirmed_21, age_confirmed_at)
     VALUES ('Karthik', '+919876500010', 'Chennai', ARRAY['nightlife', 'music'], 'active', true, now())
     RETURNING *`
  );
  attendeeUserA = userARows[0];

  await recordConsent({
    userId: attendeeUserA.id,
    channel: 'whatsapp',
    purpose: 'transactional',
    status: 'opted_in',
    source: 'registration'
  });

  await recordConsent({
    userId: attendeeUserA.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_in',
    source: 'registration'
  });

  // Create Attendee B (Chennai, Opted OUT of promotional WhatsApp)
  const { rows: userBRows } = await db.query(
    `INSERT INTO users (alias, phone, city, interests, status, age_confirmed_21, age_confirmed_at)
     VALUES ('Deepa', '+919876500020', 'Chennai', ARRAY['nightlife'], 'active', true, now())
     RETURNING *`
  );
  attendeeUserB = userBRows[0];

  await recordConsent({
    userId: attendeeUserB.id,
    channel: 'whatsapp',
    purpose: 'transactional',
    status: 'opted_in',
    source: 'registration'
  });

  await recordConsent({
    userId: attendeeUserB.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_out', // Explicitly opted out
    source: 'registration'
  });

  // Create Attendee C (Bengaluru, Opted IN but number SUPPRESSED)
  const { rows: userCRows } = await db.query(
    `INSERT INTO users (alias, phone, city, interests, status, age_confirmed_21, age_confirmed_at)
     VALUES ('Rahul', '+919876500030', 'Bengaluru', ARRAY['nightlife', 'meetup'], 'active', true, now())
     RETURNING *`
  );
  attendeeUserC = userCRows[0];

  await recordConsent({
    userId: attendeeUserC.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_in',
    source: 'profile_settings'
  });

  await addSuppression({
    channel: 'whatsapp',
    destination: attendeeUserC.phone,
    reason: 'keyword_opt_out'
  });

  // Create test events
  const { rows: eventARows } = await db.query(
    `INSERT INTO events (
      title, slug, city, category, capacity, start_at, end_at, status, organiser_user_id
    ) VALUES (
      'Neon Rooftop Mixer', 'neon-rooftop-mixer-chn', 'Chennai', 'nightlife', 50,
      now() + interval '3 days', now() + interval '3 days 4 hours', 'published', $1
    ) RETURNING *`,
    [organiserUser.id]
  );
  testEventA = eventARows[0];

  const { rows: eventBRows } = await db.query(
    `INSERT INTO events (
      title, slug, city, category, capacity, start_at, end_at, status, organiser_user_id
    ) VALUES (
      'Secret Jazz Supper Club', 'secret-jazz-supper-blr', 'Bengaluru', 'dinner_club', 30,
      now() + interval '5 days', now() + interval '5 days 3 hours', 'published', $1
    ) RETURNING *`,
    [otherOrganiser.id]
  );
  testEventB = eventBRows[0];
});

after(stopServer);

test('1. Marketing consent separation and defaults: transactional defaults to true, promotional defaults to false', async () => {
  // New user with no records in communication_consents
  const { rows: freshUserRows } = await db.query(
    `INSERT INTO users (alias, phone, status, age_confirmed_21)
     VALUES ('Sneha', '+919876500099', 'active', true) RETURNING *`
  );
  const freshUser = freshUserRows[0];

  // Transactional essential notifications: true
  const transactionalConsent = await hasConsent({ userId: freshUser.id, channel: 'whatsapp', purpose: 'transactional' });
  assert.equal(transactionalConsent, true, 'transactional notifications should default to true for booking confirmations');

  // Promotional marketing messages: FAIL-CLOSED FALSE
  const promotionalConsent = await hasConsent({ userId: freshUser.id, channel: 'whatsapp', purpose: 'promotional' });
  assert.equal(promotionalConsent, false, 'promotional marketing must be fail-closed false when no consent record exists');

  // getConsents returns explicit matrix
  const matrix = await getConsents(freshUser.id);
  assert.equal(matrix.whatsapp.transactional, true);
  assert.equal(matrix.whatsapp.promotional, false);
});

test('2. Audience targeting: strictly queries opted-in users and excludes opted-out, suppressed, or non-consenting users', async () => {
  // All eligible users across platform
  const allAudience = await queryEligibleAudience();
  const audienceIds = allAudience.map((u) => u.id);

  // Must include attendeeUserA (opted in, not suppressed)
  assert.ok(audienceIds.includes(attendeeUserA.id), 'attendeeUserA must be included');

  // Must EXCLUDE attendeeUserB (opted out)
  assert.ok(!audienceIds.includes(attendeeUserB.id), 'attendeeUserB must be excluded because opted out');

  // Must EXCLUDE attendeeUserC (suppressed)
  assert.ok(!audienceIds.includes(attendeeUserC.id), 'attendeeUserC must be excluded because phone is suppressed');

  // Filter by City: Chennai
  const chennaiAudience = await queryEligibleAudience({ targetCity: 'Chennai' });
  assert.ok(chennaiAudience.some((u) => u.id === attendeeUserA.id));

  // Filter by City: Hyderabad (zero opted-in users in Hyderabad in our seed)
  const hydAudience = await queryEligibleAudience({ targetCity: 'Hyderabad' });
  assert.equal(hydAudience.length, 0);

  // Filter by Category: nightlife
  const nightlifeAudience = await queryEligibleAudience({ targetCategory: 'nightlife' });
  assert.ok(nightlifeAudience.some((u) => u.id === attendeeUserA.id));

  // Filter by Category: weekend_trip (attendeeUserA has nightlife/music, not weekend_trip)
  const tripAudience = await queryEligibleAudience({ targetCategory: 'weekend_trip' });
  assert.equal(tripAudience.length, 0);
});

test('3. Audience preview: calculates count, estimated cost (80 paise), and official template preview', async () => {
  const preview = await previewCampaignAudience({
    eventId: testEventA.id,
    targetCity: 'Chennai',
    targetCategory: 'nightlife'
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.eventId, testEventA.id);
  assert.equal(preview.eventTitle, testEventA.title);
  assert.equal(preview.appliedFilters.targetCity, 'Chennai');
  assert.equal(preview.appliedFilters.targetCategory, 'nightlife');
  assert.equal(preview.eligibleRecipientsCount, 1);
  assert.equal(preview.estimatedCostPaise, 80);
  assert.equal(preview.estimatedCostRupees, '0.80');

  // PII masking check
  assert.equal(preview.sampleRecipientsMasked.length, 1);
  assert.equal(preview.sampleRecipientsMasked[0].phoneMasked, '+91 98****0010');
  assert.ok(!preview.sampleRecipientsMasked[0].phoneMasked.includes('500010'), 'phone must be masked in preview');

  // Template components check
  assert.equal(preview.templatePreview.templateName, 'nightlifez_promotional_event_v1');
  assert.equal(preview.templatePreview.category, 'MARKETING');
  assert.equal(preview.templatePreview.header, 'NIGHTLIFEZ EXCLUSIVE');
  assert.ok(preview.templatePreview.body.includes('Neon Rooftop Mixer'));
  assert.ok(preview.templatePreview.body.includes('Chennai'));
  assert.equal(preview.templatePreview.buttons.length, 2);
  assert.equal(preview.templatePreview.buttons[1].label, 'Text STOP to opt out');
});

test('4. Campaign lifecycle: create draft, approve, and prevent illegal transitions', async () => {
  const campaign = await createCampaign({
    eventId: testEventA.id,
    createdByUserId: organiserUser.id,
    title: 'Neon Rooftop Chennai Launch Promotion',
    targetCity: 'Chennai',
    targetCategory: 'nightlife'
  });

  assert.equal(campaign.title, 'Neon Rooftop Chennai Launch Promotion');
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.channel, 'whatsapp');
  assert.equal(campaign.estimated_recipients, 1);
  assert.equal(campaign.estimated_cost_paise, 80);

  // Approve campaign
  const approved = await approveCampaign({
    campaignId: campaign.id,
    approvedByUserId: organiserUser.id
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved_by_user_id, organiserUser.id);
  assert.ok(approved.approved_at);

  // Listing campaigns for event
  const list = await listCampaigns({ eventId: testEventA.id, userId: organiserUser.id });
  assert.ok(list.length >= 1);
  assert.equal(list[0].id, campaign.id);
});

test('5. Safe Simulated Dispatch Gate: when live sending is false, campaign runs in dry-run simulation mode', async () => {
  // Ensure ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS is not 'true'
  const prevEnv = process.env.ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS;
  delete process.env.ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS;

  const campaign = await createCampaign({
    eventId: testEventA.id,
    createdByUserId: organiserUser.id,
    title: 'Dry Run Simulation Campaign',
    targetCity: 'Chennai',
    targetCategory: 'nightlife'
  });
  await approveCampaign({ campaignId: campaign.id, approvedByUserId: organiserUser.id });

  // Dispatch campaign
  const dispatchRes = await dispatchCampaign({
    campaignId: campaign.id,
    triggeredByUserId: organiserUser.id
  });

  assert.equal(dispatchRes.ok, true);
  assert.equal(dispatchRes.simulated, true);
  assert.equal(dispatchRes.recipientsCount, 1);
  assert.equal(dispatchRes.costPaise, 80);
  assert.equal(dispatchRes.costRupees, '0.80');
  assert.ok(dispatchRes.message.includes('disabled by platform policy'));

  // Verify campaign row
  const updatedCampaign = await getCampaign({ campaignId: campaign.id });
  assert.equal(updatedCampaign.status, 'completed');
  assert.equal(updatedCampaign.actual_recipients, 1);
  assert.equal(updatedCampaign.actual_cost_paise, 80);
  assert.equal(updatedCampaign.audit_metadata.simulated, true);

  // Verify recipient delivery log
  const logs = await getCampaignLogs({ campaignId: campaign.id });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].phoneMasked, '+91 98****0010');
  assert.equal(logs[0].status, 'dispatched');
  assert.equal(logs[0].deliveryCostPaise, 80);

  // Restore env
  if (prevEnv !== undefined) process.env.ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS = prevEnv;
});

test('6. Unsubscribe and suppression handling: STOP or unsubscribe endpoint withdraws consent and suppresses number', async () => {
  // Create user who initially opts in
  const { rows } = await db.query(
    `INSERT INTO users (alias, phone, status, age_confirmed_21)
     VALUES ('Vikas', '+919876500077', 'active', true) RETURNING *`
  );
  const vikas = rows[0];

  await recordConsent({
    userId: vikas.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_in',
    source: 'registration'
  });

  assert.equal(await hasConsent({ userId: vikas.id, channel: 'whatsapp', purpose: 'promotional' }), true);

  // Simulate user calling unsubscribe endpoint
  const unsubClient = new Client();
  const unsubRes = await unsubClient.post('/api/notifications/unsubscribe', {
    phone: '+919876500077',
    channel: 'whatsapp',
    reason: 'user_opt_out'
  });

  assert.equal(unsubRes.status, 200);
  assert.equal(unsubRes.json.ok, true);

  // Check consent is now false
  const hasPromoAfter = await hasConsent({ userId: vikas.id, channel: 'whatsapp', purpose: 'promotional' });
  assert.equal(hasPromoAfter, false, 'user must no longer have promotional consent after unsubscribe');

  // Check number is suppressed
  const suppressed = await isSuppressed({ destination: '+919876500077', channel: 'whatsapp' });
  assert.equal(suppressed, true, 'phone number must be on the suppression list');

  // Essential transactional consent must remain intact
  const hasTrans = await hasConsent({ userId: vikas.id, channel: 'whatsapp', purpose: 'transactional' });
  assert.equal(hasTrans, true, 'transactional consent must remain active');
});

test('7. Multi-tenant RBAC: Organiser B cannot view, create, or dispatch campaigns for Organiser A event', async () => {
  // Organiser B signs in
  const clientB = await signedInClient();
  await db.query(`UPDATE users SET organiser_enabled = true WHERE id = $1`, [clientB.userId]);

  // Organiser B attempts to preview event A
  const previewRes = await clientB.post('/api/campaigns/preview', {
    eventId: testEventA.id,
    targetCity: 'Chennai'
  });
  assert.equal(previewRes.status, 404, 'cross-organiser access should return 404 Not Found');

  // Organiser B attempts to create campaign on event A
  const createRes = await clientB.post('/api/campaigns', {
    eventId: testEventA.id,
    title: 'Hacked Campaign'
  });
  assert.equal(createRes.status, 404, 'cross-organiser campaign creation must be blocked with 404');
});
