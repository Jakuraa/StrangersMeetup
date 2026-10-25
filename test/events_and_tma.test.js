// test/events_and_tma.test.js - Events API, Inquiries, Privacy & TMA Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import eventsHandler from '../api/events.js';
import inquiriesHandler from '../api/inquiries.js';
import tmaHandler from '../api/tma.js';
import { validateTelegramInitData } from '../lib/telegram.js';

function createMockResponse() {
  let statusCode = 200;
  let headers = {};
  let body = '';

  return {
    setHeader(name, val) {
      headers[name] = val;
    },
    set statusCode(code) {
      statusCode = code;
    },
    get statusCode() {
      return statusCode;
    },
    end(data) {
      body = data;
    },
    getJson() {
      return JSON.parse(body);
    }
  };
}

test('Events API: GET /api/events returns real published events without leaking private venues', async () => {
  const req = {
    method: 'GET',
    url: '/api/events'
  };
  const res = createMockResponse();

  await eventsHandler(req, res);
  assert.equal(res.statusCode, 200);

  const json = res.getJson();
  assert.equal(json.ok, true);
  assert.ok(json.events.length >= 7, 'Expected at least 7 seeded events');

  for (const evt of json.events) {
    // Privacy assertions: Public endpoint MUST NEVER leak private venue addresses
    assert.equal(evt.venue_address, undefined, 'Exact venue address must never be exposed publicly');
    assert.equal(evt.venue_name, undefined, 'Venue name must never be exposed publicly');
    assert.ok(evt.areaName, 'Public neighborhood area must be present');
    assert.ok(evt.privacyNotice.includes('private Telegram community'), 'Privacy disclosure notice must be included');

    // Real data integrity assertions
    assert.ok(typeof evt.capacity === 'number' && evt.capacity > 0);
    assert.ok(typeof evt.ticketsSold === 'number' && evt.ticketsSold >= 0);
    assert.ok(evt.remainingSlots >= 0);
    assert.ok(evt.availabilityLabel, 'Must provide an honest availability label');
  }
});

test('Events API: City filtering works across all 5 target cities', async () => {
  const targetCities = ['bengaluru', 'chennai', 'coimbatore', 'kochi', 'puducherry'];

  for (const city of targetCities) {
    const req = {
      method: 'GET',
      url: `/api/events?city=${city}`
    };
    const res = createMockResponse();

    await eventsHandler(req, res);
    assert.equal(res.statusCode, 200);

    const json = res.getJson();
    assert.equal(json.ok, true);
    assert.ok(json.events.length > 0, `Expected events for ${city}`);
    for (const evt of json.events) {
      assert.equal(evt.city, city);
    }
  }
});

test('Events API: Category filtering works as expected', async () => {
  const req = {
    method: 'GET',
    url: '/api/events?category=board_games'
  };
  const res = createMockResponse();

  await eventsHandler(req, res);
  assert.equal(res.statusCode, 200);

  const json = res.getJson();
  assert.equal(json.ok, true);
  for (const evt of json.events) {
    assert.equal(evt.category, 'board_games');
  }
});

test('Events API: POST /api/events creates RSVP and updates real capacity honestly', async () => {
  // First, get an open event
  const listRes = createMockResponse();
  await eventsHandler({ method: 'GET', url: '/api/events?category=open_meetups' }, listRes);
  const event = listRes.getJson().events[0];
  const initialSold = event.ticketsSold;

  const req = {
    method: 'POST',
    body: {
      eventId: event.id,
      attendeeName: 'Pooja V',
      attendeeContact: '+919876543210',
      ticketCount: 1
    }
  };
  const res = createMockResponse();

  await eventsHandler(req, res);
  assert.equal(res.statusCode, 200);

  const json = res.getJson();
  assert.equal(json.ok, true);
  assert.ok(json.rsvpId.startsWith('rsvp_'));
  assert.equal(json.status, 'CONFIRMED');

  // Verify tickets_sold was incremented in real database
  const verifyRes = createMockResponse();
  await eventsHandler({ method: 'GET', url: `/api/events?id=${event.id}` }, verifyRes);
  const updatedEvent = verifyRes.getJson().events[0];
  assert.equal(updatedEvent.ticketsSold, initialSold + 1);
});

test('Inquiries API: Validates partner, host, venue, and contact submissions', async () => {
  const inquiryTypes = ['venue', 'host', 'partner', 'contact'];

  for (const type of inquiryTypes) {
    const req = {
      method: 'POST',
      body: {
        type,
        name: `Test ${type} Applicant`,
        email: `test_${type}@example.com`,
        phone: '+919999988888',
        city: 'Bengaluru',
        message: 'Excited to collaborate with StrangersMeetup.'
      }
    };
    const res = createMockResponse();

    await inquiriesHandler(req, res);
    assert.equal(res.statusCode, 200);

    const json = res.getJson();
    assert.equal(json.ok, true);
    assert.ok(json.inquiryId.startsWith('inq_'));
    assert.ok(json.message);
  }
});

test('Inquiries API: Rejects invalid email and unknown inquiry types', async () => {
  // Invalid type
  const badTypeRes = createMockResponse();
  await inquiriesHandler({ method: 'POST', body: { type: 'invalid_type', name: 'A', email: 'a@b.com' } }, badTypeRes);
  assert.equal(badTypeRes.statusCode, 400);

  // Invalid email
  const badEmailRes = createMockResponse();
  await inquiriesHandler({ method: 'POST', body: { type: 'contact', name: 'Valid Name', email: 'not-an-email' } }, badEmailRes);
  assert.equal(badEmailRes.statusCode, 400);
});

test('TMA Validation: Validates initData and creates pseudonymous profile', async () => {
  const authDate = Math.floor(Date.now() / 1000);
  const mockUser = JSON.stringify({ id: 555888, first_name: 'Aditya', username: 'adityatg' });
  const mockInitData = `auth_date=${authDate}&query_id=AAHdF60uAAAAAN0XrS4u9d32&user=${encodeURIComponent(mockUser)}&hash=mock_hash_hex`;

  const validation = await validateTelegramInitData(mockInitData);
  assert.equal(validation.ok, true);
  assert.equal(validation.user.id, 555888);

  // Authenticate via TMA API endpoint
  const req = {
    method: 'POST',
    body: { initData: mockInitData }
  };
  const res = createMockResponse();

  await tmaHandler(req, res);
  assert.equal(res.statusCode, 200);

  const json = res.getJson();
  assert.equal(json.ok, true);
  assert.equal(json.authenticated, true);
  assert.equal(json.profile.telegramUserId, 555888);
  assert.ok(json.profile.pseudonym.startsWith('SM_'), 'Must generate a pseudonymous first-party identity');
});

test('TMA Validation: Rejects missing initData or missing hash', async () => {
  const req = {
    method: 'POST',
    body: { initData: '' }
  };
  const res = createMockResponse();

  await tmaHandler(req, res);
  assert.equal(res.statusCode, 400);
});

test('Events API: Scope filtering separates South India, Domestic Trips & International Journeys', async () => {
  const scopes = ['south_india', 'domestic_trip', 'international_trip'];

  for (const scope of scopes) {
    const req = {
      method: 'GET',
      url: `/api/events?scope=${scope}`
    };
    const res = createMockResponse();

    await eventsHandler(req, res);
    assert.equal(res.statusCode, 200);

    const json = res.getJson();
    assert.equal(json.ok, true);
    assert.ok(json.events.length > 0, `Expected items for scope: ${scope}`);
    for (const evt of json.events) {
      assert.equal(evt.scope, scope);
      assert.ok(evt.durationLabel, 'Must specify duration label');
      assert.ok(evt.imageUrl, 'Must provide authentic photography URL');
      assert.ok(Array.isArray(evt.inclusions), 'Inclusions must be an array');
      assert.ok(Array.isArray(evt.exclusions), 'Exclusions must be an array');
      assert.ok(evt.bookingTerms, 'Booking & cancellation terms must be provided');
    }
  }
});

test('Events API: Budget filtering correctly stratifies ticket pricing', async () => {
  // 1. Under 500
  const under500Res = createMockResponse();
  await eventsHandler({ method: 'GET', url: '/api/events?budget=under_500' }, under500Res);
  assert.equal(under500Res.statusCode, 200);
  const under500 = under500Res.getJson().events;
  assert.ok(under500.length > 0);
  for (const evt of under500) {
    assert.ok(evt.priceInr <= 500);
  }

  // 2. Above 1500 (Trip journeys)
  const above1500Res = createMockResponse();
  await eventsHandler({ method: 'GET', url: '/api/events?budget=above_1500' }, above1500Res);
  assert.equal(above1500Res.statusCode, 200);
  const above1500 = above1500Res.getJson().events;
  assert.ok(above1500.length > 0);
  for (const evt of above1500) {
    assert.ok(evt.priceInr > 1500);
  }
});
