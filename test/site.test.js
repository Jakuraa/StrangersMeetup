// test/site.test.js - Public site honesty, SEO, forms, escaping, and client-bundle secret scan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, startServer, stopServer, Client, db, createEvent } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

test('empty DB: homepage renders empty states and no fabricated numbers', async () => {
  const r = await new Client().get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /No upcoming experiences are listed right now/);
  assert.match(r.text, /Announcing soon/);
  assert.doesNotMatch(r.text, /\d+\s*(slots?|seats?|spots?)\s*(left|remaining|available)/i);
  assert.doesNotMatch(r.text, /(members|joined|attendees|reviews|rating)\s*[:\d]/i);
  assert.doesNotMatch(r.text, /most popular/i);
  assert.doesNotMatch(r.text, /confirmed bookings so far/); // social proof hidden below threshold
  assert.doesNotMatch(r.text, /age-gate/);                  // landing is public, no overlay
});

test('demo events are labelled "Sample", noindexed, and get no Event JSON-LD', async () => {
  await createEvent({ slug: 'sample-thing', title: 'Sample Thing', isDemo: true, price: null });
  const home = await new Client().get('/');
  assert.match(home.text, /badge-sample/);
  const page = await new Client().get('/events/sample-thing');
  assert.match(page.text, /sample listing/i);
  assert.match(page.text, /noindex/);
  assert.doesNotMatch(page.text, /"@type":"Event"/);
  const sitemap = await new Client().get('/sitemap.xml');
  assert.doesNotMatch(sitemap.text, /sample-thing/);
});

test('social proof appears only from real confirmed bookings at or above SOCIAL_PROOF_MIN', async () => {
  const ev = await createEvent({ capacity: 50 });
  for (let i = 0; i < 4; i++) {
    const u = await db.one('INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id', [990000 + i]);
    await db.query(`INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed')`, [ev.id, u.id]);
  }
  assert.doesNotMatch((await new Client().get('/')).text, /confirmed bookings so far/);
  const u = await db.one('INSERT INTO users (telegram_user_id) VALUES (990009) RETURNING id');
  await db.query(`INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed')`, [ev.id, u.id]);
  assert.match((await new Client().get('/')).text, /<strong>5<\/strong> confirmed bookings so far/);
});

test('event content is HTML-escaped (no stored XSS)', async () => {
  await createEvent({ slug: 'xss-check', title: '<script>alert(1)</script>Dinner' });
  const page = await new Client().get('/events/xss-check');
  assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;Dinner/);
});

test('unauthorised media never renders; only authorised+visible does', async () => {
  await db.query(`INSERT INTO media (type, caption, authorized_by_owner, visible) VALUES ('review', 'UNAUTHORISED QUOTE', false, false)`);
  assert.doesNotMatch((await new Client().get('/')).text, /UNAUTHORISED QUOTE/);
  await db.query(`INSERT INTO media (type, caption, author_alias, authorized_by_owner, visible) VALUES ('review', 'Real authorised quote', 'Asha', true, true)`);
  assert.match((await new Client().get('/')).text, /Real authorised quote/);
});

test('all public pages render with unique titles and canonical links', async () => {
  const paths = ['/', '/trips', '/nightlife', '/dating', '/faq', '/trust-safety', '/community-guidelines', '/privacy', '/terms', '/refunds',
    '/contact', '/partner-with-us', '/become-a-host', '/list-your-venue', '/meetups/chennai', '/meetups/kochi'];
  const titles = new Set();
  for (const p of paths) {
    const r = await new Client().get(p);
    assert.equal(r.status, 200, p);
    const title = /<title>([^<]+)<\/title>/.exec(r.text)[1];
    assert.ok(!titles.has(title), `duplicate title ${title}`);
    titles.add(title);
    assert.match(r.text, new RegExp(`<link rel="canonical" href="https://sm.test${p === '/' ? '/' : p}">`));
  }
  assert.equal((await new Client().get('/meetups/atlantis')).status, 404);
  const faq = await new Client().get('/faq');
  assert.equal((faq.text.match(/<details class="faq-item"/g) || []).length, 12);
  assert.match(faq.text, /"@type":"FAQPage"/);
});

test('robots.txt disallows everything outside production', async () => {
  const r = await new Client().get('/robots.txt');
  assert.match(r.text, /Disallow: \//);
});

test('lead forms: validation, honeypot, and per-IP rate limit', async () => {
  const c = new Client({ ip: '10.1.2.3' });
  const bad = await c.post('/api/leads/partner', { name: 'X' });
  assert.equal(bad.status, 400);
  const ok = await c.post('/api/leads/partner', { name: 'Kavya', organization: 'Cafe Co', email: 'k@cafe.co', message: 'Hosting a monthly mixer with you', consent: 'yes' });
  assert.equal(ok.status, 200);
  const hp = await c.post('/api/leads/venue', { website: 'http://spam', name: 'Bot' });
  assert.equal(hp.status, 200);
  assert.equal((await db.one(`SELECT count(*)::int n FROM leads`)).n, 1);
  for (let i = 0; i < 3; i++) await c.post('/api/leads/host', {});
  assert.equal((await c.post('/api/leads/host', {})).status, 429);
  assert.equal((await new Client().post('/api/leads/unknown', {})).status, 404);
});

test('health reports DB ok and config by name only', async () => {
  const r = await new Client().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.database, 'ok');
  assert.doesNotMatch(r.text, /TEST_ONLY_token|test_key_secret|test_rzp_webhook_secret|test-session-secret/);
});

test('no secrets or server-only env names in client assets', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(path.join(ROOT, 'public'));
  const forbidden = /(TELEGRAM_BOT_TOKEN|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|CASHFREE_SECRET_KEY|SESSION_SECRET|CRON_SECRET|DATABASE_URL|TELEGRAM_WEBHOOK_SECRET|TELEGRAM_LOGIN_CLIENT_SECRET|rzp_live_|\d{6,}:[A-Za-z0-9_-]{30,}|postgres(ql)?:\/\/)/;
  for (const f of files.filter((x) => /\.(js|css|html|svg|json|txt)$/.test(x))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), forbidden, f);
  }
});

test('rendered HTML contains no secret values', async () => {
  const html = (await new Client().get('/')).text + (await new Client().get('/signin')).text;
  for (const v of [process.env.TELEGRAM_BOT_TOKEN, process.env.RAZORPAY_KEY_SECRET, process.env.SESSION_SECRET, process.env.TELEGRAM_WEBHOOK_SECRET]) {
    assert.ok(!html.includes(v));
  }
});

test('legacy routes redirect via vercel.json and old API endpoints are gone', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.ok(cfg.redirects.some((r) => r.source === '/venue.html' && r.destination === '/list-your-venue'));
  for (const p of ['/api/entitlements?telegramUserId=1', '/api/tma', '/api/tiers', '/api/cancel']) {
    assert.equal((await new Client().get(p)).status, 404, p);
  }
});
