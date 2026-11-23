// lib/services/organiser.js - Organiser event wizard: drafts (versioned, owner-scoped), templates,
// publish-readiness checks and the one transaction that turns a draft into a published event.
//
// A draft is JSON in event_drafts. It is never visible publicly: public queries read `events`,
// and an events row is only created by publishDraft() after an explicit, confirmed request.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { z, parse } from '../validate.js';
import { audit } from '../audit.js';
import { siteUrl, livePayments, upiCheckoutEnabled } from '../config.js';
import { TIMEZONE_IDS, isLocalDateTime, zonedToUtc, datesBetween, localDate } from '../time.js';
import { ticketCheckoutStatus } from '../payments/availability.js';
import { CATEGORY_LABELS, TRIP_CATEGORIES, toPublicEvent, invalidatePublicEventCache } from './events.js';
import { ensurePersonalOrg, orgIdsFor, eventIdsFor, can, authorize } from './permissions.js';
import { resolveCity } from './locations.js';
import { enqueue } from './notifications.js';
import { CancellationPolicyDraft, POLICY_TEMPLATES, resolveCancellationPolicy } from './cancellation-policy.js';
import { EventScheduleDraft, normalizeSchedule, deriveEventBounds } from './event-schedule.js';
import { reverseBookingFeeEntry } from './finance.js';

export const MAX_IMAGES = 5;
export const MAX_TIERS = 10;
export const MAX_QUESTIONS = 12;
export const MAX_PICKUPS = 15;
export const MAX_EVENT_DAYS = 14;
export const MAX_CAPACITY = 5000;
const STEPS = ['basics', 'tickets', 'features', 'preview'];
const EVENT_ROLES = ['super_admin', 'event_manager'];

// ---------- templates & presets (sent to the wizard as JSON; defaults only, all editable) ----------

export const TICKET_PRESETS = {
  general: { name: 'General', kind: 'free', category: 'general', admitCount: 1, quantity: 50, maxPerBooking: 4, minPerBooking: 1 },
  early_bird: { name: 'Early bird', kind: 'free', category: 'early_bird', admitCount: 1, quantity: 25, maxPerBooking: 2, minPerBooking: 1 },
  couple: { name: 'Couple', kind: 'free', category: 'couple', admitCount: 2, quantity: 20, maxPerBooking: 1, minPerBooking: 1, eligibility: 'One ticket admits two people booking together' },
  vip: { name: 'VIP', kind: 'free', category: 'vip', admitCount: 1, quantity: 15, maxPerBooking: 2, minPerBooking: 1, eligibility: 'VIP access included' },
  free: { name: 'Free entry', kind: 'free', category: 'general', admitCount: 1, quantity: 50, maxPerBooking: 4, minPerBooking: 1 }
};

export const TICKET_CATEGORIES = [
  { id: 'general', label: 'General admission', defaultName: 'General Admission', defaultAdmitCount: 1 },
  { id: 'men', label: "Men's Pass", defaultName: "Men's Pass", defaultAdmitCount: 1, defaultEligibility: 'Valid for male attendees' },
  { id: 'women', label: "Women's Pass", defaultName: "Women's Pass", defaultAdmitCount: 1, defaultEligibility: 'Valid for female attendees' },
  { id: 'couple', label: 'Couple Pass', defaultName: 'Couple Pass', defaultAdmitCount: 2, defaultEligibility: 'One ticket admits two people booking together' },
  { id: 'group', label: 'Group Pass', defaultName: 'Group Pass (4 pax)', defaultAdmitCount: 4, defaultEligibility: 'One pass admits a group of up to 4 people' },
  { id: 'vip', label: 'VIP Pass', defaultName: 'VIP Pass', defaultAdmitCount: 1, defaultEligibility: 'VIP access' },
  { id: 'early_bird', label: 'Early Bird', defaultName: 'Early Bird Pass', defaultAdmitCount: 1 },
  { id: 'custom', label: 'Custom Category', defaultName: 'Special Pass', defaultAdmitCount: 1 }
];

export const QUESTION_PRESETS = {
  instagram: { label: 'Instagram handle', type: 'short', required: false },
  age: { label: 'I confirm I am 21 or older', type: 'single', options: ['Yes'], required: true },
  gender: { label: 'Gender', type: 'single', options: ['Woman', 'Man', 'Non-binary', 'Prefer not to say'], required: false,
    note: 'Only ask this if the format genuinely needs it (for example, balanced tables). Keep it optional.' },
  work: { label: 'College or work', type: 'short', required: false },
  dietary: { label: 'Dietary preference', type: 'single', options: ['Vegetarian', 'Non-vegetarian', 'Vegan', 'Jain', 'No preference'], required: false },
  tshirt: { label: 'T-shirt size', type: 'single', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], required: false }
};

export const TEMPLATES = {
  trip: { label: 'Group trip', hint: 'Treks, getaways, yatras', category: 'weekend_trip', multiDay: true, tickets: ['general'],
    features: { pickup: true, contact: true } },
  party: { label: 'Party or nightlife', hint: 'Club nights, house parties', category: 'nightlife', privateVenue: true, tickets: ['free', 'vip'],
    features: {} },
  business: { label: 'Founders meetup or business dinner', hint: 'Networking, dinners', category: 'networking', tickets: ['general'],
    features: { questions: ['work'] } },
  social: { label: 'Social meetup or matchmaking', hint: 'Mixers, dinners, games', category: 'meetup', tickets: ['free'],
    features: {} },
  workshop: { label: 'Workshop or class', hint: 'Skills, crafts, talks', category: 'workshop', tickets: ['general'],
    features: {} },
  general: { label: 'Something else', hint: 'Start from a blank event', category: 'meetup', tickets: ['general'], features: {} }
};

// ---------- draft shape (lenient while editing; publishIssues() is the strict gate) ----------

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const text = (max) => z.string().max(max).optional();
const looseInt = z.coerce.number().int().min(-1e9).max(1e9).nullable().optional();
const flag = z.boolean().optional();

const TicketDraft = z.object({
  id,
  name: text(60),
  category: z.string().max(40).optional(),
  kind: z.enum(['free', 'paid']).default('free'),
  pricePaise: looseInt,
  quantity: looseInt,
  maxPerBooking: looseInt,
  minPerBooking: looseInt,
  admitCount: looseInt,
  salesStartAt: text(30),
  salesEndAt: text(30),
  validOn: text(20),
  sessionId: z.union([z.string().uuid(), z.literal(''), z.null()]).optional().transform((v) => v === '' ? null : v),
  eligibility: text(120),
  active: flag
}).passthrough();

const QuestionDraft = z.object({
  id,
  label: text(200),
  type: z.enum(['short', 'long', 'single', 'multi']),
  options: z.array(z.string().max(80)).max(12).optional(),
  required: flag
}).passthrough();

const PickupDraft = z.object({ id, name: text(80), location: text(200), time: text(30) }).passthrough();

const FeaturesDraft = z.object({
  questions: z.object({ enabled: flag, items: z.array(QuestionDraft).max(MAX_QUESTIONS).optional() }).passthrough().optional(),
  approval: z.object({ enabled: flag }).passthrough().optional(),
  balance: z.object({ enabled: flag }).passthrough().optional(),
  pickup: z.object({ enabled: flag, points: z.array(PickupDraft).max(MAX_PICKUPS).optional() }).passthrough().optional(),
  contact: z.object({ enabled: flag, name: text(80), phone: text(24) }).passthrough().optional()
}).passthrough();

export const DraftData = z.object({
  template: z.enum(Object.keys(TEMPLATES)).optional(),
  category: z.enum(Object.keys(CATEGORY_LABELS)).optional(),
  title: text(140),
  timezone: z.enum(TIMEZONE_IDS).optional(),
  startLocal: text(40),
  endLocal: text(40),
  multiDay: flag,
  venue: text(300),
  venueId: z.union([z.string().uuid(), z.literal(''), z.null()]).optional().transform((v) => v === '' ? null : v),
  city: text(60),
  area: text(120),
  mapsUrl: text(500),
  privateVenue: flag,
  description: text(5000),
  hostName: text(80),
  coverImageId: z.union([z.string().uuid(), z.literal(''), z.null()]).optional().transform((v) => v === '' ? null : v),
  imageIds: z.array(z.string().uuid().or(z.literal(''))).max(MAX_IMAGES).optional().transform((arr) => arr ? arr.filter(Boolean) : undefined),
  imageRightsConfirmed: flag,
  refundPolicy: text(1000).optional(),
  cancellationPolicy: CancellationPolicyDraft.optional(),
  schedule: EventScheduleDraft.optional(),
  tickets: z.array(TicketDraft).max(MAX_TIERS).optional(),
  features: FeaturesDraft.optional()
}).passthrough();

const rid = () => crypto.randomBytes(5).toString('hex');

/** Starting data for a new draft, from a template. */
export function initialDraftData(templateKey) {
  const t = TEMPLATES[templateKey] || TEMPLATES.general;
  const f = t.features || {};
  return {
    template: TEMPLATES[templateKey] ? templateKey : 'general',
    category: t.category,
    timezone: 'Asia/Kolkata',
    multiDay: Boolean(t.multiDay),
    schedule: {
      type: t.multiDay ? 'consecutive' : 'single',
      dates: []
    },
    privateVenue: Boolean(t.privateVenue),
    cancellationPolicy: {
      template: 'standard',
      primaryDeadlineHours: 48,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: 24,
      secondaryRefundPercent: 50,
      customTerms: ''
    },
    refundPolicy: POLICY_TEMPLATES.standard.summary,
    tickets: (t.tickets || []).map((k) => ({ id: rid(), ...TICKET_PRESETS[k] })),
    features: {
      questions: { enabled: Boolean(f.questions), items: (f.questions || []).map((k) => ({ id: rid(), ...strip(QUESTION_PRESETS[k]) })) },
      approval: { enabled: Boolean(f.approval) },
      balance: { enabled: Boolean(f.balance) },
      pickup: { enabled: Boolean(f.pickup), points: [] },
      contact: { enabled: Boolean(f.contact) }
    }
  };
}

function strip(q) {
  const { note, ...rest } = q;
  return rest;
}

// ---------- field helpers ----------

/** Normalise a WhatsApp-capable number to E.164. Indian 10-digit mobiles get +91. */
export function normalizePhone(input) {
  const s = String(input || '').replace(/[\s\-().]/g, '');
  if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`;
  if (/^0[6-9]\d{9}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(s)) return `+${s}`;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

const MAPS_HOSTS = new Set(['maps.google.com', 'www.google.com', 'google.com', 'www.google.co.in', 'google.co.in', 'maps.app.goo.gl', 'goo.gl']);

/** Google Maps links only (https), so a "map" button can't send guests somewhere unexpected. */
export function isMapsUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== 'https:' || !MAPS_HOSTS.has(url.hostname) || url.username || url.password) return false;
  if (url.hostname === 'maps.google.com' || url.hostname === 'maps.app.goo.gl') return true;
  return url.pathname.startsWith('/maps');
}

const isTripCategory = (c) => TRIP_CATEGORIES.includes(c);
const clean = (s) => String(s ?? '').trim();

// ---------- publish readiness ----------

/**
 * Every problem that blocks publishing (severity 'error') or deserves a heads-up ('warning').
 * Pure: the same function backs the Preview step and the publish endpoint.
 */
export function publishIssues(d, { checkout = ticketCheckoutStatus(), now = new Date() } = {}) {
  const out = [];
  const err = (step, field, message) => out.push({ step, field, message, severity: 'error' });
  const warn = (step, field, message) => out.push({ step, field, message, severity: 'warning' });
  const f = d.features || {};

  // Basics
  const title = clean(d.title);
  if (title.length < 3) err('basics', 'title', 'Add an event name (at least 3 characters).');
  if (!d.category || !CATEGORY_LABELS[d.category]) err('basics', 'category', 'Choose what kind of event this is.');
  const tz = d.timezone || 'Asia/Kolkata';

  // Schedule normalization & bounds
  const sched = d.schedule ? normalizeSchedule(d.schedule, d.startLocal, d.endLocal) : null;
  const bounds = sched ? deriveEventBounds(sched, d.startLocal, d.endLocal) : { startLocal: d.startLocal, endLocal: d.endLocal, isMultiDay: Boolean(d.multiDay) };
  const effectiveStart = bounds.startLocal || d.startLocal;
  const effectiveEnd = bounds.endLocal || d.endLocal;
  const effectiveMultiDay = bounds.isMultiDay || Boolean(d.multiDay);

  const start = zonedToUtc(effectiveStart, tz);
  if (!isLocalDateTime(effectiveStart) || !start) err('basics', 'startLocal', 'Add a start date and time.');
  else if (start <= now) err('basics', 'startLocal', 'The start time is in the past.');
  let end = null;
  if (effectiveEnd) {
    end = zonedToUtc(effectiveEnd, tz);
    if (!end) err('basics', 'endLocal', 'The end date and time is not valid.');
    else if (start && end <= start) err('basics', 'endLocal', 'The end must be after the start.');
  }

  if (sched && sched.type === 'custom_dates') {
    if (!sched.dates || sched.dates.length < 2) {
      err('basics', 'schedule', 'Custom multi-date events need at least 2 dates. Add dates or switch to Single-day.');
    } else {
      const seenDates = new Set();
      sched.dates.forEach((item, idx) => {
        if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
          err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: select a valid date.`);
        } else if (seenDates.has(item.date)) {
          err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: duplicate date ${item.date}.`);
        }
        seenDates.add(item.date);
        const itemStart = zonedToUtc(item.startLocal, tz);
        const itemEnd = zonedToUtc(item.endLocal, tz);
        if (!itemStart) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: add a start time.`);
        else if (itemStart <= now) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: start time is in the past.`);
        if (!itemEnd) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: add an end time.`);
        else if (itemStart && itemEnd <= itemStart) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: end time must be after start time.`);

        if (sched.venueArrangement === 'different') {
          if (!clean(item.venueName) && !item.venueId) {
            err('basics', `schedule.dates.${idx}.venueName`, `Session ${idx + 1} (${item.date}): select or enter a venue.`);
          }
          if (item.mapsUrl && !isMapsUrl(item.mapsUrl)) {
            err('basics', `schedule.dates.${idx}.mapsUrl`, `Session ${idx + 1}: use a Google Maps link starting with https://`);
          }
        }
      });
    }
  } else if (sched && sched.type === 'recurring') {
    if (!sched.dates || sched.dates.length < 1) {
      err('basics', 'schedule', 'Generate recurring occurrences before publishing.');
    } else {
      sched.dates.forEach((item, idx) => {
        const itemStart = zonedToUtc(item.startLocal, tz);
        const itemEnd = zonedToUtc(item.endLocal, tz);
        if (!itemStart) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: add a start time.`);
        else if (itemStart <= now) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: start time is in the past.`);
        if (!itemEnd) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: add an end time.`);
        else if (itemStart && itemEnd <= itemStart) err('basics', `schedule.dates.${idx}`, `Session ${idx + 1}: end time must be after start time.`);

        if (sched.venueArrangement === 'different') {
          if (!clean(item.venueName) && !item.venueId) {
            err('basics', `schedule.dates.${idx}.venueName`, `Session ${idx + 1} (${item.date}): select or enter a venue.`);
          }
          if (item.mapsUrl && !isMapsUrl(item.mapsUrl)) {
            err('basics', `schedule.dates.${idx}.mapsUrl`, `Session ${idx + 1}: use a Google Maps link starting with https://`);
          }
        }
      });
    }
  } else if (start && effectiveMultiDay) {
    if (!end) err('basics', 'endLocal', 'A multi-day event needs an end date.');
    else if (localDate(effectiveEnd) === localDate(effectiveStart)) err('basics', 'endLocal', 'A multi-day event should end on a later day — or switch off Multi-day.');
    else if (datesBetween(effectiveStart, effectiveEnd, MAX_EVENT_DAYS + 1).length > MAX_EVENT_DAYS) err('basics', 'endLocal', `Events can last at most ${MAX_EVENT_DAYS} days.`);
  } else if (start && end && end - start > 24 * 3600e3) {
    err('basics', 'multiDay', 'This runs longer than a day. Switch on Multi-day so guests see each date.');
  }
  if (clean(d.city).length < 2) err('basics', 'city', 'Add the city — it is shown publicly, even for a private venue.');
  const hasPickups = f.pickup?.enabled && (f.pickup.points || []).length > 0;
  if (!clean(d.venue)) {
    if (d.privateVenue) err('basics', 'venue', 'Add the private address — it is revealed only to confirmed guests.');
    else if (isTripCategory(d.category) && !hasPickups) err('basics', 'venue', 'Add a meeting point or destination, or pickup points (Features).');
    else if (!isTripCategory(d.category)) err('basics', 'venue', 'Add the venue or meeting point.');
  }
  if (d.mapsUrl && !isMapsUrl(d.mapsUrl)) err('basics', 'mapsUrl', 'Use a Google Maps link starting with https://');
  if (clean(d.description).length < 20) err('basics', 'description', 'Describe the event in at least a couple of sentences (schedule, what’s included, dress code, entry rules).');
  const imgs = [d.coverImageId, ...(d.imageIds || [])].filter(Boolean);
  if (imgs.length && !d.imageRightsConfirmed) err('basics', 'imageRightsConfirmed', 'Confirm you have the right to use these images.');
  if (!d.coverImageId) warn('basics', 'coverImageId', 'Events with a cover image are easier to recognise. You can publish without one.');

  // Tickets
  const tickets = d.tickets || [];
  let eventDates = [];
  if (sched && sched.dates && sched.dates.length > 0) {
    eventDates = sched.dates.map((x) => x.date);
  } else if (effectiveMultiDay && isLocalDateTime(effectiveStart) && isLocalDateTime(effectiveEnd)) {
    eventDates = datesBetween(effectiveStart, effectiveEnd, MAX_EVENT_DAYS);
  }
  if (!tickets.length) err('tickets', 'tickets', 'Add at least one ticket type.');
  const names = new Set();
  let capacity = 0;
  tickets.forEach((t, i) => {
    const at = `tickets.${i}`;
    const label = clean(t.name) || `Ticket ${i + 1}`;
    if (!clean(t.name)) err('tickets', `${at}.name`, `Ticket ${i + 1}: add a name.`);
    else if (names.has(clean(t.name).toLowerCase())) err('tickets', `${at}.name`, `${label}: two tickets share this name.`);
    names.add(clean(t.name).toLowerCase());
    if (t.kind === 'paid') {
      if (!Number.isInteger(t.pricePaise)) err('tickets', `${at}.pricePaise`, `${label}: enter a price.`);
      else if (t.pricePaise < 0) err('tickets', `${at}.pricePaise`, `${label}: price cannot be negative.`);
      else if (t.pricePaise < 100) err('tickets', `${at}.pricePaise`, `${label}: a paid ticket must cost at least ₹1. Use a Free ticket instead.`);
      else if (t.pricePaise > 10_000_000) err('tickets', `${at}.pricePaise`, `${label}: price cannot exceed ₹1,00,000.`);
    } else if (t.pricePaise) {
      err('tickets', `${at}.pricePaise`, `${label}: a free ticket cannot have a price.`);
    }
    if (!Number.isInteger(t.quantity) || t.quantity <= 0) {
      err('tickets', `${at}.quantity`, `${label}: quantity must be a whole number greater than 0.`);
    } else if (t.quantity > MAX_CAPACITY) {
      err('tickets', `${at}.quantity`, `${label}: quantity cannot exceed ${MAX_CAPACITY}.`);
    } else {
      capacity += t.quantity;
    }
    if (!Number.isInteger(t.maxPerBooking) || t.maxPerBooking < 1 || t.maxPerBooking > 20) {
      err('tickets', `${at}.maxPerBooking`, `${label}: tickets per booking must be between 1 and 20.`);
    } else if (Number.isInteger(t.quantity) && t.quantity > 0 && t.maxPerBooking > t.quantity) {
      err('tickets', `${at}.maxPerBooking`, `${label}: tickets per booking cannot exceed available quantity (${t.quantity}).`);
    }
    if (t.minPerBooking != null) {
      if (!Number.isInteger(t.minPerBooking) || t.minPerBooking < 1) {
        err('tickets', `${at}.minPerBooking`, `${label}: minimum tickets per booking must be at least 1.`);
      } else if (Number.isInteger(t.maxPerBooking) && t.minPerBooking > t.maxPerBooking) {
        err('tickets', `${at}.minPerBooking`, `${label}: minimum booking quantity cannot exceed maximum tickets per booking.`);
      }
    }
    const valid = t.validOn || 'all';
    if (valid !== 'all') {
      if (!effectiveMultiDay) err('tickets', `${at}.validOn`, `${label}: day-specific tickets need a multi-day or multi-date event.`);
      else if (!eventDates.includes(valid)) err('tickets', `${at}.validOn`, `${label}: the chosen day is outside the event dates.`);
    }
  });
  if (tickets.length && capacity < 1) err('tickets', 'tickets', 'Make at least one ticket available (quantity above 0).');
  if (capacity > MAX_CAPACITY) err('tickets', 'tickets', `Total tickets cannot exceed ${MAX_CAPACITY}.`);

  const paid = tickets.filter((t) => t.kind === 'paid' || (t.pricePaise && t.pricePaise > 0));
  if (paid.length && !d.cancellationPolicy && clean(d.refundPolicy).length < 10) {
    err('tickets', 'refundPolicy', 'Paid tickets need a cancellation and refund policy.');
  }
  const allowPaid = livePayments() || upiCheckoutEnabled() || process.env.ALLOW_PAID_PUBLISH === 'true';
  if (paid.length > 0 && !allowPaid) {
    if (paid.length === tickets.length) {
      err('tickets', 'tickets', 'Online payment is not available yet, so guests could not book any of these tickets. Add a free ticket, or save this draft until a payment method is configured.');
    } else {
      err('tickets', 'tickets', 'Paid ticket sales are disabled. NIGHTLIFEZ is free event listings only for this phase. Convert all tickets to Free (₹0) to publish.');
    }
  } else if (paid.length && !checkout.available) {
    if (paid.length === tickets.length) err('tickets', 'tickets', 'Online payment is not available yet, so guests could not book any of these tickets. Add a free ticket, or save this draft until a payment method is configured.');
    else warn('tickets', 'tickets', 'Online payment is not available yet. Guests will see your paid tickets as “Paid ticket — external checkout not configured” and can book only the free ones.');
  }

  // Features
  if (f.questions?.enabled) {
    const items = f.questions.items || [];
    if (!items.length) err('features', 'features.questions.items', 'Add a question or switch off “Ask guests questions”.');
    items.forEach((q, i) => {
      const label = clean(q.label) || `Question ${i + 1}`;
      if (clean(q.label).length < 2) err('features', `features.questions.items.${i}.label`, `Question ${i + 1}: write the question.`);
      if (q.type === 'single' || q.type === 'multi') {
        const opts = (q.options || []).map(clean).filter(Boolean);
        // A required single choice with one option is a confirmation ("I confirm … — Yes").
        const min = q.type === 'single' && q.required ? 1 : 2;
        if (opts.length < min) err('features', `features.questions.items.${i}.options`, `${label}: add at least ${min === 1 ? 'one choice' : 'two choices'}.`);
        if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) err('features', `features.questions.items.${i}.options`, `${label}: choices must be different.`);
      }
    });
  }
  if (f.pickup?.enabled) {
    const pts = f.pickup.points || [];
    if (!pts.length) err('features', 'features.pickup.points', 'Add a pickup point or switch off Pickup points.');
    pts.forEach((p, i) => {
      if (clean(p.name).length < 2) err('features', `features.pickup.points.${i}.name`, `Pickup ${i + 1}: add a name.`);
      if (!isLocalDateTime(p.time)) err('features', `features.pickup.points.${i}.time`, `Pickup ${i + 1}: add a meeting time.`);
    });
  }
  if (f.contact?.enabled) {
    if (clean(f.contact.name).length < 2) err('features', 'features.contact.name', 'Add the contact person’s name.');
    if (!normalizePhone(f.contact.phone)) err('features', 'features.contact.phone', 'Add a valid WhatsApp number, e.g. 98765 43210 or +91 98765 43210.');
  }
  if (f.balance?.enabled && !tickets.some((t) => clean(t.eligibility))) {
    err('features', 'features.balance.enabled', 'Crowd balance is on: say who each restricted ticket is for (Tickets step), or switch it off.');
  }
  return out;
}

export const blocking = (issues) => issues.filter((i) => i.severity === 'error');

// ---------- access ----------

/** Organisers are users granted access by a super_admin, or active event admins. */
export async function isOrganiser(user, c = db) {
  if (!user) return false;
  if (user.organiser_enabled) return true;
  const a = (await c.query(`SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active`, [user.telegram_user_id])).rows[0];
  return Boolean(a && EVENT_ROLES.includes(a.role));
}

export async function requireOrganiser(user) {
  if (!(await isOrganiser(user))) throw new HttpError(403, 'organiser_required', 'Organiser access is needed to create events. Apply via Become a Host.');
}

// ---------- drafts ----------

function draftOut(r) {
  return { id: r.id, data: r.data, step: r.step, version: r.version, status: r.status, eventId: r.event_id, updatedAt: r.updated_at, createdAt: r.created_at };
}

export async function listDrafts(userId) {
  const { rows } = await db.query(
    `SELECT * FROM event_drafts WHERE organiser_user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 20`, [userId]);
  return rows.map(draftOut);
}

/** A draft owned by this organiser (any status), or 404 — never reveals other organisers' drafts. */
export async function getDraft(userId, draftId, c = db) {
  const r = (await c.query('SELECT * FROM event_drafts WHERE id = $1 AND organiser_user_id = $2', [draftId, userId])).rows[0];
  if (!r) throw new HttpError(404, 'not_found', 'Draft not found');
  return r;
}

/**
 * Authoritative permission check for linking an event or session to a venue.
 * Ensures:
 * 1. Venue exists, is status = 'active', and onboarding_completed = true.
 * 2. User has explicit permission:
 *    - Is an active member of the venue's organisation, OR
 *    - Has an approved booking enquiry for this venue, OR
 *    - Is an admin with super_admin or event_manager role.
 * Otherwise, rejects with 403 forbidden ('not_authorized_for_venue') or 409 ('venue_not_available').
 */
export async function assertVenueUsePermission(userId, venueId, c = db) {
  if (!venueId) return null;
  const venue = (await c.query(
    `SELECT v.id, v.name, v.city_id, v.locality_id, v.neighbourhood, v.address_public, v.address_private, v.org_id, v.status, v.onboarding_completed,
            c.name AS city_name
       FROM venues v
       LEFT JOIN location_cities c ON c.id = v.city_id
      WHERE v.id = $1`,
    [venueId]
  )).rows[0];

  if (!venue) {
    throw new HttpError(404, 'venue_not_found', 'Venue not found');
  }

  if (venue.status !== 'active' || !venue.onboarding_completed) {
    throw new HttpError(409, 'venue_not_available', 'Only active, completed venues can be linked to events.');
  }

  // Check admin override
  const admin = (await c.query(
    `SELECT au.role FROM admin_users au
       JOIN users u ON u.telegram_user_id = au.telegram_user_id
      WHERE u.id = $1 AND au.active`,
    [userId]
  )).rows[0];
  if (admin && ['super_admin', 'event_manager'].includes(admin.role)) {
    return venue;
  }

  // Check organisation membership
  const isOrgMember = (await c.query(
    `SELECT 1 FROM org_memberships
      WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
    [userId, venue.org_id]
  )).rows[0];
  if (isOrgMember) {
    return venue;
  }

  // Check approved venue enquiry
  const hasApprovedEnquiry = (await c.query(
    `SELECT 1 FROM venue_enquiries
      WHERE venue_id = $1 AND requester_user_id = $2 AND status = 'approved'`,
    [venueId, userId]
  )).rows[0];
  if (hasApprovedEnquiry) {
    return venue;
  }

  throw new HttpError(403, 'not_authorized_for_venue', 'You are not authorized to host events at this venue.');
}

export async function createDraft(user, { template, data, venueId } = {}) {
  const parsed = data ? parse(DraftData, data) : initialDraftData(template);
  const targetVenueId = venueId || parsed.venueId;
  if (targetVenueId) {
    const vRow = await assertVenueUsePermission(user.id, targetVenueId);
    if (vRow) {
      parsed.venueId = vRow.id;
      if (!parsed.venue) parsed.venue = vRow.name;
      if (!parsed.city && vRow.city_name) parsed.city = vRow.city_name;
      if (!parsed.area && (vRow.neighbourhood || vRow.address_public)) parsed.area = vRow.neighbourhood || vRow.address_public;
    }
  }
  const open = await db.one(`SELECT count(*)::int AS n FROM event_drafts WHERE organiser_user_id = $1 AND status = 'active'`, [user.id]);
  if (open.n >= 20) throw new HttpError(409, 'too_many_drafts', 'You have 20 unfinished drafts. Publish or discard one first.');
  const r = await db.one(
    `INSERT INTO event_drafts (organiser_user_id, data) VALUES ($1, $2) RETURNING *`, [user.id, JSON.stringify(parsed)]);
  return draftOut(r);
}

/**
 * Optimistic concurrency: the write succeeds only if `version` is the version the client last
 * saw. A stale write gets 409 with the newer server copy, so nothing is silently overwritten.
 */
export async function saveDraft(userId, draftId, { data, step, version }) {
  if (data?.venueId) {
    await assertVenueUsePermission(userId, data.venueId);
  }
  if (data?.schedule?.venueArrangement === 'different' && Array.isArray(data.schedule.dates)) {
    for (const item of data.schedule.dates) {
      if (item.venueId) {
        await assertVenueUsePermission(userId, item.venueId);
      }
    }
  }
  const r = await db.one(
    `UPDATE event_drafts SET data = $3, step = $4, version = version + 1
      WHERE id = $1 AND organiser_user_id = $2 AND status = 'active' AND version = $5 RETURNING *`,
    [draftId, userId, JSON.stringify(data), STEPS.includes(step) ? step : 'basics', version]);
  if (r) return draftOut(r);
  const cur = await getDraft(userId, draftId);
  if (cur.status !== 'active') throw new HttpError(409, 'draft_closed', cur.status === 'published' ? 'This draft has already been published.' : 'This draft was discarded.');
  throw new HttpError(409, 'version_conflict', 'This draft was changed somewhere else (another tab or device).', { draft: draftOut(cur) });
}

export async function discardDraft(userId, draftId) {
  const r = await db.one(
    `UPDATE event_drafts SET status = 'discarded', discarded_at = now() WHERE id = $1 AND organiser_user_id = $2 AND status = 'active' RETURNING id`,
    [draftId, userId]);
  if (!r) await getDraft(userId, draftId); // 404 if not theirs; otherwise already closed (idempotent)
  await db.query(`DELETE FROM event_images WHERE draft_id = $1 AND NOT is_public`, [draftId]);
}

// ---------- images ----------

const MAGIC = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP']
];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Validate by content (magic bytes), not by the claimed type alone. */
export function sniffImage(buf, claimedType) {
  if (!buf?.length) throw new HttpError(400, 'validation', 'The image is empty.');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large', 'Images must be 2 MB or smaller.');
  const hit = MAGIC.find(([, test]) => buf.length > 12 && test(buf));
  if (!hit) throw new HttpError(415, 'image_type', 'Use a JPEG, PNG or WebP image.');
  if (claimedType && claimedType.split(';')[0].trim() !== hit[0]) throw new HttpError(415, 'image_type', 'The file type does not match its contents.');
  return hit[0];
}

export async function addImage(userId, draftId, buf, claimedType) {
  const type = sniffImage(buf, claimedType);
  const d = await getDraft(userId, draftId);
  if (d.status !== 'active') throw new HttpError(409, 'draft_closed', 'This draft is no longer editable.');
  const n = await db.one(`SELECT count(*)::int AS n FROM event_images WHERE draft_id = $1`, [draftId]);
  // Allow a little headroom for replaced-but-not-yet-saved images.
  if (n.n >= MAX_IMAGES * 2) throw new HttpError(409, 'too_many_images', `Up to ${MAX_IMAGES} images per event. Remove one first.`);
  const r = await db.one(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, draftId, type, buf, buf.length]);
  return { id: r.id, url: imageUrl(r.id) };
}

export async function removeImage(userId, draftId, imageId) {
  await getDraft(userId, draftId);
  await db.query(`DELETE FROM event_images WHERE id = $1 AND draft_id = $2 AND owner_user_id = $3 AND NOT is_public`, [imageId, draftId, userId]);
}

export const imageUrl = (imageId) => `/media/event-images/${imageId}`;

/** Public images are served to anyone; draft images only to their owner or authorized team members. */
export async function readImage(imageId, viewer) {
  const r = await db.one('SELECT content_type, bytes, is_public, owner_user_id FROM event_images WHERE id = $1', [imageId]);
  if (!r) return null;
  if (r.is_public) return r;
  if (viewer && viewer.id === r.owner_user_id) return r;
  if (viewer) {
    const isVenueMember = (await db.query(
      `SELECT 1 FROM venues v
         JOIN org_memberships m ON m.org_id = v.org_id
        WHERE m.user_id = $1 AND m.status = 'active'
          AND v.photos::text LIKE '%' || $2::text || '%'
        LIMIT 1`,
      [viewer.id, imageId]
    )).rows[0];
    if (isVenueMember) return r;
  }
  return null;
}

// ---------- preview ----------

/** Turn draft data into the row shape toPublicEvent() expects, so the preview is the real page. */
export function draftToRow(d, { hostFallback = '' } = {}) {
  const tz = d.timezone || 'Asia/Kolkata';
  const sched = d.schedule ? normalizeSchedule(d.schedule, d.startLocal, d.endLocal) : null;
  const bounds = sched ? deriveEventBounds(sched, d.startLocal, d.endLocal) : { startLocal: d.startLocal, endLocal: d.endLocal, isMultiDay: Boolean(d.multiDay) };
  const effectiveStart = bounds.startLocal || d.startLocal;
  const effectiveEnd = bounds.endLocal || d.endLocal;
  const effectiveMultiDay = bounds.isMultiDay || Boolean(d.multiDay);

  const start = zonedToUtc(effectiveStart, tz);
  if (!start) return null;
  const end = effectiveEnd ? zonedToUtc(effectiveEnd, tz) : null;
  const f = d.features || {};
  const tickets = (d.tickets || []).filter((t) => Number.isInteger(t.quantity) && t.quantity >= 0);
  const resolvedPolicy = resolveCancellationPolicy(d.cancellationPolicy || { refundPolicy: d.refundPolicy });
  return {
    id: 'preview', slug: 'preview', title: clean(d.title) || 'Untitled event', summary: summaryOf(d.description), description: clean(d.description),
    category: d.category || 'meetup', city: clean(d.city) || 'City to be added', area_public: clean(d.area) || null,
    venue_private: clean(d.venue) || null, venue_privacy: d.privateVenue ? 'disclosed_after_booking' : 'public', maps_url: d.mapsUrl || null,
    start_at: start, end_at: end && end > start ? end : null, timezone: tz,
    capacity: tickets.reduce((n, t) => n + t.quantity, 0), price_status: 'tbd', ticket_price_paise: null,
    inclusions: [], exclusions: [], refund_policy: clean(d.refundPolicy) || null, gender_policy: null,
    food_available: false, stay_available: false, organizer: clean(d.hostName) || hostFallback || 'Independent organiser',
    source: 'internal', status: 'draft', is_demo: false, seats_taken: 0,
    cover_url: d.coverImageId ? imageUrl(d.coverImageId) : null,
    gallery: (d.imageIds || []).map(imageUrl),
    ticketing: 'tiers', is_multi_day: effectiveMultiDay, requires_approval: Boolean(f.approval?.enabled),
    features: {
      ...featureFlags(f),
      cancellationPolicy: resolvedPolicy.snapshot,
      schedule: sched
    },
    booking_questions: f.questions?.enabled ? sanitizeQuestions(f.questions.items) : [],
    pickup_points: f.pickup?.enabled ? sanitizePickups(f.pickup.points) : [],
    contact_phone: f.contact?.enabled ? normalizePhone(f.contact.phone) : null,
    tiers: tickets.map((t, i) => ({
      id: t.id, name: clean(t.name) || `Ticket ${i + 1}`, kind: t.kind, price_paise: t.kind === 'free' ? 0 : t.pricePaise || 0,
      category: t.category || 'general', admit_count: t.admitCount || (t.category === 'couple' ? 2 : t.category === 'group' ? 4 : 1),
      quantity: t.quantity, max_per_booking: t.maxPerBooking || 1, min_per_booking: t.minPerBooking || 1,
      valid_on: t.validOn && t.validOn !== 'all' ? t.validOn : null, session_id: t.sessionId || null,
      sales_start_at: t.salesStartAt || null, sales_end_at: t.salesEndAt || null,
      eligibility: f.balance?.enabled || clean(t.eligibility) ? clean(t.eligibility) || null : null, sold: 0, held: 0
    }))
  };
}

export function previewEvent(d, opts) {
  const row = draftToRow(d, opts);
  return row ? toPublicEvent(row) : null;
}

function summaryOf(description) {
  const first = clean(description).split(/\n{2,}/)[0] || '';
  return first.length > 220 ? `${first.slice(0, 217).trimEnd()}…` : first;
}

function featureFlags(f) {
  return {
    questions: Boolean(f.questions?.enabled), approval: Boolean(f.approval?.enabled), balance: Boolean(f.balance?.enabled),
    pickup: Boolean(f.pickup?.enabled), contact: Boolean(f.contact?.enabled)
  };
}

function sanitizeQuestions(items = []) {
  return items.map((q) => ({
    id: q.id, label: clean(q.label), type: q.type, required: Boolean(q.required),
    options: q.type === 'single' || q.type === 'multi' ? (q.options || []).map(clean).filter(Boolean) : []
  }));
}

function sanitizePickups(points = []) {
  return points.map((p) => ({ id: p.id, name: clean(p.name), location: clean(p.location), time: p.time }));
}

function slugify(title) {
  const base = clean(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${base || 'event'}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---------- publish ----------

/**
 * Publish a draft. Requires `confirm: true` and the current draft version. Re-validates on the
 * server, then creates the event, its ticket tiers and cover media in one transaction.
 */
export async function publishDraft(user, draftId, { version, confirm }) {
  if (confirm !== true) throw new HttpError(400, 'confirm_required', 'Publishing needs explicit confirmation.');
  await requireOrganiser(user);
  const checkout = ticketCheckoutStatus();
  const result = await db.tx(async (c) => {
    const draft = (await c.query('SELECT * FROM event_drafts WHERE id = $1 AND organiser_user_id = $2 FOR UPDATE', [draftId, user.id])).rows[0];
    if (!draft) throw new HttpError(404, 'not_found', 'Draft not found');
    if (draft.status !== 'active') throw new HttpError(409, 'draft_closed', draft.status === 'published' ? 'This draft has already been published.' : 'This draft was discarded.');
    if (draft.version !== version) throw new HttpError(409, 'version_conflict', 'This draft changed since you reviewed it. Review the latest version, then publish.', { draft: draftOut(draft) });
    const d = parse(DraftData, draft.data);
    const errors = blocking(publishIssues(d, { checkout }));
    if (errors.length) throw new HttpError(422, 'not_ready', 'Some details need attention before publishing.', { issues: errors });
    const allowPaid = livePayments() || upiCheckoutEnabled() || process.env.ALLOW_PAID_PUBLISH === 'true';
    if (!allowPaid && d.tickets?.some((t) => t.kind === 'paid' || (t.pricePaise && t.pricePaise > 0))) {
      throw new HttpError(422, 'paid_tickets_disabled', 'Paid ticket sales are disabled. Only free events can be published.');
    }

    const imageIds = [d.coverImageId, ...(d.imageIds || [])].filter(Boolean);
    if (imageIds.length) {
      const owned = (await c.query(`SELECT id FROM event_images WHERE id = ANY($1) AND draft_id = $2 AND owner_user_id = $3`, [imageIds, draftId, user.id])).rows;
      if (owned.length !== new Set(imageIds).size) throw new HttpError(422, 'not_ready', 'An image is missing. Re-upload it and try again.', { issues: [{ step: 'basics', field: 'coverImageId', message: 'An image is missing.', severity: 'error' }] });
    }

    const tz = d.timezone || 'Asia/Kolkata';
    const f = d.features || {};
    const tickets = d.tickets;
    const capacity = tickets.reduce((n, t) => n + t.quantity, 0);
    let coverMediaId = null;
    if (d.coverImageId) {
      coverMediaId = (await c.query(
        `INSERT INTO media (type, url, caption, author_alias, authorized_by_owner, visible) VALUES ('photo', $1, $2, $3, true, true) RETURNING id`,
        [imageUrl(d.coverImageId), clean(d.title).slice(0, 140), user.alias || null])).rows[0].id;
    }
    const contactPhone = f.contact?.enabled ? normalizePhone(f.contact.phone) : null;
    const orgId = await ensurePersonalOrg(user, c);

    // Resolve location intelligence references from official directory
    const resolvedCity = await resolveCity(d.city, c);
    const canonicalCity = resolvedCity ? resolvedCity.name : clean(d.city);
    const cityId = resolvedCity ? resolvedCity.id : null;
    let lat = resolvedCity ? resolvedCity.lat : null;
    let lng = resolvedCity ? resolvedCity.lng : null;
    let coordsProvenance = resolvedCity ? 'city' : 'none';

    let localityId = null;
    if (resolvedCity && d.area && clean(d.area)) {
      const loc = (await c.query(
        `SELECT id, lat, lng FROM location_localities
          WHERE city_id = $1
            AND (lower(name) = lower($2) OR lower(slug) = lower($2) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($2)))
          LIMIT 1`, [resolvedCity.id, clean(d.area)])).rows[0];
      if (loc) {
        localityId = loc.id;
        if (loc.lat != null && loc.lng != null) {
          lat = loc.lat;
          lng = loc.lng;
          coordsProvenance = 'locality';
        }
      }
    }

    const sched = d.schedule ? normalizeSchedule(d.schedule, d.startLocal, d.endLocal) : null;
    const bounds = sched ? deriveEventBounds(sched, d.startLocal, d.endLocal) : { startLocal: d.startLocal, endLocal: d.endLocal, isMultiDay: Boolean(d.multiDay) };
    const effectiveStart = bounds.startLocal || d.startLocal;
    const effectiveEnd = bounds.endLocal || d.endLocal;
    const effectiveMultiDay = bounds.isMultiDay || Boolean(d.multiDay);

    const resolvedPolicy = resolveCancellationPolicy(d.cancellationPolicy || { refundPolicy: d.refundPolicy });
    const finalFeatures = {
      ...featureFlags(f),
      cancellationPolicy: resolvedPolicy.snapshot,
      schedule: sched
    };
    const finalRefundPolicyText = d.cancellationPolicy
      ? (resolvedPolicy.renderedText || resolvedPolicy.snapshot.summary)
      : (clean(d.refundPolicy) || resolvedPolicy.renderedText || resolvedPolicy.snapshot.summary);

    const hasPaid = tickets.some((t) => t.kind === 'paid');
    const checkoutMode = hasPaid ? (checkout.available && (checkout.provider === 'phonepe' || checkout.provider === 'phonepe_sandbox') ? 'upi_direct' : 'none') : 'free';

    let linkedVenueId = null;
    if (d.venueId) {
      const v = await assertVenueUsePermission(user.id, d.venueId, c);
      if (v) linkedVenueId = v.id;
    }
    if (sched && sched.venueArrangement === 'different' && Array.isArray(sched.dates)) {
      for (const item of sched.dates) {
        if (item.venueId) {
          await assertVenueUsePermission(user.id, item.venueId, c);
        }
      }
    }

    const ev = (await c.query(
      `INSERT INTO events (slug, category, title, summary, description, city, city_id, locality_id, lat, lng, coords_provenance, area_public, venue_private, venue_privacy, start_at, end_at, timezone,
                           capacity, price_status, refund_policy, organizer, status, published_at, organiser_user_id, draft_id, ticketing,
                           is_multi_day, maps_url, requires_approval, booking_questions, pickup_points, contact_name, contact_phone, gallery, features, cover_media_id,
                           organiser_org_id, checkout_mode, venue_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, 'tbd', $19, $20, 'published', now(), $21, $22, 'tiers',
               $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35) RETURNING id, slug, category, venue_id`,
      [slugify(d.title), d.category, clean(d.title), summaryOf(d.description) || null, clean(d.description),
        canonicalCity, cityId, localityId, lat, lng, coordsProvenance, clean(d.area) || null,
        clean(d.venue) || null, d.privateVenue ? 'disclosed_after_booking' : 'public', zonedToUtc(effectiveStart, tz),
        effectiveEnd ? zonedToUtc(effectiveEnd, tz) : null, tz, capacity, finalRefundPolicyText,
        clean(d.hostName) || user.alias || 'Independent organiser', user.id, draftId,
        effectiveMultiDay, d.mapsUrl || null, Boolean(f.approval?.enabled),
        JSON.stringify(f.questions?.enabled ? sanitizeQuestions(f.questions.items) : []),
        JSON.stringify(f.pickup?.enabled ? sanitizePickups(f.pickup.points) : []),
        contactPhone ? clean(f.contact.name) : null, contactPhone,
        JSON.stringify((d.imageIds || []).map(imageUrl)), JSON.stringify(finalFeatures), coverMediaId, orgId, checkoutMode, linkedVenueId])).rows[0];

    // Insert recurring / multi-date occurrences into event_sessions
    const sessionMap = new Map();
    if (sched && sched.dates && sched.dates.length > 0) {
      for (const [idx, item] of sched.dates.entries()) {
        const sVenueName = sched.venueArrangement === 'different' && item.venueName ? item.venueName : clean(d.venue);
        const sVenueAddress = sched.venueArrangement === 'different' && item.venueAddress ? item.venueAddress : (clean(d.venue) || null);
        const sCity = sched.venueArrangement === 'different' && item.city ? item.city : canonicalCity;
        const sMapsUrl = sched.venueArrangement === 'different' && item.mapsUrl ? item.mapsUrl : (d.mapsUrl || null);
        const sLat = sched.venueArrangement === 'different' && item.lat != null ? item.lat : lat;
        const sLng = sched.venueArrangement === 'different' && item.lng != null ? item.lng : lng;
        const sTz = item.timezone || tz;
        const sStart = zonedToUtc(item.startLocal, sTz);
        const sEnd = item.endLocal ? zonedToUtc(item.endLocal, sTz) : null;
        const sRow = (await c.query(
          `INSERT INTO event_sessions (
             event_id, session_index, session_date, start_at, end_at, label,
             venue_id, venue_name, venue_address, city, maps_url, lat, lng, timezone
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, session_date`,
          [ev.id, idx + 1, item.date, sStart, sEnd, item.label || `Session ${idx + 1}`,
           sched.venueArrangement === 'different' ? (item.venueId || null) : (linkedVenueId || null),
           sVenueName || null, sVenueAddress || null, sCity, sMapsUrl, sLat, sLng, sTz]
        )).rows[0];
        sessionMap.set(item.date, sRow.id);
      }
    }

    for (const [i, t] of tickets.entries()) {
      const admitCount = Number.isInteger(t.admitCount) && t.admitCount > 0 ? t.admitCount : (t.category === 'couple' ? 2 : t.category === 'group' ? 4 : 1);
      const minPerBooking = Number.isInteger(t.minPerBooking) && t.minPerBooking > 0 ? t.minPerBooking : 1;
      const category = clean(t.category) || 'general';
      const targetSessionId = t.sessionId || (t.validOn && sessionMap.get(t.validOn)) || null;
      await c.query(
        `INSERT INTO ticket_types (
           event_id, name, kind, price_paise, quantity, max_per_booking, min_per_booking,
           valid_on, eligibility, sort_order, category, admit_count, sales_start_at, sales_end_at, session_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [ev.id, clean(t.name), t.kind, t.kind === 'free' ? 0 : t.pricePaise, t.quantity, t.maxPerBooking || 1,
         minPerBooking, t.validOn && t.validOn !== 'all' ? t.validOn : null,
         f.balance?.enabled || clean(t.eligibility) ? clean(t.eligibility) || null : null,
         i, category, admitCount, t.salesStartAt ? new Date(t.salesStartAt) : null,
         t.salesEndAt ? new Date(t.salesEndAt) : null, targetSessionId]);
    }
    if (imageIds.length) await c.query(`UPDATE event_images SET is_public = true WHERE id = ANY($1)`, [imageIds]);
    await c.query(`UPDATE event_drafts SET status = 'published', event_id = $2, published_at = now(), version = version + 1 WHERE id = $1`, [draftId, ev.id]);
    await c.query(
      `INSERT INTO event_team (event_id, user_id, team_role, status, invited_by)
       VALUES ($1, $2, 'organiser', 'active', $2)
       ON CONFLICT (event_id, user_id) WHERE status = 'active' AND user_id IS NOT NULL DO NOTHING`,
      [ev.id, user.id]
    );
    await audit(`user:${user.id}`, 'event.publish', ev.id, { draftId, tiers: tickets.length, approval: Boolean(f.approval?.enabled) }, c);
    return ev;
  });
  invalidatePublicEventCache();
  const path = `${isTripCategory(result.category) ? '/trips' : '/events'}/${result.slug}`;
  return { eventId: result.id, slug: result.slug, path, url: `${siteUrl()}${path}`, manageUrl: `/organiser/events/${result.id}` };
}

// ---------- organiser's events ----------

/** Events of every org where this user may see inventory/events, or events where they are assigned staff. */
export async function listOrganiserEvents(user) {
  const orgIds = await orgIdsFor(user, 'event.view_inventory');
  const staffEventIds = await eventIdsFor(user, 'event.view_inventory');
  const { rows } = await db.query(
    `SELECT e.id, e.slug, e.title, e.category, e.city, e.start_at, e.end_at, e.status, e.capacity, e.requires_approval,
            (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed', 'checked_in')) AS confirmed,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'pending_approval') AS requests,
            (SELECT count(*)::int FROM tickets t WHERE t.event_id = e.id AND t.status = 'checked_in') AS checked_in_count,
            (SELECT count(*)::int FROM event_team et WHERE et.event_id = e.id AND et.status = 'active') AS staff_count
       FROM events e
      WHERE (e.organiser_org_id = ANY($1::uuid[]) OR e.id = ANY($2::uuid[]))
      ORDER BY e.start_at DESC LIMIT 100`, [orgIds, staffEventIds]);
  return rows.map((r) => {
    const confirmed = r.confirmed || 0;
    const checkedIn = r.checked_in_count || 0;
    const remaining = Math.max(0, (r.capacity || 0) - confirmed);
    const attendancePct = confirmed > 0 ? Math.round((checkedIn / confirmed) * 100) : 0;
    return {
      id: r.id, title: r.title, city: r.city, startAt: r.start_at, endAt: r.end_at, status: r.status,
      capacity: r.capacity, confirmed, requests: r.requests || 0, requiresApproval: r.requires_approval,
      checkedIn, remaining, attendanceRate: attendancePct, staffCount: r.staff_count || 0,
      path: `${isTripCategory(r.category) ? '/trips' : '/events'}/${r.slug}`,
      manageUrl: `/organiser/events/${r.id}`,
      scanUrl: `/organiser/events/${r.id}/scan`
    };
  });
}

/**
 * Detailed event overview and readiness status for organisers.
 */
export async function getEventOverview(user, eventId) {
  await authorize(user, 'event.view_inventory', { eventId });
  const e = (await db.query(`SELECT * FROM events WHERE id = $1`, [eventId])).rows[0];
  if (!e) throw new HttpError(404, 'not_found', 'Event not found');

  const [attendance, staffRows, announcements] = await Promise.all([
    db.query(`SELECT
       (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.event_id = $1 AND b.status IN ('confirmed', 'checked_in')) AS confirmed_seats,
       (SELECT count(*)::int FROM bookings b WHERE b.event_id = $1 AND b.status = 'pending_approval') AS pending_requests,
       (SELECT count(*)::int FROM tickets t WHERE t.event_id = $1 AND t.status = 'checked_in') AS checked_in_count,
       (SELECT count(*)::int FROM tickets t WHERE t.event_id = $1 AND t.status IN ('valid', 'checked_in')) AS eligible_tickets,
       (SELECT count(*)::int FROM bookings b WHERE b.event_id = $1 AND b.status = 'refunded') AS refunded_bookings`, [eventId]),
    db.query(`SELECT count(*)::int AS count FROM event_team WHERE event_id = $1 AND status = 'active'`, [eventId]),
    db.query(`SELECT count(*)::int AS count FROM event_announcements WHERE event_id = $1`, [eventId])
  ]);

  const stats = attendance.rows[0];
  const confirmed = stats.confirmed_seats || 0;
  const checkedIn = stats.checked_in_count || 0;
  const eligible = stats.eligible_tickets || 0;
  const remaining = Math.max(0, e.capacity - confirmed);
  const attendanceRate = eligible > 0 ? Math.round((checkedIn / eligible) * 100) : 0;

  const [canEdit, canManageStaff, canCheckIn, canDecide, canCancel] = await Promise.all([
    can(user, 'event.edit', { eventId }),
    can(user, 'event.manage_staff', { eventId }),
    can(user, 'event.check_in', { eventId }),
    can(user, 'event.decide_bookings', { eventId }),
    can(user, 'event.cancel', { eventId })
  ]);

  const hasTitle = Boolean(e.title && e.title.length >= 3);
  const hasDescription = Boolean(e.description && e.description.length >= 10);
  const hasVenue = Boolean(e.venue_private || e.area_public);
  const hasTiers = (await db.query(`SELECT 1 FROM ticket_types WHERE event_id = $1 AND active LIMIT 1`, [eventId])).rowCount > 0;
  const isPublished = e.status === 'published';
  const staffCount = staffRows.rows[0]?.count || 0;
  const hasStaff = staffCount > 0;
  const gateReady = hasStaff || canCheckIn;

  const readinessScore = [hasTitle, hasDescription, hasVenue, hasTiers, isPublished, gateReady].filter(Boolean).length;
  const path = `${isTripCategory(e.category) ? '/trips' : '/events'}/${e.slug}`;

  return {
    event: {
      id: e.id,
      title: e.title,
      slug: e.slug,
      category: e.category,
      city: e.city,
      startAt: e.start_at,
      endAt: e.end_at,
      status: e.status,
      capacity: e.capacity,
      venuePrivacy: e.venue_privacy,
      venue: e.venue_private,
      area: e.area_public,
      mapsUrl: e.maps_url,
      refundPolicy: e.refund_policy,
      requiresApproval: e.requires_approval,
      path,
      manageUrl: `/organiser/events/${e.id}`,
      scanUrl: `/organiser/events/${e.id}/scan`
    },
    metrics: {
      capacity: e.capacity,
      confirmedSeats: confirmed,
      remainingSeats: remaining,
      pendingRequests: stats.pending_requests || 0,
      eligibleTickets: eligible,
      checkedInTickets: checkedIn,
      attendanceRate,
      refundedBookings: stats.refunded_bookings || 0,
      activeStaffCount: staffCount,
      announcementsCount: announcements.rows[0]?.count || 0
    },
    readiness: {
      score: `${readinessScore}/6`,
      complete: readinessScore === 6,
      checklist: [
        { key: 'basics', label: 'Event Basics & Title', passed: hasTitle },
        { key: 'description', label: 'Event Description', passed: hasDescription },
        { key: 'venue', label: 'Venue & Directions', passed: hasVenue },
        { key: 'tiers', label: 'Ticket Tiers Configured', passed: hasTiers },
        { key: 'published', label: 'Published & Discoverable', passed: isPublished },
        { key: 'gate', label: 'Door Staff & Scanner Ready', passed: gateReady }
      ]
    },
    permissions: {
      canEdit,
      canManageStaff,
      canCheckIn,
      canDecide,
      canCancel
    }
  };
}

/**
 * Ticket tier inventory and availability breakdown.
 */
export async function getEventInventory(user, eventId) {
  await authorize(user, 'event.view_inventory', { eventId });
  const e = (await db.query(`SELECT id, title, capacity FROM events WHERE id = $1`, [eventId])).rows[0];
  if (!e) throw new HttpError(404, 'not_found', 'Event not found');

  const tiers = (await db.query(
    `SELECT t.id, t.name, t.kind, t.price_paise, t.quantity, t.max_per_booking, t.eligibility, t.valid_on, t.sort_order,
            (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.ticket_type_id = t.id AND b.status IN ('confirmed', 'checked_in')) AS sold,
            (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.ticket_type_id = t.id AND b.status = 'pending_payment' AND b.hold_expires_at > now()) AS holds
       FROM ticket_types t
      WHERE t.event_id = $1 AND t.active
      ORDER BY t.sort_order ASC, t.created_at ASC`,
    [eventId]
  )).rows;

  const totalSold = tiers.reduce((sum, t) => sum + (t.sold || 0), 0);
  const totalHolds = tiers.reduce((sum, t) => sum + (t.holds || 0), 0);
  const totalRemaining = Math.max(0, e.capacity - totalSold - totalHolds);

  return {
    eventId,
    capacity: e.capacity,
    totalSold,
    totalHolds,
    totalRemaining,
    tiers: tiers.map((t) => {
      const sold = t.sold || 0;
      const holds = t.holds || 0;
      const remaining = Math.max(0, t.quantity - sold - holds);
      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        pricePaise: t.price_paise,
        quantity: t.quantity,
        maxPerBooking: t.max_per_booking,
        eligibility: t.eligibility || null,
        sold,
        holds,
        remaining
      };
    })
  };
}

/**
 * Validated edit of a published event's parameters.
 */
export async function updateOrganiserEvent(user, eventId, updates) {
  await authorize(user, 'event.edit', { eventId });

  return db.tx(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
    if (!e) throw new HttpError(404, 'not_found', 'Event not found');
    if (e.status === 'cancelled') throw new HttpError(409, 'event_cancelled', 'Cancelled events cannot be modified');

    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.title !== undefined) {
      const title = clean(updates.title);
      if (title.length < 3) throw new HttpError(400, 'validation', 'Event title must be at least 3 characters');
      fields.push(`title = $${idx++}`);
      values.push(title);
    }

    if (updates.description !== undefined) {
      const desc = clean(updates.description);
      if (desc.length < 10) throw new HttpError(400, 'validation', 'Event description must be at least 10 characters');
      fields.push(`description = $${idx++}`);
      values.push(desc);
    }

    if (updates.capacity !== undefined) {
      const cap = Number(updates.capacity);
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAPACITY) {
        throw new HttpError(400, 'validation', `Capacity must be between 1 and ${MAX_CAPACITY}`);
      }
      const confirmed = (await c.query(
        `SELECT COALESCE(sum(quantity), 0)::int AS n FROM bookings WHERE event_id = $1 AND status IN ('confirmed', 'checked_in')`,
        [eventId]
      )).rows[0].n;
      if (cap < confirmed) {
        throw new HttpError(409, 'capacity_too_low', `Capacity cannot be reduced below the ${confirmed} currently confirmed seats`);
      }
      fields.push(`capacity = $${idx++}`);
      values.push(cap);
    }

    if (updates.start_at !== undefined) {
      const d = new Date(updates.start_at);
      if (isNaN(d.getTime())) throw new HttpError(400, 'validation', 'Invalid start time');
      fields.push(`start_at = $${idx++}`);
      values.push(d.toISOString());
    }

    if (updates.end_at !== undefined) {
      if (updates.end_at === null) {
        fields.push(`end_at = NULL`);
      } else {
        const d = new Date(updates.end_at);
        if (isNaN(d.getTime())) throw new HttpError(400, 'validation', 'Invalid end time');
        const start = updates.start_at ? new Date(updates.start_at) : new Date(e.start_at);
        if (d <= start) throw new HttpError(400, 'validation', 'End time must be after start time');
        fields.push(`end_at = $${idx++}`);
        values.push(d.toISOString());
      }
    }

    if (updates.venue_private !== undefined) {
      fields.push(`venue_private = $${idx++}`);
      values.push(clean(updates.venue_private) || null);
    }

    if (updates.venue_id !== undefined || updates.venueId !== undefined) {
      const vId = updates.venue_id !== undefined ? updates.venue_id : updates.venueId;
      if (vId) {
        await assertVenueUsePermission(user.id, vId, c);
      }
      fields.push(`venue_id = $${idx++}`);
      values.push(vId || null);
    }

    if (updates.area_public !== undefined) {
      fields.push(`area_public = $${idx++}`);
      values.push(clean(updates.area_public) || null);
    }

    if (updates.venue_privacy !== undefined) {
      if (!['public', 'disclosed_after_booking'].includes(updates.venue_privacy)) {
        throw new HttpError(400, 'validation', 'Invalid venue privacy option');
      }
      fields.push(`venue_privacy = $${idx++}`);
      values.push(updates.venue_privacy);
    }

    if (updates.maps_url !== undefined) {
      if (updates.maps_url && !isMapsUrl(updates.maps_url)) {
        throw new HttpError(400, 'validation', 'Maps link must be a valid Google Maps HTTPS URL');
      }
      fields.push(`maps_url = $${idx++}`);
      values.push(updates.maps_url ? clean(updates.maps_url) : null);
    }

    if (updates.cancellationPolicy !== undefined || updates.cancellation_policy !== undefined) {
      const polInput = updates.cancellationPolicy !== undefined ? updates.cancellationPolicy : updates.cancellation_policy;
      const resPol = resolveCancellationPolicy(polInput);
      const existingFeatures = typeof e.features === 'object' && e.features !== null ? e.features : {};
      const newFeatures = { ...existingFeatures, cancellationPolicy: resPol.snapshot };
      fields.push(`features = $${idx++}`);
      values.push(JSON.stringify(newFeatures));
      fields.push(`refund_policy = $${idx++}`);
      values.push(resPol.renderedText || resPol.snapshot.summary);
    } else if (updates.refund_policy !== undefined) {
      fields.push(`refund_policy = $${idx++}`);
      values.push(clean(updates.refund_policy) || null);
    }

    if (updates.schedule !== undefined) {
      const sched = normalizeSchedule(updates.schedule, updates.start_at || e.start_at, updates.end_at || e.end_at);
      const bounds = deriveEventBounds(sched, updates.start_at || e.start_at, updates.end_at || e.end_at);
      const existingFeatures = typeof e.features === 'object' && e.features !== null ? e.features : {};
      const newFeatures = { ...existingFeatures, schedule: sched };
      fields.push(`features = $${idx++}`);
      values.push(JSON.stringify(newFeatures));
      fields.push(`is_multi_day = $${idx++}`);
      values.push(bounds.isMultiDay);
      if (bounds.startLocal && updates.start_at === undefined) {
        fields.push(`start_at = $${idx++}`);
        values.push(new Date(bounds.startLocal).toISOString());
      }
      if (bounds.endLocal && updates.end_at === undefined) {
        fields.push(`end_at = $${idx++}`);
        values.push(new Date(bounds.endLocal).toISOString());
      }
    }

    if (updates.booking_questions !== undefined) {
      fields.push(`booking_questions = $${idx++}`);
      values.push(JSON.stringify(Array.isArray(updates.booking_questions) ? updates.booking_questions : []));
    }

    if (updates.pickup_points !== undefined) {
      fields.push(`pickup_points = $${idx++}`);
      values.push(JSON.stringify(Array.isArray(updates.pickup_points) ? updates.pickup_points : []));
    }

    if (!fields.length) throw new HttpError(400, 'validation', 'No updates provided');

    fields.push(`updated_at = now()`);
    values.push(eventId);

    const updated = (await c.query(
      `UPDATE events SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )).rows[0];

    await audit(`user:${user.id}`, 'event.edit', eventId, updates, c);
    return updated;
  });
  invalidatePublicEventCache();
  return result;
}

/**
 * Organiser cancels an entire event with a stated reason.
 */
export async function cancelOrganiserEvent(user, eventId, { reason = 'Cancelled by organiser' } = {}) {
  await authorize(user, 'event.cancel', { eventId });

  const res = await db.tx(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
    if (!e) throw new HttpError(404, 'not_found', 'Event not found');
    if (e.status === 'cancelled') throw new HttpError(409, 'already_cancelled', 'Event is already cancelled');

    await c.query(`UPDATE events SET status = 'cancelled', updated_at = now() WHERE id = $1`, [eventId]);

    await c.query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancelled_at = now(),
              cancel_reason = $2,
              updated_at = now()
        WHERE event_id = $1 AND status IN ('pending_approval', 'pending_payment', 'confirmed')`,
      [eventId, reason]
    );

    await c.query(
      `UPDATE tickets
          SET status = 'cancelled',
              updated_at = now()
        WHERE event_id = $1 AND status = 'valid'`,
      [eventId]
    );

    // Transition succeeded payments for cancelled bookings to refund_pending (100% full refund guarantee)
    const paidBookings = (await c.query(
      `SELECT b.id AS booking_id, b.user_id, p.id AS payment_id, p.order_id, p.amount, p.status AS payment_status
         FROM bookings b
         JOIN payments p ON (p.booking_id = b.id OR p.id = b.payment_id)
        WHERE b.event_id = $1
          AND p.status = 'succeeded'
        FOR UPDATE OF p`,
      [eventId]
    )).rows;

    for (const pb of paidBookings) {
      await c.query(
        `UPDATE payments
            SET status = 'refund_pending',
                failure_reason = 'event_cancelled_by_organiser',
                updated_at = now()
          WHERE id = $1`,
        [pb.payment_id]
      );

      await c.query(
        `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
         VALUES ($1, $2, 'succeeded', 'refund_pending', $3, $4)`,
        [
          pb.payment_id,
          pb.order_id,
          `organiser:${user.id}`,
          JSON.stringify({
            action: 'creator_event_cancel_full_refund',
            eventId,
            bookingId: pb.booking_id,
            reason,
            refundPercent: 100,
            amountPaise: pb.amount,
            note: '100% full refund initiated per creator cancellation policy. Subject to provider webhook or authorized finance reconciliation.'
          })
        ]
      );
    }

    const attendees = (await c.query(
      `SELECT DISTINCT user_id, id FROM bookings WHERE event_id = $1`,
      [eventId]
    )).rows;

    const paidUserIds = new Set(paidBookings.map((pb) => pb.user_id));
    for (const a of attendees) {
      const isPaid = paidUserIds.has(a.user_id);
      await enqueue(c, {
        kind: 'event_update',
        userId: a.user_id,
        eventId,
        bookingId: a.id,
        title: `Event Cancelled: ${e.title}`,
        text: isPaid
          ? `The organiser has cancelled "${e.title}". Reason: ${reason}. A 100% full refund has been initiated and will reach your original payment method in 5–7 business days.`
          : `The organiser has cancelled "${e.title}". Reason: ${reason}.`,
        dedupeKey: `cancel:${eventId}:${a.user_id}`
      });
    }

    await audit(`user:${user.id}`, 'event.cancel', eventId, { reason, attendeeCount: attendees.length, refundPendingCount: paidBookings.length }, c);
    return { ok: true, eventId, status: 'cancelled', refundPendingCount: paidBookings.length };
  });
  invalidatePublicEventCache();
  return res;
}

/**
 * Organiser cancels an individual attendee booking with a stated reason.
 */
export async function cancelOrganiserBooking(user, bookingId, { reason = 'Cancelled by organiser' } = {}) {
  const b = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b) throw new HttpError(404, 'not_found', 'Booking not found');

  await authorize(user, 'event.cancel_booking', { eventId: b.event_id });

  return db.tx(async (c) => {
    const locked = (await c.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
    if (locked.status === 'cancelled' || locked.status === 'declined') {
      throw new HttpError(409, 'already_closed', 'This booking is already cancelled or declined');
    }

    await c.query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancelled_at = now(),
              cancel_reason = $2,
              updated_at = now()
        WHERE id = $1`,
      [bookingId, reason]
    );

    await c.query(
      `UPDATE tickets
          SET status = 'cancelled',
              revoked_at = now(),
              revoked_by = $2,
              revocation_reason = $3,
              updated_at = now()
        WHERE booking_id = $1 AND status = 'valid'`,
      [bookingId, user.id, reason]
    );

    // Reverse infrastructure fee entry and generate credit note
    await reverseBookingFeeEntry(bookingId, { reason, actor: `organiser:${user.id}` }, c);

    // If booking was paid, transition payment to refund_pending (100% full refund guarantee)
    const pb = (await c.query(
      `SELECT p.id, p.order_id, p.amount, p.status
         FROM payments p
        WHERE (p.booking_id = $1 OR p.id = $2)
          AND p.status = 'succeeded'
        FOR UPDATE OF p`,
      [bookingId, locked.payment_id]
    )).rows[0];

    let refundPending = false;
    if (pb) {
      refundPending = true;
      await c.query(
        `UPDATE payments
            SET status = 'refund_pending',
                failure_reason = 'booking_cancelled_by_organiser',
                updated_at = now()
          WHERE id = $1`,
        [pb.id]
      );

      await c.query(
        `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
         VALUES ($1, $2, 'succeeded', 'refund_pending', $3, $4)`,
        [
          pb.id,
          pb.order_id,
          `organiser:${user.id}`,
          JSON.stringify({
            action: 'creator_booking_cancel_full_refund',
            bookingId,
            reason,
            refundPercent: 100,
            amountPaise: pb.amount,
            note: '100% full refund initiated per creator cancellation policy.'
          })
        ]
      );
    }

    await enqueue(c, {
      kind: 'booking_declined',
      userId: locked.user_id,
      bookingId: locked.id,
      dedupeKey: `bk:${locked.id}:cancelled`,
      title: 'Booking Cancelled by Host',
      text: refundPending
        ? `Your booking was cancelled by the host. Reason: ${reason}. A 100% full refund has been initiated and will arrive in 5–7 business days.`
        : `Your booking was cancelled by the host. Reason: ${reason}.`
    });

    await audit(`user:${user.id}`, 'booking.cancel_by_host', bookingId, { eventId: locked.event_id, reason, refundPending }, c);
    return { ok: true, bookingId, status: 'cancelled', refundPending };
  });
}

/**
 * Filtered & paginated attendee/booking search for an event.
 */
export async function listOrganiserBookings(user, eventId, { query = '', status = 'all', page = 1, limit = 50 } = {}) {
  await authorize(user, 'event.view_guests', { eventId });

  const params = [eventId];
  let where = 'b.event_id = $1';

  if (status && status !== 'all') {
    params.push(status);
    where += ` AND b.status = $${params.length}`;
  }

  if (query && query.trim()) {
    params.push(`%${query.trim().toLowerCase()}%`);
    const qIdx = params.length;
    where += ` AND (lower(u.alias) LIKE $${qIdx} OR b.id::text LIKE $${qIdx})`;
  }

  const offset = Math.max(0, (page - 1) * limit);
  params.push(limit);
  const lIdx = params.length;
  params.push(offset);
  const oIdx = params.length;

  const { rows } = await db.query(
    `SELECT b.id, b.status, b.quantity, b.amount_paise, b.payment_mode, b.created_at, b.confirmed_at,
            b.checked_in_at, b.cancelled_at, b.cancel_reason, b.answers, b.pickup_point_id,
            u.id AS user_id, u.alias, u.telegram_user_id,
            tt.name AS tier_name, tt.kind AS tier_kind,
            eo.status AS payment_status,
            (SELECT count(*)::int FROM tickets t WHERE t.booking_id = b.id AND t.status = 'checked_in') AS tickets_checked_in
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN ticket_types tt ON tt.id = b.ticket_type_id
       LEFT JOIN external_orders eo ON eo.matched_booking_id = b.id
      WHERE ${where}
      ORDER BY b.created_at DESC
      LIMIT $${lIdx} OFFSET $${oIdx}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    ref: r.id.slice(0, 8).toUpperCase(),
    status: r.status,
    userId: r.user_id,
    alias: r.alias || 'Guest',
    ticket: r.tier_name || 'Standard',
    kind: r.tier_kind || 'free',
    quantity: r.quantity,
    amountPaise: r.amount_paise,
    paymentMode: r.payment_mode,
    paymentStatus: r.payment_mode === 'free' ? 'not_required' : (r.payment_status || 'unpaid'),
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    checkedInAt: r.checked_in_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    ticketsCheckedIn: r.tickets_checked_in || 0
  }));
}

