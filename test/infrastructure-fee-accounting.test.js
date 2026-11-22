// test/infrastructure-fee-accounting.test.js - Comprehensive test suite for
// NIGHTLIFEZ 5% Infrastructure Fee & Organiser Commission Accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb, startServer, stopServer, signedInClient, Client } from './helpers.js';
import {
  calculateInfrastructureFee,
  getActiveFeeRule,
  setFeeRule,
  recordBookingFeeEntry,
  reverseBookingFeeEntry,
  submitFeePayment,
  confirmFeePayment,
  rejectFeePayment,
  investigateFeePayment,
  getOrganiserFinanceSummary,
  getAdminFinanceOverview,
  extendPaymentDeadline,
  DEFAULT_FEE_PERCENTAGE
} from '../lib/services/finance.js';
import {
  createDraft,
  saveDraft,
  publishDraft
} from '../lib/services/organiser.js';
import {
  createUpiPaymentIntent,
  applySuccessfulUpiPayment
} from '../lib/services/upi-payments.js';
import { bookTier } from '../lib/services/ticketing.js';
import { checkInTicket } from '../lib/services/tickets.js';

let superAdminClient;
let financeClient;
let eventManagerClient;
let organiserAClient;
let organiserBClient;
let attendeeClient;

test.before(async () => {
  await resetDb();
  await startServer();

  // Setup roles
  superAdminClient = await signedInClient({ tgId: 900000001 }); // ADMIN_BOOTSTRAP_TELEGRAM_ID
  assert.equal((await superAdminClient.get('/api/admin/session')).json.role, 'super_admin');
  superAdminClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [superAdminClient.userId])).rows[0];

  financeClient = await signedInClient();
  await superAdminClient.post('/api/admin/admins', { telegram_user_id: financeClient.tgId, role: 'finance' });
  financeClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [financeClient.userId])).rows[0];
  financeClient.admin = (await db.query('SELECT * FROM admin_users WHERE telegram_user_id = $1', [financeClient.tgId])).rows[0];

  eventManagerClient = await signedInClient();
  await superAdminClient.post('/api/admin/admins', { telegram_user_id: eventManagerClient.tgId, role: 'event_manager' });
  eventManagerClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [eventManagerClient.userId])).rows[0];

  organiserAClient = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true, age_confirmed_21 = true WHERE id = $1', [organiserAClient.userId]);
  organiserAClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [organiserAClient.userId])).rows[0];

  organiserBClient = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true, age_confirmed_21 = true WHERE id = $1', [organiserBClient.userId]);
  organiserBClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [organiserBClient.userId])).rows[0];

  attendeeClient = await signedInClient();
  await db.query('UPDATE users SET age_confirmed_21 = true WHERE id = $1', [attendeeClient.userId]);
  attendeeClient.user = (await db.query('SELECT * FROM users WHERE id = $1', [attendeeClient.userId])).rows[0];

  process.env.UPI_CHECKOUT_ENABLED = 'true';
});

test.after(async () => {
  process.env.UPI_CHECKOUT_ENABLED = 'false';
  await stopServer();
});

test('1. 5% fee calculation and integer paise rounding with different ticket prices', () => {
  // ₹1,000 base price (100,000 paise) -> 5% fee is ₹50 (5,000 paise) -> total ₹1,050 (105,000 paise)
  const calc1000 = calculateInfrastructureFee(100000, 5.00);
  assert.equal(calc1000.basePaise, 100000);
  assert.equal(calc1000.feePaise, 5000);
  assert.equal(calc1000.totalPaise, 105000);
  assert.equal(calc1000.feePercentage, 5.00);

  // ₹499 base price (49,900 paise) -> 5% fee is ₹24.95 (2,495 paise) -> total ₹523.95 (52,395 paise)
  const calc499 = calculateInfrastructureFee(49900, 5.00);
  assert.equal(calc499.basePaise, 49900);
  assert.equal(calc499.feePaise, 2495);
  assert.equal(calc499.totalPaise, 52395);

  // Odd paise rounding: ₹33.33 (3,333 paise) * 0.05 = 166.65 -> rounded to 167 paise
  const calcOdd = calculateInfrastructureFee(3333, 5.00);
  assert.equal(calcOdd.basePaise, 3333);
  assert.equal(calcOdd.feePaise, 167);
  assert.equal(calcOdd.totalPaise, 3500);

  // Free ticket: ₹0 base price -> ₹0 fee -> ₹0 total
  const calcFree = calculateInfrastructureFee(0, 5.00);
  assert.equal(calcFree.basePaise, 0);
  assert.equal(calcFree.feePaise, 0);
  assert.equal(calcFree.totalPaise, 0);
});

test('2. Couple and group ticket quantities calculate correct base and fee', () => {
  // Couple pass: ₹1,500 base, qty = 2 (admit_count=2, total 4 people)
  // Base total = ₹3,000 (300,000 paise), 5% fee = ₹150 (15,000 paise), total = ₹3,150 (315,000 paise)
  const coupleBase = 150000 * 2;
  const calcCouple = calculateInfrastructureFee(coupleBase, 5.00);
  assert.equal(calcCouple.basePaise, 300000);
  assert.equal(calcCouple.feePaise, 15000);
  assert.equal(calcCouple.totalPaise, 315000);

  // Group pass: ₹4,000 base, qty = 1 (admit_count=4)
  // Base total = 400,000 paise, fee = 20,000 paise, total = 420,000 paise
  const calcGroup = calculateInfrastructureFee(400000, 5.00);
  assert.equal(calcGroup.basePaise, 400000);
  assert.equal(calcGroup.feePaise, 20000);
  assert.equal(calcGroup.totalPaise, 420000);
});

test('3. Attendee checkout displays transparent breakdown and UPI intent requests full amount', async () => {
  // Create an event with paid tickets
  const draft = await createDraft(organiserAClient.user, { template: 'nightlife' });
  const draftData = {
    ...draft.data,
    title: 'Neon Skyline Party',
    category: 'nightlife',
    startLocal: '2026-12-20T21:00',
    endLocal: '2026-12-21T03:00',
    city: 'Bengaluru',
    venue: 'Skyline Club',
    description: 'An exclusive rooftop nightlife event with strict capacity limits and music.',
    tickets: [
      {
        id: 't_vip',
        name: 'VIP Entry',
        category: 'general',
        kind: 'paid',
        pricePaise: 100000, // ₹1,000
        quantity: 50,
        admitCount: 1,
        maxPerBooking: 4
      }
    ]
  };
  const saved = await saveDraft(organiserAClient.userId, draft.id, { version: draft.version, step: 'tickets', data: draftData });
  const pub = await publishDraft(organiserAClient.user, draft.id, { version: saved.version, confirm: true });
  const event = (await db.query(`SELECT * FROM events WHERE id = $1`, [pub.eventId])).rows[0];
  const tiers = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub.eventId])).rows;

  // Add organiser UPI destination
  await db.query(`UPDATE events SET organiser_upi_id = 'skyline@icici' WHERE id = $1`, [event.id]);

  // Create UPI payment intent for 1 ticket (Base: ₹1,000, Fee: ₹50, Total: ₹1,050)
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: attendeeClient.user,
    ticketTypeId: tiers[0].id,
    quantity: 1,
    deviceType: 'desktop'
  });

  assert.equal(intent.baseAmountPaise, 100000, 'Base amount must be 100,000 paise (₹1,000)');
  assert.equal(intent.feePaise, 5000, 'Fee must be 5,000 paise (₹50)');
  assert.equal(intent.amountPaise, 105000, 'Total intent amount must be 105,000 paise (₹1,050)');
  assert.equal(intent.amountRupees, '1050.00');
  assert.equal(intent.organiserUpiId, 'skyline@icici');

  // Verify Checkout HTML renders the complete price breakdown and organiser destination
  const resHtml = await attendeeClient.get(`/checkout/${event.slug}/upi?tier=${tiers[0].id}&qty=1`);
  assert.equal(resHtml.status, 200);
  assert.ok(resHtml.text.includes('Organiser ticket price'), 'Must display Organiser ticket price');
  assert.ok(resHtml.text.includes('1000.00'), 'Must display ₹1,000.00 base');
  assert.ok(resHtml.text.includes('NIGHTLIFEZ infrastructure fee (5%)'), 'Must display 5% fee row');
  assert.ok(resHtml.text.includes('50.00'), 'Must display ₹50.00 fee');
  assert.ok(resHtml.text.includes('1050.00'), 'Must display ₹1,050.00 total');
  assert.ok(resHtml.text.includes('skyline@icici'), 'Must display organiser UPI destination');
  assert.ok(resHtml.text.includes('payable by the organiser to NIGHTLIFEZ'), 'Must explain fee collection model');

  // Critical Requirement: The generated UPI string must charge the full displayed attendee amount (₹1,050)
  assert.ok(intent.upiIntentUrl.includes('am=1050.00'), 'UPI payment request URI must charge full ₹1,050.00');
});

test('4. Successful attendee booking accrues 5% fee and updates organiser fee account & invoice', async () => {
  const event = (await db.query(`SELECT * FROM events WHERE title = 'Neon Skyline Party'`)).rows[0];
  const tier = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [event.id])).rows[0];

  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: attendeeClient.user,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // Complete the payment via mock adapter
  const confirmed = await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    providerPaymentId: `UTR${Date.now()}`,
    verifiedAmountPaise: 105000,
    merchantId: 'PGTESTPAYUAT',
    currency: 'INR',
    actor: 'test:adapter'
  });

  assert.equal(confirmed.status, 'succeeded');
  assert.ok(confirmed.bookingId, 'Booking must be created');

  // Verify booking snapshot
  const booking = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [confirmed.bookingId])).rows[0];
  assert.equal(booking.amount_paise, 105000, 'Total collected: ₹1,050');
  assert.equal(booking.base_price_paise, 100000, 'Base price: ₹1,000');
  assert.equal(booking.infrastructure_fee_paise, 5000, 'Infra fee: ₹50');
  assert.equal(Number(booking.fee_percentage), 5.00);
  assert.ok(booking.fee_calculation_snapshot, 'Fee snapshot must exist');

  // Verify infrastructure fee ledger entry
  const feeEntry = (await db.query(`SELECT * FROM infrastructure_fee_entries WHERE booking_id = $1`, [booking.id])).rows[0];
  assert.ok(feeEntry, 'Fee entry must be recorded');
  assert.equal(feeEntry.fee_amount_paise, 5000);
  assert.equal(feeEntry.base_amount_paise, 100000);
  assert.equal(feeEntry.status, 'accrued');

  // Verify organiser fee account
  const acc = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  assert.ok(acc);
  assert.equal(acc.total_fee_payable_paise, 5000);
  assert.equal(acc.outstanding_balance_paise, 5000);
  assert.equal(acc.total_fee_paid_paise, 0);

  // Verify organiser fee invoice
  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE event_id = $1`, [event.id])).rows[0];
  assert.ok(inv);
  assert.equal(inv.fee_amount_paise, 5000);
  assert.equal(inv.net_fee_payable_paise, 5000);
  assert.equal(inv.outstanding_amount_paise, 5000);
  assert.equal(inv.amount_paid_paise, 0);
  assert.equal(inv.status, 'pending');
});

test('5. Organiser payment claim submission records claim without clearing outstanding balance', async () => {
  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  const utr = `UTR${Date.now()}`;

  // Organiser submits payment claim for ₹50
  const submitRes = await organiserAClient.post('/api/organiser/finance/submit-payment', {
    invoiceId: inv.id,
    paymentReference: inv.payment_reference,
    amountPaise: 5000,
    utrNumber: utr,
    payerUpiId: 'hostA@okhdfcbank',
    notes: 'Paid via GPay to official platform account'
  });

  assert.equal(submitRes.status, 201);
  assert.equal(submitRes.json.ok, true);

  // CRITICAL REQUIREMENT: Organiser submission must NEVER clear the outstanding balance
  const accAfterSubmit = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  assert.equal(accAfterSubmit.outstanding_balance_paise, 5000, 'Outstanding balance must remain unchanged after claim submission');
  assert.equal(accAfterSubmit.total_fee_paid_paise, 0, 'Total paid must remain 0 until admin confirmation');

  const invAfterSubmit = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [inv.id])).rows[0];
  assert.equal(invAfterSubmit.outstanding_amount_paise, 5000, 'Invoice outstanding must remain unchanged');
  assert.equal(invAfterSubmit.amount_paid_paise, 0);
  assert.equal(invAfterSubmit.status, 'under_verification', 'Invoice status reflects under_verification');
});

test('6. Duplicate UTR submission is rejected with 409', async () => {
  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  const existingSub = (await db.query(`SELECT utr_number FROM organiser_fee_payment_submissions WHERE organiser_id = $1 LIMIT 1`, [organiserAClient.user.id])).rows[0];

  // Try to submit with same UTR
  const dupRes = await organiserAClient.post('/api/organiser/finance/submit-payment', {
    invoiceId: inv.id,
    amountPaise: 5000,
    utrNumber: existingSub.utr_number
  });

  assert.equal(dupRes.status, 409, 'Duplicate UTR must return 409 Conflict');
  assert.equal(dupRes.json.error, 'duplicate_utr');
});

test('7. Admin confirmation verifies incoming bank credit, generates receipt, and clears outstanding balance', async () => {
  const sub = (await db.query(`SELECT * FROM organiser_fee_payment_submissions WHERE organiser_id = $1 AND status = 'submitted'`, [organiserAClient.user.id])).rows[0];
  const bankTxId = `BANK-TX-${Date.now()}`;

  // Finance admin confirms payment
  const confirmRes = await financeClient.post('/api/admin/finance/confirm-payment', {
    submissionId: sub.id,
    bankTxId,
    verifiedAmountPaise: 5000,
    notes: 'Verified on ICICI current account bank statement'
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.json.ok, true);
  assert.ok(confirmRes.json.receiptNumbers?.length > 0, 'Receipt must be generated');

  // Verify Organiser Fee Account is now settled
  const accAfterConfirm = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  assert.equal(accAfterConfirm.total_fee_paid_paise, 5000, 'Total paid must be updated to verified amount');
  assert.equal(accAfterConfirm.outstanding_balance_paise, 0, 'Outstanding balance is now 0');
  assert.equal(accAfterConfirm.status, 'settled');

  // Verify invoice is fully settled
  const invAfterConfirm = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [sub.invoice_id])).rows[0];
  assert.equal(invAfterConfirm.amount_paid_paise, 5000);
  assert.equal(invAfterConfirm.outstanding_amount_paise, 0);
  assert.equal(invAfterConfirm.status, 'fully_settled');

  // Verify bank transaction recorded and fully allocated
  const bankTx = (await db.query(`SELECT * FROM nightlifez_bank_transactions WHERE bank_tx_id = $1`, [bankTxId])).rows[0];
  assert.ok(bankTx);
  assert.equal(bankTx.allocated_amount_paise, 5000);
  assert.equal(bankTx.unallocated_amount_paise, 0);
  assert.equal(bankTx.status, 'fully_allocated');

  // Verify audit log
  const auditLog = (await db.query(`SELECT * FROM finance_audit_logs WHERE entity_id = $1 AND action = 'payment_confirmed'`, [sub.id])).rows[0];
  assert.ok(auditLog, 'Audit log must record payment confirmation');
  assert.equal(auditLog.actor_id, financeClient.admin.id);
});

test('8. Partial commission payment and multiple payments against one invoice', async () => {
  // Organiser B creates event with ₹50,000 ticket sales -> ₹2,500 fee
  const draft = await createDraft(organiserBClient.user, { template: 'nightlife' });
  const draftData = {
    ...draft.data,
    title: 'Secret Warehouse Party',
    category: 'nightlife',
    startLocal: '2026-12-25T22:00',
    endLocal: '2026-12-26T04:00',
    city: 'Bengaluru',
    venue: 'Warehouse 9',
    description: 'Underground electronic dance party with top DJs and immersive visual atmosphere.',
    tickets: [{ id: 't_gen', name: 'General', category: 'general', kind: 'paid', pricePaise: 5000000, quantity: 10, admitCount: 1, maxPerBooking: 1 }]
  };
  const saved = await saveDraft(organiserBClient.userId, draft.id, { version: draft.version, step: 'tickets', data: draftData });
  const pub = await publishDraft(organiserBClient.user, draft.id, { version: saved.version, confirm: true });
  const event = (await db.query(`SELECT * FROM events WHERE id = $1`, [pub.eventId])).rows[0];
  const tiers = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub.eventId])).rows;

  // Booking of 1 ticket: ₹50,000 base -> ₹2,500 fee (250,000 paise)
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: attendeeClient.user,
    ticketTypeId: tiers[0].id,
    quantity: 1
  });
  await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    providerPaymentId: `UTR${Date.now()}`,
    verifiedAmountPaise: 5250000,
    merchantId: 'PGTESTPAYUAT',
    currency: 'INR',
    actor: 'test:adapter'
  });

  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE event_id = $1`, [event.id])).rows[0];
  assert.equal(inv.net_fee_payable_paise, 250000); // ₹2,500

  // 1st partial payment: Organiser submits ₹1,000
  const sub1 = await submitFeePayment({
    organiserId: organiserBClient.user.id,
    invoiceId: inv.id,
    amountPaise: 100000,
    utrNumber: `PARTIAL1-${Date.now()}`
  });

  // Admin verifies ₹1,000
  const conf1 = await confirmFeePayment({
    submissionId: sub1.submission.id,
    bankTxId: `BANK-TX-PARTIAL1-${Date.now()}`,
    verifiedAmountPaise: 100000,
    adminUser: financeClient.user
  });

  // Outstanding drops to ₹1,500 (150,000 paise), status partially_settled
  assert.equal(conf1.outstandingBalancePaise, 150000);
  const invAfterPart1 = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [inv.id])).rows[0];
  assert.equal(invAfterPart1.amount_paid_paise, 100000);
  assert.equal(invAfterPart1.outstanding_amount_paise, 150000);
  assert.equal(invAfterPart1.status, 'partially_settled');

  // 2nd partial payment: Organiser submits remaining ₹1,500
  const sub2 = await submitFeePayment({
    organiserId: organiserBClient.user.id,
    invoiceId: inv.id,
    amountPaise: 150000,
    utrNumber: `PARTIAL2-${Date.now()}`
  });

  // Admin verifies remaining ₹1,500
  const conf2 = await confirmFeePayment({
    submissionId: sub2.submission.id,
    bankTxId: `BANK-TX-PARTIAL2-${Date.now()}`,
    verifiedAmountPaise: 150000,
    adminUser: financeClient.user
  });

  // Outstanding is now 0, status fully_settled
  assert.equal(conf2.outstandingBalancePaise, 0);
  const invAfterPart2 = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [inv.id])).rows[0];
  assert.equal(invAfterPart2.amount_paid_paise, 250000);
  assert.equal(invAfterPart2.outstanding_amount_paise, 0);
  assert.equal(invAfterPart2.status, 'fully_settled');
});

test('9. Multiple invoices paid in one bank transaction allocation', async () => {
  // Create 2 events for Organiser A
  const draft1 = await createDraft(organiserAClient.user, { template: 'nightlife' });
  const saved1 = await saveDraft(organiserAClient.userId, draft1.id, {
    version: draft1.version, step: 'tickets',
    data: { ...draft1.data, title: 'Multi Inv Event 1', category: 'nightlife', startLocal: '2026-12-28T20:00', endLocal: '2026-12-29T02:00', city: 'Bengaluru', venue: 'Venue 1',
      description: 'First multi-invoice testing event with premium music and atmosphere.',
      tickets: [{ id: 't1', name: 'Pass 1', category: 'general', kind: 'paid', pricePaise: 200000, quantity: 10, admitCount: 1, maxPerBooking: 1 }] }
  });
  const pub1 = await publishDraft(organiserAClient.user, draft1.id, { version: saved1.version, confirm: true });

  const draft2 = await createDraft(organiserAClient.user, { template: 'nightlife' });
  const saved2 = await saveDraft(organiserAClient.userId, draft2.id, {
    version: draft2.version, step: 'tickets',
    data: { ...draft2.data, title: 'Multi Inv Event 2', category: 'nightlife', startLocal: '2026-12-29T20:00', endLocal: '2026-12-30T02:00', city: 'Bengaluru', venue: 'Venue 2',
      description: 'Second multi-invoice testing event with premium music and atmosphere.',
      tickets: [{ id: 't2', name: 'Pass 2', category: 'general', kind: 'paid', pricePaise: 300000, quantity: 10, admitCount: 1, maxPerBooking: 1 }] }
  });
  const pub2 = await publishDraft(organiserAClient.user, draft2.id, { version: saved2.version, confirm: true });

  const t1 = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub1.eventId])).rows[0];
  const t2 = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub2.eventId])).rows[0];

  // Book 1 ticket on Event 1 (Fee: ₹100 = 10,000 paise)
  const i1 = await createUpiPaymentIntent({ slug: pub1.slug, user: attendeeClient.user, ticketTypeId: t1.id });
  await applySuccessfulUpiPayment({ orderId: i1.orderId, providerPaymentId: `UTR${Date.now()}`, verifiedAmountPaise: 210000, merchantId: 'PGTESTPAYUAT', currency: 'INR', actor: 'test' });

  // Book 1 ticket on Event 2 (Fee: ₹150 = 15,000 paise)
  const i2 = await createUpiPaymentIntent({ slug: pub2.slug, user: attendeeClient.user, ticketTypeId: t2.id });
  await applySuccessfulUpiPayment({ orderId: i2.orderId, providerPaymentId: `UTR${Date.now()}`, verifiedAmountPaise: 315000, merchantId: 'PGTESTPAYUAT', currency: 'INR', actor: 'test' });

  const inv1 = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE event_id = $1`, [pub1.eventId])).rows[0];
  const inv2 = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE event_id = $1`, [pub2.eventId])).rows[0];

  assert.equal(inv1.outstanding_amount_paise, 10000); // ₹100
  assert.equal(inv2.outstanding_amount_paise, 15000); // ₹150

  // Organiser transfers ₹250 (25,000 paise) in ONE payment covering both invoices
  const subMulti = await submitFeePayment({
    organiserId: organiserAClient.user.id,
    amountPaise: 25000,
    utrNumber: `MULTI-UTR-${Date.now()}`,
    notes: 'Consolidated payment for Event 1 and Event 2'
  });

  // Admin allocates: ₹100 to Inv 1, ₹150 to Inv 2
  const confMulti = await confirmFeePayment({
    submissionId: subMulti.submission.id,
    bankTxId: `BANK-TX-MULTI-${Date.now()}`,
    verifiedAmountPaise: 25000,
    adminUser: financeClient.user,
    allocations: [
      { invoiceId: inv1.id, amountPaise: 10000 },
      { invoiceId: inv2.id, amountPaise: 15000 }
    ]
  });

  assert.equal(confMulti.receiptNumbers.length, 2, 'Must generate 2 distinct receipts');

  const inv1After = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [inv1.id])).rows[0];
  const inv2After = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE id = $1`, [inv2.id])).rows[0];

  assert.equal(inv1After.status, 'fully_settled');
  assert.equal(inv1After.outstanding_amount_paise, 0);
  assert.equal(inv2After.status, 'fully_settled');
  assert.equal(inv2After.outstanding_amount_paise, 0);
});

test('10. Bank credit over-allocation is strictly prevented', async () => {
  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices LIMIT 1`)).rows[0];
  const sub = await submitFeePayment({
    organiserId: organiserAClient.user.id,
    invoiceId: inv.id,
    amountPaise: 10000,
    utrNumber: `OVER-ALLOC-UTR-${Date.now()}`
  });

  // Try to allocate more than the verified bank amount
  await assert.rejects(
    async () => {
      await confirmFeePayment({
        submissionId: sub.submission.id,
        bankTxId: `BANK-TX-OVER-${Date.now()}`,
        verifiedAmountPaise: 10000,
        adminUser: financeClient.user,
        allocations: [{ invoiceId: inv.id, amountPaise: 20000 }] // ₹200 vs ₹100
      });
    },
    { message: /Allocation breakdown.*must match verified total/ }
  );
});

test('11. Rejected payment leaves outstanding balance unchanged', async () => {
  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE organiser_id = $1 LIMIT 1`, [organiserAClient.userId])).rows[0];
  const sub = await submitFeePayment({
    organiserId: organiserAClient.userId,
    invoiceId: inv.id,
    amountPaise: 5000,
    utrNumber: `REJECT-UTR-${Date.now()}`
  });

  const accBefore = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];

  // Admin rejects claim with mandatory reason
  const rejRes = await financeClient.post('/api/admin/finance/reject-payment', {
    submissionId: sub.submission.id,
    reason: 'UTR reference not found in bank transaction statement after reconciliation'
  });

  assert.equal(rejRes.status, 200);
  assert.equal(rejRes.json.ok, true);

  const accAfter = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.user.id])).rows[0];
  assert.equal(accAfter.outstanding_balance_paise, accBefore.outstanding_balance_paise, 'Outstanding balance must remain unchanged');
  assert.equal(accAfter.total_fee_paid_paise, accBefore.total_fee_paid_paise);
});

test('12. Organiser isolation: cannot view or pay another organiser\'s finances', async () => {
  // Organiser B attempts to access Organiser A's event finance
  const evA = (await db.query(`SELECT * FROM events WHERE organiser_user_id = $1 LIMIT 1`, [organiserAClient.user.id])).rows[0];
  const forbiddenRes = await organiserBClient.get(`/api/organiser/events/${evA.id}/finance`);
  assert.equal(forbiddenRes.status, 404, 'Must not reveal another organiser\'s event finances (returns 404)');

  // Organiser B attempts to submit payment against Organiser A's invoice
  const invA = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE organiser_id = $1 LIMIT 1`, [organiserAClient.user.id])).rows[0];
  const hackRes = await organiserBClient.post('/api/organiser/finance/submit-payment', {
    invoiceId: invA.id,
    amountPaise: 5000,
    utrNumber: `HACK-UTR-${Date.now()}`
  });
  // Does not affect Organiser A's invoice
  const subCreated = (await db.query(`SELECT * FROM organiser_fee_payment_submissions WHERE id = $1`, [hackRes.json.submission.id])).rows[0];
  assert.equal(subCreated.invoice_id, null, 'Invoice ID must be ignored if owned by another organiser');
});

test('13. Non-finance admin cannot confirm or reject payments', async () => {
  const sub = (await db.query(`SELECT * FROM organiser_fee_payment_submissions WHERE status = 'submitted' LIMIT 1`)).rows[0];
  if (!sub) return;

  // Event manager attempts to confirm payment
  const resConfirm = await eventManagerClient.post('/api/admin/finance/confirm-payment', {
    submissionId: sub.id,
    bankTxId: `UNAUTH-${Date.now()}`,
    verifiedAmountPaise: sub.amount_paise
  });
  assert.equal(resConfirm.status, 403, 'Event manager must be forbidden from confirming payments');
  assert.equal(resConfirm.json.error, 'forbidden_role');

  // Event manager attempts to reject payment
  const resReject = await eventManagerClient.post('/api/admin/finance/reject-payment', {
    submissionId: sub.id,
    reason: 'Unauthorized rejection attempt'
  });
  assert.equal(resReject.status, 403);
});

test('14. Fee rule updates are recorded in audit logs and do not alter historical bookings', async () => {
  // 1. Get current booking fee percentage
  const oldBooking = (await db.query(`SELECT * FROM bookings WHERE fee_percentage IS NOT NULL LIMIT 1`)).rows[0];
  const oldFee = oldBooking.infrastructure_fee_paise;
  const oldPct = oldBooking.fee_percentage;

  // 2. Finance admin updates fee percentage to 6.00%
  const updateRuleRes = await financeClient.post('/api/admin/finance/rules', {
    percentage: 6.00,
    name: 'Q1 Special Infrastructure Fee',
    notes: 'Seasonal platform rate adjustment'
  });
  assert.equal(updateRuleRes.status, 201);
  assert.equal(Number(updateRuleRes.json.rule.fee_percentage), 6.00);

  // 3. Historical booking must remain completely unchanged
  const oldBookingAfter = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [oldBooking.id])).rows[0];
  assert.equal(oldBookingAfter.infrastructure_fee_paise, oldFee, 'Historical fee must never be recalculated');
  assert.equal(oldBookingAfter.fee_percentage, oldPct, 'Historical applied percentage must be preserved');

  // 4. Audit log verifies commission rule update
  const ruleLog = (await db.query(`SELECT * FROM finance_audit_logs WHERE action = 'rule_updated' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.ok(ruleLog);
  assert.equal(ruleLog.actor_id, financeClient.admin.id);

  // Restore 5.00% default
  await setFeeRule({ percentage: 5.00, name: 'Standard 5% Rule', notes: 'Restored default', adminUser: financeClient.user });
});

test('15. Booking cancellation reverses fee, generates credit note, and updates balance', async () => {
  // Create an event with paid tickets
  const draft = await createDraft(organiserAClient.user, { template: 'nightlife' });
  const saved = await saveDraft(organiserAClient.userId, draft.id, {
    version: draft.version, step: 'tickets',
    data: { ...draft.data, title: 'Cancellation Reversal Event', category: 'nightlife', startLocal: '2026-12-30T21:00', endLocal: '2026-12-31T03:00', city: 'Bengaluru', venue: 'Club 1',
      description: 'Event to test cancellation and infrastructure fee reversal with credit note.',
      tickets: [{ id: 't_rev', name: 'Standard', category: 'general', kind: 'paid', pricePaise: 100000, quantity: 10, admitCount: 1, maxPerBooking: 1 }] }
  });
  const pub = await publishDraft(organiserAClient.user, draft.id, { version: saved.version, confirm: true });
  const tRev = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub.eventId])).rows[0];

  const intent = await createUpiPaymentIntent({ slug: pub.slug, user: attendeeClient.user, ticketTypeId: tRev.id });
  const conf = await applySuccessfulUpiPayment({ orderId: intent.orderId, providerPaymentId: `UTR${Date.now()}`, verifiedAmountPaise: 105000, merchantId: 'PGTESTPAYUAT', currency: 'INR', actor: 'test' });

  const accBefore = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.userId])).rows[0];
  const outstandingBefore = Number(accBefore.outstanding_balance_paise);

  // Reverse fee entry via refund/cancellation
  const reversal = await reverseBookingFeeEntry(conf.bookingId, { reason: 'Attendee requested full refund' });
  assert.ok(reversal);
  assert.equal(reversal.feeEntry.fee_amount_paise, 5000);
  assert.ok(reversal.adjustment.credit_note_number.startsWith('CN-'), 'Credit note must be issued');

  // Verify account outstanding balance decreased by fee amount (₹50)
  const accAfter = (await db.query(`SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`, [organiserAClient.userId])).rows[0];
  assert.equal(Number(accAfter.outstanding_balance_paise), outstandingBefore - 5000, 'Outstanding balance must decrease by reversed fee');
  assert.equal(accAfter.total_fee_reversal_paise, 5000);

  // Verify credit note recorded in finance_audit_logs
  const cnLog = (await db.query(`SELECT * FROM finance_audit_logs WHERE entity_type = 'credit_note' AND action = 'fee_reversed'`)).rows[0];
  assert.ok(cnLog);
});

test('16. Free-ticket flows remain unaffected: no fee accrued, no payment requested', async () => {
  const draft = await createDraft(organiserAClient.user, { template: 'nightlife' });
  const saved = await saveDraft(organiserAClient.userId, draft.id, {
    version: draft.version, step: 'tickets',
    data: { ...draft.data, title: 'Community Mixer (Free)', category: 'nightlife', startLocal: '2026-12-31T18:00', endLocal: '2026-12-31T22:00', city: 'Bengaluru', venue: 'Open Lawn',
      description: 'Community meetup with free entry for all registered members.',
      tickets: [{ id: 't_free', name: 'Free RSVP', category: 'general', kind: 'free', pricePaise: 0, quantity: 20, admitCount: 1, maxPerBooking: 1 }] }
  });
  const pub = await publishDraft(organiserAClient.user, draft.id, { version: saved.version, confirm: true });
  const tFree = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [pub.eventId])).rows[0];

  const bookRes = await bookTier(attendeeClient.user, pub.eventId, {
    ticketTypeId: tFree.id,
    quantity: 1
  });

  assert.equal(bookRes.status, 'confirmed');

  // Verify no fee entry was accrued
  const feeEntry = (await db.query(`SELECT * FROM infrastructure_fee_entries WHERE booking_id = $1`, [bookRes.bookingId])).rows[0];
  assert.equal(feeEntry, undefined, 'Free booking must never accrue infrastructure fee');
});

test('17. Attendee tickets remain valid and check-in works regardless of organiser fee balance', async () => {
  // Event where organiser has unpaid fees
  const event = (await db.query(`SELECT * FROM events WHERE title = 'Neon Skyline Party'`)).rows[0];
  const booking = (await db.query(`SELECT * FROM bookings WHERE event_id = $1 AND status = 'confirmed' LIMIT 1`, [event.id])).rows[0];
  const ticket = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1 AND status = 'valid' LIMIT 1`, [booking.id])).rows[0];

  assert.ok(ticket, 'Ticket must be valid');

  // Door check-in executed by organiser
  const checkInRes = await checkInTicket(organiserAClient.user, event.id, { ticketCode: ticket.ticket_code, method: 'manual_lookup' });
  assert.equal(checkInRes.ok, true);
  assert.equal(checkInRes.result, 'success');

  // Verify ticket status
  const checkedTicket = (await db.query(`SELECT * FROM tickets WHERE id = $1`, [ticket.id])).rows[0];
  assert.equal(checkedTicket.status, 'checked_in', 'Attendee valid ticket must never be blocked by organiser fee status');
});

test('18. Downloadable CSV statements work for organiser and admin', async () => {
  // Organiser financial statement CSV
  const orgCsvRes = await organiserAClient.get('/api/organiser/finance/statement');
  assert.equal(orgCsvRes.status, 200);
  assert.ok(orgCsvRes.headers.get('content-type').includes('text/csv'));
  assert.ok(orgCsvRes.text.includes('Gross Ticket Value (INR)'));
  assert.ok(orgCsvRes.text.includes('Infrastructure Fee (5%) (INR)'));

  // Admin finance export CSV
  const adminCsvRes = await financeClient.get('/api/admin/finance/export');
  assert.equal(adminCsvRes.status, 200);
  assert.ok(adminCsvRes.headers.get('content-type').includes('text/csv'));
  assert.ok(adminCsvRes.text.includes('Invoice Number,Payment Reference'));
});

test('19. Admin deadline extension updates invoice due date and records audit trail', async () => {
  const event = (await db.query(`SELECT * FROM events WHERE title = 'Neon Skyline Party'`)).rows[0];
  const newDate = '2027-01-15T18:00:00Z';

  const extRes = await financeClient.post('/api/admin/finance/extend-deadline', {
    eventId: event.id,
    newDeadline: newDate,
    reason: 'Organiser requested post-event settlement grace period'
  });

  assert.equal(extRes.status, 200);
  assert.equal(extRes.json.ok, true);

  const inv = (await db.query(`SELECT * FROM organiser_fee_invoices WHERE event_id = $1`, [event.id])).rows[0];
  assert.equal(new Date(inv.due_date).toISOString(), new Date(newDate).toISOString());

  const auditLog = (await db.query(`SELECT * FROM finance_audit_logs WHERE action = 'fee_deadline_extended' AND entity_id = $1`, [event.id])).rows[0];
  assert.ok(auditLog);
  assert.equal(auditLog.actor_id, financeClient.admin.id);
});
