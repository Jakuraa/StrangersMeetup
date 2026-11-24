// test/advanced-event-ticketing.test.js
// Automated test suite for Advanced Event Configuration & Professional Ticketing System:
// Module 1: Event Facilities & Amenities
// Module 2: Offers & Discount Engine
// Module 3: Interactive Venue Layout & Section-Based Ticketing
// Module 4: Sales Timeline & Scheduled Pricing Phases
// Integration: Full E2E with Direct UPI Checkout and Backward Compatibility for Free Events.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, db, signedInClient, clearCalls
} from './helpers.js';

import {
  PREDEFINED_FACILITIES,
  FACILITY_CATEGORIES,
  getEventFacilities
} from '../lib/services/event-facilities.js';

import {
  calculateDiscountPaise,
  getOrganiserOffersReport
} from '../lib/services/event-offers.js';

import {
  getEventVenueLayout
} from '../lib/services/event-venue.js';

import {
  categorizePhases
} from '../lib/services/sales-phases.js';

let org1;
let org2;
let attendee1;
let attendee2;

function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function createOrganiser() {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

before(async () => {
  process.env.ENABLE_LIVE_PAYMENTS = 'false';
  process.env.UPI_CHECKOUT_ENABLED = 'false';

  await resetDb();
  await startServer();

  org1 = await createOrganiser();
  org2 = await createOrganiser();
  attendee1 = await signedInClient();
  attendee2 = await signedInClient();
});

after(async () => {
  await stopServer();
});

beforeEach(clearCalls);

function baseEventDraft(overrides = {}) {
  return {
    template: 'party',
    category: 'nightlife',
    title: 'Superclub Experience Bangalore',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(5, '20:00'),
    endLocal: istLocal(6, '02:00'),
    multiDay: false,
    venue: 'Sky Lounge Highstreet',
    city: 'Bengaluru',
    area: 'MG Road',
    privateVenue: false,
    description: 'Premier nightlife experience with international DJs.',
    paymentMethod: 'direct_upi',
    organiserUpiId: 'superclub@okhdfcbank',
    organiserPayeeName: 'Superclub Ventures Pvt Ltd',
    paymentInstructions: 'Transfer ticket amount and provide bank UTR.',
    refundPolicy: 'Full refund if cancelled 48h before event.',
    cancellationPolicy: {
      template: 'standard',
      primaryDeadlineHours: 48,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: 24,
      secondaryRefundPercent: 50,
      noRefundHours: 24,
      allowTransfers: false
    },
    tickets: [
      {
        id: 'tier_ga',
        name: 'General Admission',
        kind: 'paid',
        pricePaise: 99900,
        quantity: 100,
        maxPerBooking: 4,
        validOn: 'all'
      }
    ],
    features: {},
    ...overrides
  };
}

// =============================================================================
// MODULE 1: EVENT FACILITIES & AMENITIES
// =============================================================================

test('Module 1: Predefined facilities and categories are properly defined', () => {
  assert.ok(Array.isArray(PREDEFINED_FACILITIES));
  assert.ok(PREDEFINED_FACILITIES.length >= 10);
  assert.ok(Object.keys(FACILITY_CATEGORIES).length >= 5);

  const keys = PREDEFINED_FACILITIES.map(f => f.key);
  assert.ok(keys.includes('valet_parking'));
  assert.ok(keys.includes('wheelchair_accessible'));
  assert.ok(keys.includes('first_aid'));
  assert.ok(keys.includes('food_available'));
});

test('Module 1: Save facilities with draft, publish, and query public event', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const facilities = [
    {
      facilityKey: 'free_parking',
      category: 'parking',
      name: 'Free Parking Available',
      icon: '🚗',
      description: 'Dedicated parking for 200 cars'
    },
    {
      facilityKey: 'wheelchair_accessible',
      category: 'accessibility',
      name: 'Wheelchair Accessible',
      icon: '♿'
    },
    {
      facilityKey: 'custom_pool_lounge',
      category: 'other',
      name: 'Rooftop Pool Access',
      icon: '🏊',
      description: 'Towels provided at entrance',
      isCustom: true
    }
  ];

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: baseEventDraft({ facilities }),
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);
  assert.equal(putRes.json.draft.data.facilities.length, 3);

  // Publish event
  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const eventId = pubRes.json.eventId;
  assert.ok(eventId);

  // Verify facilities in database
  const savedFacs = await getEventFacilities(db, eventId);
  assert.equal(savedFacs.length, 3);
  const custom = savedFacs.find(f => f.is_custom);
  assert.ok(custom);
  assert.equal(custom.name, 'Rooftop Pool Access');
  assert.equal(custom.category, 'other');

  // Verify public event data includes facilities
  const eventRow = await db.one('SELECT * FROM events WHERE id = $1', [eventId]);
  assert.equal(eventRow.has_facilities, true);

  // Verify HTML renders the facilities section
  const pageRes = await attendee1.get(`/events/${pubRes.json.slug}`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Facilities &amp; Amenities/);
  assert.match(pageRes.text, /Free Parking Available/);
  assert.match(pageRes.text, /Wheelchair Accessible/);
  assert.match(pageRes.text, /Rooftop Pool Access/);
});

test('Module 1: Free event works with facilities completely omitted', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const freeDraft = baseEventDraft({
    title: 'Sunday Morning Coffee & Book Club',
    paymentMethod: 'free',
    organiserUpiId: null,
    organiserPayeeName: null,
    tickets: [
      {
        id: 'tier_free_rsvp',
        name: 'Free RSVP',
        kind: 'free',
        pricePaise: 0,
        quantity: 30,
        maxPerBooking: 2,
        validOn: 'all'
      }
    ],
    facilities: []
  });

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: freeDraft,
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);

  const savedFacs = await getEventFacilities(db, pubRes.json.eventId);
  assert.equal(savedFacs.length, 0);

  const eventRow = await db.one('SELECT has_facilities FROM events WHERE id = $1', [pubRes.json.eventId]);
  assert.equal(eventRow.has_facilities, false);
});

// =============================================================================
// MODULE 2: OFFERS & DISCOUNT ENGINE
// =============================================================================

test('Module 2: Percentage discount calculation with cap in integer paise', () => {
  const offer = {
    name: '20% Mega Festival Discount',
    code: 'FEST20',
    discountType: 'percentage',
    discountValue: 20,
    maxDiscountPaise: 50000, // Capped at ₹500
    minOrderPaise: 100000,   // Min ₹1,000 order
    minQuantity: 1
  };

  // Case 1: Order of ₹2,000 (200000 paise). 20% is ₹400 (40000 paise) < cap ₹500
  const eval1 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 200000, quantity: 2 });
  assert.equal(eval1.valid, true);
  assert.equal(eval1.discountPaise, 40000);
  assert.equal(eval1.finalPayablePaise, 160000);

  // Case 2: Order of ₹5,000 (500000 paise). 20% is ₹1,000 > cap ₹500. Discount capped at ₹500
  const eval2 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 500000, quantity: 5 });
  assert.equal(eval2.valid, true);
  assert.equal(eval2.discountPaise, 50000);
  assert.equal(eval2.finalPayablePaise, 450000);

  // Case 3: Order below min order (₹800 < ₹1,000)
  const eval3 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 80000, quantity: 1 });
  assert.equal(eval3.valid, false);
  assert.match(eval3.reason, /Minimum order/);
});

test('Module 2: Fixed rupee discount and minQuantity rule', () => {
  const offer = {
    name: 'Squad Saver ₹300 Off',
    code: 'SQUAD300',
    discountType: 'fixed_amount',
    discountValue: 30000, // ₹300 in paise
    minQuantity: 3
  };

  // Only 2 tickets: fails minQuantity
  const eval1 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 100000, quantity: 2 });
  assert.equal(eval1.valid, false);
  assert.match(eval1.reason, /Minimum of 3/);

  // 3 tickets: succeeds
  const eval2 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 150000, quantity: 3 });
  assert.equal(eval2.valid, true);
  assert.equal(eval2.discountPaise, 30000);
  assert.equal(eval2.finalPayablePaise, 120000);

  // Discount cannot make price negative
  const eval3 = calculateDiscountPaise(offer, { ticketSubtotalPaise: 20000, quantity: 3 });
  assert.equal(eval3.valid, true);
  assert.equal(eval3.discountPaise, 20000); // capped at subtotal
  assert.equal(eval3.finalPayablePaise, 0);
});

test('Module 2: Direct UPI checkout with promo code reflects exact discounted amount', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const offers = [
    {
      name: 'Nightlife Launch 10% Off',
      code: 'NIGHT10',
      discountType: 'percentage',
      discountValue: 10,
      maxDiscountPaise: 20000,
      minQuantity: 1
    }
  ];

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: baseEventDraft({
      title: 'Neon Nights With Promo Code',
      tickets: [
        {
          id: 'tier_vip',
          name: 'VIP Pass',
          kind: 'paid',
          pricePaise: 100000, // ₹1,000
          quantity: 50,
          maxPerBooking: 4,
          validOn: 'all'
        }
      ],
      offers
    }),
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const event = pubRes.json;

  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.eventId]);

  // Attendee initiates checkout for 2 tickets with promo code night10
  // Subtotal = 2 * ₹1,000 = ₹2,000. 10% discount = ₹200. Final payable = ₹1,800.
  const checkoutRes = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2&promoCode=night10`
  );
  assert.equal(checkoutRes.status, 200, checkoutRes.text);

  // Verify rendered checkout page includes payee, discounted total and discount row
  assert.match(checkoutRes.text, /Superclub Ventures Pvt Ltd/);
  assert.match(checkoutRes.text, /superclub@okhdfcbank/);
  assert.match(checkoutRes.text, /₹1800\.00/);
  assert.match(checkoutRes.text, /am=1800\.00/);
  assert.match(checkoutRes.text, /Nightlife Launch 10% Off/);

  // Retrieve booking from DB
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.eventId, attendee1.userId]
  );
  assert.ok(booking);
  assert.equal(booking.amount_paise, 180000); // ₹1,800
  assert.equal(booking.discount_paise, 20000); // ₹200
  assert.equal(booking.quantity, 2);

  // Submit UTR
  const utrRes = await attendee1.post('/api/checkout/upi/report-payment', {
    bookingId: booking.id,
    utr: '123456789012'
  });
  assert.equal(utrRes.status, 200);

  // Organiser confirms payment
  const confirmRes = await org1.post(`/api/organiser/events/${event.eventId}/payments/${booking.id}/confirm`, {
    warningConfirmed: true,
    note: 'Verified ₹1,800 in bank app'
  });
  assert.equal(confirmRes.status, 200);

  // Verify reporting
  const report = await getOrganiserOffersReport(db, event.eventId);
  assert.equal(report.length, 1);
  assert.equal(report[0].code, 'NIGHT10');
  assert.equal(Number(report[0].total_redemptions), 1);
  assert.equal(Number(report[0].total_discount_paise), 20000);
  assert.equal(Number(report[0].net_revenue_paise), 180000);
});

// =============================================================================
// MODULE 3: INTERACTIVE VENUE LAYOUT & SECTION-BASED TICKETING
// =============================================================================

test('Module 3: Section-based venue layout with independent prices and capacities', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const venueLayout = {
    layoutType: 'section_based',
    sections: [
      {
        sectionKey: 'sec_vip_lounge',
        name: 'VIP Sky Lounge',
        category: 'vip',
        pricePaise: 199900, // ₹1,999
        capacity: 10,
        status: 'available',
        color: '#a855f7'
      },
      {
        sectionKey: 'sec_fanpit',
        name: 'Front Fanpit',
        category: 'fanpit',
        pricePaise: 99900, // ₹999
        capacity: 20,
        status: 'available',
        color: '#06b6d4'
      },
      {
        sectionKey: 'sec_sold_out',
        name: 'Sold Out Balcony',
        category: 'gold',
        pricePaise: 149900,
        capacity: 5,
        status: 'sold_out',
        color: '#eab308'
      }
    ]
  };

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: baseEventDraft({
      title: 'Stadium Concert with Section Layout',
      venueLayout
    }),
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const event = pubRes.json;

  // Verify public layout retrieval
  const layout = await getEventVenueLayout(event.eventId, db);
  assert.equal(layout.layoutType, 'section_based');
  assert.equal(layout.sections.length, 3);

  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.eventId]);
  const vipSec = layout.sections.find(s => s.section_key === 'sec_vip_lounge');
  assert.ok(vipSec);

  // Booking with VIP section uses the VIP section price (₹1,999)
  const checkoutRes = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2&sectionId=${vipSec.id}`
  );
  assert.equal(checkoutRes.status, 200, checkoutRes.text);
  assert.match(checkoutRes.text, /₹3998\.00/);
  assert.match(checkoutRes.text, /am=3998\.00/);

  // Booking with sold-out section fails with error
  const soldOutSec = layout.sections.find(s => s.section_key === 'sec_sold_out');
  const soldOutRes = await attendee2.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&sectionId=${soldOutSec.id}`
  );
  assert.equal(soldOutRes.status, 409);
  assert.match(soldOutRes.text, /sold out/i);
});

test('Module 3: Section capacity oversell protection with transactional row-locking', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const venueLayout = {
    layoutType: 'section_based',
    sections: [
      {
        sectionKey: 'sec_micro_table',
        name: 'Private Table 1',
        category: 'vip',
        pricePaise: 500000,
        capacity: 2, // only 2 spots!
        status: 'available'
      }
    ]
  };

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: baseEventDraft({
      title: 'Exclusive High Roller Event',
      venueLayout
    }),
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const event = pubRes.json;

  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.eventId]);
  const sec = await db.one('SELECT * FROM event_venue_sections WHERE event_id = $1', [event.eventId]);

  // Attendee 1 books 2 seats (fills section capacity)
  const book1 = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2&sectionId=${sec.id}`
  );
  assert.equal(book1.status, 200);

  // Attendee 2 attempts to book 1 seat in the same section -> rejected!
  const book2 = await attendee2.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&sectionId=${sec.id}`
  );
  assert.equal(book2.status, 409);
  assert.match(book2.text, /sold out/i);
});

// =============================================================================
// MODULE 4: SALES TIMELINE & SCHEDULED PRICING PHASES
// =============================================================================

test('Module 4: Authoritative server clock evaluates active, upcoming, and ended phases', () => {
  const now = new Date('2026-11-24T12:00:00Z');

  const phases = [
    {
      id: 'p_past',
      name: 'Early Bird',
      phase_type: 'early_access',
      starts_at: '2026-11-20T00:00:00Z',
      ends_at: '2026-11-23T23:59:59Z',
      price_paise: 49900
    },
    {
      id: 'p_curr',
      name: 'Phase 2 Pre-Sale',
      phase_type: 'pre_sale',
      starts_at: '2026-11-24T00:00:00Z',
      ends_at: '2026-11-26T23:59:59Z',
      price_paise: 69900,
      quota: 100,
      tickets_sold: 10
    },
    {
      id: 'p_future',
      name: 'General Final Release',
      phase_type: 'final_release',
      starts_at: '2026-11-27T00:00:00Z',
      ends_at: '2026-11-30T23:59:59Z',
      price_paise: 99900
    }
  ];

  const cat = categorizePhases(phases, { now });
  assert.equal(cat.current?.id, 'p_curr');
  assert.equal(cat.upcoming.length, 1);
  assert.equal(cat.upcoming[0].id, 'p_future');
  assert.equal(cat.past.length, 1);
  assert.equal(cat.past[0].id, 'p_past');
});

test('Module 4: Phase quota exhaustion and access code unlocking', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 864e5 * 2).toISOString();

  const salesTimeline = {
    enabled: true,
    phases: [
      {
        name: 'Flash Sale (First 2 Only)',
        phaseType: 'pre_sale',
        startsAt: nowIso,
        endsAt: futureIso,
        pricePaise: 29900, // ₹299
        quota: 2 // only 2 tickets in this phase
      },
      {
        name: 'Secret VIP Release',
        phaseType: 'early_access',
        startsAt: nowIso,
        endsAt: futureIso,
        pricePaise: 19900,
        quota: 10,
        accessCode: 'SECRETVIP'
      }
    ]
  };

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: baseEventDraft({
      title: 'Festival with Progressive Phases',
      salesTimeline
    }),
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const event = pubRes.json;

  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.eventId]);
  const phases = (await db.query('SELECT * FROM event_sales_phases WHERE event_id = $1', [event.eventId])).rows;
  const secretPhase = phases.find(p => p.access_code === 'SECRETVIP');
  const flashPhase = phases.find(p => p.quota === 2);

  // 1. Secret VIP phase requires valid access code
  const noCodeRes = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&phaseId=${secretPhase.id}`
  );
  assert.equal(noCodeRes.status, 400);
  assert.match(noCodeRes.text, /access code/i);

  const withCodeRes = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&phaseId=${secretPhase.id}&accessCode=SECRETVIP`
  );
  assert.equal(withCodeRes.status, 200);
  assert.match(withCodeRes.text, /₹199\.00/);

  // 2. Flash sale quota test: book 2 tickets
  const flash1 = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2&phaseId=${flashPhase.id}`
  );
  assert.equal(flash1.status, 200);
  assert.match(flash1.text, /₹598\.00/); // 2 × ₹299

  // Attempting to book 1 more ticket under flashPhase fails because quota (2) is exhausted
  const flash2 = await attendee2.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&phaseId=${flashPhase.id}`
  );
  assert.equal(flash2.status, 409);
  assert.match(flash2.text, /quota|sold out/i);
});

// =============================================================================
// INTEGRATION: COMBINED WORKFLOW & BACKWARD COMPATIBILITY
// =============================================================================

test('Integration: Combined workflow (Section + Phase Override + Offer Discount) with Direct UPI', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 864e5 * 2).toISOString();

  // Base tier: ₹1,000 (100000 paise)
  // Section: VIP Lounge base price ₹2,000 (200000 paise)
  // Phase: Early Bird price override ₹1,500 (150000 paise)
  // Offer: Promo code SAVE20 (20% off) -> 20% of ₹1,500 = ₹300 discount -> Final ₹1,200 (120000 paise)
  const fullDraft = baseEventDraft({
    title: 'Ultimate Mega Festival 2026',
    facilities: [
      { facilityKey: 'valet_parking', category: 'parking', name: 'Valet Parking Available', icon: '🚗' },
      { facilityKey: 'first_aid', category: 'medical_safety', name: 'First Aid & Medical Desk', icon: '🩺' }
    ],
    venueLayout: {
      layoutType: 'section_based',
      sections: [
        { sectionKey: 'sec_vip', name: 'VIP Lounge', category: 'vip', pricePaise: 200000, capacity: 50, status: 'available' }
      ]
    },
    salesTimeline: {
      enabled: true,
      phases: [
        { name: 'Early Bird Phase', phaseType: 'early_access', startsAt: nowIso, endsAt: futureIso, pricePaise: 150000 }
      ]
    },
    offers: [
      { name: '20% Mega Promo', code: 'SAVE20', discountType: 'percentage', discountValue: 20, minQuantity: 1 }
    ]
  });

  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data: fullDraft,
    step: 'preview',
    version
  });
  assert.equal(putRes.status, 200, putRes.text);

  const pubRes = await org1.post(`/api/organiser/drafts/${draftId}/publish`, {
    version: putRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  const event = pubRes.json;

  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.eventId]);
  const sec = await db.one('SELECT * FROM event_venue_sections WHERE event_id = $1', [event.eventId]);
  const phase = await db.one('SELECT * FROM event_sales_phases WHERE event_id = $1', [event.eventId]);

  // Attendee books 1 ticket in VIP section under Early Bird phase with SAVE20 promo code
  const checkoutRes = await attendee1.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&sectionId=${sec.id}&phaseId=${phase.id}&promoCode=save20&quantity=1`
  );

  assert.equal(checkoutRes.status, 200, checkoutRes.text);
  assert.match(checkoutRes.text, /₹1200\.00/);
  assert.match(checkoutRes.text, /am=1200\.00/);
  assert.match(checkoutRes.text, /20% Mega Promo/);

  // Retrieve booking and verify snapshot
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.eventId, attendee1.userId]
  );
  assert.equal(booking.amount_paise, 120000); // ₹1,200
  assert.equal(booking.discount_paise, 30000); // ₹300
  assert.equal(booking.section_id, sec.id);
  assert.equal(booking.phase_id, phase.id);

  // Verify booking price snapshot
  const snapshot = await db.one('SELECT * FROM booking_price_snapshots WHERE booking_id = $1', [booking.id]);
  assert.ok(snapshot);
  assert.equal(snapshot.base_price_paise, 200000); // VIP section base price
  assert.equal(snapshot.subtotal_paise, 150000); // Early Bird phase override
  assert.equal(snapshot.discount_paise, 30000);
  assert.equal(snapshot.final_paise, 120000);
  assert.equal(snapshot.offer_code, 'SAVE20');
});
