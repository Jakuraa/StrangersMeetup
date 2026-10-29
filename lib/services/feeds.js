// lib/services/feeds.js - Event discovery: permitted public RSS/Atom feeds and public submissions
// land in a moderation queue (event_candidates). Nothing is published without an admin.
// A feed's <pubDate>/<updated> is when the post was written, NOT when the event happens, so it is
// never used as an event date; only explicit event-date fields (RSS event module) are read.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { Agent } from 'undici';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { siteUrl } from '../config.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';

export const FEED_UA = 'StrangersMeetupBot/1.0';
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;
const FETCH_TIMEOUT_MS = 10_000;

// ---------- normalisation & dedupe ----------

export function normalizeTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&[a-z]+;|[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|at|in|on|and|with|by)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** IST calendar day, so 23:30 UTC and 00:30 IST the next day are the same event day. */
function istDay(d) {
  return new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
}

/** Same title + same IST day + same city = same event. Null when date or city is unknown. */
export function dedupeKey({ title, startAt, city }) {
  if (!title || !startAt || !city || Number.isNaN(new Date(startAt).getTime())) return null;
  const basis = `${normalizeTitle(title)}|${istDay(startAt)}|${String(city).trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export function slugify(title, startAt) {
  const base = normalizeTitle(title).replace(/ /g, '-').slice(0, 60).replace(/-+$/, '') || 'event';
  const day = startAt ? istDay(startAt).replace(/-/g, '') : 'tbd';
  return `${base}-${day}-${crypto.randomBytes(2).toString('hex')}`;
}

// ---------- SSRF-safe fetch ----------

// Everything that is not ordinary public unicast: private, loopback, link-local, CGNAT, benchmarking,
// documentation, multicast/reserved, plus IPv6 transition prefixes that can embed a private IPv4
// (NAT64, 6to4, Teredo) and the deprecated site-local range.
const BLOCKED = new net.BlockList();
for (const [net4, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCKED.addSubnet(net4, bits, 'ipv4');
// net.BlockList matches IPv4-mapped IPv6 (::ffff:a.b.c.d, also in hex) against the IPv4 rules above.
for (const [net6, bits] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(net6, bits, 'ipv6');

export function isPrivateIp(ip) {
  const v = String(ip).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]);
  if (net.isIPv4(v)) return BLOCKED.check(v, 'ipv4');
  if (net.isIPv6(v)) return BLOCKED.check(v, 'ipv6');
  return true; // not an IP address at all: refuse
}

/** DNS resolution, replaceable in tests. */
export const resolver = { lookup: (host) => dns.lookup(host, { all: true }) };

/**
 * DNS lookup for outgoing feed connections. It resolves, refuses the connection if any answer is
 * private, and hands the socket the address it just checked, so a second (rebound) DNS answer can
 * never be the one we connect to. TLS still verifies the certificate against the URL's hostname.
 */
export function pinnedLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : {};
  resolver.lookup(hostname).then((addrs) => {
    if (!addrs.length) throw Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' });
    if (addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATEADDR' });
    const list = addrs.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
    if (opts.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  }).catch((err) => callback(err));
}

/** Feed requests go through this dispatcher only: no other code shares its connection pool. */
export const feedDispatcher = new Agent({ connect: { lookup: pinnedLookup }, connections: 4 });

export async function assertPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'invalid_url', 'Invalid URL'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'Only https URLs are allowed');
  if (u.username || u.password) throw new HttpError(400, 'invalid_url', 'URLs with credentials are not allowed');
  if (u.port && u.port !== '443') throw new HttpError(400, 'invalid_url', 'Only the default https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await resolver.lookup(host).catch(() => []);
  if (!addrs.length) throw new HttpError(400, 'invalid_url', 'Host does not resolve');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'invalid_url', 'Host resolves to a private address');
  return u;
}

/** GET with redirect re-validation, timeout and a body size cap. Returns { status, headers, text }. */
export async function safeFetch(url, headers = {}, { maxBytes = MAX_FEED_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHttpsUrl(current);
    const res = await fetch(current, {
      headers: { 'User-Agent': `${FEED_UA} (+${siteUrl()})`, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1', ...headers },
      redirect: 'manual',
      dispatcher: feedDispatcher,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location (${res.status})`);
      current = new URL(loc, current).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('feed too large');
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error('feed too large'); }
        chunks.push(value);
      }
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    }
    return { status: res.status, headers: res.headers, text, finalUrl: current };
  }
  throw new Error('too many redirects');
}

// ---------- robots.txt ----------

/** Minimal robots.txt evaluation for our UA (falls back to `*`). Longest matching rule wins; Allow wins ties. */
export function robotsAllows(robotsTxt, path, ua = FEED_UA) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(robotsTxt || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const token = ua.toLowerCase().split('/')[0];
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const r of chosen.flatMap((g) => g.rules)) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (!re.test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

async function checkRobots(feedUrl) {
  const u = new URL(feedUrl);
  try {
    const r = await safeFetch(`${u.origin}/robots.txt`, { Accept: 'text/plain' }, { maxBytes: 512 * 1024 });
    if (r.status >= 500) return { ok: false, reason: `robots.txt returned ${r.status}` };
    if (r.status >= 400) return { ok: true };
    return robotsAllows(r.text, u.pathname + u.search) ? { ok: true } : { ok: false, reason: 'Disallowed by robots.txt' };
  } catch (err) {
    return { ok: false, reason: `robots.txt unreachable: ${String(err.message).slice(0, 80)}` };
  }
}

// ---------- parsing ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function plainText(v, max = 1000) {
  // RSS descriptions are usually entity-escaped HTML: decode once to get the HTML, strip tags,
  // then decode entities that were inside the text.
  const markup = decodeEntities(textOf(v));
  const stripped = markup.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim().slice(0, max);
}

function textOf(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return textOf(v['#text'] ?? v.__cdata ?? '');
  return '';
}

/** Find a child by local name (ignores namespace prefix), case-insensitive. */
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const k of Object.keys(obj)) {
    const local = k.split(':').pop().toLowerCase();
    if (wanted.includes(local)) return obj[k];
  }
  return undefined;
}

function asArray(v) {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function httpsOrNull(s) {
  const v = String(s || '').trim();
  try { return new URL(v).protocol === 'https:' ? new URL(v).toString() : null; } catch { return null; }
}

function dateOrNull(s) {
  const v = textOf(s).trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function atomLink(entry) {
  const links = asArray(pick(entry, 'link'));
  const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) || links[0];
  return typeof alt === 'object' ? alt['@_href'] : textOf(alt);
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom into plain items. Throws on non-feed XML. */
export function parseFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, htmlEntities: false,
    cdataPropName: '__cdata', trimValues: true, parseTagValue: false
  });
  let doc;
  try { doc = parser.parse(xml); } catch (err) { throw new Error(`invalid XML: ${String(err.message).slice(0, 80)}`); }
  let raw;
  let kind;
  const rss = pick(doc, 'rss');
  const rdf = pick(doc, 'RDF');
  const atom = pick(doc, 'feed');
  if (rss) { raw = asArray(pick(pick(rss, 'channel'), 'item')); kind = 'rss'; }
  else if (rdf) { raw = asArray(pick(rdf, 'item')); kind = 'rdf'; }
  else if (atom) { raw = asArray(pick(atom, 'entry')); kind = 'atom'; }
  else throw new Error('not an RSS or Atom feed');

  return raw.slice(0, MAX_ITEMS).map((it) => {
    const link = kind === 'atom' ? atomLink(it) : textOf(pick(it, 'link')) || (typeof it === 'object' ? it['@_rdf:about'] : '');
    const guid = textOf(pick(it, 'guid', 'id')) || link || '';
    return {
      guid: guid.slice(0, 500),
      link: httpsOrNull(decodeEntities(link)),
      rawLink: String(link || '').slice(0, 500),
      title: plainText(pick(it, 'title'), 300),
      summary: plainText(pick(it, 'description', 'summary', 'content', 'encoded'), 1000),
      // Explicit event dates only (RSS 1.0 event module `ev:startdate` / schema-like `startDate`).
      startAt: dateOrNull(pick(it, 'startdate')),
      endAt: dateOrNull(pick(it, 'enddate')),
      location: plainText(pick(it, 'location'), 200),
      organizer: plainText(pick(it, 'organizer'), 120)
    };
  }).filter((i) => i.title);
}

// ---------- ingestion ----------

async function logFetch(feedId, row) {
  await db.query(
    `INSERT INTO feed_fetch_log (feed_id, status, http_status, items_seen, items_new, items_dup, error, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [feedId, row.status, row.httpStatus ?? null, row.seen || 0, row.new || 0, row.dup || 0, row.error ? String(row.error).slice(0, 300) : null, row.ms ?? null]);
}

/** Is this item already known (same link as an event/candidate, or same title+day+city)? */
async function findDuplicate(c, { link, key }) {
  if (link) {
    const e = (await c.query(`SELECT id FROM events WHERE external_url = $1 AND status IN ('draft','published') LIMIT 1`, [link])).rows[0];
    if (e) return { eventId: e.id };
    const cand = (await c.query(`SELECT id FROM event_candidates WHERE link = $1 AND status IN ('pending','approved') LIMIT 1`, [link])).rows[0];
    if (cand) return { candidateId: cand.id };
  }
  if (key) {
    const e = (await c.query(`SELECT id FROM events WHERE dedupe_key = $1 AND status IN ('draft','published') LIMIT 1`, [key])).rows[0];
    if (e) return { eventId: e.id };
    const cand = (await c.query(`SELECT id FROM event_candidates WHERE dedupe_key = $1 AND status IN ('pending','approved') LIMIT 1`, [key])).rows[0];
    if (cand) return { candidateId: cand.id };
  }
  return null;
}

export async function ingestFeed(feed) {
  const t0 = Date.now();
  const result = { feedId: feed.id, status: 'ok', seen: 0, new: 0, dup: 0 };
  try {
    const robots = await checkRobots(feed.url);
    if (!robots.ok) {
      Object.assign(result, { status: 'blocked_robots', error: robots.reason });
    } else {
      const headers = {};
      if (feed.etag) headers['If-None-Match'] = feed.etag;
      if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;
      const r = await safeFetch(feed.url, headers);
      result.httpStatus = r.status;
      if (r.status === 304) {
        result.status = 'not_modified';
      } else if (r.status !== 200) {
        Object.assign(result, { status: 'error', error: `HTTP ${r.status}` });
      } else {
        const items = parseFeed(r.text);
        result.seen = items.length;
        for (const it of items) {
          const city = feed.default_city || null;
          const key = dedupeKey({ title: it.title, startAt: it.startAt, city });
          const guid = it.guid || crypto.createHash('sha256').update(it.title).digest('hex');
          const inserted = await db.tx(async (c) => {
            const dup = await findDuplicate(c, { link: it.link, key });
            const r2 = await c.query(
              `INSERT INTO event_candidates (origin, feed_id, guid, link, title, summary, start_at, end_at, city, venue, category, organizer, dedupe_key, status, duplicate_of_event, review_note)
               VALUES ('feed', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               ON CONFLICT (feed_id, guid) WHERE feed_id IS NOT NULL AND guid IS NOT NULL DO NOTHING RETURNING id`,
              [feed.id, guid, it.link, it.title, it.summary || null, it.startAt, it.endAt && it.startAt && it.endAt > it.startAt ? it.endAt : null,
                city, it.location || null, feed.default_category || null, it.organizer || null, key,
                dup ? 'duplicate' : 'pending', dup?.eventId || null,
                dup ? 'Auto-flagged duplicate on ingest' : (!it.link && it.rawLink ? 'Source link is not https — add an https booking link before approving' : null)]);
            return r2.rowCount ? (dup ? 'dup' : 'new') : null;
          });
          if (inserted === 'new') result.new++;
          else if (inserted === 'dup') result.dup++;
        }
        await db.query('UPDATE event_feeds SET etag = $2, last_modified = $3 WHERE id = $1',
          [feed.id, r.headers.get('etag'), r.headers.get('last-modified')]);
      }
    }
  } catch (err) {
    Object.assign(result, { status: 'error', error: String(err.message || err).slice(0, 300) });
  }
  result.ms = Date.now() - t0;
  const ok = result.status === 'ok' || result.status === 'not_modified';
  await db.query(
    `UPDATE event_feeds SET last_fetched_at = now(), last_status = $2, last_error = $3,
       last_success_at = CASE WHEN $4 THEN now() ELSE last_success_at END,
       last_item_count = CASE WHEN $2 = 'ok' THEN $5 ELSE last_item_count END,
       consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures + 1 END
     WHERE id = $1`, [feed.id, result.status, ok ? null : result.error, ok, result.seen]);
  await logFetch(feed.id, result);
  if (!ok) {
    await db.query(`INSERT INTO integration_errors (source, kind, detail) VALUES ('feed', $1, $2)`,
      [result.status, `${feed.name}: ${String(result.error || '').slice(0, 200)}`]);
    logger.warn('feed fetch failed', { feedId: feed.id, status: result.status });
  }
  return result;
}

/** Cron/admin: fetch active feeds not fetched in the last `minAgeMinutes`. */
export async function runFeeds({ force = false, feedId = null, minAgeMinutes = 50 } = {}) {
  const params = [];
  let where = 'active';
  if (feedId) { params.push(feedId); where = `id = $1`; }
  else if (!force) { params.push(minAgeMinutes); where += ` AND (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(mins => $1))`; }
  const { rows } = await db.query(`SELECT * FROM event_feeds WHERE ${where} ORDER BY last_fetched_at NULLS FIRST LIMIT 20`, params);
  const results = [];
  for (const f of rows) results.push(await ingestFeed(f));
  return results;
}

// ---------- submissions ----------

export async function createSubmission(s, ipHash) {
  const key = dedupeKey({ title: s.title, startAt: s.start_at, city: s.city });
  return db.tx(async (c) => {
    const dup = await findDuplicate(c, { link: s.link || null, key });
    const r = await c.query(
      `INSERT INTO event_candidates (origin, link, title, summary, start_at, end_at, city, venue, category, organizer, submitter_contact, dedupe_key, status, duplicate_of_event, ip_hash, review_note)
       VALUES ('submission', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [s.link || null, s.title, s.description || null, s.start_at, s.end_at || null, s.city, s.venue || null, s.category, s.organizer || null,
        s.contact, key, dup ? 'duplicate' : 'pending', dup?.eventId || null, ipHash, dup ? 'Auto-flagged duplicate on submission' : null]);
    return { id: r.rows[0].id, duplicate: Boolean(dup) };
  });
}

// ---------- moderation ----------

/**
 * Approve a candidate into an event (in one transaction, candidate row-locked).
 * mode 'external': attributed listing, booking happens on the organiser's https page.
 * mode 'internal': becomes our own draft event (price TBD; edit it in Events before publishing).
 */
export async function approveCandidate(id, d, actor) {
  return db.tx(async (c) => {
    const cand = (await c.query('SELECT * FROM event_candidates WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cand) throw new HttpError(404, 'not_found', 'Not found');
    if (cand.status === 'approved') throw new HttpError(409, 'already_reviewed', 'Already approved');
    if (cand.status === 'rejected') throw new HttpError(409, 'already_reviewed', 'Already rejected');
    const feed = cand.feed_id ? (await c.query('SELECT * FROM event_feeds WHERE id = $1', [cand.feed_id])).rows[0] : null;
    const key = dedupeKey({ title: d.title, startAt: d.start_at, city: d.city });
    const dup = await findDuplicate(c, { link: d.mode === 'external' ? d.external_url : null, key });
    if (dup?.eventId) throw new HttpError(409, 'duplicate', 'An event with the same title, day and city (or link) already exists');

    const external = d.mode === 'external';
    if (external && !d.external_url) throw new HttpError(400, 'validation', 'External listings need an https booking/details link', { fields: [{ field: 'external_url', message: 'Required' }] });
    const sourceName = external ? (d.source_name || feed?.attribution || cand.organizer) : null;
    if (external && !sourceName) throw new HttpError(400, 'validation', 'Name the source to attribute', { fields: [{ field: 'source_name', message: 'Required' }] });
    const status = d.publish && external ? 'published' : 'draft';
    let ev;
    try {
      ev = (await c.query(
        `INSERT INTO events (slug, category, title, summary, description, city, area_public, venue_private, venue_privacy, start_at, end_at, capacity,
                             price_status, organizer, source, external_url, source_name, source_url, feed_id, dedupe_key, status, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'tbd',$13,$14,$15,$16,$17,$18,$19,$20::event_status, CASE WHEN $20::text = 'published' THEN now() END)
         RETURNING id, slug, status`,
        [slugify(d.title, d.start_at), d.category, d.title, d.summary || null, d.summary || null, d.city, d.area || null,
          d.venue || null, external ? 'public' : 'disclosed_after_booking', d.start_at, d.end_at || null,
          external ? 0 : (d.capacity || 10), d.organizer || (external ? sourceName : null), external ? 'external' : 'internal',
          external ? d.external_url : null, sourceName, external ? (feed?.site_url || null) : null, cand.feed_id, key, status])).rows[0];
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'duplicate', 'An event with the same title, day and city already exists');
      throw err;
    }
    await c.query(`UPDATE event_candidates SET status = 'approved', event_id = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
      [id, ev.id, actor, d.note || null]);
    await audit(actor, 'candidate.approve', id, { eventId: ev.id, mode: d.mode, status }, c);
    return ev;
  });
}

export async function rejectCandidate(id, { status, note }, actor) {
  return db.tx(async (c) => {
    const r = await c.query(
      `UPDATE event_candidates SET status = $2::candidate_status, review_note = $3, reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND status IN ('pending', 'duplicate') RETURNING id`, [id, status, note || null, actor]);
    if (!r.rowCount) throw new HttpError(409, 'not_pending', 'Only pending or duplicate items can be changed');
    await audit(actor, `candidate.${status}`, id, {}, c);
  });
}

