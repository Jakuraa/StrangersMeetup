import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb, startServer, stopServer, Client, signedInClient, makeWidgetData, BOT_TOKEN } from './helpers.js';
import { sealWidgetState } from '../lib/telegram/auth.js';
import { CITIES } from '../lib/services/events.js';
import { INTEREST_CATEGORIES, COMMUNITY_CHANNELS } from '../lib/services/member-onboarding.js';

describe('Master Auth, Onboarding & Community Growth Suite', () => {
  before(async () => {
    await resetDb();
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  describe('Phase 1: Telegram Sign-In Security & Lifecycle', () => {
    test('rejects Telegram callback with missing or mismatched anti-CSRF state nonce', async () => {
      const client = new Client();
      const widgetData = makeWidgetData({
        id: 99887766,
        first_name: 'TestTgUser'
      });
      const params = new URLSearchParams({
        ...widgetData,
        state: 'invalid-state-nonce',
        next: '/me'
      });

      // No sm_tg_state cookie set
      const res = await client.get(`/auth/telegram/widget-callback?${params.toString()}`);
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') || '', /error=(session_expired|expired)/);
    });

    test('authenticates genuine Telegram user with valid state cookie and HMAC signature', async () => {
      const client = new Client();
      const stateNonce = sealWidgetState({ ageConfirmed: true, next: '/me' });
      const tgId = 88776655;
      const widgetData = makeWidgetData({
        id: tgId,
        first_name: 'Rohit',
        username: 'rohit_nightlife'
      });
      const params = new URLSearchParams({
        ...widgetData,
        state: stateNonce,
        next: '/me'
      });

      client.cookies.sm_tg_state = stateNonce;
      const res = await client.get(`/auth/telegram/widget-callback?${params.toString()}`);

      assert.equal(res.status, 302);
      const location = res.headers.get('location') || '';
      assert.ok(location.includes('/onboarding') || location.includes('/me'));

      // Check session cookie set
      const setCookies = res.headers.getSetCookie();
      assert.ok(setCookies.some((h) => h.startsWith('sm_session=')));

      // Check age confirmation and audit
      const u = await db.one('SELECT age_confirmed_21 FROM users WHERE telegram_user_id = $1', [tgId]);
      assert.equal(u.age_confirmed_21, true);
    });
  });

  describe('Phase 3: Mandatory Mobile & Gender Selection', () => {
    test('saves basic profile with self-describe gender and custom description', async () => {
      const client = await signedInClient({ ageConfirmed: true, onboarded: false });

      const profileRes = await client.post('/api/onboarding/profile', {
        displayName: 'Maya Lin',
        gender: 'self_describe',
        genderCustom: 'Genderqueer',
        city: 'Bengaluru'
      });

      assert.equal(profileRes.status, 200);
      assert.equal(profileRes.json.ok, true);
      assert.equal(profileRes.json.saved, true);

      // Verify in database
      const row = await db.query('SELECT gender, gender_custom FROM users WHERE id = $1', [client.userId]);
      assert.ok(row.rows.length > 0);
      assert.equal(row.rows[0].gender, 'self_describe');
      assert.equal(row.rows[0].gender_custom, 'Genderqueer');
    });

    test('rejects basic profile without required fields', async () => {
      const client = await signedInClient({ ageConfirmed: true, onboarded: false });

      const res = await client.post('/api/onboarding/profile', {
        displayName: '',
        gender: 'female',
        city: 'Bengaluru'
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Phase 4: Scalable 6 Categories & 33 Curated Interests', () => {
    test('accepts multi-category interests and persists to member_interests', async () => {
      const client = await signedInClient({ ageConfirmed: true, onboarded: false });

      const selectedInterests = [
        'nightclubs',
        'dj_nights',
        'social_mixers',
        'fine_dining',
        'weekend_trips',
        'creative_experiences'
      ];

      const res = await client.post('/api/onboarding/interests', {
        interests: selectedInterests
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.count, selectedInterests.length);

      // Verify via /api/me/profile
      const meProfile = await client.get('/api/me/profile');
      assert.equal(meProfile.status, 200);
      for (const key of selectedInterests) {
        assert.ok(meProfile.json.profile.interests.includes(key));
      }
      assert.equal(meProfile.json.options.interestCategories.length, 6);
    });
  });

  describe('Phase 5: City Directory Expansion & Admin Control', () => {
    test('contains all 49 major event cities across South, West, North, East, and Central India', () => {
      assert.equal(CITIES.length, 49, `Expected exactly 49 canonical cities, found ${CITIES.length}`);
      assert.equal(new Set(CITIES.map((c) => c.slug)).size, 49, 'All 49 city slugs must be strictly unique');
      const regions = new Set(CITIES.map((c) => c.region));
      assert.ok(regions.has('South'));
      assert.ok(regions.has('West'));
      assert.ok(regions.has('North'));
      assert.ok(regions.has('East'));
      assert.ok(regions.has('Central'));

      // Check specific key cities
      const names = new Set(CITIES.map((c) => c.name));
      assert.ok(names.has('Mumbai'));
      assert.ok(names.has('Bengaluru'));
      assert.ok(names.has('Delhi NCR'));
      assert.ok(names.has('Kolkata'));
      assert.ok(names.has('Hyderabad'));
      assert.ok(names.has('Goa / Panaji'));
    });

    test('admin can toggle city active status', async () => {
      const admin = await signedInClient({ tgId: 900000001 });
      // Trigger super_admin bootstrap
      await admin.get('/api/admin/session');

      // Deactivate a city
      const patchRes = await admin.patch('/api/admin/cities/kochi', {
        active: false
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.json.city.active, false);

      // Reactivate city
      const reactivateRes = await admin.patch('/api/admin/cities/kochi', {
        active: true
      });
      assert.equal(reactivateRes.status, 200);
      assert.equal(reactivateRes.json.city.active, true);
    });
  });

  describe('Phase 6: Official Community Connection', () => {
    test('records and retrieves user community channel confirmations', async () => {
      const client = await signedInClient({ ageConfirmed: true, onboarded: false });

      // Record join for Telegram and WhatsApp
      const joinTg = await client.post('/api/onboarding/community', {
        channel: 'telegram',
        confirmed: true
      });
      assert.equal(joinTg.status, 200);
      assert.equal(joinTg.json.ok, true);

      const joinWa = await client.post('/api/onboarding/community', {
        channel: 'whatsapp',
        confirmed: true
      });
      assert.equal(joinWa.status, 200);

      // Retrieve confirmed channels
      const getComm = await client.get('/api/onboarding/community');
      assert.equal(getComm.status, 200);
      assert.ok(Array.isArray(getComm.json.channels));
      assert.ok(getComm.json.channels.includes('telegram'));
      assert.ok(getComm.json.channels.includes('whatsapp_channel'));
    });
  });
});
