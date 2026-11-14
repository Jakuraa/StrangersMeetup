// test/cancellation-policy.test.js - Comprehensive unit and integration tests for Event Creator
// Cancellation & Refund Templates, Attendee Policy Snapshots, and Creator Cancellation Workflows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  POLICY_TEMPLATES,
  COMMON_POLICY_CLAUSES,
  resolveCancellationPolicy,
  calculateRefundEligibility,
  renderPolicyText
} from '../lib/services/cancellation-policy.js';
import {
  initialDraftData,
  createDraft,
  saveDraft,
  publishDraft,
  cancelOrganiserEvent,
  cancelOrganiserBooking,
  updateOrganiserEvent
} from '../lib/services/organiser.js';
import { bookTier } from '../lib/services/ticketing.js';
import { cancelUserBooking, getUserBooking } from '../lib/services/bookings.js';

test.beforeEach(async () => {
  await resetDb();
});

test('cancellation policy templates: standard, flexible, strict, and custom resolve correctly', () => {
  // 1. Standard (Default)
  const std = resolveCancellationPolicy({ template: 'standard' });
  assert.equal(std.snapshot.template, 'standard');
  assert.equal(std.snapshot.primaryDeadlineHours, 48);
  assert.equal(std.snapshot.primaryRefundPercent, 100);
  assert.equal(std.snapshot.secondaryDeadlineHours, 24);
  assert.equal(std.snapshot.secondaryRefundPercent, 50);
  assert.match(std.renderedText, /100% refund up to 48 hours/);
  assert.match(std.renderedText, /50% refund between 48.*and 24 hours/);
  assert.match(std.renderedText, /5–7 business days/);
  assert.match(std.renderedText, /Guaranteed 100% full refund/);

  // 2. Flexible
  const flex = resolveCancellationPolicy({ template: 'flexible' });
  assert.equal(flex.snapshot.template, 'flexible');
  assert.equal(flex.snapshot.primaryDeadlineHours, 24);
  assert.equal(flex.snapshot.primaryRefundPercent, 100);
  assert.equal(flex.snapshot.secondaryDeadlineHours, null);
  assert.equal(flex.snapshot.secondaryRefundPercent, 0);
  assert.match(flex.renderedText, /100% refund up to 24 hours/);
  assert.match(flex.renderedText, /Non-refundable within 24 hours/);

  // 3. Strict
  const strict = resolveCancellationPolicy({ template: 'strict' });
  assert.equal(strict.snapshot.template, 'strict');
  assert.equal(strict.snapshot.primaryDeadlineHours, 168);
  assert.equal(strict.snapshot.primaryRefundPercent, 100);
  assert.equal(strict.snapshot.secondaryDeadlineHours, 48);
  assert.equal(strict.snapshot.secondaryRefundPercent, 50);
  assert.match(strict.renderedText, /100% refund up to 7 days/);
  assert.match(strict.renderedText, /50% refund between 7 days.*and 48 hours/);

  // 4. Custom
  const custom = resolveCancellationPolicy({
    template: 'custom',
    primaryDeadlineHours: 72,
    primaryRefundPercent: 100,
    secondaryDeadlineHours: 36,
    secondaryRefundPercent: 30,
    customTerms: 'Gate closes 15 minutes after start.'
  });
  assert.equal(custom.snapshot.template, 'custom');
  assert.equal(custom.snapshot.primaryDeadlineHours, 72);
  assert.equal(custom.snapshot.primaryRefundPercent, 100);
  assert.equal(custom.snapshot.secondaryDeadlineHours, 36);
  assert.equal(custom.snapshot.secondaryRefundPercent, 30);
  assert.match(custom.renderedText, /72 hours/);
  assert.match(custom.renderedText, /30% refund between 72.*and 36 hours/);
  assert.match(custom.renderedText, /Gate closes 15 minutes after start/);

  // 5. Fallback from legacy text or empty
  const fallback = resolveCancellationPolicy({});
  assert.equal(fallback.snapshot.template, 'standard');
  assert.equal(fallback.snapshot.primaryDeadlineHours, 48);
});

test('refund eligibility calculation: evaluates deadlines, windows, no-show and percentages', () => {
  const std = resolveCancellationPolicy({ template: 'standard' }).snapshot;
  const now = new Date('2026-11-20T12:00:00Z');

  // Case A: 60 hours before start -> Primary window (100% refund)
  const eventIn60h = new Date('2026-11-23T00:00:00Z').toISOString();
  const el60 = calculateRefundEligibility(std, eventIn60h, now);
  assert.equal(el60.eligible, true);
  assert.equal(el60.refundPercent, 100);
  assert.equal(el60.window, 'primary');

  // Case B: 30 hours before start -> Secondary window (50% refund)
  const eventIn30h = new Date('2026-11-21T18:00:00Z').toISOString();
  const el30 = calculateRefundEligibility(std, eventIn30h, now);
  assert.equal(el30.eligible, true);
  assert.equal(el30.refundPercent, 50);
  assert.equal(el30.window, 'secondary');

  // Case C: 12 hours before start -> Non-refundable window (0% refund)
  const eventIn12h = new Date('2026-11-21T00:00:00Z').toISOString();
  const el12 = calculateRefundEligibility(std, eventIn12h, now);
  assert.equal(el12.eligible, false);
  assert.equal(el12.refundPercent, 0);
  assert.equal(el12.window, 'non_refundable');

  // Case D: Event already started 1 hour ago -> Past event / No-show (0% refund)
  const event1hAgo = new Date('2026-11-20T11:00:00Z').toISOString();
  const elPast = calculateRefundEligibility(std, event1hAgo, now);
  assert.equal(elPast.eligible, false);
  assert.equal(elPast.refundPercent, 0);
  assert.equal(elPast.window, 'past_event');
});

test('wizard draft workflow: initializes with Standard template, allows custom, and publishes policy snapshot', async () => {
  // Create an organiser user
  const u = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000001', 'Host Alice', true) RETURNING *`
  )).rows[0];

  // Check initial draft data contains standard template
  const init = initialDraftData('nightlife');
  assert.equal(init.cancellationPolicy.template, 'standard');
  assert.equal(init.cancellationPolicy.primaryDeadlineHours, 48);

  // Create a draft
  const draft = await createDraft(u, 'nightlife');
  assert.ok(draft.id);

  // Update draft with Flexible cancellation policy
  const updatedData = {
    ...draft.data,
    title: 'Neon Nights Party',
    category: 'nightlife',
    startLocal: '2026-12-01T22:00',
    endLocal: '2026-12-02T03:00',
    city: 'Bengaluru',
    venue: 'Indiranagar Social, 100ft Road',
    description: 'An electrifying nightlife experience with top DJ sets, themed cocktails and a curated dancefloor.',
    cancellationPolicy: {
      template: 'flexible',
      primaryDeadlineHours: 24,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: null,
      secondaryRefundPercent: 0,
      customTerms: ''
    },
    tickets: [
      { id: 't1', name: 'General Entry', kind: 'free', quantity: 50, maxPerBooking: 4, pricePaise: 0 }
    ]
  };

  const saved = await saveDraft(u.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  assert.equal(saved.data.cancellationPolicy.template, 'flexible');

  // Publish the draft
  const published = await publishDraft(u, draft.id, { version: saved.version, confirm: true });
  assert.ok(published.eventId);

  // Verify published event row in database
  const ev = (await db.query(`SELECT * FROM events WHERE id = $1`, [published.eventId])).rows[0];
  assert.ok(ev.features.cancellationPolicy);
  assert.equal(ev.features.cancellationPolicy.template, 'flexible');
  assert.equal(ev.features.cancellationPolicy.primaryDeadlineHours, 24);
  assert.match(ev.refund_policy, /100% refund up to 24 hours/);
});

test('attendee policy snapshot: captures policy at booking time and remains immutable if event policy changes', async () => {
  const host = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000002', 'Host Bob', true) RETURNING *`
  )).rows[0];

  const attendee = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at)
     VALUES ('800000002', 'Guest Charlie', true, now()) RETURNING *`
  )).rows[0];

  const draft = await createDraft(host, 'nightlife');
  const dData = {
    ...draft.data,
    title: 'Secret Warehouse Rave',
    category: 'nightlife',
    startLocal: '2026-12-10T21:00',
    endLocal: '2026-12-10T23:30',
    city: 'Bengaluru',
    venue: 'Whitefield Industrial Area',
    description: 'Underground techno and immersive lighting visuals in a converted warehouse.',
    cancellationPolicy: {
      template: 'standard',
      primaryDeadlineHours: 48,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: 24,
      secondaryRefundPercent: 50
    },
    tickets: [
      { id: 't1', name: 'Free RSVP', kind: 'free', quantity: 30, maxPerBooking: 2, pricePaise: 0 }
    ]
  };
  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: dData });
  const pub = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  const tier = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1 LIMIT 1`, [pub.eventId])).rows[0];

  // Attendee books free RSVP
  const booked = await bookTier(attendee, pub.eventId, { ticketTypeId: tier.id, quantity: 1, answers: {} });
  assert.ok(booked.bookingId);

  // Verify attendee booking has policy snapshot
  const bk = await getUserBooking(attendee.id, booked.bookingId);
  assert.ok(bk.policySnapshot);
  assert.equal(bk.policySnapshot.template, 'standard');
  assert.equal(bk.policySnapshot.primaryDeadlineHours, 48);

  // Host updates event to Strict policy
  await updateOrganiserEvent(host, pub.eventId, {
    cancellationPolicy: {
      template: 'strict',
      primaryDeadlineHours: 168,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: 48,
      secondaryRefundPercent: 50
    }
  });

  // Verify event was updated
  const evUpdated = (await db.query(`SELECT * FROM events WHERE id = $1`, [pub.eventId])).rows[0];
  assert.equal(evUpdated.features.cancellationPolicy.template, 'strict');

  // Verify attendee's booking STILL has original Standard snapshot (immutability)
  const bkAfter = await getUserBooking(attendee.id, booked.bookingId);
  assert.equal(bkAfter.policySnapshot.template, 'standard');
  assert.equal(bkAfter.policySnapshot.primaryDeadlineHours, 48);
});

test('attendee self-cancellation: eligible paid booking safely transitions payment to refund_pending with audit log', async () => {
  const host = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000003', 'Host Dan', true) RETURNING *`
  )).rows[0];

  const attendee = (await db.query(
    `INSERT INTO users (telegram_user_id, alias)
     VALUES ('800000003', 'Guest Diana') RETURNING *`
  )).rows[0];

  // Event starting 72 hours from now
  const startAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  const event = (await db.query(
    `INSERT INTO events (
       slug, title, category, city, venue_private, start_at, timezone, capacity,
       organizer, status, organiser_user_id, ticketing, features, refund_policy
     ) VALUES (
       'techno-rooftop', 'Techno Rooftop', 'nightlife', 'Bengaluru', 'Skydeck Rooftop',
       $1, 'Asia/Kolkata', 100, 'Host Dan', 'published', $2, 'tiers',
       $3, '100% refund up to 48 hours before event.'
     ) RETURNING *`,
    [
      startAt,
      host.id,
      JSON.stringify({
        cancellationPolicy: {
          template: 'standard',
          primaryDeadlineHours: 48,
          primaryRefundPercent: 100,
          secondaryDeadlineHours: 24,
          secondaryRefundPercent: 50
        }
      })
    ]
  )).rows[0];

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking)
     VALUES ($1, 'VIP Entry', 'paid', 200000, 50, 2) RETURNING *`,
    [event.id]
  )).rows[0];

  // Create payment record in 'succeeded' state (₹2,000)
  const payment = (await db.query(
    `INSERT INTO payments (
       order_id, user_id, provider_txn_id, amount, currency, status, provider, purpose, created_at
     ) VALUES (
       'ORD-TEST-001', $1, 'TXN-TEST-001', 200000, 'INR', 'succeeded', 'upi_mock', 'ticket', now()
     ) RETURNING *`,
    [attendee.id]
  )).rows[0];

  // Create confirmed booking linked to payment with policy snapshot
  const booking = (await db.query(
    `INSERT INTO bookings (
       event_id, user_id, ticket_type_id, quantity, status, amount_paise,
       payment_mode, payment_id, confirmed_at, answers
     ) VALUES (
       $1, $2, $3, 1, 'confirmed', 200000, 'provider', $4, now(),
       $5
     ) RETURNING *`,
    [
      event.id,
      attendee.id,
      tier.id,
      payment.id,
      JSON.stringify({
        policy_snapshot: event.features.cancellationPolicy
      })
    ]
  )).rows[0];

  await db.query(`UPDATE payments SET booking_id = $1 WHERE id = $2`, [booking.id, payment.id]);

  // Attendee cancels booking 72 hours before start (entitled to 100% refund)
  const cancelRes = await cancelUserBooking(attendee.id, booking.id, { reason: 'Work schedule change' });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(cancelRes.refundStatus, 'refund_pending');
  assert.equal(cancelRes.refundPercent, 100);
  assert.equal(cancelRes.refundPaise, 200000);

  // Verify payment transitioned to 'refund_pending' and NOT 'refunded' (strict invariant)
  const paymentAfter = (await db.query(`SELECT * FROM payments WHERE id = $1`, [payment.id])).rows[0];
  assert.equal(paymentAfter.status, 'refund_pending');
  assert.equal(paymentAfter.failure_reason, 'attendee_cancelled');

  // Verify payment audit record
  const audits = (await db.query(`SELECT * FROM payment_audits WHERE payment_id = $1 ORDER BY id DESC`, [payment.id])).rows;
  assert.ok(audits.length > 0);
  assert.equal(audits[0].to_status, 'refund_pending');
  assert.equal(audits[0].actor, `user:${attendee.id}`);
});

test('attendee self-cancellation: inside non-refundable window cancels booking but preserves succeeded payment', async () => {
  const host = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000004', 'Host Eve', true) RETURNING *`
  )).rows[0];

  const attendee = (await db.query(
    `INSERT INTO users (telegram_user_id, alias)
     VALUES ('800000004', 'Guest Frank') RETURNING *`
  )).rows[0];

  // Event starting 10 hours from now (Standard non-refundable window is < 24h)
  const startAt = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
  const event = (await db.query(
    `INSERT INTO events (
       slug, title, category, city, venue_private, start_at, timezone, capacity,
       organizer, status, organiser_user_id, ticketing, features, refund_policy
     ) VALUES (
       'sunset-lounge', 'Sunset Lounge', 'nightlife', 'Bengaluru', 'High Ultra Lounge',
       $1, 'Asia/Kolkata', 100, 'Host Eve', 'published', $2, 'tiers',
       $3, '100% refund up to 48h, 50% up to 24h, non-refundable within 24h.'
     ) RETURNING *`,
    [
      startAt,
      host.id,
      JSON.stringify({
        cancellationPolicy: {
          template: 'standard',
          primaryDeadlineHours: 48,
          primaryRefundPercent: 100,
          secondaryDeadlineHours: 24,
          secondaryRefundPercent: 50
        }
      })
    ]
  )).rows[0];

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking)
     VALUES ($1, 'Regular', 'paid', 100000, 50, 2) RETURNING *`,
    [event.id]
  )).rows[0];

  const payment = (await db.query(
    `INSERT INTO payments (
       order_id, user_id, provider_txn_id, amount, currency, status, provider, purpose, created_at
     ) VALUES (
       'ORD-TEST-002', $1, 'TXN-TEST-002', 100000, 'INR', 'succeeded', 'upi_mock', 'ticket', now()
     ) RETURNING *`,
    [attendee.id]
  )).rows[0];

  const booking = (await db.query(
    `INSERT INTO bookings (
       event_id, user_id, ticket_type_id, quantity, status, amount_paise,
       payment_mode, payment_id, confirmed_at, answers
     ) VALUES (
       $1, $2, $3, 1, 'confirmed', 100000, 'provider', $4, now(),
       $5
     ) RETURNING *`,
    [
      event.id,
      attendee.id,
      tier.id,
      payment.id,
      JSON.stringify({ policy_snapshot: event.features.cancellationPolicy })
    ]
  )).rows[0];

  await db.query(`UPDATE payments SET booking_id = $1 WHERE id = $2`, [booking.id, payment.id]);

  // Attendee cancels 10h before event start -> Non-refundable window
  const cancelRes = await cancelUserBooking(attendee.id, booking.id, { reason: 'Missed flight' });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(cancelRes.refundStatus, 'non_refundable');
  assert.equal(cancelRes.refundPercent, 0);

  // Payment remains 'succeeded' per agreed policy terms
  const paymentAfter = (await db.query(`SELECT * FROM payments WHERE id = $1`, [payment.id])).rows[0];
  assert.equal(paymentAfter.status, 'succeeded');

  // Audit ledger documents non-refundable cancellation
  const audits = (await db.query(`SELECT * FROM payment_audits WHERE payment_id = $1 ORDER BY id DESC`, [payment.id])).rows;
  assert.ok(audits.length > 0);
  assert.equal(audits[0].to_status, 'succeeded');
  assert.match(JSON.stringify(audits[0].details), /non_refundable/);
});

test('creator cancellation workflow: organiser cancels event and transitions all succeeded payments to refund_pending', async () => {
  const host = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000005', 'Host George', true) RETURNING *`
  )).rows[0];

  const guest1 = (await db.query(
    `INSERT INTO users (telegram_user_id, alias)
     VALUES ('800000005', 'Guest Hannah') RETURNING *`
  )).rows[0];

  const guest2 = (await db.query(
    `INSERT INTO users (telegram_user_id, alias)
     VALUES ('800000006', 'Guest Ian') RETURNING *`
  )).rows[0];

  const startAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const event = (await db.query(
    `INSERT INTO events (
       slug, title, category, city, venue_private, start_at, timezone, capacity,
       organizer, status, organiser_user_id, ticketing, features
     ) VALUES (
       'pool-party-bash', 'Pool Party Bash', 'nightlife', 'Bengaluru', 'Palm Meadows Resort',
       $1, 'Asia/Kolkata', 100, 'Host George', 'published', $2, 'tiers',
       '{}'::jsonb
     ) RETURNING *`,
    [startAt, host.id]
  )).rows[0];

  await db.query(
    `INSERT INTO event_team (event_id, user_id, team_role, status, invited_by)
     VALUES ($1, $2, 'organiser', 'active', $2)`,
    [event.id, host.id]
  );

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking)
     VALUES ($1, 'Pool Pass', 'paid', 150000, 50, 2) RETURNING *`,
    [event.id]
  )).rows[0];

  // Guest 1 payment & booking
  const p1 = (await db.query(
    `INSERT INTO payments (order_id, user_id, provider_txn_id, amount, currency, status, provider, purpose)
     VALUES ('ORD-CANC-001', $1, 'TXN-CANC-001', 150000, 'INR', 'succeeded', 'upi_mock', 'ticket') RETURNING *`,
    [guest1.id]
  )).rows[0];

  const b1 = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, payment_id, confirmed_at)
     VALUES ($1, $2, $3, 1, 'confirmed', 150000, 'provider', $4, now()) RETURNING *`,
    [event.id, guest1.id, tier.id, p1.id]
  )).rows[0];
  await db.query(`UPDATE payments SET booking_id = $1 WHERE id = $2`, [b1.id, p1.id]);

  // Guest 2 payment & booking
  const p2 = (await db.query(
    `INSERT INTO payments (order_id, user_id, provider_txn_id, amount, currency, status, provider, purpose)
     VALUES ('ORD-CANC-002', $1, 'TXN-CANC-002', 150000, 'INR', 'succeeded', 'upi_mock', 'ticket') RETURNING *`,
    [guest2.id]
  )).rows[0];

  const b2 = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, payment_id, confirmed_at)
     VALUES ($1, $2, $3, 1, 'confirmed', 150000, 'provider', $4, now()) RETURNING *`,
    [event.id, guest2.id, tier.id, p2.id]
  )).rows[0];
  await db.query(`UPDATE payments SET booking_id = $1 WHERE id = $2`, [b2.id, p2.id]);

  // Organiser cancels entire event due to weather/unforeseen circumstances
  const cancelRes = await cancelOrganiserEvent(host, event.id, { reason: 'Severe tropical storm alert' });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(cancelRes.refundPendingCount, 2);

  // Verify both payments transitioned to 'refund_pending' with failure_reason = 'event_cancelled_by_organiser'
  const p1After = (await db.query(`SELECT * FROM payments WHERE id = $1`, [p1.id])).rows[0];
  const p2After = (await db.query(`SELECT * FROM payments WHERE id = $1`, [p2.id])).rows[0];
  assert.equal(p1After.status, 'refund_pending');
  assert.equal(p1After.failure_reason, 'event_cancelled_by_organiser');
  assert.equal(p2After.status, 'refund_pending');
  assert.equal(p2After.failure_reason, 'event_cancelled_by_organiser');

  // Verify notifications enqueued to attendees with 100% full refund disclosure
  const notifs = (await db.query(
    `SELECT * FROM notifications WHERE event_id = $1 ORDER BY id ASC`,
    [event.id]
  )).rows;
  assert.equal(notifs.length, 2);
  assert.equal(notifs[0].kind, 'event_update');
});

test('creator cancels individual booking: transitions payment to refund_pending with 100% refund disclosure', async () => {
  const host = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled)
     VALUES ('700000007', 'Host Julia', true) RETURNING *`
  )).rows[0];

  const guest = (await db.query(
    `INSERT INTO users (telegram_user_id, alias)
     VALUES ('800000007', 'Guest Kevin') RETURNING *`
  )).rows[0];

  const startAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const event = (await db.query(
    `INSERT INTO events (
       slug, title, category, city, venue_private, start_at, timezone, capacity,
       organizer, status, organiser_user_id, ticketing
     ) VALUES (
       'vip-dinner-club', 'VIP Dinner Club', 'dinner_club', 'Bengaluru', 'Olive Beach',
       $1, 'Asia/Kolkata', 20, 'Host Julia', 'published', $2, 'tiers'
     ) RETURNING *`,
    [startAt, host.id]
  )).rows[0];

  await db.query(
    `INSERT INTO event_team (event_id, user_id, team_role, status, invited_by)
     VALUES ($1, $2, 'organiser', 'active', $2)`,
    [event.id, host.id]
  );

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking)
     VALUES ($1, 'Dinner Pass', 'paid', 350000, 20, 1) RETURNING *`,
    [event.id]
  )).rows[0];

  const payment = (await db.query(
    `INSERT INTO payments (order_id, user_id, provider_txn_id, amount, currency, status, provider, purpose)
     VALUES ('ORD-CANC-BK-001', $1, 'TXN-CANC-BK-001', 350000, 'INR', 'succeeded', 'upi_mock', 'ticket') RETURNING *`,
    [guest.id]
  )).rows[0];

  const booking = (await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, payment_id, confirmed_at)
     VALUES ($1, $2, $3, 1, 'confirmed', 350000, 'provider', $4, now()) RETURNING *`,
    [event.id, guest.id, tier.id, payment.id]
  )).rows[0];
  await db.query(`UPDATE payments SET booking_id = $1 WHERE id = $2`, [booking.id, payment.id]);

  // Host cancels individual booking
  const res = await cancelOrganiserBooking(host, booking.id, { reason: 'Venue capacity reduced by management' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'cancelled');
  assert.equal(res.refundPending, true);

  // Verify payment transitioned to refund_pending
  const paymentAfter = (await db.query(`SELECT * FROM payments WHERE id = $1`, [payment.id])).rows[0];
  assert.equal(paymentAfter.status, 'refund_pending');
  assert.equal(paymentAfter.failure_reason, 'booking_cancelled_by_organiser');
});
