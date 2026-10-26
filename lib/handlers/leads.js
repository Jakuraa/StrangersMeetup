// lib/handlers/leads.js - Partner / Host / Venue forms → leads; basic funnel analytics.
import { db } from '../db.js';
import { HttpError, readRawBody, sendJson, redirect, hashIp } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { logger } from '../logger.js';

const text = (max, min = 1) => z.string({ required_error: 'Required' }).trim()
  .min(min, min > 1 ? `Please enter at least ${min} characters` : 'Required').max(max, 'Too long');
const optText = (max) => z.string().trim().max(max, 'Too long').optional().transform((v) => v || undefined);
const email = z.string().trim().toLowerCase().email('Enter a valid email').max(200);
const optEmail = z.union([z.literal(''), email]).optional().transform((v) => v || undefined);
const consent = z.literal('yes', { errorMap: () => ({ message: 'Please tick to continue' }) });

const SCHEMAS = {
  partner: z.object({
    name: text(120, 2), organization: text(160), email, city: optText(80), message: text(2000, 10), consent
  }),
  host: z.object({
    name: text(120, 2), telegram: z.string().trim().regex(/^@?[A-Za-z0-9_]{5,32}$/, 'Enter a valid Telegram username'),
    email: optEmail, city: text(80), experience: text(2000, 10), idea: optText(2000), consent
  }),
  venue: z.object({
    name: text(120, 2), venue_name: text(160), email,
    phone: z.string().trim().regex(/^[+0-9 ()-]{0,20}$/, 'Enter a valid phone number').optional().transform((v) => v || undefined),
    city: text(80), area: optText(120),
    capacity: z.union([z.literal(''), z.coerce.number().int().min(1).max(5000)]).optional().transform((v) => (v === '' ? undefined : v)),
    message: optText(2000), consent
  })
};

const RETURN_PATH = { partner: '/partner-with-us', host: '/become-a-host', venue: '/list-your-venue' };

export async function readBody(req) {
  const raw = await readRawBody(req);
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return { body: JSON.parse(raw || '{}'), isForm: false }; } catch { throw new HttpError(400, 'invalid_json', 'Invalid request'); }
  }
  return { body: Object.fromEntries(new URLSearchParams(raw)), isForm: true };
}

export async function submitLead({ req, res, params, ip }) {
  const type = params.type;
  const schema = SCHEMAS[type];
  if (!schema) throw new HttpError(404, 'not_found', 'Unknown form');
  const { body, isForm } = await readBody(req);
  const ipHash = hashIp(ip);

  await rateLimit(`lead:${ipHash}`, 5, 3600);

  const done = () => (isForm
    ? redirect(res, `${RETURN_PATH[type]}?sent=1`, 303)
    : sendJson(res, 200, { ok: true, message: 'Thank you — we have your details and will be in touch soon.' }));

  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    logger.info('lead honeypot triggered', { type });
    return done();
  }
  const { consent: _c, ...payload } = parse(schema, body);
  await db.query('INSERT INTO leads (type, payload, ip_hash) VALUES ($1, $2, $3)', [type, JSON.stringify(payload), ipHash]);
  logger.info('lead received', { type });
  done();
}

const ANALYTICS = z.object({
  name: z.enum(['page_view', 'event_view', 'book_click', 'checkout_start', 'signin', 'membership_click']),
  visitorId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  // page_view only: pathname (no query string), referrer host (no path), utm_source.
  path: z.string().max(200).regex(/^\/[A-Za-z0-9\-._~/%]*$/).optional(),
  ref: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(),
  utm: z.string().max(60).regex(/^[A-Za-z0-9_.-]+$/).optional()
});

export async function trackEvent({ req, res, ip }) {
  const raw = await readRawBody(req, 2048);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* ignored */ }
  const r = ANALYTICS.safeParse(body);
  if (!r.success) return sendJson(res, 400, { ok: false, error: 'validation' });
  await rateLimit(`an:${hashIp(ip)}`, 120, 60);
  const pv = r.data.name === 'page_view';
  await db.query('INSERT INTO analytics_events (name, visitor_uuid, event_id, path, referrer_host, utm_source) VALUES ($1, $2, $3, $4, $5, $6)',
    [r.data.name, r.data.visitorId || null, r.data.eventId || null, pv ? r.data.path || null : null,
      pv ? r.data.ref?.toLowerCase() || null : null, pv ? r.data.utm?.toLowerCase() || null : null]);
  res.statusCode = 204;
  res.end();
}
