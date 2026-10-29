// test/discovery.test.js - Feeds (parse, robots, SSRF, dedupe), submissions, moderation, external listings.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db, signedInClient, clearCalls, stubUrl, calls } from './helpers.js';
import { fetch as undiciFetch } from 'undici';
import { parseFeed, robotsAllows, assertPublicHttpsUrl, resolver, dedupeKey, isPrivateIp, pinnedLookup, feedDispatcher, safeFetch } from '../lib/services/feeds.js';

const FEED_URL = 'https://feeds.example.org/events.xml';
const inDays = (n, h = 19) => {
  const d = new Date(Date.now() + n * 864e5);
  d.setUTCHours(h - 5, 30, 0, 0); // h:00 IST
  return d;
};

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>${items.map((i) => `
  <item><title>${i.title}</title><link>${i.link}</link><guid>${i.guid || i.link}</guid>
  <pubDate>${new Date().toUTCString()}</pubDate><description>${i.desc || '&lt;p&gt;Come &amp;amp; meet &lt;b&gt;people&lt;/b&gt;&lt;/p&gt;'}</description></item>`).join('')}
</channel></rss>`;

let owner;
let moderator;
let outsider;
let robotsTxt = '';
let feedBody = '';
let feedEtag = '"v1"';
const realLookup = resolver.lookup;

before(async () => {
  await resetDb();
  await startServer();
  resolver.lookup = async (host) => (host.endsWith('.internal') ? [{ address: '10.0.0.5' }] : [{ address: '93.184.215.14' }]);
  stubUrl('https://feeds.example.org/robots.txt', () => (robotsTxt ? { body: robotsTxt } : { status: 404 }));
  stubUrl(FEED_URL, (url, init) => (init.headers?.['If-None-Match'] === feedEtag
    ? { status: 304 }
    : { body: feedBody, headers: { etag: feedEtag, 'content-type': 'application/rss+xml' } }));
  owner = await signedInClient({ tgId: 900000001 });
  moderator = await signedInClient();
  outsider = await signedInClient();
  await owner.get('/api/admin/session');
  assert.equal((await owner.post('/api/admin/admins', { telegram_user_id: moderator.tgId, role: 'moderator' })).status, 200);
});
after(async () => {
  resolver.lookup = realLookup;
  await stopServer();
});
beforeEach(clearCalls);

test('parseFeed: RSS 2.0 pubDate is never used as the event date; HTML is stripped; http links dropped', () => {
  const items = parseFeed(rss([{ title: 'Sunset Social', link: 'https://x.example/e/1' }, { title: 'Plain', link: 'http://x.example/e/2' }]));
  assert.equal(items.length, 2);
  assert.equal(items[0].startAt, null, 'pubDate must not become startAt');
  assert.equal(items[0].summary, 'Come & meet people');
  assert.equal(items[0].link, 'https://x.example/e/1');
  assert.equal(items[1].link, null);
});

test('parseFeed: RSS 1.0 event module dates and Atom entries', () => {
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:ev="http://purl.org/rss/1.0/modules/event/">
    <item rdf:about="https://x.example/a"><title>Board Game Night</title><link>https://x.example/a</link>
      <ev:startdate>2030-01-05T19:00:00+05:30</ev:startdate><ev:enddate>2030-01-05T22:00:00+05:30</ev:enddate><ev:location>Indiranagar</ev:location></item></rdf:RDF>`;
  const [a] = parseFeed(rdf);
  assert.equal(a.startAt, new Date('2030-01-05T19:00:00+05:30').toISOString());
  assert.equal(a.location, 'Indiranagar');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Rooftop Party</title><id>tag:x,1</id>
    <link rel="alternate" href="https://x.example/r"/><updated>2026-10-01T00:00:00Z</updated><summary>Fun</summary></entry></feed>`;
  const [b] = parseFeed(atom);
  assert.equal(b.link, 'https://x.example/r');
  assert.equal(b.startAt, null, 'Atom <updated> is not an event date');
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS or Atom feed/);
});

test('robots.txt evaluation', () => {
  assert.equal(robotsAllows('', '/feed'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/feed'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /feed', '/feed'), true);
  assert.equal(robotsAllows('User-agent: StrangersMeetupBot\nDisallow: /events\n\nUser-agent: *\nAllow: /', '/events.xml'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/anything'), true);
});

test('SSRF guard: only public https hosts', async () => {
  await assert.rejects(assertPublicHttpsUrl('http://feeds.example.org/x'), /https/);
  for (const u of ['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://svc.internal/feed', 'https://u:p@feeds.example.org/', 'https://feeds.example.org:8443/']) {
    await assert.rejects(assertPublicHttpsUrl(u), undefined, u);
  }
  await assertPublicHttpsUrl('https://feeds.example.org/events.xml');
});

test('SSRF guard: private, reserved and IPv6 transition addresses are refused; public ones pass', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.1.1', '172.16.0.1', '192.168.1.1', '192.0.2.5', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:a00:1::', '2001:0:4136::', 'fe80::1', 'fec0::1', 'fd00::1', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['93.184.215.14', '8.8.8.8', '::ffff:8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('SSRF guard: DNS rebinding after validation cannot reach a private address (lookup is pinned at connect time)', async () => {
  const before = resolver.lookup;
  try {
    // First answer public (passes validation), every later answer private: a rebinding attacker.
    let n = 0;
    resolver.lookup = async () => (n++ === 0 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    await assertPublicHttpsUrl('https://rebind.example.net/feed');
    const err = await new Promise((resolve) => pinnedLookup('rebind.example.net', {}, (e) => resolve(e)));
    assert.equal(err?.code, 'EPRIVATEADDR');
    // Through a real HTTP client: the connection is refused before any socket to 127.0.0.1 opens.
    await assert.rejects(undiciFetch('https://rebind.example.net/feed', { dispatcher: feedDispatcher }), (e) => e.cause?.code === 'EPRIVATEADDR');

    // A public answer is handed to the socket as-is (both lookup call shapes).
    resolver.lookup = async () => [{ address: '93.184.215.14', family: 4 }, { address: '2606:4700::1111', family: 6 }];
    const one = await new Promise((resolve, reject) => pinnedLookup('ok.example.net', {}, (e, address, family) => (e ? reject(e) : resolve({ address, family }))));
    assert.deepEqual(one, { address: '93.184.215.14', family: 4 });
    const all = await new Promise((resolve, reject) => pinnedLookup('ok.example.net', { all: true }, (e, list) => (e ? reject(e) : resolve(list))));
    assert.equal(all.length, 2);
    // Mixed answers (one public, one private) are refused outright rather than filtered.
    resolver.lookup = async () => [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const mixed = await new Promise((resolve) => pinnedLookup('mixed.example.net', {}, (e) => resolve(e)));
    assert.equal(mixed?.code, 'EPRIVATEADDR');
  } finally {
    resolver.lookup = before;
  }
});

test('SSRF guard: feed requests are sent through the pinned dispatcher', async () => {
  let seen;
  stubUrl('https://pin.example.org/', (url, init) => { seen = init.dispatcher; return { body: 'ok' }; });
  try {
    await safeFetch('https://pin.example.org/feed.xml');
    assert.equal(seen, feedDispatcher);
  } finally {
    stubUrl('https://pin.example.org/');
  }
});

test('dedupe key: same title/IST-day/city match regardless of case and punctuation', () => {
  const d = inDays(5);
  assert.equal(dedupeKey({ title: 'The Rooftop Party!', startAt: d, city: 'Chennai' }), dedupeKey({ title: 'rooftop   party', startAt: new Date(d.getTime() + 3600e3), city: 'chennai' }));
  assert.notEqual(dedupeKey({ title: 'Rooftop Party', startAt: d, city: 'Chennai' }), dedupeKey({ title: 'Rooftop Party', startAt: inDays(6), city: 'Chennai' }));
  assert.equal(dedupeKey({ title: 'x', startAt: null, city: 'Chennai' }), null);
});

let feedId;

test('feeds: role checks, permission basis required, private hosts refused', async () => {
  const body = { name: 'Example Events', url: FEED_URL, site_url: 'https://feeds.example.org', attribution: 'Example Events', permission_basis: 'Organiser emailed permission on 2026-10-20', default_city: 'Chennai' };
  assert.equal((await outsider.post('/api/admin/feeds', body)).status, 403);
  assert.equal((await new Client().get('/api/admin/feeds')).status, 401);
  assert.equal((await owner.post('/api/admin/feeds', { ...body, permission_basis: 'ok' })).status, 400);
  assert.equal((await owner.post('/api/admin/feeds', { ...body, url: 'https://svc.internal/feed' })).status, 400);
  const r = await moderator.post('/api/admin/feeds', body);
  assert.equal(r.status, 201, r.text);
  feedId = r.json.feed.id;
  assert.equal((await owner.post('/api/admin/feeds', body)).status, 409);
});

test('fetch: items land in the queue (never published), conditional GET, guid dedupe', async () => {
  feedBody = rss([{ title: 'Sunset Social', link: 'https://feeds.example.org/e/1' }, { title: 'Board Games Night', link: 'https://feeds.example.org/e/2' }]);
  const r = await owner.post(`/api/admin/feeds/${feedId}/fetch`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.status, 'ok');
  assert.equal(r.json.result.new, 2);
  const ua = calls.find((c) => c.path === FEED_URL)?.headers?.['User-Agent'] || '';
  assert.match(ua, /StrangersMeetupBot/);
  const pending = (await owner.get('/api/admin/candidates?status=pending')).json.candidates;
  assert.equal(pending.length, 2);
  assert.ok(pending.every((c) => c.start_at === null && c.city === 'Chennai'));
  assert.equal((await db.one(`SELECT count(*)::int n FROM events WHERE source = 'external'`)).n, 0, 'nothing auto-published');

  const again = await owner.post(`/api/admin/feeds/${feedId}/fetch`, {});
  assert.equal(again.json.result.status, 'not_modified');

  feedEtag = '"v2"';
  const third = await owner.post(`/api/admin/feeds/${feedId}/fetch`, {});
  assert.equal(third.json.result.status, 'ok');
  assert.equal(third.json.result.new, 0, 'same guids are not re-queued');
  const log = (await owner.get('/api/admin/feeds')).json.feeds[0];
  assert.equal(log.consecutive_failures, 0);
  assert.ok(log.recent.length >= 3);
});

test('approve as external listing: attributed page, organiser link, never bookable, duplicate refused', async () => {
  const [c] = (await owner.get('/api/admin/candidates?status=pending')).json.candidates.filter((x) => x.title === 'Sunset Social');
  const start = inDays(8).toISOString();
  const base = { mode: 'external', title: 'Sunset Social', category: 'weekend_party', city: 'Chennai', start_at: start, external_url: c.link, source_name: 'Example Events', publish: true };
  assert.equal((await outsider.post(`/api/admin/candidates/${c.id}/approve`, base)).status, 403);
  assert.equal((await owner.post(`/api/admin/candidates/${c.id}/approve`, { ...base, start_at: inDays(-1).toISOString() })).status, 400);
  const r = await moderator.post(`/api/admin/candidates/${c.id}/approve`, base);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.event.status, 'published');
  assert.equal((await owner.post(`/api/admin/candidates/${c.id}/approve`, base)).status, 409);

  const page = await new Client().get(`/events/${r.json.event.slug}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Listed from/);
  assert.match(page.text, /View &amp; book on Example Events/);
  assert.match(page.text, new RegExp(c.link.replace(/[.]/g, '\\.')));
  assert.doesNotMatch(page.text, /data-sp-buy=/, 'no internal booking button');
  assert.doesNotMatch(page.text, /"@type":"Event"/, 'no Event JSON-LD for events we do not run');
  assert.doesNotMatch(page.text, /Up to 0 people/);

  const parties = await new Client().get('/weekend-parties');
  assert.match(parties.text, /Sunset Social/);
  assert.match(parties.text, /Via Example Events/);

  const user = await signedInClient();
  const book = await user.post(`/api/events/${r.json.event.id}/book`, { ticketTypeId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(book.status, 409, 'external listings cannot be booked here');
  const out = await new Client().get(`/checkout/${r.json.event.slug}`);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), `/events/${r.json.event.slug}`, 'no checkout for events we do not sell');

  // A second source with the same title, IST day and city is a duplicate.
  const [other] = (await owner.get('/api/admin/candidates?status=pending')).json.candidates;
  const dup = await owner.post(`/api/admin/candidates/${other.id}/approve`, { ...base, external_url: 'https://elsewhere.example/x', start_at: new Date(new Date(start).getTime() + 3600e3).toISOString() });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'duplicate');
});

test('robots disallow blocks the fetch and is recorded as a feed failure', async () => {
  robotsTxt = 'User-agent: *\nDisallow: /';
  const r = await owner.post(`/api/admin/feeds/${feedId}/fetch`, {});
  assert.equal(r.json.result.status, 'blocked_robots');
  robotsTxt = '';
  const f = await db.one('SELECT consecutive_failures, last_status FROM event_feeds WHERE id = $1', [feedId]);
  assert.equal(f.last_status, 'blocked_robots');
  assert.equal(f.consecutive_failures, 1);
  assert.equal((await db.one(`SELECT count(*)::int n FROM integration_errors WHERE source = 'feed'`)).n, 1);
});

test('redirects to private hosts are refused', async () => {
  stubUrl('https://hop.example.org/robots.txt', () => ({ status: 404 }));
  stubUrl('https://hop.example.org/feed', () => ({ status: 302, headers: { location: 'https://svc.internal/admin' } }));
  const add = await owner.post('/api/admin/feeds', { name: 'Hop', url: 'https://hop.example.org/feed', attribution: 'Hop', permission_basis: 'Published terms allow syndication' });
  assert.equal(add.status, 201);
  const r = await owner.post(`/api/admin/feeds/${add.json.feed.id}/fetch`, {});
  assert.equal(r.json.result.status, 'error');
  assert.match(r.json.result.error, /private/);
  assert.ok(!calls.some((c) => c.path.includes('svc.internal')), 'never requested the private host');
});

test('public submissions: validation, honeypot, dedupe flag, rate limit; contact visible to admins only', async () => {
  const c = new Client();
  const when = inDays(12).toISOString().slice(0, 16);
  const good = { title: 'Filter Coffee Walk', category: 'meetup', city: 'Chennai', start_at: when, description: 'A morning walk through Mylapore.', contact: '@walkhost', consent: 'yes' };
  const bad = await c.post('/api/events/submit', { ...good, start_at: '2020-01-01T10:00', link: 'http://x.example' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.some((f) => f.field === 'start_at'));
  assert.ok(bad.json.fields.some((f) => f.field === 'link'));
  const hp = await c.post('/api/events/submit', { ...good, website: 'spam' });
  assert.equal(hp.status, 200);
  assert.equal((await db.one(`SELECT count(*)::int n FROM event_candidates WHERE origin = 'submission'`)).n, 0);
  assert.equal((await c.post('/api/events/submit', good)).status, 200);
  assert.equal((await c.post('/api/events/submit', good)).status, 200);
  const rows = (await db.query(`SELECT status FROM event_candidates WHERE origin = 'submission' ORDER BY created_at`)).rows;
  assert.deepEqual(rows.map((r) => r.status), ['pending', 'duplicate']);
  for (let i = 0; i < 2; i++) await c.post('/api/events/submit', { ...good, title: `Other ${i}` });
  assert.equal((await c.post('/api/events/submit', { ...good, title: 'Sixth' })).status, 429);
  const form = await new Client().get('/submit-event');
  assert.equal(form.status, 200);
  assert.match(form.text, /reviews every submission/);
  const list = (await owner.get('/api/admin/candidates?status=pending')).json.candidates;
  assert.ok(list.some((x) => x.submitter_contact === '@walkhost'));
  assert.ok(list.every((x) => !('ip_hash' in x)));
  assert.doesNotMatch((await new Client().get('/events')).text, /walkhost/);
});

test('approve a submission as our own draft event; reject another', async () => {
  const [s] = (await owner.get('/api/admin/candidates?status=pending')).json.candidates.filter((x) => x.title === 'Filter Coffee Walk');
  const r = await owner.post(`/api/admin/candidates/${s.id}/approve`, { mode: 'internal', title: s.title, category: 'meetup', city: 'Chennai', start_at: s.start_at, capacity: 12, publish: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.event.status, 'draft', 'internal events always start as drafts');
  const ev = await db.one('SELECT source, price_status, capacity FROM events WHERE id = $1', [r.json.event.id]);
  assert.deepEqual(ev, { source: 'internal', price_status: 'tbd', capacity: 12 });
  const [o] = (await owner.get('/api/admin/candidates?status=pending')).json.candidates.filter((x) => x.title === 'Other 0');
  assert.equal((await owner.post(`/api/admin/candidates/${o.id}/reject`, { status: 'rejected', note: 'Not in our cities' })).status, 200);
  assert.equal((await owner.post(`/api/admin/candidates/${o.id}/reject`, { status: 'rejected' })).status, 409);
  const audit = await db.query(`SELECT action FROM audit_log WHERE action LIKE 'candidate.%'`);
  assert.ok(audit.rows.some((a) => a.action === 'candidate.approve') && audit.rows.some((a) => a.action === 'candidate.rejected'));
});

test('discovery pages render with honest empty states', async () => {
  const c = new Client();
  for (const p of ['/events', '/weekend-parties', '/dinners', '/meetups', '/membership', '/events?category=matchmaking']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
  }
  assert.match((await c.get('/dinners')).text, /No dinners are listed right now/);
  assert.equal((await c.get('/events/no-such-event')).status, 404);
});
