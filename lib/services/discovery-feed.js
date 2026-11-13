// lib/services/discovery-feed.js - Attendee Discovery Feed, Ranking & Personalised Recommendations.
// Combines transparent recommendation factors, trending signals, location intelligence, and multi-facet filtering.
import { db } from '../db.js';
import {
  listPublicEvents, toPublicEvent, CATEGORY_LABELS, CITIES,
  SEAT_HOLDING_SQL, TIERS_SQL, formatDistanceBand
} from './events.js';
import { findNearbyEvents, haversineKm } from './locations.js';
import { listSavedEventIds } from './saved-events.js';

export { CATEGORY_LABELS, CITIES };

/** Canonical category groupings for consumer discovery */
export const DISCOVERY_COLLECTIONS = [
  { key: 'nightlife', label: 'Nightlife & Parties', categories: ['nightlife', 'weekend_party'], icon: '🍸' },
  { key: 'dinners', label: 'Dinner Clubs & Food', categories: ['dinner_club'], icon: '🍷' },
  { key: 'social', label: 'Social Mixers & Dating', categories: ['meetup', 'dating_mixer', 'matchmaking'], icon: '❤️' },
  { key: 'activities', label: 'Games, Movies & Activities', categories: ['board_games', 'movie', 'workshop'], icon: '🎲' },
  { key: 'trips', label: 'Trips & Getaways', categories: ['weekend_trip', 'resort_getaway'], icon: '🎒' },
  { key: 'community', label: 'Founders & Community', categories: ['networking'], icon: '💼' }
];

/**
 * Compute date boundaries for 'when' filter in IST (UTC+5:30).
 */
export function parseDateFilter(when) {
  if (!when) return {};
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  const startOfDay = (d) => {
    const s = new Date(d);
    s.setUTCHours(0, 0, 0, 0);
    return new Date(s.getTime() - istOffset);
  };
  const endOfDay = (d) => {
    const e = new Date(d);
    e.setUTCHours(23, 59, 59, 999);
    return new Date(e.getTime() - istOffset);
  };

  if (when === 'today') {
    return { from: now.toISOString(), to: endOfDay(istNow).toISOString() };
  }
  if (when === 'tomorrow') {
    const tmrw = new Date(istNow);
    tmrw.setUTCDate(tmrw.getUTCDate() + 1);
    return { from: startOfDay(tmrw).toISOString(), to: endOfDay(tmrw).toISOString() };
  }
  if (when === 'weekend' || when === 'this_weekend') {
    // Find next Friday/Saturday/Sunday
    const day = istNow.getUTCDay(); // 0 is Sunday, 5 is Friday, 6 is Saturday
    const fri = new Date(istNow);
    const daysUntilFri = (5 - day + 7) % 7;
    fri.setUTCDate(fri.getUTCDate() + daysUntilFri);
    const sun = new Date(fri);
    sun.setUTCDate(sun.getUTCDate() + 2);
    return { from: startOfDay(fri).toISOString(), to: endOfDay(sun).toISOString() };
  }
  if (when === 'week' || when === 'next_7_days') {
    const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { from: now.toISOString(), to: in7.toISOString() };
  }
  if (when === 'month' || when === 'this_month') {
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return { from: now.toISOString(), to: in30.toISOString() };
  }
  return {};
}

/**
 * Retrieve user recommendation context based on:
 * 1. User's voluntary profile (city, interests)
 * 2. Categories of previously attended events
 * 3. Categories of explicitly saved/bookmarked events
 */
export async function getUserRecommendationContext(userId, c = db) {
  if (!userId) return null;

  const [userRow, attendedCats, savedCats, savedIds] = await Promise.all([
    c.one(`SELECT city, interests FROM users WHERE id = $1`, [userId]).catch(() => null),
    c.query(
      `SELECT DISTINCT e.category
         FROM bookings b
         JOIN events e ON e.id = b.event_id
        WHERE b.user_id = $1 AND b.status IN ('confirmed', 'checked_in')
        LIMIT 10`,
      [userId]
    ).catch(() => ({ rows: [] })),
    c.query(
      `SELECT DISTINCT e.category
         FROM saved_events s
         JOIN events e ON e.id = s.event_id
        WHERE s.user_id = $1
        LIMIT 10`,
      [userId]
    ).catch(() => ({ rows: [] })),
    listSavedEventIds(userId, c).catch(() => [])
  ]);

  const preferredCity = userRow?.city || null;
  const profileInterests = Array.isArray(userRow?.interests) ? userRow.interests : [];
  const attendedCategories = attendedCats.rows.map((r) => r.category);
  const savedCategories = savedCats.rows.map((r) => r.category);

  return {
    preferredCity,
    profileInterests,
    attendedCategories,
    savedCategories,
    savedEventIds: new Set(savedIds)
  };
}

/**
 * Calculate transparent recommendation score and reason for an event.
 */
export function scoreEventRecommendation(event, userContext, targetCity = null) {
  let score = 0;
  const reasons = [];

  // Trending signal: proportion of capacity booked or high confirmed seats
  const seats = Number(event.seats_taken || 0);
  const cap = Number(event.capacity || 0);
  if (cap > 0 && seats >= Math.min(3, Math.floor(cap * 0.4))) {
    score += 20;
    reasons.push('Popular in ' + event.city);
  }

  // Starts soon (within 5 days): recency boost
  const hoursUntil = (new Date(event.start_at).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil > 0 && hoursUntil < 120) {
    score += 15;
  }

  if (userContext) {
    // City preference match
    if (userContext.preferredCity && event.city &&
        event.city.toLowerCase() === userContext.preferredCity.toLowerCase()) {
      score += 40;
      reasons.push('In your preferred city (' + userContext.preferredCity + ')');
    }

    // Profile interests match
    if (userContext.profileInterests && userContext.profileInterests.includes(event.category)) {
      score += 30;
      reasons.push('Matches your interest in ' + (CATEGORY_LABELS[event.category] || event.category));
    }

    // Previously booked categories match
    if (userContext.attendedCategories && userContext.attendedCategories.includes(event.category)) {
      score += 25;
      reasons.push('Similar to events you joined');
    }

    // Saved categories match
    if (userContext.savedCategories && userContext.savedCategories.includes(event.category)) {
      score += 15;
      reasons.push('Based on your saved events');
    }
  } else if (targetCity && event.city && event.city.toLowerCase() === targetCity.toLowerCase()) {
    score += 30;
    reasons.push('Upcoming in ' + event.city);
  }

  return {
    score,
    reason: reasons[0] || (event.city ? 'Upcoming experience in ' + event.city : 'Upcoming experience')
  };
}

/**
 * Core Attendee Discovery Feed builder.
 */
export async function getDiscoveryFeed({
  userId = null,
  city = null,
  lat = null,
  lng = null,
  radiusKm = 50,
  category = null,
  categories = null,
  when = null,
  price = null,
  q = null,
  sort = 'recommended',
  limit = 50,
  offset = 0
} = {}, c = db) {
  const userContext = await getUserRecommendationContext(userId, c);
  const range = parseDateFilter(when);

  // Normalize city input: slug or full name
  let targetCityName = null;
  let targetCitySlug = null;
  if (city) {
    const found = CITIES.find((x) => x.slug === city.toLowerCase() || x.name.toLowerCase() === city.toLowerCase());
    if (found) {
      targetCityName = found.name;
      targetCitySlug = found.slug;
    } else {
      targetCityName = city;
    }
  } else if (userContext?.preferredCity) {
    const found = CITIES.find((x) => x.name.toLowerCase() === userContext.preferredCity.toLowerCase());
    if (found) {
      targetCityName = found.name;
      targetCitySlug = found.slug;
    }
  }

  // Handle coordinates if provided and valid
  let rawEvents = [];
  const hasCoords = lat != null && lng != null &&
    !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng)) &&
    Number(lat) >= -90 && Number(lat) <= 90 &&
    Number(lng) >= -180 && Number(lng) <= 180;

  if (hasCoords) {
    rawEvents = await findNearbyEvents({
      lat: Number(lat),
      lng: Number(lng),
      radiusKm: Number(radiusKm) || 50,
      citySlug: targetCitySlug,
      category: category || undefined,
      limit: 100,
      includeUnlocated: true
    }, c);
  } else {
    rawEvents = await listPublicEvents({
      city: targetCityName,
      category: category || undefined,
      categories: categories || undefined,
      from: range.from,
      to: range.to,
      q,
      limit: 100
    });
  }

  // Filter by price if requested ('free', 'paid')
  let filtered = rawEvents;
  if (price === 'free') {
    filtered = filtered.filter((e) => {
      if (e.ticketing === 'tiers') return e.tiers && e.tiers.some((t) => t.kind === 'free' && t.available);
      return e.pricePaise === 0 || e.priceLabel === 'Free';
    });
  } else if (price === 'paid') {
    filtered = filtered.filter((e) => {
      if (e.ticketing === 'tiers') return e.tiers && e.tiers.some((t) => t.kind === 'paid');
      return e.pricePaise && e.pricePaise > 0;
    });
  }

  // Apply distance filter if coordinates provided
  if (hasCoords && radiusKm) {
    const maxR = Number(radiusKm);
    filtered = filtered.filter((e) => {
      if (e.lat == null || e.lng == null) return true; // keep city-level unlocated
      const d = haversineKm(lat, lng, e.lat, e.lng);
      return d == null || d <= maxR;
    });
  }

  // Decorate each event with saved status and recommendation scoring
  const decorated = filtered.map((e) => {
    const isSaved = userContext?.savedEventIds?.has(e.id) || false;
    const { score, reason } = scoreEventRecommendation(e, userContext, targetCityName);
    return {
      ...e,
      isSaved,
      recommendationScore: score,
      recommendationReason: reason
    };
  });

  // Sorting
  if (sort === 'recommended') {
    decorated.sort((a, b) => b.recommendationScore - a.recommendationScore || new Date(a.startAt) - new Date(b.startAt));
  } else if (sort === 'trending') {
    decorated.sort((a, b) => (Number(b.seats_taken || 0)) - (Number(a.seats_taken || 0)) || new Date(a.startAt) - new Date(b.startAt));
  } else if (sort === 'date_asc') {
    decorated.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  } else if (sort === 'date_desc') {
    decorated.sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  } else if (sort === 'price_low') {
    const getPrice = (ev) => {
      if (ev.ticketing === 'tiers' && ev.tiers?.length) {
        const prices = ev.tiers.map((t) => (t.kind === 'free' ? 0 : t.pricePaise || 999999));
        return Math.min(...prices);
      }
      return ev.pricePaise != null ? ev.pricePaise : 999999;
    };
    decorated.sort((a, b) => getPrice(a) - getPrice(b));
  }

  // Derive modules: Trending, Featured, and Recommended
  const trending = decorated.slice(0, 6);
  const featured = decorated.filter((e) => e.coverUrl || e.isTrip).slice(0, 6);
  const recommended = decorated.filter((e) => e.recommendationScore >= 30).slice(0, 8);

  const paginated = decorated.slice(offset, offset + limit);

  return {
    ok: true,
    total: decorated.length,
    events: paginated,
    featured: featured.length ? featured : paginated.slice(0, 4),
    trending: trending.length ? trending : paginated.slice(0, 4),
    recommended: recommended.length ? recommended : paginated.slice(0, 4),
    collections: DISCOVERY_COLLECTIONS,
    filter: {
      city: targetCitySlug || '',
      cityName: targetCityName || '',
      category: category || '',
      when: when || '',
      price: price || '',
      q: q || '',
      lat: hasCoords ? Number(lat) : null,
      lng: hasCoords ? Number(lng) : null,
      radiusKm: Number(radiusKm) || 50,
      sort
    },
    userContext: userContext ? {
      preferredCity: userContext.preferredCity,
      hasInterests: userContext.profileInterests.length > 0,
      savedCount: userContext.savedEventIds.size
    } : null
  };
}
