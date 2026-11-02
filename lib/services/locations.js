// lib/services/locations.js - India Location Intelligence Foundation based on official Local Government Directory (LGD).
// Provides state/district/city/locality queries, alias matching, and geospatial nearby event discovery.
import { db } from '../db.js';
import { SEAT_HOLDING_SQL, TIERS_SQL, toPublicEvent } from './events.js';

/**
 * Pure JS Haversine distance in kilometers (mean Earth radius 6371 km).
 * Matches PostgreSQL haversine_km() function from migration 013.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const numLat1 = Number(lat1);
  const numLng1 = Number(lng1);
  const numLat2 = Number(lat2);
  const numLng2 = Number(lng2);
  if (Number.isNaN(numLat1) || Number.isNaN(numLng1) || Number.isNaN(numLat2) || Number.isNaN(numLng2)) return null;

  const R = 6371.0;
  const dLat = (numLat2 - numLat1) * (Math.PI / 180.0);
  const dLng = (numLng2 - numLng1) * (Math.PI / 180.0);
  const a = (Math.sin(dLat / 2.0) ** 2) +
    Math.cos(numLat1 * (Math.PI / 180.0)) * Math.cos(numLat2 * (Math.PI / 180.0)) *
    (Math.sin(dLng / 2.0) ** 2);
  const clamped = Math.min(1.0, Math.max(0.0, a));
  const c = 2.0 * Math.asin(Math.sqrt(clamped));
  return R * c;
}

/**
 * List official States and Union Territories with verified LGD codes.
 */
export async function listStates({ activeOnly = true, type = null } = {}, c = db) {
  const conditions = [];
  const params = [];
  if (activeOnly) {
    conditions.push('active = true');
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await c.query(
    `SELECT id, country_code, lgd_code, name, type, state_code, active, source_url, source_date, verified
       FROM location_states
      ${where}
      ORDER BY name ASC`, params);
  return rows;
}

/**
 * List official Districts for a State (initial focus: TN, PY, KA, KL) with official LGD codes.
 */
export async function listDistricts({ stateId = null, stateLgdCode = null, activeOnly = true } = {}, c = db) {
  const conditions = [];
  const params = [];
  if (activeOnly) {
    conditions.push('d.active = true');
  }
  if (stateId) {
    params.push(stateId);
    conditions.push(`d.state_id = $${params.length}`);
  }
  if (stateLgdCode) {
    params.push(stateLgdCode);
    conditions.push(`d.state_lgd_code = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await c.query(
    `SELECT d.id, d.state_id, d.state_lgd_code, d.lgd_code, d.name, d.census_2011_code, d.active,
            d.source_url, d.source_date, d.verified, s.name AS state_name
       FROM location_districts d
       JOIN location_states s ON s.id = d.state_id
      ${where}
      ORDER BY d.name ASC`, params);
  return rows;
}

/**
 * List cities/towns with coordinates, aliases, LGD mapping, and NIGHTLIFEZ business market tier.
 * Supports query matching against name, slug, local_name, and aliases.
 */
export async function listCities({
  activeOnly = true,
  discoveryOnly = false,
  stateId = null,
  districtId = null,
  q = null
} = {}, c = db) {
  const conditions = [];
  const params = [];
  if (activeOnly) conditions.push('c.active = true');
  if (discoveryOnly) conditions.push('c.is_discovery_active = true');
  if (stateId) {
    params.push(stateId);
    conditions.push(`c.state_id = $${params.length}`);
  }
  if (districtId) {
    params.push(districtId);
    conditions.push(`c.district_id = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    const pIdx = params.length;
    conditions.push(`(
      c.name ILIKE $${pIdx}
      OR c.slug ILIKE $${pIdx}
      OR (c.local_name IS NOT NULL AND c.local_name ILIKE $${pIdx})
      OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE a ILIKE $${pIdx})
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await c.query(
    `SELECT c.id, c.slug, c.name, c.local_name, c.lgd_code, c.lat, c.lng, c.aliases, c.market_tier,
            c.active, c.is_discovery_active, c.source_url, c.source_date, c.verified,
            s.name AS state_name, s.state_code, s.lgd_code AS state_lgd_code,
            d.name AS district_name, d.lgd_code AS district_lgd_code
       FROM location_cities c
       JOIN location_states s ON s.id = c.state_id
       LEFT JOIN location_districts d ON d.id = c.district_id
      ${where}
      ORDER BY
        CASE c.market_tier
          WHEN 'primary_market' THEN 1
          WHEN 'expansion_market' THEN 2
          WHEN 'getaway_destination' THEN 3
          ELSE 4
        END,
        c.name ASC`, params);
  return rows;
}

/**
 * Fetch a single city by slug, name, or alias.
 */
export async function getCityBySlug(slug, c = db) {
  if (!slug || typeof slug !== 'string') return null;
  const term = slug.trim();
  const row = await c.one(
    `SELECT c.id, c.slug, c.name, c.local_name, c.lgd_code, c.lat, c.lng, c.aliases, c.market_tier,
            c.active, c.is_discovery_active, c.source_url, c.source_date, c.verified,
            s.name AS state_name, s.state_code, s.lgd_code AS state_lgd_code,
            d.name AS district_name, d.lgd_code AS district_lgd_code
       FROM location_cities c
       JOIN location_states s ON s.id = c.state_id
       LEFT JOIN location_districts d ON d.id = c.district_id
      WHERE lower(c.slug) = lower($1)
         OR lower(c.name) = lower($1)
         OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE lower(a) = lower($1))
      LIMIT 1`, [term]);
  return row;
}

/**
 * List localities for a city (e.g. Indiranagar, Koramangala in Bengaluru).
 */
export async function listLocalities({ cityId = null, citySlug = null, activeOnly = true } = {}, c = db) {
  const conditions = [];
  const params = [];
  if (activeOnly) conditions.push('l.active = true');
  if (cityId) {
    params.push(cityId);
    conditions.push(`l.city_id = $${params.length}`);
  }
  if (citySlug) {
    params.push(citySlug);
    conditions.push(`c.slug = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await c.query(
    `SELECT l.id, l.city_id, l.slug, l.name, l.postal_code, l.lat, l.lng, l.aliases, l.active, l.verified,
            c.name AS city_name, c.slug AS city_slug
       FROM location_localities l
       JOIN location_cities c ON c.id = l.city_id
      ${where}
      ORDER BY l.name ASC`, params);
  return rows;
}

/**
 * Discover nearby events within radiusKm using Haversine distance.
 * Preserves privacy: never exposes secret private venue details on public search.
 * Handles events without coordinates safely.
 */
export async function findNearbyEvents({
  lat = null,
  lng = null,
  radiusKm = 50,
  citySlug = null,
  category = null,
  categories = null,
  kind = 'all',
  limit = 20,
  offset = 0,
  includeUnlocated = false
} = {}, c = db) {
  const hasCoords = lat != null && lng != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng));
  const numLat = hasCoords ? Number(lat) : null;
  const numLng = hasCoords ? Number(lng) : null;
  const numRadius = Math.max(1, Math.min(500, Number(radiusKm) || 50));
  const numLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const numOffset = Math.max(0, Number(offset) || 0);

  const where = [`e.status = 'published'`, `COALESCE(e.end_at, e.start_at) > now()`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  let distanceExpr = 'NULL::DOUBLE PRECISION';
  if (hasCoords) {
    const latParam = p(numLat);
    const lngParam = p(numLng);
    distanceExpr = `haversine_km(${latParam}, ${lngParam}, e.lat, e.lng)`;

    if (citySlug && includeUnlocated) {
      // Within radius OR located in the specified city (even if unlocated)
      const radParam = p(numRadius);
      const cityParam = p(citySlug);
      where.push(`(
        (${distanceExpr} <= ${radParam})
        OR (e.lat IS NULL AND (
          lower(e.city) = lower(${cityParam})
          OR EXISTS (SELECT 1 FROM location_cities lc WHERE lc.id = e.city_id AND lower(lc.slug) = lower(${cityParam}))
        ))
      )`);
    } else {
      const radParam = p(numRadius);
      where.push(`${distanceExpr} <= ${radParam}`);
    }
  } else if (citySlug) {
    const cityParam = p(citySlug);
    where.push(`(
      lower(e.city) = lower(${cityParam})
      OR EXISTS (SELECT 1 FROM location_cities lc WHERE lc.id = e.city_id AND (lower(lc.slug) = lower(${cityParam}) OR lower(lc.name) = lower(${cityParam})))
    )`);
  }

  if (category) where.push(`e.category = ${p(category)}`);
  if (categories?.length) where.push(`e.category::text = ANY(${p(categories)})`);
  if (kind === 'events') where.push(`e.category NOT IN ('weekend_trip', 'resort_getaway')`);
  if (kind === 'trips') where.push(`e.category IN ('weekend_trip', 'resort_getaway')`);

  const limitParam = p(numLimit);
  const offsetParam = p(numOffset);

  const querySql = `
    SELECT e.*,
           ${distanceExpr} AS distance_km,
           (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.event_id = e.id AND ${SEAT_HOLDING_SQL}) AS seats_taken,
           (SELECT m.url FROM media m WHERE m.id = e.cover_media_id AND m.authorized_by_owner AND m.visible) AS cover_url,
           ${TIERS_SQL} AS tiers
      FROM events e
     WHERE ${where.join(' AND ')}
     ORDER BY
       ${hasCoords ? 'distance_km ASC NULLS LAST,' : ''}
       e.is_demo ASC,
       e.start_at ASC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const { rows } = await c.query(querySql, params);
  return rows.map((r) => toPublicEvent(r));
}
