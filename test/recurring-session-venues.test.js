// test/recurring-session-venues.test.js - Recurring Event Series with Same vs Different Venues Per Session
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  createDraft,
  saveDraft,
  publishDraft,
  publishIssues
} from '../lib/services/organiser.js';
import { bookTier } from '../lib/services/ticketing.js';
import { getUserBooking } from '../lib/services/bookings.js';
import { checkInTicket, getBookingTickets } from '../lib/services/tickets.js';

test.beforeEach(async () => {
  await resetDb();
});

async function createHostUser(alias = 'dj_kavya') {
  const row = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled, age_confirmed_21)
     VALUES ($1, $2, true, true)
     RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias]
  )).rows[0];
  return row;
}

async function createAttendeeUser(alias = 'attendee_rahul') {
  const row = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, phone)
     VALUES ($1, $2, true, '+919876543210')
     RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias]
  )).rows[0];
  return row;
}

test('Recurring series: Option A - same venue applies to all generated sessions', async () => {
  const host = await createHostUser('host_same_venue');

  const draft = await createDraft(host, 'nightlife');
  assert.ok(draft.id);

  const updatedData = {
    ...draft.data,
    title: 'Saturday Music Sessions',
    category: 'nightlife',
    startLocal: '2026-12-05T20:00',
    endLocal: '2026-12-26T23:00',
    city: 'Coimbatore',
    venue: 'The High Tide Lounge, Race Course Road',
    description: 'Weekly Saturday electronic music sessions featuring resident and guest producers.',
    schedule: {
      type: 'recurring',
      venueArrangement: 'same',
      dates: [
        { date: '2026-12-05', startLocal: '2026-12-05T20:00', endLocal: '2026-12-05T23:00', label: 'Session 1' },
        { date: '2026-12-12', startLocal: '2026-12-12T20:00', endLocal: '2026-12-12T23:00', label: 'Session 2' },
        { date: '2026-12-19', startLocal: '2026-12-19T20:00', endLocal: '2026-12-19T23:00', label: 'Session 3' }
      ]
    },
    tickets: [
      { id: 't1', name: 'Standard Pass', kind: 'free', quantity: 100, maxPerBooking: 4, pricePaise: 0 }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });
  assert.ok(published.eventId);

  // Verify event_sessions records
  const sessions = (await db.query(
    `SELECT * FROM event_sessions WHERE event_id = $1 ORDER BY session_index ASC`,
    [published.eventId]
  )).rows;

  assert.equal(sessions.length, 3);
  for (const s of sessions) {
    assert.equal(s.venue_name, 'The High Tide Lounge, Race Course Road');
    assert.equal(s.city, 'Coimbatore');
  }
});

test('Recurring series: Option B - different venues per session persist independently', async () => {
  const host = await createHostUser('host_touring');

  const draft = await createDraft(host, 'nightlife');
  assert.ok(draft.id);

  // 6-week tour:
  // Session 1: Coimbatore, Venue A
  // Session 2: Coimbatore, Venue A
  // Session 3: Bengaluru, Venue B
  // Session 4: Chennai, Venue C
  // Session 5: Coimbatore, Venue D
  // Session 6: Coimbatore, Venue A
  const updatedData = {
    ...draft.data,
    title: 'South India Underground Music Tour',
    category: 'nightlife',
    startLocal: '2026-11-28T20:00',
    endLocal: '2027-01-02T23:00',
    city: 'Coimbatore',
    venue: 'The Underground Club (HQ)',
    description: 'Six-week rotating residency showcasing underground electronic acts across Coimbatore, Bengaluru and Chennai.',
    schedule: {
      type: 'recurring',
      venueArrangement: 'different',
      dates: [
        { date: '2026-11-28', startLocal: '2026-11-28T20:00', endLocal: '2026-11-28T23:00', label: 'Session 1', venueName: 'Venue A - Echo Rooftop', city: 'Coimbatore' },
        { date: '2026-12-05', startLocal: '2026-12-05T20:00', endLocal: '2026-12-05T23:00', label: 'Session 2', venueName: 'Venue A - Echo Rooftop', city: 'Coimbatore' },
        { date: '2026-12-12', startLocal: '2026-12-12T20:00', endLocal: '2026-12-12T23:00', label: 'Session 3', venueName: 'Venue B - Indiranagar Social', city: 'Bengaluru' },
        { date: '2026-12-19', startLocal: '2026-12-19T20:00', endLocal: '2026-12-19T23:00', label: 'Session 4', venueName: 'Venue C - Bayview Lounge', city: 'Chennai' },
        { date: '2026-12-26', startLocal: '2026-12-26T20:00', endLocal: '2026-12-26T23:00', label: 'Session 5', venueName: 'Venue D - Club Pulse', city: 'Coimbatore' },
        { date: '2027-01-02', startLocal: '2027-01-02T20:00', endLocal: '2027-01-02T23:00', label: 'Session 6', venueName: 'Venue A - Echo Rooftop', city: 'Coimbatore' }
      ]
    },
    tickets: [
      { id: 't_bengaluru', name: 'Bengaluru Session Pass', kind: 'free', quantity: 50, maxPerBooking: 2, pricePaise: 0, validOn: '2026-12-12' },
      { id: 't_chennai', name: 'Chennai Session Pass', kind: 'free', quantity: 50, maxPerBooking: 2, pricePaise: 0, validOn: '2026-12-19' }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  const sessions = (await db.query(
    `SELECT session_index, session_date, venue_name, city FROM event_sessions WHERE event_id = $1 ORDER BY session_index ASC`,
    [published.eventId]
  )).rows;

  assert.equal(sessions.length, 6);
  assert.equal(sessions[0].venue_name, 'Venue A - Echo Rooftop');
  assert.equal(sessions[0].city, 'Coimbatore');
  assert.equal(sessions[1].venue_name, 'Venue A - Echo Rooftop');
  assert.equal(sessions[1].city, 'Coimbatore');
  assert.equal(sessions[2].venue_name, 'Venue B - Indiranagar Social');
  assert.equal(sessions[2].city, 'Bengaluru');
  assert.equal(sessions[3].venue_name, 'Venue C - Bayview Lounge');
  assert.equal(sessions[3].city, 'Chennai');
  assert.equal(sessions[4].venue_name, 'Venue D - Club Pulse');
  assert.equal(sessions[4].city, 'Coimbatore');
  assert.equal(sessions[5].venue_name, 'Venue A - Echo Rooftop');
  assert.equal(sessions[5].city, 'Coimbatore');
});

test('Validation: Different-venue mode blocks publishing if a session has no venue', async () => {
  const host = await createHostUser('host_missing_venue');

  const draft = await createDraft(host, 'nightlife');
  const invalidData = {
    ...draft.data,
    title: 'Multi-City Tour Missing Venue',
    category: 'nightlife',
    startLocal: '2026-12-05T20:00',
    endLocal: '2026-12-19T23:00',
    city: 'Coimbatore',
    venue: 'HQ',
    description: 'Description long enough to pass initial validation test here.',
    schedule: {
      type: 'recurring',
      venueArrangement: 'different',
      dates: [
        { date: '2026-12-05', startLocal: '2026-12-05T20:00', endLocal: '2026-12-05T23:00', label: 'Session 1', venueName: 'Venue A', city: 'Coimbatore' },
        { date: '2026-12-12', startLocal: '2026-12-12T20:00', endLocal: '2026-12-12T23:00', label: 'Session 2', venueName: '', city: 'Bengaluru' } // Missing venue name!
      ]
    },
    tickets: [
      { id: 't1', name: 'Free Pass', kind: 'free', quantity: 20, maxPerBooking: 2, pricePaise: 0 }
    ]
  };

  const issues = publishIssues(invalidData);
  const venueErrors = issues.filter((i) => i.field.includes('venueName'));
  assert.ok(venueErrors.length > 0, 'Must produce validation error for session missing venue');
  assert.match(venueErrors[0].message, /Session 2.*select or enter a venue/);
});

test('Session check-in verification: Validates session and rejects session mismatch', async () => {
  const host = await createHostUser('host_scanner');
  const attendee = await createAttendeeUser('attendee_scanner');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'Dual Session Residency',
    category: 'nightlife',
    startLocal: '2026-12-05T20:00',
    endLocal: '2026-12-12T23:00',
    city: 'Bengaluru',
    venue: 'Venue 1',
    description: 'Residency with two sessions at different venues in Bengaluru.',
    schedule: {
      type: 'recurring',
      venueArrangement: 'different',
      dates: [
        { date: '2026-12-05', startLocal: '2026-12-05T20:00', endLocal: '2026-12-05T23:00', label: 'Session 1', venueName: 'Venue Alpha', city: 'Bengaluru' },
        { date: '2026-12-12', startLocal: '2026-12-12T20:00', endLocal: '2026-12-12T23:00', label: 'Session 2', venueName: 'Venue Beta', city: 'Bengaluru' }
      ]
    },
    tickets: [
      { id: 't_s1', name: 'Session 1 Pass', kind: 'free', quantity: 20, maxPerBooking: 2, pricePaise: 0, validOn: '2026-12-05' },
      { id: 't_s2', name: 'Session 2 Pass', kind: 'free', quantity: 20, maxPerBooking: 2, pricePaise: 0, validOn: '2026-12-12' }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  const sessions = (await db.query(
    `SELECT id, session_date, venue_name FROM event_sessions WHERE event_id = $1 ORDER BY session_index ASC`,
    [published.eventId]
  )).rows;
  const session1 = sessions[0];
  const session2 = sessions[1];

  const tierS1 = (await db.query(
    `SELECT id FROM ticket_types WHERE event_id = $1 AND valid_on = '2026-12-05'`,
    [published.eventId]
  )).rows[0];

  // Attendee books Session 1
  const booking = await bookTier(attendee, published.eventId, {
    tierId: tierS1.id,
    quantity: 1
  });
  assert.ok(booking.bookingId);

  const tickets = await getBookingTickets(booking.bookingId, attendee);
  assert.equal(tickets.length, 1);
  const ticket = tickets[0];
  assert.equal(ticket.sessionId, session1.id);
  assert.equal(ticket.sessionDate, '2026-12-05');

  // 1. Staff attempts to scan ticket at Session 2 (Session mismatch) -> MUST REJECT
  await assert.rejects(
    async () => {
      await checkInTicket(host, published.eventId, {
        ticketCode: ticket.ticketCode,
        sessionId: session2.id,
        sessionDate: '2026-12-12'
      });
    },
    (err) => {
      assert.equal(err.code, 'session_mismatch');
      return true;
    }
  );

  // 2. Staff scans ticket at Session 1 (Matching session) -> MUST SUCCEED
  const checkInResult = await checkInTicket(host, published.eventId, {
    ticketCode: ticket.ticketCode,
    sessionId: session1.id,
    sessionDate: '2026-12-05'
  });

  assert.equal(checkInResult.ok, true);
  assert.equal(checkInResult.result, 'success');
  assert.equal(checkInResult.ticket.sessionId, session1.id);

  // 3. Verify scan log recorded session_id
  const scanLog = (await db.query(
    `SELECT * FROM ticket_scans WHERE ticket_id = $1`,
    [ticket.id]
  )).rows[0];
  assert.equal(scanLog.session_id, session1.id);
});

test('Session location privacy: Private venue address is revealed on booking pass only when confirmed', async () => {
  const host = await createHostUser('host_mystery');
  const attendee = await createAttendeeUser('attendee_mystery');

  const draft = await createDraft(host, 'party');
  const updatedData = {
    ...draft.data,
    title: 'Secret Warehouse Sessions',
    category: 'nightlife',
    startLocal: '2026-12-10T22:00',
    endLocal: '2026-12-24T04:00',
    city: 'Bengaluru',
    venue: 'Primary Secret Spot',
    privateVenue: true,
    description: 'Secret underground techno series with mystery locations revealed on ticket passes.',
    schedule: {
      type: 'recurring',
      venueArrangement: 'different',
      dates: [
        { date: '2026-12-10', startLocal: '2026-12-10T22:00', endLocal: '2026-12-11T04:00', label: 'Session 1', venueName: 'Secret Old Distillery', venueAddress: 'Shed 4, Old Madras Road', city: 'Bengaluru' },
        { date: '2026-12-24', startLocal: '2026-12-24T22:00', endLocal: '2026-12-25T04:00', label: 'Session 2', venueName: 'Secret Textile Mill', venueAddress: 'Gate 2, Peenya Industrial Area', city: 'Bengaluru' }
      ]
    },
    tickets: [
      { id: 't_s1', name: 'Session 1 Pass', kind: 'free', quantity: 20, maxPerBooking: 1, pricePaise: 0, validOn: '2026-12-10' }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  const tierS1 = (await db.query(`SELECT id FROM ticket_types WHERE event_id = $1`, [published.eventId])).rows[0];
  const booking = await bookTier(attendee, published.eventId, { tierId: tierS1.id, quantity: 1 });

  const userBooking = await getUserBooking(attendee.id, booking.bookingId);
  assert.ok(userBooking);
  assert.equal(userBooking.status, 'confirmed');
  assert.equal(userBooking.venue, 'Shed 4, Old Madras Road');
  assert.equal(userBooking.session.venueName, 'Secret Old Distillery');
});
