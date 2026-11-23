// test/category-ticket-pricing.test.js - Category-based Ticket Pricing, Couple & Group Pass Capacity Accounting, and Inventory Integrity
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  createDraft,
  saveDraft,
  publishDraft
} from '../lib/services/organiser.js';
import { bookTier } from '../lib/services/ticketing.js';
import { getUserBooking, seatsTaken } from '../lib/services/bookings.js';
import { getBookingTickets, checkInTicket } from '../lib/services/tickets.js';
import {
  createUpiPaymentIntent,
  applySuccessfulUpiPayment,
  activePaymentHolds
} from '../lib/services/upi-payments.js';

test.beforeEach(async () => {
  await resetDb();
  process.env.UPI_CHECKOUT_ENABLED = 'true';
});

test.afterEach(() => {
  process.env.UPI_CHECKOUT_ENABLED = 'false';
});

async function createHost(alias = 'host_tickets') {
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled, age_confirmed_21)
     VALUES ($1, $2, true, true) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias]
  )).rows[0];
}

async function createAttendee(alias = 'attendee_buyer') {
  const digits = Math.floor(100000000 + Math.random() * 900000000);
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, phone)
     VALUES ($1, $2, true, $3) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias, `+919${digits}`]
  )).rows[0];
}

test('Category-based tickets: Couple pass (admit_count=2) consumes 2 venue seats per ticket', async () => {
  const host = await createHost('host_couple_test');
  const attendee = await createAttendee('buyer_couple');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'Valentine Eve Gala',
    category: 'nightlife',
    startLocal: '2026-12-14T20:00',
    endLocal: '2026-12-15T02:00',
    city: 'Bengaluru',
    venue: 'Skyline Terrace',
    description: 'An exclusive rooftop nightlife event with strict capacity limits and couple admissions.',
    tickets: [
      {
        id: 't_couple',
        name: 'Couple Pass',
        category: 'couple',
        kind: 'free',
        pricePaise: 0,
        quantity: 5,
        admitCount: 2,
        maxPerBooking: 2,
        eligibility: 'One pass admits 1 couple arriving together'
      }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  // Update event capacity to 10 attendees (5 couples = 10 people)
  await db.query(`UPDATE events SET capacity = 10 WHERE id = $1`, [published.eventId]);

  const tier = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [published.eventId])).rows[0];
  assert.equal(tier.category, 'couple');
  assert.equal(tier.admit_count, 2);

  // Initial seats taken = 0
  const initialSeats = await seatsTaken(db, published.eventId);
  assert.equal(initialSeats, 0);

  // Attendee attempts to book without confirming eligibility -> MUST REJECT
  await assert.rejects(
    async () => {
      await bookTier(attendee, published.eventId, {
        ticketTypeId: tier.id,
        quantity: 1
      });
    },
    (err) => {
      assert.equal(err.code, 'validation');
      assert.match(err.message, /Please confirm you meet this ticket’s eligibility/);
      return true;
    }
  );

  // Attendee books 1 Couple Pass with explicit eligibility confirmation
  const bookingRes = await bookTier(attendee, published.eventId, {
    ticketTypeId: tier.id,
    quantity: 1,
    eligibilityConfirmed: true
  });
  assert.ok(bookingRes.bookingId);

  // Event capacity accounting: 1 couple pass booked must count as 2 attendees towards venue capacity!
  const seatsAfterOne = await seatsTaken(db, published.eventId);
  assert.equal(seatsAfterOne, 2, 'One couple pass must consume 2 seats');

  // Verify booking row
  const bRow = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [bookingRes.bookingId])).rows[0];
  assert.equal(bRow.quantity, 1);
  assert.equal(bRow.admit_count, 2);

  // Verify issued ticket
  const tickets = await getBookingTickets(bookingRes.bookingId, attendee);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].admitCount, 2);

  // Verify check-in displays admit count 2
  const checkIn = await checkInTicket(host, published.eventId, {
    ticketCode: tickets[0].ticketCode
  });
  assert.equal(checkIn.ok, true);
  assert.equal(checkIn.ticket.admitCount, 2);
  assert.equal(checkIn.attendee.admitCount, 2);
});

test('Group pass (admit_count=4) consumes 4 venue seats per ticket and respects event capacity limits', async () => {
  const host = await createHost('host_group_test');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'VIP Lounge Gathering',
    category: 'nightlife',
    startLocal: '2026-12-20T21:00',
    endLocal: '2026-12-21T03:00',
    city: 'Chennai',
    venue: 'Bayview Private Lounge',
    description: 'High energy private gathering with table reservations for groups of 4.',
    tickets: [
      {
        id: 't_group',
        name: 'Group Pass (4 Pax)',
        category: 'group',
        kind: 'free',
        pricePaise: 0,
        quantity: 3,
        admitCount: 4,
        maxPerBooking: 1,
        eligibility: 'One pass admits a group of up to 4 people'
      }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  // Set total event capacity to 8 people (so exactly 2 group passes fill the venue)
  await db.query(`UPDATE events SET capacity = 8 WHERE id = $1`, [published.eventId]);

  const tier = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [published.eventId])).rows[0];

  // Attendee 1 books 1 group pass (4 people)
  const user1 = await createAttendee('group_lead_1');
  await bookTier(user1, published.eventId, { ticketTypeId: tier.id, quantity: 1, eligibilityConfirmed: true });
  assert.equal(await seatsTaken(db, published.eventId), 4);

  // Attendee 2 books 1 group pass (4 people) -> fills all 8 seats
  const user2 = await createAttendee('group_lead_2');
  await bookTier(user2, published.eventId, { ticketTypeId: tier.id, quantity: 1, eligibilityConfirmed: true });
  assert.equal(await seatsTaken(db, published.eventId), 8);

  // Attendee 3 attempts to book 1 group pass -> venue capacity of 8 is exhausted -> MUST REJECT
  const user3 = await createAttendee('group_lead_3');
  await assert.rejects(
    async () => {
      await bookTier(user3, published.eventId, { ticketTypeId: tier.id, quantity: 1, eligibilityConfirmed: true });
    },
    (err) => {
      assert.equal(err.code, 'sold_out');
      return true;
    }
  );
});

test('Paid ticket categories: Server-authoritative price calculation and minimum per booking', async () => {
  process.env.ALLOW_PAID_PUBLISH = 'true';
  try {
  const host = await createHost('host_paid_categories');
  const attendee = await createAttendee('paid_buyer');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'Electric Carnival 2027',
    category: 'nightlife',
    startLocal: '2026-12-31T20:00',
    endLocal: '2027-01-01T04:00',
    city: 'Bengaluru',
    venue: 'Whitefield Arena',
    description: 'New Year Eve dance festival with multi-category passes including Men, Women, Couple and VIP passes.',
    tickets: [
      { id: 't_men', name: "Men's Pass", category: 'men', kind: 'paid', pricePaise: 99900, quantity: 100, maxPerBooking: 4, minPerBooking: 1 },
      { id: 't_women', name: "Women's Pass", category: 'women', kind: 'paid', pricePaise: 49900, quantity: 100, maxPerBooking: 4, minPerBooking: 1 },
      { id: 't_couple', name: 'Couple Pass', category: 'couple', kind: 'paid', pricePaise: 149900, quantity: 50, admitCount: 2, maxPerBooking: 2, minPerBooking: 1 },
      { id: 't_vip', name: 'VIP Pass', category: 'vip', kind: 'paid', pricePaise: 299900, quantity: 20, maxPerBooking: 2, minPerBooking: 2 } // min 2 required!
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  const ev = (await db.query(`SELECT * FROM events WHERE id = $1`, [published.eventId])).rows[0];
  assert.equal(ev.checkout_mode, 'upi_direct', 'Published event with paid tickets must have checkout_mode = upi_direct');

  const tiers = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY price_paise ASC`, [published.eventId])).rows;
  const womenTier = tiers.find((t) => t.category === 'women');
  const vipTier = tiers.find((t) => t.category === 'vip');

  // 1. Min per booking enforcement: VIP pass requires minimum 2 tickets
  await assert.rejects(
    async () => {
      await createUpiPaymentIntent({
        slug: ev.slug,
        user: attendee,
        ticketTypeId: vipTier.id,
        quantity: 1 // only 1 requested when min is 2
      });
    },
    (err) => {
      assert.equal(err.code, 'validation');
      assert.match(err.message, /At least 2 tickets required/);
      return true;
    }
  );

  // 2. Server-calculated total payable amount: 2 women passes @ ₹499 = ₹998 (99800 paise base + 5% fee = 104790 paise)
  const intent = await createUpiPaymentIntent({
    slug: ev.slug,
    user: attendee,
    ticketTypeId: womenTier.id,
    quantity: 2
  });
  assert.ok(intent.orderId);
  assert.equal(intent.baseAmountPaise, 99800, 'Server must calculate base price from ticket_types, ignoring client');
  assert.equal(intent.amountPaise, 104790, 'Total payable includes 5% infrastructure fee');

  // 3. Active payment hold accounting: 2 tickets are held while payment intent is active
  const held = await activePaymentHolds(db, ev.id);
  assert.equal(held, 2);
  } finally {
    delete process.env.ALLOW_PAID_PUBLISH;
  }
});
