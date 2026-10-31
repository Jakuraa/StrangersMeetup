// lib/handlers/discovery.js - Public event submissions → moderation queue, and discovery listings.
import { sendJson, sendHtml, redirect, hashIp, PUBLIC_CACHE } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { logger } from '../logger.js';
import { readBody } from './leads.js';
import { createSubmission } from '../services/feeds.js';
import { listPublicEvents, listTiers, CATEGORY_LABELS, CITIES } from '../services/events.js';
import { whenRange } from '../views/components.js';
import * as D from '../views/discovery.js';

/** Without a database (e.g. an unconfigured preview), pages show honest empty states. */
async function orEmpty(promise, fallback) {
  try { return await promise; } catch (err) { if (err.code === 'DB_NOT_CONFIGURED') return fallback; throw err; }
}

const localDateTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and time')
  .transform((v) => `${v}:00+05:30`)
  .refine((v) => new Date(v).getTime() > Date.now(), 'The event must be in the future');
const optLocal = z.union([z.literal(''), z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]).optional()
  .transform((v) => (v ? `${v}:00+05:30` : undefined));

export const SubmissionBody = z.object({
  title: z.string().trim().min(3, 'Please enter a title').max(140),
  category: z.enum(Object.keys(CATEGORY_LABELS), { errorMap: () => ({ message: 'Choose a format' }) }),
  city: z.enum(CITIES.map((c) => c.name), { errorMap: () => ({ message: 'Choose a city' }) }),
  start_at: localDateTime,
  end_at: optLocal,
  venue: z.string().trim().max(200).optional().transform((v) => v || undefined),
  link: z.union([z.literal(''), z.string().trim().url('Enter a full https:// link').regex(/^https:\/\//, 'Link must start with https://').max(500)])
    .optional().transform((v) => v || undefined),
  organizer: z.string().trim().max(120).optional().transform((v) => v || undefined),
  description: z.string().trim().min(10, 'Tell us a little more (10+ characters)').max(2000),
  contact: z.string().trim().min(3, 'How can we reach you?').max(200)
    .refine((v) => /^@?[A-Za-z0-9_]{5,32}$/.test(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter an email or Telegram username'),
  consent: z.literal('yes', { errorMap: () => ({ message: 'Please tick to continue' }) }),
  website: z.string().optional()
}).refine((s) => !s.end_at || new Date(s.end_at) > new Date(s.start_at), { message: 'End must be after start', path: ['end_at'] });

export async function submitEvent({ req, res, ip }) {
  const { body, isForm } = await readBody(req);
  const ipHash = hashIp(ip);
  await rateLimit(`submit:${ipHash}`, 5, 3600);
  const done = () => (isForm
    ? redirect(res, '/submit-event?sent=1', 303)
    : sendJson(res, 200, { ok: true, message: 'Thanks — our team reviews every submission before anything is listed.' }));
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    logger.info('submission honeypot triggered');
    return done();
  }
  const { consent: _c, website: _w, ...s } = parse(SubmissionBody, body);
  const r = await createSubmission(s, ipHash);
  logger.info('event submission received', { duplicate: r.duplicate });
  done();
}

export async function submitEventPage({ res, query }) {
  sendHtml(res, 200, query.get('sent') === '1' ? D.renderSubmitThanks() : D.renderSubmitEvent(), { cache: PUBLIC_CACHE });
}

const CITY_BY_SLUG = Object.fromEntries(CITIES.map((c) => [c.slug, c]));

export async function allEventsPage({ res, query }) {
  const city = CITY_BY_SLUG[query.get('city')];
  const category = Object.hasOwn(CATEGORY_LABELS, query.get('category') || '') ? query.get('category') : '';
  const when = ['week', 'month'].includes(query.get('when')) ? query.get('when') : '';
  const q = (query.get('q') || '').trim().slice(0, 80);
  const events = await orEmpty(listPublicEvents({ city: city?.name, category: category || undefined, q, ...whenRange(when), limit: 100 }), []);
  sendHtml(res, 200, D.renderAllEvents({ events, filter: { city: city?.slug || '', category, when, q } }), { cache: PUBLIC_CACHE });
}

export const COLLECTIONS = {
  '/weekend-parties': { categories: ['weekend_party'], key: 'parties' },
  '/dinners': { categories: ['dinner_club'], key: 'dinners' },
  '/meetups': { categories: ['meetup', 'board_games', 'movie'], key: 'meetups' }
};

export async function collectionPage({ res, pathname }) {
  const c = COLLECTIONS[pathname.replace(/\/$/, '')];
  const events = await orEmpty(listPublicEvents({ categories: c.categories }), []);
  sendHtml(res, 200, D.renderCollection(c.key, events), { cache: PUBLIC_CACHE });
}

export async function membershipPage({ res }) {
  const tiers = await orEmpty(listTiers(), []);
  sendHtml(res, 200, D.renderMembership(tiers), { cache: PUBLIC_CACHE });
}
