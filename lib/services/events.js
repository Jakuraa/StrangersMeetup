// lib/services/events.js - Event queries and the public (privacy-safe) representation.
import { db } from '../db.js';
import { socialProofMin } from '../config.js';
import { checkoutForEvent } from '../payments/availability.js';
import { resolveCancellationPolicy } from './cancellation-policy.js';

export const CATEGORY_LABELS = {
  meetup: 'Meetup',
  dating_mixer: 'Dating mixer',
  nightlife: 'Nightlife',
  dinner_club: 'Dinner club',
  movie: 'Movie night',
  board_games: 'Board games',
  weekend_trip: 'Weekend trip',
  resort_getaway: 'Resort getaway',
  weekend_party: 'Weekend party',
  matchmaking: 'Matchmaking',
  networking: 'Founders & networking',
  workshop: 'Workshop'
};
export const TRIP_CATEGORIES = ['weekend_trip', 'resort_getaway'];

/**
 * Format distance into privacy-preserving coarse distance bands.
 * Prevents exact trilateration of private venues while giving attendees clear proximity info.
 */
export function formatDistanceBand(distanceKm) {
  if (distanceKm == null) return null;
  const d = Number(distanceKm);
  if (Number.isNaN(d) || d < 0) return null;
  if (d < 1) return '< 1 km away';
  if (d < 3) return '~2 km away';
  if (d < 6) return '~5 km away';
  if (d < 12) return '~10 km away';
  if (d < 25) return '~20 km away';
  if (d < 50) return '~30–50 km away';
  return `~${Math.round(d / 10) * 10} km away`;
}

export const CITIES = [
  // South India (18 canonical event markets)
  { slug: 'chennai', name: 'Chennai', state: 'Tamil Nadu', region: 'South', marketTier: 'primary_market' },
  { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', region: 'South', marketTier: 'primary_market' },
  { slug: 'hyderabad', name: 'Hyderabad', state: 'Telangana', region: 'South', marketTier: 'primary_market' },
  { slug: 'kochi', name: 'Kochi', state: 'Kerala', region: 'South', marketTier: 'primary_market' },
  { slug: 'coimbatore', name: 'Coimbatore', state: 'Tamil Nadu', region: 'South', marketTier: 'primary_market' },
  { slug: 'puducherry', name: 'Puducherry', state: 'Puducherry', region: 'South', marketTier: 'primary_market' },
  { slug: 'madurai', name: 'Madurai', state: 'Tamil Nadu', region: 'South', marketTier: 'expansion_market' },
  { slug: 'trivandrum', name: 'Trivandrum', state: 'Kerala', region: 'South', marketTier: 'expansion_market' },
  { slug: 'kozhikode', name: 'Kozhikode', state: 'Kerala', region: 'South', marketTier: 'expansion_market' },
  { slug: 'mysuru', name: 'Mysuru', state: 'Karnataka', region: 'South', marketTier: 'expansion_market' },
  { slug: 'mangaluru', name: 'Mangaluru', state: 'Karnataka', region: 'South', marketTier: 'expansion_market' },
  { slug: 'vijayawada', name: 'Vijayawada', state: 'Andhra Pradesh', region: 'South', marketTier: 'expansion_market' },
  { slug: 'visakhapatnam', name: 'Visakhapatnam', state: 'Andhra Pradesh', region: 'South', marketTier: 'expansion_market' },
  { slug: 'tiruchirappalli', name: 'Tiruchirappalli', state: 'Tamil Nadu', region: 'South', marketTier: 'expansion_market' },
  { slug: 'salem', name: 'Salem', state: 'Tamil Nadu', region: 'South', marketTier: 'expansion_market' },
  { slug: 'warangal', name: 'Warangal', state: 'Telangana', region: 'South', marketTier: 'expansion_market' },
  { slug: 'guntur', name: 'Guntur', state: 'Andhra Pradesh', region: 'South', marketTier: 'expansion_market' },
  { slug: 'hubli-dharwad', name: 'Hubli-Dharwad', state: 'Karnataka', region: 'South', marketTier: 'expansion_market' },

  // West India (10 canonical event markets)
  { slug: 'mumbai', name: 'Mumbai', state: 'Maharashtra', region: 'West', marketTier: 'primary_market' },
  { slug: 'pune', name: 'Pune', state: 'Maharashtra', region: 'West', marketTier: 'primary_market' },
  { slug: 'ahmedabad', name: 'Ahmedabad', state: 'Gujarat', region: 'West', marketTier: 'primary_market' },
  { slug: 'goa', name: 'Goa / Panaji', state: 'Goa', region: 'West', marketTier: 'primary_market' },
  { slug: 'surat', name: 'Surat', state: 'Gujarat', region: 'West', marketTier: 'expansion_market' },
  { slug: 'vadodara', name: 'Vadodara', state: 'Gujarat', region: 'West', marketTier: 'expansion_market' },
  { slug: 'nagpur', name: 'Nagpur', state: 'Maharashtra', region: 'West', marketTier: 'expansion_market' },
  { slug: 'nashik', name: 'Nashik', state: 'Maharashtra', region: 'West', marketTier: 'expansion_market' },
  { slug: 'rajkot', name: 'Rajkot', state: 'Gujarat', region: 'West', marketTier: 'expansion_market' },
  { slug: 'kolhapur', name: 'Kolhapur', state: 'Maharashtra', region: 'West', marketTier: 'expansion_market' },

  // North India (13 canonical event markets)
  { slug: 'delhi-ncr', name: 'Delhi NCR', state: 'Delhi', region: 'North', marketTier: 'primary_market' },
  { slug: 'chandigarh', name: 'Chandigarh', state: 'Chandigarh', region: 'North', marketTier: 'primary_market' },
  { slug: 'jaipur', name: 'Jaipur', state: 'Rajasthan', region: 'North', marketTier: 'primary_market' },
  { slug: 'gurugram', name: 'Gurugram', state: 'Haryana', region: 'North', marketTier: 'expansion_market' },
  { slug: 'noida', name: 'Noida', state: 'Uttar Pradesh', region: 'North', marketTier: 'expansion_market' },
  { slug: 'lucknow', name: 'Lucknow', state: 'Uttar Pradesh', region: 'North', marketTier: 'expansion_market' },
  { slug: 'dehradun', name: 'Dehradun', state: 'Uttarakhand', region: 'North', marketTier: 'expansion_market' },
  { slug: 'amritsar', name: 'Amritsar', state: 'Punjab', region: 'North', marketTier: 'expansion_market' },
  { slug: 'ludhiana', name: 'Ludhiana', state: 'Punjab', region: 'North', marketTier: 'expansion_market' },
  { slug: 'jammu', name: 'Jammu', state: 'Jammu and Kashmir', region: 'North', marketTier: 'expansion_market' },
  { slug: 'agra', name: 'Agra', state: 'Uttar Pradesh', region: 'North', marketTier: 'expansion_market' },
  { slug: 'varanasi', name: 'Varanasi', state: 'Uttar Pradesh', region: 'North', marketTier: 'expansion_market' },
  { slug: 'kanpur', name: 'Kanpur', state: 'Uttar Pradesh', region: 'North', marketTier: 'expansion_market' },

  // East & Central India (8 canonical event markets)
  { slug: 'kolkata', name: 'Kolkata', state: 'West Bengal', region: 'East', marketTier: 'primary_market' },
  { slug: 'bhubaneswar', name: 'Bhubaneswar', state: 'Odisha', region: 'East', marketTier: 'expansion_market' },
  { slug: 'guwahati', name: 'Guwahati', state: 'Assam', region: 'East', marketTier: 'expansion_market' },
  { slug: 'patna', name: 'Patna', state: 'Bihar', region: 'East', marketTier: 'expansion_market' },
  { slug: 'ranchi', name: 'Ranchi', state: 'Jharkhand', region: 'East', marketTier: 'expansion_market' },
  { slug: 'raipur', name: 'Raipur', state: 'Chhattisgarh', region: 'Central', marketTier: 'expansion_market' },
  { slug: 'indore', name: 'Indore', state: 'Madhya Pradesh', region: 'Central', marketTier: 'expansion_market' },
  { slug: 'bhopal', name: 'Bhopal', state: 'Madhya Pradesh', region: 'Central', marketTier: 'expansion_market' }
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
  // A paid ticket is sold by SuperProfile only when provider is superprofile_link; UPI PhonePe checkout uses internal stock.
  const sellsOnSuperprofile = !free && Boolean(checkout?.available) && checkout?.provider === 'superprofile_link';
  const used = sellsOnSuperprofile ? 0 : Number(t.sold || 0) + Number(t.held || 0);
  const remaining = Math.max(0, t.quantity - used);
  let unavailable = null;
  if (remaining <= 0) {
    unavailable = Number(t.held || 0) > 0 ? 'Temporarily full — may reopen if a held spot is released' : 'Sold out';
  } else if (!free && !checkout?.available) {
    unavailable = 'Online payment not available yet (Paid ticket — external checkout not configured)';
  } else if (!free && requiresApproval) {
    unavailable = 'Paid tickets can’t be approval-only yet';
  } else if (t.sales_start_at && new Date(t.sales_start_at) > new Date()) {
    unavailable = 'Sales have not started yet';
  } else if (t.sales_end_at && new Date(t.sales_end_at) < new Date()) {
    unavailable = 'Sales have ended';
  }
  return {
    id: t.id,
    name: t.name,
    category: t.category || 'general',
    kind: t.kind,
    pricePaise: free ? 0 : t.price_paise,
    priceLabel: free ? 'Free' : formatPaise(t.price_paise),
    quantity: t.quantity,
    remaining,
    remainingLabel: showCounts && !sellsOnSuperprofile ? `${remaining} of ${t.quantity} left` : null,
    maxPerBooking: t.max_per_booking,
    minPerBooking: t.min_per_booking || 1,
    admitCount: t.admit_count || (t.category === 'couple' ? 2 : t.category === 'group' ? 4 : 1),
    validOn: t.valid_on ? String(t.valid_on).slice(0, 10) : null,
    sessionId: t.session_id || null,
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
    cityId: row.city_id || null,
    localityId: row.locality_id || null,
    area: row.area_public || '',
    venue: venuePublic ? (row.venue_private || '') : '',
    venueId: row.venue_id || null,
    venuePrivacy: row.venue_privacy,
    coordsProvenance: row.coords_provenance || (row.lat != null ? 'city' : 'none'),
    lat: venuePublic && row.coords_provenance === 'venue' && row.lat != null ? Number(row.lat) : null,
    lng: venuePublic && row.coords_provenance === 'venue' && row.lng != null ? Number(row.lng) : null,
    distanceKm: venuePublic ? (row.distance_km != null ? Math.round(Number(row.distance_km) * 10) / 10 : null) : null,
    distanceBand: formatDistanceBand(row.distance_km),
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
    checkoutAvailable: (row.payment_method === 'direct_upi' || (Boolean(row.organiser_upi_id) && Boolean(row.organiser_payee_name))) ? true : Boolean(checkout?.available),
    checkoutMode: (row.payment_method === 'direct_upi' || (Boolean(row.organiser_upi_id) && Boolean(row.organiser_payee_name))) ? 'upi_direct' : (sp ? (checkout.provider === 'phonepe' || checkout.provider === 'phonepe_sandbox' ? 'upi_direct' : 'superprofile') : (row.checkout_mode === 'upi_direct' ? 'upi_direct' : 'none')),
    checkoutPath: (row.payment_method === 'direct_upi' || (Boolean(row.organiser_upi_id) && Boolean(row.organiser_payee_name)) || sp || row.checkout_mode === 'upi_direct') ? `/checkout/${row.slug}` : null,
    paymentMethod: (row.payment_method === 'direct_upi' || (Boolean(row.organiser_upi_id) && Boolean(row.organiser_payee_name))) ? 'direct_upi' : (row.payment_method || 'free'),
    organiserUpiId: row.organiser_upi_id || null,
    organiserPayeeName: row.organiser_payee_name || null,
    paymentInstructions: row.payment_instructions || null,
    inclusions: arr(row.inclusions),
    exclusions: arr(row.exclusions),
    refundPolicy: row.refund_policy || '',
    cancellationPolicy: features.cancellationPolicy || (row.refund_policy ? resolveCancellationPolicy({ refundPolicy: row.refund_policy }).snapshot : null),
    schedule: features.schedule || null,
    genderPolicy: row.gender_policy || '',
    foodAvailable: row.food_available,
    stayAvailable: row.stay_available,
    organizer: row.organizer || (external ? row.source_name : 'NIGHTLIFEZ'),
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
      'max_per_booking', t.max_per_booking, 'min_per_booking', COALESCE(t.min_per_booking, 1),
      'admit_count', COALESCE(t.admit_count, 1), 'category', COALESCE(t.category, 'general'),
      'valid_on', t.valid_on, 'session_id', t.session_id, 'eligibility', t.eligibility,
      'sales_start_at', t.sales_start_at, 'sales_end_at', t.sales_end_at,
      'sold', (SELECT COALESCE(sum(b.quantity), 0) FROM bookings b WHERE b.ticket_type_id = t.id AND b.status IN ('confirmed', 'checked_in')),
      'held', (SELECT COALESCE(sum(b.quantity), 0) FROM bookings b WHERE b.ticket_type_id = t.id AND b.status = 'pending_payment' AND b.hold_expires_at > now())
    ) ORDER BY t.sort_order), '[]'::json) FROM ticket_types t WHERE t.event_id = e.id AND t.active)`;

const PUBLIC_SELECT = `
  SELECT e.*,
         (SELECT COALESCE(sum(b.quantity * COALESCE(b.admit_count, 1)), 0)::int FROM bookings b WHERE b.event_id = e.id AND ${SEAT_HOLDING_SQL}) AS seats_taken,
         (SELECT m.url FROM media m WHERE m.id = e.cover_media_id AND m.authorized_by_owner AND m.visible) AS cover_url,
         ${TIERS_SQL} AS tiers
    FROM events e`;

const PUBLIC_EVENT_CACHE = new Map();
const PUBLIC_CACHE_TTL_MS = (process.env.NODE_ENV === 'test' || process.env.TEST_DATABASE_URL) ? 0 : 30_000;
const MAX_CACHE_ENTRIES = 200;

export function invalidatePublicEventCache() {
  PUBLIC_EVENT_CACHE.clear();
}

export async function listPublicEvents(opts = {}) {
  const cacheKey = JSON.stringify(opts);
  const cached = PUBLIC_EVENT_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < PUBLIC_CACHE_TTL_MS) {
    return cached.data;
  }
  const { city, category, categories, kind = 'all', from, to, q, limit = 60 } = opts;
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
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    where.push(`(e.title ILIKE ${p(term)} OR e.summary ILIKE ${p(term)} OR e.description ILIKE ${p(term)} OR e.city ILIKE ${p(term)} OR e.area_public ILIKE ${p(term)})`);
  }
  const { rows } = await db.query(
    `${PUBLIC_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.is_demo ASC, e.start_at ASC LIMIT ${p(Math.min(limit, 100))}`,
    params
  );
  const data = rows.map(toPublicEvent);
  if (PUBLIC_EVENT_CACHE.size >= MAX_CACHE_ENTRIES) {
    const firstKey = PUBLIC_EVENT_CACHE.keys().next().value;
    PUBLIC_EVENT_CACHE.delete(firstKey);
  }
  PUBLIC_EVENT_CACHE.set(cacheKey, { ts: Date.now(), data });
  return data;
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
