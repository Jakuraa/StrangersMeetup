// test/locations.test.js - Comprehensive test suite for India Location Intelligence V1.
// Tests: LGD states, districts, cities, aliases, market tiers, Haversine distance,
// nearby event discovery, privacy preservation, and location picker HTTP endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, db, Client, createEvent, signedInClient } from './helpers.js';
import {
  haversineKm,
  listStates,
  listDistricts,
  listCities,
  getCityBySlug,
  listLocalities,
  findNearbyEvents,
  resolveCity,
  formatDistanceBand
} from '../lib/services/locations.js';

let http;

before(async () => {
  await resetDb();
  await startServer();
  http = new Client();
});
after(stopServer);

test('1. Location Intelligence Foundation: 36 States and Union Territories', async () => {
  const states = await listStates();
  assert.equal(states.length, 36, 'All 28 states and 8 UTs must be seeded');

  const statesOnly = states.filter((s) => s.type === 'state');
  const utsOnly = states.filter((s) => s.type === 'union_territory');
  assert.equal(statesOnly.length, 28, 'Must have exactly 28 states');
  assert.equal(utsOnly.length, 8, 'Must have exactly 8 union territories');

  // LGD codes must be unique integers
  const lgdCodes = new Set(states.map((s) => s.lgd_code));
  assert.equal(lgdCodes.size, 36, 'Every state/UT must have a unique LGD code');

  // Verify key states have exact official LGD codes
  const tn = states.find((s) => s.state_code === 'TN');
  const ka = states.find((s) => s.state_code === 'KA');
  const kl = states.find((s) => s.state_code === 'KL');
  const py = states.find((s) => s.state_code === 'PY');
  const dl = states.find((s) => s.state_code === 'DL');
  const mh = states.find((s) => s.state_code === 'MH');

  assert.equal(tn?.lgd_code, 33, 'Tamil Nadu LGD code must be 33');
  assert.equal(ka?.lgd_code, 29, 'Karnataka LGD code must be 29');
  assert.equal(kl?.lgd_code, 32, 'Kerala LGD code must be 32');
  assert.equal(py?.lgd_code, 34, 'Puducherry LGD code must be 34');
  assert.equal(dl?.lgd_code, 7, 'Delhi LGD code must be 7');
  assert.equal(mh?.lgd_code, 27, 'Maharashtra LGD code must be 27');

  // Metadata verification
  assert.ok(tn.verified, 'Official LGD record must be marked verified');
  assert.equal(tn.source_url, 'https://lgdirectory.gov.in/');
});

test('2. Official Districts: 87 districts across TN, KA, KL, PY with official LGD codes', async () => {
  const allDistricts = await listDistricts();
  assert.equal(allDistricts.length, 87, 'Must have 87 districts across TN, KA, KL, PY');

  const tnDistricts = await listDistricts({ stateLgdCode: 33 });
  const kaDistricts = await listDistricts({ stateLgdCode: 29 });
  const klDistricts = await listDistricts({ stateLgdCode: 32 });
  const pyDistricts = await listDistricts({ stateLgdCode: 34 });

  assert.equal(tnDistricts.length, 38, 'Tamil Nadu must have 38 districts');
  assert.equal(kaDistricts.length, 31, 'Karnataka must have 31 districts');
  assert.equal(klDistricts.length, 14, 'Kerala must have 14 districts');
  assert.equal(pyDistricts.length, 4, 'Puducherry must have 4 districts');

  // All 87 district LGD codes must be distinct and non-null
  const distCodes = new Set(allDistricts.map((d) => d.lgd_code));
  assert.equal(distCodes.size, 87, 'Every district LGD code must be globally unique');

  // Spot-check verified LGD district codes
  const chennai = tnDistricts.find((d) => d.name === 'Chennai');
  const coimbatore = tnDistricts.find((d) => d.name === 'Coimbatore');
  const blrUrban = kaDistricts.find((d) => d.name === 'Bengaluru Urban');
  const mysuru = kaDistricts.find((d) => d.name === 'Mysuru');
  const ernakulam = klDistricts.find((d) => d.name === 'Ernakulam');
  const pondy = pyDistricts.find((d) => d.name === 'Puducherry');

  assert.equal(chennai?.lgd_code, 568);
  assert.equal(coimbatore?.lgd_code, 569);
  assert.equal(blrUrban?.lgd_code, 525);
  assert.equal(mysuru?.lgd_code, 545);
  assert.equal(ernakulam?.lgd_code, 555);
  assert.equal(pondy?.lgd_code, 600);
});

test('3. Active Cities and Towns: Market tiers, aliases, and discovery', async () => {
  const cities = await listCities();
  assert.equal(cities.length, 19, 'Must seed 19 active discovery cities');

  // Business Market Tiers (distinct from administrative tiers)
  const primary = cities.filter((c) => c.market_tier === 'primary_market');
  const expansion = cities.filter((c) => c.market_tier === 'expansion_market');
  const getaway = cities.filter((c) => c.market_tier === 'getaway_destination');

  assert.equal(primary.length, 5, 'Primary markets: Chennai, Bengaluru, Coimbatore, Kochi, Puducherry');
  assert.equal(expansion.length, 7, 'Expansion markets: Mysuru, Mangaluru, Madurai, Salem, Trichy, Trivandrum, Kozhikode');
  assert.equal(getaway.length, 7, 'Getaway destinations: Ooty, Kodaikanal, Coorg, Gokarna, Chikmagalur, Varkala, Wayanad');

  // All coordinates must be valid numbers within India latitude/longitude bounds
  for (const c of cities) {
    assert.ok(c.lat >= 8.0 && c.lat <= 16.0, `${c.name} lat (${c.lat}) must be in South India bounds`);
    assert.ok(c.lng >= 74.0 && c.lng <= 81.0, `${c.name} lng (${c.lng}) must be in South India bounds`);
  }

  // Alias matching: 'Bangalore' -> Bengaluru, 'Kovai' -> Coimbatore, 'Madras' -> Chennai
  const matchedBlr = await listCities({ q: 'Bangalore' });
  assert.equal(matchedBlr.length, 1);
  assert.equal(matchedBlr[0].slug, 'bengaluru');

  const matchedCbe = await listCities({ q: 'Kovai' });
  assert.equal(matchedCbe.length, 1);
  assert.equal(matchedCbe[0].slug, 'coimbatore');

  const matchedMaa = await listCities({ q: 'Madras' });
  assert.equal(matchedMaa.length, 1);
  assert.equal(matchedMaa[0].slug, 'chennai');

  const matchedTrichy = await listCities({ q: 'Trichy' });
  assert.equal(matchedTrichy.length, 1);
  assert.equal(matchedTrichy[0].slug, 'tiruchirappalli');

  // getCityBySlug supports alias lookup as well
  const cityByAlias = await getCityBySlug('Kudla');
  assert.equal(cityByAlias?.slug, 'mangaluru');
});

test('4. Localities: Seeding and retrieval', async () => {
  const localities = await listLocalities({ citySlug: 'bengaluru' });
  assert.ok(localities.length >= 5, 'Bengaluru must have at least 5 core localities');

  const indiranagar = localities.find((l) => l.slug === 'indiranagar');
  assert.ok(indiranagar);
  assert.equal(indiranagar.postal_code, '560038');
  assert.ok(indiranagar.aliases.includes('100ft Road'));
});

test('5. Haversine Distance: Accuracy and null handling (JS & Postgres)', async () => {
  // Bengaluru (12.9716, 77.5946) to Chennai (13.0827, 80.2707)
  const jsDist = haversineKm(12.9716, 77.5946, 13.0827, 80.2707);
  assert.ok(jsDist >= 288 && jsDist <= 292, `Distance should be ~290 km, got ${jsDist}`);

  const dbDistRow = await db.one('SELECT haversine_km(12.9716, 77.5946, 13.0827, 80.2707) AS dist');
  assert.ok(Math.abs(dbDistRow.dist - jsDist) < 0.01, 'JS and Postgres Haversine must match within 0.01 km');

  // Bengaluru to Mysuru (~128 km)
  const blrToMys = haversineKm(12.9716, 77.5946, 12.2958, 76.6394);
  assert.ok(blrToMys >= 125 && blrToMys <= 132, `Distance should be ~128 km, got ${blrToMys}`);

  // Null coordinate handling: must return null, never throw or return 0
  assert.equal(haversineKm(null, 77.59, 13.08, 80.27), null);
  assert.equal(haversineKm(12.97, null, 13.08, 80.27), null);
  assert.equal(haversineKm(12.97, 77.59, null, 80.27), null);
  assert.equal(haversineKm(12.97, 77.59, 13.08, null), null);

  const dbNullRow = await db.one('SELECT haversine_km(NULL, 77.59, 13.08, 80.27) AS dist');
  assert.equal(dbNullRow.dist, null);
});

test('6. Nearby Event Discovery: Radius filtering and ordering', async () => {
  // Create 3 published events:
  // 1. Bengaluru event (coords 12.9716, 77.5946)
  // 2. Mysuru event (coords 12.2958, 76.6394) - ~128km from Bengaluru
  // 3. Chennai event (coords 13.0827, 80.2707) - ~290km from Bengaluru
  const blrCity = await db.one(`SELECT id FROM location_cities WHERE slug = 'bengaluru'`);
  const mysCity = await db.one(`SELECT id FROM location_cities WHERE slug = 'mysuru'`);
  const cheCity = await db.one(`SELECT id FROM location_cities WHERE slug = 'chennai'`);

  const evBlr = await createEvent({ title: 'BLR Rooftop Mixer', city: 'Bengaluru', venuePrivacy: 'public' });
  await db.query(`UPDATE events SET city_id = $1, lat = 12.9716, lng = 77.5946, coords_provenance = 'venue' WHERE id = $2`, [blrCity.id, evBlr.id]);

  const evMys = await createEvent({ title: 'Mysuru Heritage Walk', city: 'Mysuru', venuePrivacy: 'public' });
  await db.query(`UPDATE events SET city_id = $1, lat = 12.2958, lng = 76.6394, coords_provenance = 'venue' WHERE id = $2`, [mysCity.id, evMys.id]);

  const evChe = await createEvent({ title: 'Chennai Beach Social', city: 'Chennai', venuePrivacy: 'public' });
  await db.query(`UPDATE events SET city_id = $1, lat = 13.0827, lng = 80.2707, coords_provenance = 'venue' WHERE id = $2`, [cheCity.id, evChe.id]);

  // Search from Indiranagar, Bengaluru (12.9784, 77.6408) within 50 km:
  // Only the BLR event should be returned
  const nearby50 = await findNearbyEvents({
    lat: 12.9784,
    lng: 77.6408,
    radiusKm: 50
  });
  const found50Ids = nearby50.map((e) => e.id);
  assert.ok(found50Ids.includes(evBlr.id), 'BLR event must be found within 50km');
  assert.ok(!found50Ids.includes(evMys.id), 'Mysuru event must NOT be found within 50km');
  assert.ok(!found50Ids.includes(evChe.id), 'Chennai event must NOT be found within 50km');

  // Verify distance badge value on returned event
  const blrRes = nearby50.find((e) => e.id === evBlr.id);
  assert.ok(blrRes.distanceKm != null && blrRes.distanceKm < 10, 'BLR event should be < 10km from Indiranagar');

  // Search from Bengaluru within 150 km:
  // Both BLR and Mysuru events should be returned, sorted by distance
  const nearby150 = await findNearbyEvents({
    lat: 12.9716,
    lng: 77.5946,
    radiusKm: 150
  });
  const found150Ids = nearby150.map((e) => e.id);
  assert.ok(found150Ids.includes(evBlr.id));
  assert.ok(found150Ids.includes(evMys.id));
  assert.ok(!found150Ids.includes(evChe.id));

  // Distance ordering
  const blrIdx = nearby150.findIndex((e) => e.id === evBlr.id);
  const mysIdx = nearby150.findIndex((e) => e.id === evMys.id);
  assert.ok(blrIdx < mysIdx, 'Closest event (BLR) must come before Mysuru');
});

test('7. Privacy Boundary: Private venue details are NEVER exposed in discovery', async () => {
  const blrCity = await db.one(`SELECT id FROM location_cities WHERE slug = 'bengaluru'`);
  const privateEv = await createEvent({
    title: 'Secret Penthouse Party',
    city: 'Bengaluru',
    venue_privacy: 'disclosed_after_booking'
  });
  await db.query(
    `UPDATE events
        SET city_id = $1, lat = 12.9750, lng = 77.6000,
            venue_private = 'Top Secret Penthouse Suite 402, 12th Main',
            maps_url = 'https://maps.google.com/?q=secret-penthouse'
      WHERE id = $2`, [blrCity.id, privateEv.id]);

  const nearby = await findNearbyEvents({
    lat: 12.9716,
    lng: 77.5946,
    radiusKm: 20
  });

  const found = nearby.find((e) => e.id === privateEv.id);
  assert.ok(found, 'Private event must be discoverable nearby');
  assert.equal(found.venuePrivacy, 'disclosed_after_booking');
  assert.equal(found.venue, '', 'Secret venue address must be hidden on public discovery');
  assert.equal(found.mapsUrl, null, 'Secret map link must be hidden on public discovery');
  assert.equal(found.lat, null, 'Exact coordinates must not be exposed when venue is secret');
  assert.equal(found.lng, null, 'Exact coordinates must not be exposed when venue is secret');
  assert.equal(found.distanceKm, null, 'Exact numeric distanceKm must be suppressed for secret venue to prevent trilateration');
  assert.ok(found.distanceBand != null, 'Privacy-safe coarse distanceBand must be provided');
});

test('8. HTTP Endpoints: /api/locations and /api/events/nearby', async () => {
  // GET /api/locations/states
  const resStates = await http.get('/api/locations/states');
  assert.equal(resStates.status, 200);
  assert.equal(resStates.json.ok, true);
  assert.equal(resStates.json.count, 36);

  // GET /api/locations/districts?state_lgd_code=33
  const resDist = await http.get('/api/locations/districts?state_lgd_code=33');
  assert.equal(resDist.status, 200);
  assert.equal(resDist.json.ok, true);
  assert.equal(resDist.json.count, 38);

  // GET /api/locations/cities?q=kovai
  const resCities = await http.get('/api/locations/cities?q=kovai');
  assert.equal(resCities.status, 200);
  assert.equal(resCities.json.count, 1);
  assert.equal(resCities.json.cities[0].slug, 'coimbatore');

  // GET /api/locations/cities/bengaluru
  const resCity = await http.get('/api/locations/cities/bengaluru');
  assert.equal(resCity.status, 200);
  assert.equal(resCity.json.city.slug, 'bengaluru');
  assert.equal(resCity.json.city.district_name, 'Bengaluru Urban');

  // GET /api/locations/cities/nonexistent -> 404
  const resNotFound = await http.get('/api/locations/cities/nonexistent-city-xyz');
  assert.equal(resNotFound.status, 404);

  // GET /api/events/nearby with valid coords
  const resNearby = await http.get('/api/events/nearby?lat=12.9716&lng=77.5946&radius_km=50');
  assert.equal(resNearby.status, 200);
  assert.equal(resNearby.json.ok, true);
  assert.ok(Array.isArray(resNearby.json.events));
  assert.ok(resNearby.headers.get('cache-control')?.includes('max-age=60'));

  // GET /api/events/nearby with invalid coords -> 400
  const resInvalid = await http.get('/api/events/nearby?lat=999&lng=77.59');
  assert.equal(resInvalid.status, 400);

  // GET /api/events/nearby with no location -> 400
  const resMissing = await http.get('/api/events/nearby');
  assert.equal(resMissing.status, 400);
});

test('9. City Resolution: resolveCity matches canonical name, slug, aliases and returns null for unknown', async () => {
  const byName = await resolveCity('Bengaluru');
  assert.equal(byName?.slug, 'bengaluru');
  assert.equal(byName?.name, 'Bengaluru');

  const bySlug = await resolveCity('bengaluru');
  assert.equal(bySlug?.id, byName?.id);

  const byAliasBangalore = await resolveCity('Bangalore');
  assert.equal(byAliasBangalore?.slug, 'bengaluru');

  const byAliasMadras = await resolveCity('Madras');
  assert.equal(byAliasMadras?.slug, 'chennai');

  const byAliasKovai = await resolveCity('Kovai');
  assert.equal(byAliasKovai?.slug, 'coimbatore');

  const byAliasPondy = await resolveCity('Pondy');
  assert.equal(byAliasPondy?.slug, 'puducherry');

  // Unsupported or invalid city names must return null and never guess
  assert.equal(await resolveCity('Atlantis'), null);
  assert.equal(await resolveCity(''), null);
  assert.equal(await resolveCity(null), null);
  assert.equal(await resolveCity('X'), null);
});

test('10. Privacy Distance Bands: formatDistanceBand tiers and null handling', () => {
  assert.equal(formatDistanceBand(0.2), '< 1 km away');
  assert.equal(formatDistanceBand(0.9), '< 1 km away');
  assert.equal(formatDistanceBand(1.5), '~2 km away');
  assert.equal(formatDistanceBand(2.9), '~2 km away');
  assert.equal(formatDistanceBand(4.2), '~5 km away');
  assert.equal(formatDistanceBand(8.7), '~10 km away');
  assert.equal(formatDistanceBand(18.0), '~20 km away');
  assert.equal(formatDistanceBand(38.0), '~30–50 km away');
  assert.equal(formatDistanceBand(75.0), '~80 km away');

  assert.equal(formatDistanceBand(null), null);
  assert.equal(formatDistanceBand(undefined), null);
  assert.equal(formatDistanceBand('invalid'), null);
  assert.equal(formatDistanceBand(-5), null);
});

test('11. Nearby Discovery: Bounding box pre-filter and antimeridian handling', async () => {
  // Normal coordinate search
  const events = await findNearbyEvents({ lat: 12.9716, lng: 77.5946, radiusKm: 25 });
  assert.ok(Array.isArray(events));

  // Extreme polar latitudes (lat clamped to [-90, 90])
  const northPoleEvents = await findNearbyEvents({ lat: 89.9, lng: 0, radiusKm: 50 });
  assert.ok(Array.isArray(northPoleEvents));

  const southPoleEvents = await findNearbyEvents({ lat: -89.9, lng: 0, radiusKm: 50 });
  assert.ok(Array.isArray(southPoleEvents));

  // Antimeridian longitude wrap (lng near 180 / -180)
  const wrapEvents = await findNearbyEvents({ lat: 0, lng: 179.9, radiusKm: 50 });
  assert.ok(Array.isArray(wrapEvents));
});

test('12. Organiser Publishing: Auto-resolves city and locality, assigns coords, discoverable by GPS', async () => {
  const orgClient = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [orgClient.userId]);

  const draftRes = await orgClient.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(draftRes.status, 201);
  const draft = draftRes.json.draft;

  const d = new Date(Date.now() + 7 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  const validData = {
    template: 'social', category: 'meetup', title: 'Indiranagar Social Mixer', timezone: 'Asia/Kolkata',
    startLocal: `${d}T18:00`, endLocal: `${d}T21:00`, multiDay: false,
    venue: 'Toit Brewpub', city: 'Bangalore', area: 'Indiranagar', privateVenue: false,
    description: 'Casual networking evening for makers and tech folks.',
    tickets: [{ id: 't1', name: 'Standard entry', kind: 'free', pricePaise: 0, quantity: 30, maxPerBooking: 2, validOn: 'all' }],
    features: {}
  };

  const saveRes = await orgClient.req('PUT', `/api/organiser/drafts/${draft.id}`, { data: validData, step: 'preview', version: draft.version });
  assert.equal(saveRes.status, 200);

  const pubRes = await orgClient.post(`/api/organiser/drafts/${draft.id}/publish`, { version: saveRes.json.draft.version, confirm: true });
  assert.equal(pubRes.status, 200);
  const eventId = pubRes.json.eventId;

  const evRow = await db.one(`SELECT id, city, city_id, locality_id, lat, lng, coords_provenance FROM events WHERE id = $1`, [eventId]);
  assert.equal(evRow.city, 'Bengaluru', 'Canonical city name must be saved even if alias "Bangalore" was input');
  assert.ok(evRow.city_id, 'city_id must be linked');
  assert.ok(evRow.locality_id, 'locality_id for Indiranagar must be linked');
  assert.equal(evRow.coords_provenance, 'locality', 'coords_provenance must be locality');
  assert.ok(evRow.lat != null && evRow.lng != null, 'lat and lng must be assigned');

  // Discoverable via GPS search around Indiranagar (12.9784, 77.6408)
  const nearby = await findNearbyEvents({ lat: 12.9784, lng: 77.6408, radiusKm: 10 });
  const found = nearby.some((e) => e.id === eventId);
  assert.equal(found, true, 'Event must be discoverable via GPS');
});

test('13. HTTP Rate Limiting on /api/events/nearby: 60 req/min limit, 429 status and Retry-After header', async () => {
  const testClient = new Client({ ip: '198.51.100.99' });
  let rateLimited = false;
  for (let i = 0; i < 65; i++) {
    const res = await testClient.get('/api/events/nearby?lat=12.9716&lng=77.5946&radius_km=50');
    if (res.status === 429) {
      rateLimited = true;
      assert.equal(res.json.error, 'rate_limited');
      assert.ok(res.headers.get('retry-after'));
      break;
    }
  }
  assert.equal(rateLimited, true, 'Rate limit must be enforced after 60 requests in 1 minute');
});
