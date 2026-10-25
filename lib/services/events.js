// lib/services/events.js - Event queries and the public (privacy-safe) representation.
import { db } from '../db.js';
import { socialProofMin } from '../config.js';

export const CATEGORY_LABELS = {
  meetup: 'Meetup',
  dating_mixer: 'Dating mixer',
  nightlife: 'Nightlife',
  dinner_club: 'Dinner club',
  movie: 'Movie night',
  board_games: 'Board games',
  weekend_trip: 'Weekend trip',
  resort_getaway: 'Resort getaway'
};
export const TRIP_CATEGORIES = ['weekend_trip', 'resort_getaway'];
export const CITIES = [
  { slug: 'chennai', name: 'Chennai', state: 'Tamil Nadu' },
  { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka' },
  { slug: 'coimbatore', name: 'Coimbatore', state: 'Tamil Nadu' },
  { slug: 'kochi', name: 'Kochi', state: 'Kerala' },
  { slug: 'puducherry', name: 'Puducherry', state: 'Puducherry' }
];

/** SQL fragment: bookings that currently occupy a seat (live holds + paid). */
export const SEAT_HOLDING_SQL = `(b.status IN ('confirmed', 'checked_in')
  OR (b.status = 'pending_payment' AND b.hold_expires_at > now()))`;

export function isTrip(category) {
  return TRIP_CATEGORIES.includes(category);
}

export function formatPaise(paise) {
  if (!paise) return null;
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: rupees % 1 ? 2 : 0 })}`;
}

function arr(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  return [];
}

/**
 * Map a DB row to what the public site may show. Never includes venue_private unless the
 * event's venue is public. `seats_taken` is an internal number used only to decide "Sold out".
 */
export function toPublicEvent(row) {
  const soldOut = row.capacity > 0 && Number(row.seats_taken || 0) >= row.capacity;
  const priceSet = row.price_status === 'set' && row.ticket_price_paise > 0;
  const upcoming = new Date(row.start_at).getTime() > Date.now();
  let state;
  if (row.status === 'cancelled') state = 'cancelled';
  else if (!upcoming) state = 'past';
  else if (soldOut) state = 'sold_out';
  else if (!priceSet) state = 'price_tbd';
  else state = 'open';
  const STATE_LABEL = {
    cancelled: 'Cancelled',
    past: 'Event ended',
    sold_out: 'Sold out',
    price_tbd: 'Bookings open soon',
    open: 'Bookings open'
  };
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary || '',
    description: row.description || '',
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    isTrip: isTrip(row.category),
    city: row.city,
    area: row.area_public || '',
    venue: row.venue_privacy === 'public' ? (row.venue_private || '') : '',
    venuePrivacy: row.venue_privacy,
    startAt: new Date(row.start_at).toISOString(),
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: row.timezone,
    capacity: row.capacity,
    priceLabel: priceSet ? formatPaise(row.ticket_price_paise) : 'Price to be announced',
    pricePaise: priceSet ? row.ticket_price_paise : null,
    inclusions: arr(row.inclusions),
    exclusions: arr(row.exclusions),
    refundPolicy: row.refund_policy || '',
    genderPolicy: row.gender_policy || '',
    foodAvailable: row.food_available,
    stayAvailable: row.stay_available,
    organizer: row.organizer || 'StrangersMeetup',
    bookmyshowUrl: row.bookmyshow_url || null,
    externalPaymentUrl: row.external_payment_url || null,
    coverUrl: row.cover_url || null,
    isDemo: row.is_demo,
    status: row.status,
    state,
    stateLabel: STATE_LABEL[state],
    bookable: state === 'open'
  };
}

const PUBLIC_SELECT = `
  SELECT e.*,
         (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND ${SEAT_HOLDING_SQL}) AS seats_taken,
         (SELECT m.url FROM media m WHERE m.id = e.cover_media_id AND m.authorized_by_owner AND m.visible) AS cover_url
    FROM events e`;

export async function listPublicEvents({ city, category, kind = 'all', from, to, limit = 60 } = {}) {
  const where = [`e.status = 'published'`, `COALESCE(e.end_at, e.start_at) > now()`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (city) where.push(`lower(e.city) = lower(${p(city)})`);
  if (category) where.push(`e.category = ${p(category)}`);
  if (kind === 'events') where.push(`e.category NOT IN ('weekend_trip', 'resort_getaway')`);
  if (kind === 'trips') where.push(`e.category IN ('weekend_trip', 'resort_getaway')`);
  if (from) where.push(`e.start_at >= ${p(from)}`);
  if (to) where.push(`e.start_at < ${p(to)}`);
  const { rows } = await db.query(
    `${PUBLIC_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.is_demo ASC, e.start_at ASC LIMIT ${p(Math.min(limit, 100))}`,
    params
  );
  return rows.map(toPublicEvent);
}

export async function getPublicEventBySlug(slug) {
  const row = await db.one(`${PUBLIC_SELECT} WHERE e.slug = $1 AND e.status IN ('published', 'cancelled')`, [slug]);
  return row ? toPublicEvent(row) : null;
}

/** Slugs for sitemap: real (non-demo) published events only. */
export async function listSitemapEvents() {
  const { rows } = await db.query(
    `SELECT slug, category, updated_at FROM events
      WHERE status = 'published' AND NOT is_demo AND COALESCE(end_at, start_at) > now()
      ORDER BY start_at`);
  return rows;
}

/**
 * Real social proof: confirmed attendance on real events. Returns null below the threshold so
 * the widget stays hidden.
 */
export async function socialProof() {
  const row = await db.one(
    `SELECT count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.status IN ('confirmed', 'checked_in') AND NOT e.is_demo`);
  const n = row?.n || 0;
  return n >= socialProofMin() ? { confirmedBookings: n } : null;
}

export async function listVisibleMedia(limit = 6) {
  const { rows } = await db.query(
    `SELECT id, type, url, caption, author_alias FROM media
      WHERE authorized_by_owner AND visible ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

export async function listTiers() {
  const { rows } = await db.query(
    `SELECT id, code, name, benefits, stars_amount, period_seconds, active
       FROM membership_tiers WHERE active ORDER BY sort_order, name`);
  return rows.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    benefits: arr(t.benefits),
    starsAmount: t.stars_amount,
    periodDays: Math.round(t.period_seconds / 86400),
    priceLabel: t.stars_amount ? `${t.stars_amount} Stars / ${Math.round(t.period_seconds / 86400)} days` : 'Announcing soon',
    purchasable: Boolean(t.stars_amount)
  }));
}
