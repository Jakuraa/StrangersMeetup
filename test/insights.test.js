// test/insights.test.js - Admin insights (unavailable ≠ zero, suppression, roles), voluntary profile,
// first-party page views, SuperProfile webhook lifecycle, Telegram live config check.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resetDb, startServer, stopServer, Client, db, signedInClient, clearCalls, callsTo, stubOnce } from './helpers.js';

let owner;
let support;
let finance;
const SP_SECRET = 'sp_test_secret_0123456789abcdef';

before(async () => {
  delete process.env.SUPERPROFILE_WEBHOOK_SECRET;
  await resetDb();
  await startServer();
  owner = await signedInClient({ tgId: 900000001 });
  support = await signedInClient();
  finance = await signedInClient();
  await owner.get('/api/admin/session');
  await owner.post('/api/admin/admins', { telegram_user_id: support.tgId, role: 'support' });
  await owner.post('/api/admin/admins', { telegram_user_id: finance.tgId, role: 'finance' });
});
after(async () => {
  delete process.env.SUPERPROFILE_WEBHOOK_SECRET;
  await stopServer();
});
beforeEach(clearCalls);

const insights = async (c = owner, days = 30) => (await c.get(`/api/admin/insights?days=${days}`)).json.insights;

test('insights: role-checked', async () => {
  assert.equal((await new Client().get('/api/admin/insights')).status, 401);
  assert.equal((await (await signedInClient()).get('/api/admin/insights')).status, 403);
  assert.equal((await support.get('/api/admin/insights')).status, 403, 'support cannot see revenue');
  assert.equal((await finance.get('/api/admin/insights')).status, 200);
});

test('insights: no data source → unavailable with a reason; real zero → 0', async () => {
  const x = await insights();
  assert.equal(x.traffic.visitors.available, false);
  assert.equal(x.traffic.visitors.value, null);
  assert.match(x.traffic.visitors.reason, /No page views recorded yet/);
  assert.equal(x.conversions.visitorToSignup.available, false);
  assert.equal(x.membership.superprofile.active.available, false);
  assert.match(x.membership.superprofile.active.reason, /not connected/);
  assert.equal(x.revenue.superprofile.available, false);
  assert.equal(x.demographics.gender.available, false);
  assert.equal(x.demographics.interests.available, false);
  // Tables exist, so these are real zeros.
  assert.deepEqual(x.revenue.liveTicketGross, { available: true, value: 0, unit: 'paise', note: 'Live payments are disabled (ENABLE_LIVE_PAYMENTS=false).' });
  assert.equal(x.registrations.totalUsers.value, (await db.one('SELECT count(*)::int n FROM users')).n);
  assert.equal(x.membership.stars.active.value, 0);
  assert.equal(x.bookings.upcomingInternalEvents.value, 0);
  assert.equal(x.failures.overdueNotifications.value, 0);
  assert.equal(x.discovery.feeds.available, true);
  assert.deepEqual(x.discovery.feeds.value, []);
  assert.equal(x.windowDays, 30);
  assert.equal((await insights(owner, 9999)).windowDays, 30, 'unknown windows fall back to 30');
});

test('page views: path only, referrer host only, distinct visitors counted', async () => {
  const c = new Client();
  const v1 = crypto.randomUUID();
  const v2 = crypto.randomUUID();
  const send = (body) => c.post('/api/analytics', body);
  assert.equal((await send({ name: 'page_view', visitorId: v1, path: '/events', ref: 'Instagram.com', utm: 'ig_story' })).status, 204);
  assert.equal((await send({ name: 'page_view', visitorId: v1, path: '/trips' })).status, 204);
  assert.equal((await send({ name: 'page_view', visitorId: v2, path: '/events', ref: 'google.com' })).status, 204);
  assert.equal((await send({ name: 'page_view', visitorId: v2, path: '/events?email=a@b.com' })).status, 400, 'query strings are refused');
  assert.equal((await send({ name: 'page_view', visitorId: v2, path: '/x', ref: 'https://evil.example/path?q=1' })).status, 400, 'full referrer URLs are refused');
  const row = await db.one(`SELECT path, referrer_host, utm_source FROM analytics_events WHERE visitor_uuid = $1 AND path = '/events'`, [v1]);
  assert.deepEqual(row, { path: '/events', referrer_host: 'instagram.com', utm_source: 'ig_story' });
  const x = await insights();
  assert.equal(x.traffic.visitors.value, 2);
  assert.equal(x.traffic.pageViews.value, 3);
  assert.deepEqual(x.traffic.topPaths.value[0], { label: '/events', count: 2 });
  assert.ok(x.traffic.topReferrers.value.some((r) => r.label === 'ig_story'));
  assert.equal(x.conversions.funnel.available, true);
  assert.equal(x.conversions.funnel.value[0].count, 2);
});

test('page-view beacon is a quiet 204 when no database is configured (no console errors on previews)', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const r = await new Client().post('/api/analytics', { name: 'page_view', visitorId: crypto.randomUUID(), path: '/' });
    assert.equal(r.status, 204);
  } finally {
    process.env.DATABASE_URL = saved;
  }
});

test('profile: optional, validated, CSRF-protected, clearable', async () => {
  const u = await signedInClient();
  assert.equal((await new Client().get('/api/me/profile')).status, 401);
  const noCsrf = await u.req('PATCH', '/api/me/profile', { gender: 'female' }, { 'x-csrf-token': 'nope' });
  assert.equal(noCsrf.status, 403);
  assert.equal((await u.patch('/api/me/profile', { gender: 'robot' })).status, 400);
  assert.equal((await u.patch('/api/me/profile', { interests: ['nightlife', 'hacking'] })).status, 400);
  assert.equal((await u.patch('/api/me/profile', { city: 'Mumbai' })).status, 400);
  const ok = await u.patch('/api/me/profile', { gender: 'female', age_band: '25_29', city: 'Kochi', interests: ['nightlife', 'dinners', 'nightlife'] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.profile.interests, ['nightlife', 'dinners']);
  const partial = await u.patch('/api/me/profile', { age_band: null });
  assert.equal(partial.json.profile.ageBand, null);
  assert.equal(partial.json.profile.gender, 'female', 'omitted fields are unchanged');
  const got = await u.get('/api/me/profile');
  assert.ok(got.json.options.interests.includes('matchmaking'));
});

test('demographics: buckets under 5 are suppressed; 5+ shown', async () => {
  let x = await insights();
  const g = x.demographics.gender;
  assert.equal(g.available, true);
  assert.deepEqual(g.value, [{ label: 'female', count: null, suppressed: true }]);
  for (let i = 0; i < 4; i++) {
    const u = await signedInClient();
    await u.patch('/api/me/profile', { gender: 'female', interests: ['nightlife'] });
  }
  x = await insights();
  assert.deepEqual(x.demographics.gender.value, [{ label: 'female', count: 5, suppressed: false }]);
  assert.equal(x.demographics.gender.respondents, 5);
  assert.deepEqual(x.demographics.interests.value.find((i) => i.label === 'nightlife'), { label: 'nightlife', count: 5, suppressed: false });
  assert.deepEqual(x.demographics.interests.value.find((i) => i.label === 'dinners'), { label: 'dinners', count: null, suppressed: true });
});

const sp = (body, secret = SP_SECRET) => new Client().req('POST', '/api/membership/superprofile/webhook', body, secret ? { 'x-webhook-secret': secret } : {});

test('SuperProfile webhook: 503 until configured, secret enforced, payload validated', async () => {
  assert.equal((await sp({ event: 'purchase', id: '1', product: 'Insider' })).status, 503);
  process.env.SUPERPROFILE_WEBHOOK_SECRET = SP_SECRET;
  assert.equal((await sp({ event: 'purchase', id: '1', product: 'Insider' }, 'wrong-secret-wrong-secret-xx')).status, 401);
  assert.equal((await sp({ event: 'purchase', id: '1', product: 'Insider' }, null)).status, 401);
  assert.equal((await sp({ event: 'bogus', id: '1', product: 'Insider' })).status, 400);
  assert.equal((await sp({ event: 'purchase', id: '1' })).json.result, 'unmatched', 'a purchase without a product is stored, not dropped');
});

test('SuperProfile: tier mapping, lifecycle, idempotency, email never stored', async () => {
  const tier = (await owner.get('/api/admin/tiers')).json.tiers.find((t) => t.code === 'tier_1');
  assert.equal((await owner.patch(`/api/admin/tiers/${tier.id}`, { superprofile_url: 'http://superprofile.bio/x' })).status, 400, 'https only');
  const set = await owner.patch(`/api/admin/tiers/${tier.id}`, { access_provider: 'superprofile', superprofile_url: 'https://superprofile.bio/vp/insider', superprofile_product_ref: 'Insider Circle' });
  assert.equal(set.status, 200, set.text);

  const email = 'Member.One@Example.com';
  const a = await sp({ event: 'purchase', id: 'ord_1', product: 'insider circle', email, amount: '₹499.00', currency: 'INR' });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual([a.json.result, a.json.tierMapped], ['activated', true]);
  assert.equal((await sp({ event: 'purchase', id: 'ord_1', product: 'Insider Circle', email })).json.result, 'duplicate');
  assert.equal((await sp({ event: 'purchase', id: 'ord_2', product: 'Insider Circle', email: email.toLowerCase() })).json.result, 'renewed');
  assert.equal((await sp({ event: 'purchase', id: 'ord_3', product: 'Unknown Product', email: 'two@example.com' })).json.tierMapped, false);
  assert.equal((await sp({ event: 'purchase_abandoned', id: 'ab_1' })).json.result, 'recorded');

  const dump = JSON.stringify((await db.query('SELECT * FROM superprofile_events')).rows) + JSON.stringify((await db.query('SELECT * FROM superprofile_memberships')).rows) +
    JSON.stringify((await db.query('SELECT * FROM audit_log')).rows);
  assert.doesNotMatch(dump.toLowerCase(), /member\.one@example\.com|two@example\.com/);

  let x = await insights();
  assert.equal(x.membership.superprofile.active.value, 1, 'an unknown product is an unmatched order, not a membership');
  assert.equal(x.membership.superprofile.newInWindow.value, 1);
  assert.equal(x.membership.superprofile.renewalsInWindow.value, 1);
  assert.equal(x.membership.superprofile.abandonedInWindow.value, 1);
  assert.equal(x.membership.superprofile.unmappedProducts.value, 1);
  assert.equal(x.revenue.superprofile.value, 49900);

  assert.equal((await sp({ event: 'subscription_expired', id: 'exp_1', product: 'Insider Circle', email })).json.result, 'expired');
  assert.equal((await sp({ event: 'subscription_expired', id: 'exp_2', product: 'Insider Circle', email: 'nobody@example.com' })).json.result, 'expired_unknown_member');
  x = await insights();
  assert.equal(x.membership.superprofile.active.value, 0);
  assert.equal(x.membership.superprofile.expiredInWindow.value, 1);

  const log = await finance.get('/api/admin/superprofile');
  assert.equal(log.status, 200);
  assert.equal(log.json.configured, true);
  assert.ok(log.json.events.every((e) => !('email_hash' in e)));
  assert.equal((await support.get('/api/admin/superprofile')).status, 403);
});

test('SuperProfile tier: web checkout link hidden inside Telegram, no Stars invoice, not offered by the bot', async () => {
  const page = await new Client().get('/membership');
  assert.match(page.text, /href="https:\/\/superprofile\.bio\/vp\/insider"[^>]*data-web-only/);
  assert.match(page.text, /Price shown at checkout on SuperProfile/);
  const home = await new Client().get('/');
  assert.match(home.text, /data-web-only/);

  const u = await signedInClient();
  const r = await u.post('/api/membership/checkout', { tierCode: 'tier_1' });
  assert.equal(r.status, 409, 'Stars cannot sell a SuperProfile-managed tier');

  clearCalls();
  const upd = { update_id: 880001, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 555, type: 'private' }, from: { id: 555, first_name: 'Bot' }, text: '/membership' } };
  const wh = await new Client().req('POST', '/api/telegram/webhook', upd, { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' });
  assert.equal(wh.status, 200);
  const sent = callsTo('sendMessage').map((c) => JSON.stringify(c.params)).join('\n');
  assert.doesNotMatch(sent, /superprofile/i);
  assert.doesNotMatch(sent, /Insider/);
});

test('Telegram live check: webhook URL, bot rights per chat; super_admin only', async () => {
  assert.equal((await finance.get('/api/admin/integrations/telegram')).status, 403);
  const r = await owner.get('/api/admin/integrations/telegram');
  assert.equal(r.status, 200, r.text);
  const t = r.json.telegram;
  assert.equal(t.available, true);
  assert.equal(t.bot.username, 'SmTestBot');
  assert.equal(t.webhook.matchesThisDeployment, true);
  assert.ok(t.chats.find((c) => c.name === 'events').ok);
  assert.equal(t.chats.find((c) => c.name === 'tier_1').skipped, 'Managed by SuperProfile');

  stubOnce('tg:getChatMember', () => ({ status: 'member' }));
  stubOnce('tg:getWebhookInfo', () => ({ url: 'https://old.example/hook', pending_update_count: 7, last_error_date: 1700000000, last_error_message: 'Wrong response from the webhook: 500' }));
  const r2 = (await owner.get('/api/admin/integrations/telegram')).json.telegram;
  assert.equal(r2.webhook.matchesThisDeployment, false);
  assert.equal(r2.webhook.pendingUpdates, 7);
  assert.match(r2.webhook.lastError, /500/);
  assert.equal(r2.chats.find((c) => c.name === 'events').ok, false, 'bot that is not admin is flagged');
  assert.doesNotMatch(JSON.stringify(r2), /TEST_ONLY_token/);
});

test('webhook processing failures are recorded without payloads or tokens', async () => {
  stubOnce('tg:sendMessage', () => { throw Object.assign(new Error('Bad Request: chat not found'), { code: 400 }); });
  const upd = { update_id: 880002, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: 556, type: 'private' }, from: { id: 556, first_name: 'X' }, text: '/help' } };
  const wh = await new Client().req('POST', '/api/telegram/webhook', upd, { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' });
  assert.equal(wh.status, 500);
  const e = await db.one(`SELECT source, kind, detail FROM integration_errors WHERE source = 'telegram_webhook' ORDER BY at DESC LIMIT 1`);
  assert.equal(e.kind, 'update_failed');
  assert.doesNotMatch(e.detail || '', /bot\d+:/);
  const x = await insights();
  assert.ok(x.failures.integrationErrors.value.some((i) => i.source === 'telegram_webhook'));
});

test('admin overview shows a real zero as 0 (client no longer prints "No data yet")', async () => {
  const js = fs.readFileSync(new URL('../public/js/admin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /No data yet/);
  assert.match(js, /Unavailable — /);
});
