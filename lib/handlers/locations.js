// lib/handlers/locations.js - HTTP API endpoints for Location Intelligence and nearby event discovery.
import { sendJson, HttpError, PUBLIC_CACHE } from '../http.js';
import {
  listStates,
  listDistricts,
  listCities,
  getCityBySlug,
  listLocalities,
  findNearbyEvents
} from '../services/locations.js';

export async function listStatesHandler({ req, res, query }) {
  const type = query.get('type') || null;
  const states = await listStates({ type, activeOnly: true });
  sendJson(res, 200, { ok: true, count: states.length, states }, { 'Cache-Control': PUBLIC_CACHE || 'public, max-age=3600' });
}

export async function listDistrictsHandler({ req, res, query }) {
  const stateId = query.get('state_id') || null;
  const stateLgdCode = query.get('state_lgd_code') ? Number(query.get('state_lgd_code')) : null;
  const districts = await listDistricts({ stateId, stateLgdCode, activeOnly: true });
  sendJson(res, 200, { ok: true, count: districts.length, districts }, { 'Cache-Control': PUBLIC_CACHE || 'public, max-age=3600' });
}

export async function listCitiesHandler({ req, res, query }) {
  const q = query.get('q') || null;
  const stateId = query.get('state_id') || null;
  const districtId = query.get('district_id') || null;
  const discoveryOnly = query.get('discovery_only') === 'true';

  const cities = await listCities({
    activeOnly: true,
    discoveryOnly,
    stateId,
    districtId,
    q
  });
  sendJson(res, 200, { ok: true, count: cities.length, cities }, { 'Cache-Control': 'public, max-age=600' });
}

export async function getCityHandler({ req, res, params }) {
  const city = await getCityBySlug(params.slug);
  if (!city) {
    throw new HttpError(404, 'city_not_found', 'City not found in official directory');
  }
  sendJson(res, 200, { ok: true, city }, { 'Cache-Control': PUBLIC_CACHE || 'public, max-age=3600' });
}

export async function listLocalitiesHandler({ req, res, query }) {
  const cityId = query.get('city_id') || null;
  const citySlug = query.get('city_slug') || null;
  const localities = await listLocalities({ cityId, citySlug, activeOnly: true });
  sendJson(res, 200, { ok: true, count: localities.length, localities }, { 'Cache-Control': PUBLIC_CACHE || 'public, max-age=600' });
}

export async function nearbyEventsHandler({ req, res, query }) {
  const latStr = query.get('lat');
  const lngStr = query.get('lng');
  const radiusStr = query.get('radius_km');
  const citySlug = query.get('city');
  const category = query.get('category');
  const limitStr = query.get('limit');
  const offsetStr = query.get('offset');

  let lat = null;
  let lng = null;
  if (latStr !== null && lngStr !== null) {
    lat = Number(latStr);
    lng = Number(lngStr);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      throw new HttpError(400, 'invalid_latitude', 'lat must be a valid number between -90 and 90');
    }
    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      throw new HttpError(400, 'invalid_longitude', 'lng must be a valid number between -180 and 180');
    }
  }

  if (lat == null && !citySlug) {
    throw new HttpError(400, 'missing_location', 'Provide either lat and lng coordinates, or a city slug');
  }

  const radiusKm = radiusStr ? Number(radiusStr) : 50;
  if (Number.isNaN(radiusKm) || radiusKm <= 0 || radiusKm > 500) {
    throw new HttpError(400, 'invalid_radius', 'radius_km must be a number between 1 and 500');
  }

  const limit = limitStr ? Math.min(100, Math.max(1, Number(limitStr))) : 20;
  const offset = offsetStr ? Math.max(0, Number(offsetStr)) : 0;

  const events = await findNearbyEvents({
    lat,
    lng,
    radiusKm,
    citySlug,
    category,
    limit,
    offset,
    includeUnlocated: Boolean(citySlug)
  });

  sendJson(res, 200, {
    ok: true,
    count: events.length,
    radiusKm,
    events
  });
}
