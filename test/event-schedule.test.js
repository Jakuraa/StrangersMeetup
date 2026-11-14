import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSchedule,
  deriveEventBounds,
  generateRecurringOccurrences,
  EventScheduleDraft
} from '../lib/services/event-schedule.js';
import { publishIssues } from '../lib/services/organiser.js';
import { toPublicEvent, toPublicTier } from '../lib/services/events.js';

test('EventSchedule - normalizes single day schedule correctly', () => {
  const norm = normalizeSchedule(
    { type: 'single', dates: [{ date: '2026-12-15', startLocal: '2026-12-15T18:00', endLocal: '2026-12-15T21:00', label: 'Main' }] },
    '2026-12-15T18:00',
    '2026-12-15T21:00'
  );
  assert.equal(norm.type, 'single');
  assert.equal(norm.dates.length, 1);
  assert.equal(norm.dates[0].date, '2026-12-15');

  const bounds = deriveEventBounds(norm, '2026-12-15T18:00', '2026-12-15T21:00');
  assert.equal(bounds.startLocal, '2026-12-15T18:00');
  assert.equal(bounds.endLocal, '2026-12-15T21:00');
  assert.equal(bounds.isMultiDay, false);
});

test('EventSchedule - deduplicates custom dates and sorts chronologically', () => {
  const input = {
    type: 'custom_dates',
    dates: [
      { date: '2026-11-20', startLocal: '2026-11-20T19:00', endLocal: '2026-11-20T22:00', label: 'Grand Finale' },
      { date: '2026-11-14', startLocal: '2026-11-14T18:00', endLocal: '2026-11-14T21:00', label: 'Opening Night' },
      { date: '2026-11-16', startLocal: '2026-11-16T19:00', endLocal: '2026-11-16T22:00', label: 'Round 2' },
      { date: '2026-11-14', startLocal: '2026-11-14T18:00', endLocal: '2026-11-14T21:00', label: 'Duplicate' }
    ]
  };

  const norm = normalizeSchedule(input);
  assert.equal(norm.type, 'custom_dates');
  assert.equal(norm.dates.length, 3, 'duplicate Nov 14 must be removed');
  assert.equal(norm.dates[0].date, '2026-11-14');
  assert.equal(norm.dates[1].date, '2026-11-16');
  assert.equal(norm.dates[2].date, '2026-11-20');

  const bounds = deriveEventBounds(norm);
  assert.equal(bounds.startLocal, '2026-11-14T18:00');
  assert.equal(bounds.endLocal, '2026-11-20T22:00');
  assert.equal(bounds.isMultiDay, true);
});

test('EventSchedule - recurring generator produces deterministic preview occurrences', () => {
  const occurrences = generateRecurringOccurrences({
    startDate: '2026-12-01',
    daysOfWeek: [5, 6], // Friday and Saturday
    occurrences: 4,
    startTime: '20:00',
    endTime: '23:30',
    labelPrefix: 'Party'
  });

  assert.equal(occurrences.length, 4);
  assert.equal(occurrences[0].label, 'Party 1');
  assert.equal(occurrences[0].startLocal.slice(11), '20:00');
  assert.equal(occurrences[0].endLocal.slice(11), '23:30');

  // Verify dates are on Fri (5) or Sat (6)
  occurrences.forEach((occ) => {
    const day = new Date(occ.date + 'T12:00:00Z').getUTCDay();
    assert.ok(day === 5 || day === 6, `Day ${day} must be Friday or Saturday`);
  });
});

test('EventSchedule - publishIssues rejects custom multi-date with fewer than 2 dates', () => {
  const future = new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 16);
  const futureEnd = new Date(Date.now() + 86400000 * 5 + 3600000 * 3).toISOString().slice(0, 16);
  const now = new Date();

  const d = {
    title: 'Custom Festival',
    category: 'nightlife',
    city: 'Bengaluru',
    venue: 'Indiranagar Club',
    description: 'This is a long description for an incredible nightlife experience across dates.',
    imageRightsConfirmed: true,
    coverImageId: 'dummy-cover-id',
    schedule: {
      type: 'custom_dates',
      dates: [
        { date: future.slice(0, 10), startLocal: future, endLocal: futureEnd, label: 'Solo' }
      ]
    },
    tickets: [
      { name: 'General', kind: 'free', quantity: 20, maxPerBooking: 2 }
    ]
  };

  const issues = publishIssues(d, { checkout: { available: true }, now });
  const schedErr = issues.find((i) => i.field === 'schedule');
  assert.ok(schedErr, 'Expected schedule error for single date under custom_dates type');
  assert.match(schedErr.message, /at least 2 dates/);
});

test('EventSchedule - ticket validation allows validOn matching custom date session', () => {
  const day1 = '2026-12-10';
  const day2 = '2026-12-14';
  const now = new Date('2026-12-01T00:00:00Z');

  const d = {
    title: 'Two Day Summit',
    category: 'meetup',
    city: 'Bengaluru',
    venue: 'Koramangala Hub',
    description: 'A two session summit covering networking and community building.',
    imageRightsConfirmed: true,
    coverImageId: 'dummy-cover',
    schedule: {
      type: 'custom_dates',
      dates: [
        { date: day1, startLocal: `${day1}T10:00`, endLocal: `${day1}T17:00`, label: 'Day 1' },
        { date: day2, startLocal: `${day2}T10:00`, endLocal: `${day2}T17:00`, label: 'Day 2' }
      ]
    },
    tickets: [
      { name: 'All Sessions Pass', kind: 'free', quantity: 50, maxPerBooking: 2, validOn: 'all' },
      { name: 'Day 1 Only', kind: 'free', quantity: 25, maxPerBooking: 2, validOn: day1 },
      { name: 'Invalid Day Pass', kind: 'free', quantity: 10, maxPerBooking: 1, validOn: '2026-12-18' }
    ]
  };

  const issues = publishIssues(d, { checkout: { available: true }, now });
  const invalidDayErr = issues.find((i) => i.field === 'tickets.2.validOn');
  assert.ok(invalidDayErr, 'Expected error for ticket validOn outside scheduled dates');
  assert.match(invalidDayErr.message, /outside the event dates/);

  const day1Err = issues.find((i) => i.field === 'tickets.1.validOn');
  assert.equal(day1Err, undefined, 'Ticket for valid Day 1 should not have an error');
});

test('Payment Contradiction - paid ticket without live checkout displays explicit draft status', () => {
  const tier = {
    id: 't-1',
    name: 'VIP Experience',
    kind: 'paid',
    price_paise: 250000,
    quantity: 10,
    sold: 0,
    held: 0,
    max_per_booking: 2
  };

  // Live checkout disabled
  const pubTier = toPublicTier(tier, { checkout: { available: false } });
  assert.equal(pubTier.available, false);
  assert.equal(pubTier.unavailable, 'Online payment not available yet (Paid ticket — external checkout not configured)');

  // Free ticket remains available even when checkout is disabled
  const freeTier = {
    id: 't-2',
    name: 'Free RSVP',
    kind: 'free',
    price_paise: 0,
    quantity: 20,
    sold: 0,
    held: 0,
    max_per_booking: 2
  };
  const pubFree = toPublicTier(freeTier, { checkout: { available: false } });
  assert.equal(pubFree.available, true);
  assert.equal(pubFree.unavailable, null);
});
