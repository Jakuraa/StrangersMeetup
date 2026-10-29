// lib/services/events.js - Event queries and the public (privacy-safe) representation.
import { db } from '../db.js';
import { socialProofMin } from '../config.js';
import { checkoutForEvent } from '../payments/availability.js';

export const CATEGORY_LABELS = {
  meetup: 'Meetup',
  dating_mixer: 'Dating mixer',
  nightlife: 'Nightlife',
  dinner_club: 'Dinner club',
  movie: 'Movie night',
  board_games: 'Board games',
  weekend_trip: 'Strangers trip',
  resort_getaway: 'Resort getaway',
  weekend_party: 'Weekend party',
  matchmaking: 'Matchmaking',
  networking: 'Founders & networking',
  workshop: 'Workshop'
};
export const TRIP_CATEGORIES = ['weekend_trip', 'resort_getaway'];
export const CITIES = [
  { slug: 'chennai', name: 'Chennai', state: 'Tamil Nadu' },
  { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka' },
  { slug: 'coimbatore', name: 'Coimbatore', state: 'Tamil Nadu' },
  { slug: 'kochi', name: 'Kochi', state: 'Kerala' },
  { slug: 'puducherry', name: 'Puducherry', state: 'Puducherry' }
];

/** SQL fragment: bookings that currently occupy seats (live holds + confirmed). Sum b.quantity. */
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

function list(v) {
  return Array.isArray(v) ? v : [];
}

/** Public view of one ticket tier. `sold` = confirmed seats, `held` = live checkout holds. */
export function toPublicTier(t, { checkout, showCounts = false, requiresApproval = false } = {}) {
  const free = t.kind === 'free';
  // A paid ticket is sold by SuperProfile, which owns its stock; our own booking counts say nothing about it.
  const sellsOnSuperprofile = !free && Boolean(checkout?.available);
  const used = sellsOnSuperprofile ? 0 : Number(t.sold || 0) + Number(t.held || 0);
  const remaining = Math.max(0, t.quantity - used);
  let unavailable = null;
  if (remaining <= 0) {
    unavailable = Number(t.held || 0) > 0 ? 'Temporarily full — may reopen if a held spot is released' : 'Sold out';
  } else if (!free && !checkout?.available) {
    unavailable = 'Online payment not available yet';
  } else if (!free && requiresApproval) {
    unavailable = 'Paid tickets can’t be approval-only yet';
  }
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    pricePaise: free ? 0 : t.price_paise,
    priceLabel: free ? 'Free' : formatPaise(t.price_paise),
    quantity: t.quantity,
    remaining,
    remainingLabel: showCounts && !sellsOnSuperprofile ? `${remaining} of ${t.quantity} left` : null,
    maxPerBooking: t.max_per_booking,
    validOn: t.valid_on ? String(t.valid_on).slice(0, 10) : null,
    eligibility: t.eligibility || null,
    available: !unavailable,
    unavailable
  };
}

function tiersPriceLabel(tiers) {
  if (!tiers.length) return 'Price to be announced';
  const paid = tiers.filter((t) => t.kind === 'paid').map((t) => t.pricePaise);
  const anyFree = tiers.some((t) => t.kind === 'free');
  if (!paid.length) return 'Free';
  const min = formatPaise(Math.min(...paid));
  if (anyFree) return `Free or from ${min}`;
  return paid.length === 1 ? min : `From ${min}`;
}

/**
 * Map a DB row to what the public site may show. Never includes venue_private unless the
 * event's venue is public. `seats_taken` is an internal number used only to decide "Sold out".
 */
export function toPublicEvent(row, { checkout = checkoutForEvent(row) } = {}) {
  const external = row.source === 'external';
  const tiered = row.ticketing === 'tiers';
  const features = row.features && typeof row.features === 'object' ? row.features : {};
  const tiers = tiered ? list(row.tiers).map((t) => toPublicTier(t, { checkout, showCounts: Boolean(features.balance), requiresApproval: Boolean(row.requires_approval) })) : [];
  // External listings: we know nothing about seats or price, so we never claim either.
  // SuperProfile sells its own stock, so a linked event is never "sold out" from our booking counts alone.
  const sp = !external && checkout.available;
  const soldOut = !external && !(sp && !tiered) && row.capacity > 0 && (Number(row.seats_taken || 0) >= row.capacity ||
    (tiered && tiers.length > 0 && tiers.every((t) => t.remaining <= 0)));
  const priceSet = tiered ? tiers.length > 0 : row.price_status === 'set' && row.ticket_price_paise > 0;
  const upcoming = new Date(row.start_at).getTime() > Date.now();
  const venuePublic = row.venue_privacy === 'public';
  let state;
  if (row.status === 'cancelled') state = 'cancelled';
  else if (!upcoming) state = 'past';
  else if (external) state = 'external';
  else if (soldOut) state = 'sold_out';
  else if (!priceSet && !sp) state = 'price_tbd';
  else if (tiered && !tiers.some((t) => t.available)) state = 'payment_unavailable';
  else if (!tiered && !sp) state = 'payment_unavailable';
  else state = 'open';
  const STATE_LABEL = {
    cancelled: 'Cancelled',
    past: 'Event ended',
    sold_out: 'Sold out',
    price_tbd: 'Bookings open soon',
    payment_unavailable: 'Online booking not available yet',
    open: tiered && row.requires_approval ? 'Requests open — host approves each guest' : 'Bookings open',
    external: row.source_name ? `Book on ${row.source_name}` : 'Book with the organiser'
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
    venue: venuePublic ? (row.venue_private || '') : '',
    venuePrivacy: row.venue_privacy,
    // Same rule as the venue: a private venue's map link is only on a confirmed guest's booking.
    mapsUrl: venuePublic ? (row.maps_url || null) : null,
    startAt: new Date(row.start_at).toISOString(),
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    timezone: row.timezone,
    capacity: row.capacity,
    priceLabel: external ? 'Price set by organiser' : tiered ? tiersPriceLabel(tiers) : priceSet ? formatPaise(row.ticket_price_paise) : sp ? 'Price shown at checkout' : 'Price to be announced',
    pricePaise: !tiered && priceSet ? row.ticket_price_paise : null,
    ticketing: tiered ? 'tiers' : 'single',
    tiers,
    isMultiDay: Boolean(row.is_multi_day),
    requiresApproval: tiered && Boolean(row.requires_approval),
    questions: tiered ? list(row.booking_questions).map((q) => ({ id: q.id, label: q.label, type: q.type, options: list(q.options), required: Boolean(q.required) })) : [],
    pickupPoints: tiered ? list(row.pickup_points).map((p) => ({ id: p.id, name: p.name, location: p.location || '', time: p.time || null })) : [],
    hasContact: tiered && Boolean(row.contact_phone),
    gallery: list(row.gallery).filter((u) => typeof u === 'string' && u.startsWith('/media/')),
    balance: Boolean(features.balance),
    organiserManaged: Boolean(row.organiser_user_id),
    checkoutAvailable: Boolean(checkout?.available),
    checkoutMode: sp ? 'superprofile' : 'none',
    checkoutPath: sp ? `/checkout/${row.slug}` : null,
    inclusions: arr(row.inclusions),
    exclusions: arr(row.exclusions),
    refundPolicy: row.refund_policy || '',
    genderPolicy: row.gender_policy || '',
    foodAvailable: row.food_available,
    stayAvailable: row.stay_available,
    organizer: row.organizer || (external ? row.source_name : 'StrangersMeetup'),
    isExternal: external,
    externalUrl: external ? row.external_url : null,
    sourceName: external ? row.source_name : null,
    sourceUrl: external ? (row.source_url || null) : null,
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

/** SQL expression: an event's active tiers with confirmed (`sold`) and live-hold (`held`) seats. */
export const TIERS_SQL = `(SELECT COALESCE(json_agg(json_build_object(
      'id', t.id, 'name', t.name, 'kind', t.kind, 'price_paise', t.price_paise, 'quantity', t.quantity,
      'max_per_booking', t.max_per_booking, 'valid_on', t.valid_on, 'eligibility', t.eligibility,
      'sold', (SELECT COALESCE(sum(b.quantity), 0) FROM bookings b WHERE b.ticket_type_id = t.id AND b.status IN ('confirmed', 'checked_in')),
      'held', (SELECT COALESCE(sum(b.quantity), 0) FROM bookings b WHERE b.ticket_type_id = t.id AND b.status = 'pending_payment' AND b.hold_expires_at > now())
    ) ORDER BY t.sort_order), '[]'::json) FROM ticket_types t WHERE t.event_id = e.id AND t.active)`;

const PUBLIC_SELECT = `
  SELECT e.*,
         (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.event_id = e.id AND ${SEAT_HOLDING_SQL}) AS seats_taken,
         (SELECT m.url FROM media m WHERE m.id = e.cover_media_id AND m.authorized_by_owner AND m.visible) AS cover_url,
         ${TIERS_SQL} AS tiers
    FROM events e`;

export async function listPublicEvents({ city, category, categories, kind = 'all', from, to, limit = 60 } = {}) {
  const where = [`e.status = 'published'`, `COALESCE(e.end_at, e.start_at) > now()`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (city) where.push(`lower(e.city) = lower(${p(city)})`);
  if (category) where.push(`e.category = ${p(category)}`);
  if (categories?.length) where.push(`e.category::text = ANY(${p(categories)})`);
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
    `SELECT id, code, name, benefits, stars_amount, period_seconds, active, access_provider, superprofile_url
       FROM membership_tiers WHERE active ORDER BY sort_order, name`);
  return rows.map((t) => (t.access_provider === 'superprofile' ? {
    id: t.id,
    code: t.code,
    name: t.name,
    benefits: arr(t.benefits),
    provider: 'superprofile',
    // Price lives on SuperProfile; we never restate it here.
    priceLabel: t.superprofile_url ? 'Price shown at checkout on SuperProfile' : 'Announcing soon',
    superprofileUrl: t.superprofile_url || null,
    purchasable: Boolean(t.superprofile_url)
  } : {
    id: t.id,
    provider: 'telegram_stars',
    code: t.code,
    name: t.name,
    benefits: arr(t.benefits),
    starsAmount: t.stars_amount,
    periodDays: Math.round(t.period_seconds / 86400),
    priceLabel: t.stars_amount ? `${t.stars_amount} Stars / ${Math.round(t.period_seconds / 86400)} days` : 'Announcing soon',
    purchasable: Boolean(t.stars_amount)
  }));
}
