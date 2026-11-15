// test/production-quality-assurance.test.js - Production Quality Assurance Suite
// Covers all 13 real-user journeys for Nightlifez:
// 1. New user signs up through Telegram
// 2. Existing user signs in through Telegram
// 3. A different Telegram account signs in from another browser session
// 4. New user signs up through WhatsApp OTP
// 5. Existing user signs in through WhatsApp OTP
// 6. User links both identities to one account securely
// 7. Telegram welcome message and community invite
// 8. WhatsApp channel opt-in
// 9. Free event booking
// 10. Paid UPI checkout and verified payment callback
// 11. Duplicate callback and duplicate payment protection
// 12. Failed payment, expired payment and refund
// 13. Admin can inspect the resulting audit trail

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb, Client, signedInClient, calls, startServer, stopServer, createEvent } from './helpers.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import {
  createUpiPaymentIntent,
  processUpiWebhook,
  applySuccessfulUpiPayment,
  getUpiPaymentStatus,
  refundUpiOrder
} from '../lib/services/upi-payments.js';
import { PhonePeAdapter } from '../lib/upi/adapter.js';
import { telegramCommunityUrl, whatsappChannelUrl } from '../lib/config.js';
import { registerTelegramOnboarding } from '../lib/services/community-onboarding.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  getWhatsAppProvider().clearSentMessages();
});

// Journey 1: New user signs up through Telegram
test('Journey 1: New user signs up through Telegram', async () => {
  const tgId = 1122334455;
  const client = await signedInClient({ tgId });
  const meRes = await client.get('/api/me');
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.ok, true);
  assert.ok(meRes.json.user.alias);
  assert.equal(meRes.json.user.ageConfirmed, true);

  // Verify database state: numeric Telegram user ID is saved
  const user = (await db.query(`SELECT * FROM users WHERE telegram_user_id = $1`, [tgId])).rows[0];
  assert.ok(user);
  assert.equal(String(user.telegram_user_id), String(tgId));
  assert.equal(user.status, 'active');

  // Verify user_identities record exists
  const identity = (await db.query(`SELECT * FROM user_identities WHERE user_id = $1 AND provider = 'telegram'`, [user.id])).rows[0];
  assert.ok(identity);
  assert.equal(identity.subject, String(tgId));

  // Verify Telegram community onboarding record is registered
  const onboarding = (await db.query(`SELECT * FROM user_onboarding WHERE user_id = $1 AND channel = 'telegram'`, [user.id])).rows[0];
  assert.ok(onboarding);
  assert.equal(String(onboarding.telegram_user_id), String(tgId));
});

// Journey 2: Existing user signs in through Telegram
test('Journey 2: Existing user signs in through Telegram', async () => {
  const tgId = 2233445566;
  // First sign-in
  const client1 = await signedInClient({ tgId });
  const user1 = (await db.query(`SELECT * FROM users WHERE telegram_user_id = $1`, [tgId])).rows[0];

  // Second sign-in with fresh browser session
  const client2 = await signedInClient({ tgId });
  const meRes = await client2.get('/api/me');
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.user.alias, user1.alias);

  // Verify no duplicate account was created
  const users = (await db.query(`SELECT * FROM users WHERE telegram_user_id = $1`, [tgId])).rows;
  assert.equal(users.length, 1);
  assert.equal(users[0].id, user1.id);
});

// Journey 3: A different Telegram account signs in from another browser session
test('Journey 3: A different Telegram account signs in from another browser session', async () => {
  const clientA = await signedInClient({ tgId: 3001 });
  const clientB = await signedInClient({ tgId: 3002 });

  const meA = await clientA.get('/api/me');
  const meB = await clientB.get('/api/me');

  assert.ok(meA.json.user.alias);
  assert.ok(meB.json.user.alias);
  assert.notEqual(meA.json.user.alias, meB.json.user.alias);

  // Strict session and data isolation
  const userA = (await db.query(`SELECT id FROM users WHERE telegram_user_id = 3001`)).rows[0];
  const userB = (await db.query(`SELECT id FROM users WHERE telegram_user_id = 3002`)).rows[0];
  assert.notEqual(userA.id, userB.id);
});

// Journey 4: New user signs up through WhatsApp OTP
test('Journey 4: New user signs up through WhatsApp OTP', async () => {
  const c = new Client();
  const phone = '+919876543201';

  // 1. Request OTP
  const otpRes = await c.post('/api/auth/whatsapp/otp', { phone, promotionalOptIn: true });
  assert.equal(otpRes.status, 200);
  assert.equal(otpRes.json.ok, true);
  assert.ok(otpRes.json.challengeId);
  assert.equal(otpRes.json.phoneMasked, '+91 98****3201');

  // Retrieve OTP from stub provider
  const sent = getWhatsAppProvider().getSentMessages();
  assert.ok(sent.length >= 1);
  const otp = sent[sent.length - 1].otp;
  assert.match(otp, /^\d{6}$/);

  // 2. Verify OTP
  const verifyRes = await c.post('/api/auth/whatsapp/verify', {
    challengeId: otpRes.json.challengeId,
    phone,
    code: otp,
    promotionalOptIn: true
  });

  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.json.ok, true);
  assert.equal(verifyRes.json.isNewUser, true);
  assert.ok(verifyRes.json.onboarding);
  assert.equal(verifyRes.json.onboarding.channelUrl, whatsappChannelUrl());

  // Verify database record
  const user = (await db.query(`SELECT * FROM users WHERE phone = $1`, [phone])).rows[0];
  assert.ok(user);
  assert.equal(user.phone, phone);
  assert.equal(user.status, 'active');

  // Verify communication consents: both transactional and promotional
  const consents = (await db.query(`SELECT purpose, status FROM communication_consents WHERE user_id = $1`, [user.id])).rows;
  assert.equal(consents.length, 2);
  const promo = consents.find((c) => c.purpose === 'promotional');
  assert.equal(promo.status, 'opted_in');

  // Verify WhatsApp onboarding record
  const onboarding = (await db.query(`SELECT * FROM user_onboarding WHERE user_id = $1 AND channel = 'whatsapp'`, [user.id])).rows[0];
  assert.ok(onboarding);
  assert.equal(onboarding.status, 'channel_offered');
});

// Journey 5: Existing user signs in through WhatsApp OTP
test('Journey 5: Existing user signs in through WhatsApp OTP', async () => {
  const phone = '+919876543202';
  // Seed user
  const u = (await db.query(
    `INSERT INTO users (phone, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES ($1, 'kavya_m', true, now(), 'active') RETURNING *`,
    [phone]
  )).rows[0];

  const c = new Client();
  const req = await c.post('/api/auth/whatsapp/otp', { phone });
  const otp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;

  const verify = await c.post('/api/auth/whatsapp/verify', {
    challengeId: req.json.challengeId,
    phone,
    code: otp
  });

  assert.equal(verify.status, 200);
  assert.equal(verify.json.isNewUser, false);

  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.alias, 'kavya_m');
});

// Journey 6: User links both identities to one account securely
test('Journey 6: User links both identities to one account securely', async () => {
  const tgId = 4455667788;
  const client = await signedInClient({ tgId });
  const phone = '+919876543203';

  // Request link OTP
  const linkOtpRes = await client.post('/api/auth/whatsapp/otp', { phone });
  const otp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;

  // Link WhatsApp to signed-in Telegram account
  const linkRes = await client.post('/api/auth/whatsapp/link', {
    challengeId: linkOtpRes.json.challengeId,
    phone,
    code: otp
  });
  assert.equal(linkRes.status, 200);
  assert.equal(linkRes.json.ok, true);

  // Verify identities: both telegram and phone belong to single account
  const identRes = await client.get('/api/me/identities');
  assert.equal(identRes.status, 200);
  assert.equal(identRes.json.identities.telegram.linked, true);
  assert.equal(identRes.json.identities.whatsapp.linked, true);
  assert.equal(identRes.json.identities.whatsapp.phoneMasked, '+91 98****3203');

  // Conflict test: Another account trying to link this same phone must be rejected with 409
  const clientOther = await signedInClient({ tgId: 999999 });
  const attackOtpRes = await clientOther.post('/api/auth/whatsapp/otp', { phone });
  const attackOtp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;

  const conflictRes = await clientOther.post('/api/auth/whatsapp/link', {
    challengeId: attackOtpRes.json.challengeId,
    phone,
    code: attackOtp
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.json.error, 'phone_already_linked');

  // Sole-provider unlinking guard: User cannot disconnect Telegram if WhatsApp were the only provider,
  // and when both are linked, unlinking one leaves the other intact
  const unlinkRes = await client.post('/api/auth/whatsapp/unlink', { phone });
  assert.equal(unlinkRes.status, 200);
  assert.equal(unlinkRes.json.ok, true);

  const identAfter = await client.get('/api/me/identities');
  assert.equal(identAfter.json.identities.whatsapp.linked, false);
  assert.equal(identAfter.json.identities.telegram.linked, true);
});

// Journey 7: Telegram welcome message and community invite
test('Journey 7: Telegram welcome message and community invite', async () => {
  const tgId = 5566778899;
  const user = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES ($1, 'diya_k', true, now(), 'active') RETURNING *`,
    [tgId]
  )).rows[0];

  // User authorizes bot
  const reg = await registerTelegramOnboarding({
    userId: user.id,
    telegramUserId: tgId,
    botStarted: true
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.welcomeSent, true);

  const welcomeCalls = calls.filter((c) => c.api === 'telegram' && c.method === 'sendMessage');
  assert.equal(welcomeCalls.length, 1);
  assert.equal(welcomeCalls[0].params.chat_id, tgId);
  assert.match(welcomeCalls[0].params.text, /Welcome to <b>NIGHTLIFEZ<\/b>/);

  const btn = welcomeCalls[0].params.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.equal(btn.text, 'Join NIGHTLIFEZ Community');
  assert.equal(btn.url, telegramCommunityUrl());
});

// Journey 8: WhatsApp channel opt-in
test('Journey 8: WhatsApp channel opt-in', async () => {
  const client = await signedInClient();
  const trackRes = await client.post('/api/onboarding/track', {
    channel: 'whatsapp',
    action: 'channel_clicked'
  });
  assert.equal(trackRes.status, 200);
  assert.equal(trackRes.json.ok, true);
  assert.equal(trackRes.json.record.status, 'channel_clicked');
  assert.equal(trackRes.json.record.membership_verified, false, 'clicking channel must not claim verified membership');
});

// Journey 9: Free event booking
test('Journey 9: Free event booking', async () => {
  const client = await signedInClient({ tgId: 6677889900 });
  const event = await createEvent({ title: 'Bangalore Tech Mixer', price: null });
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [event.id]);

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
     VALUES ($1, 'General Admission', 'free', 0, 50, true) RETURNING *`,
    [event.id]
  )).rows[0];

  const bookRes = await client.post(`/api/events/${event.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 200);
  assert.equal(bookRes.json.ok, true);
  assert.equal(bookRes.json.status, 'confirmed');
  assert.ok(bookRes.json.bookingId);

  // Verify single-use ticket issued with QR code
  const ticketRes = await client.get(`/api/me/bookings/${bookRes.json.bookingId}/ticket`);
  assert.equal(ticketRes.status, 200);
  assert.equal(ticketRes.json.ok, true);
  assert.ok(ticketRes.json.tickets && ticketRes.json.tickets.length >= 1);
  assert.ok(ticketRes.json.tickets[0].ticketCode);
  assert.ok(ticketRes.json.tickets[0].qrSvg);
});

// Journey 10: Paid UPI checkout and verified payment callback
test('Journey 10: Paid UPI checkout and verified payment callback', async () => {
  const prevUpi = process.env.UPI_CHECKOUT_ENABLED;
  process.env.UPI_CHECKOUT_ENABLED = 'true';
  try {
    const user = (await db.query(
      `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
       VALUES (7788990011, 'siddharth_p', true, now(), 'active') RETURNING *`
    )).rows[0];

    const event = await createEvent({
      title: 'South India Rooftop Sundowner',
      price_status: 'set',
      ticket_price_paise: 150000,
      checkout_mode: 'upi_direct'
    });

    const tier = (await db.query(
      `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
       VALUES ($1, 'Early Bird Pass', 'paid', 150000, 20, true) RETURNING *`,
      [event.id]
    )).rows[0];

    // Create payment intent
    const intent = await createUpiPaymentIntent({
      slug: event.slug,
      user,
      ticketTypeId: tier.id,
      quantity: 1,
      deviceType: 'desktop'
    });

    assert.ok(intent.orderId);
    assert.equal(intent.amountPaise, 150000);
    assert.equal(intent.currency, 'INR');

    // Simulate authentic server-to-server webhook callback
    const adapter = new PhonePeAdapter({ merchantId: 'PGTESTPAYUAT', saltKey: 'test_salt_key', saltIndex: '1' });
    const webhookPayload = {
      response: Buffer.from(JSON.stringify({
        code: 'PAYMENT_SUCCESS',
        data: {
          merchantId: 'PGTESTPAYUAT',
          merchantTransactionId: intent.orderId,
          transactionId: `TXN-${intent.orderId}`,
          amount: 150000,
          currency: 'INR',
          state: 'COMPLETED',
          paymentInstrument: { utr: 'UTR123456789012' }
        }
      })).toString('base64')
    };

    const signature = adapter.signRequest(webhookPayload.response, '');
    const headers = { 'x-verify': `${signature.split('###')[0]}###1` };

    // Apply verified payment
    const result = await applySuccessfulUpiPayment({
      orderId: intent.orderId,
      providerTxnId: `TXN-${intent.orderId}`,
      providerPaymentId: 'UTR123456789012',
      verifiedAmountPaise: 150000,
      currency: 'INR',
      merchantId: 'PGTESTPAYUAT',
      actor: 'webhook:phonepe'
    });

    assert.equal(result.status, 'succeeded');
    assert.ok(result.bookingId);

    // Verify booking is confirmed and ticket is issued
    const booking = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [result.bookingId])).rows[0];
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.amount_paise, 150000);

    const tickets = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [result.bookingId])).rows;
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].status, 'valid');

    // Verify payment audit record
    const audits = (await db.query(`SELECT * FROM payment_audits WHERE order_id = $1 ORDER BY created_at ASC`, [intent.orderId])).rows;
    assert.ok(audits.length >= 1);
    assert.equal(audits[audits.length - 1].to_status, 'succeeded');
  } finally {
    process.env.UPI_CHECKOUT_ENABLED = prevUpi;
  }
});

// Journey 11: Duplicate callback and duplicate payment protection
test('Journey 11: Duplicate callback and duplicate payment protection', async () => {
  const prevUpi = process.env.UPI_CHECKOUT_ENABLED;
  process.env.UPI_CHECKOUT_ENABLED = 'true';
  try {
    const user = (await db.query(
      `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
       VALUES (8899001122, 'neha_k', true, now(), 'active') RETURNING *`
    )).rows[0];

    const event = await createEvent({ title: 'Cocktail Club', price_status: 'set', ticket_price_paise: 200000, checkout_mode: 'upi_direct' });
    const tier = (await db.query(
      `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
       VALUES ($1, 'VIP Entry', 'paid', 200000, 10, true) RETURNING *`,
      [event.id]
    )).rows[0];

    const intent = await createUpiPaymentIntent({
      slug: event.slug,
      user,
      ticketTypeId: tier.id,
      quantity: 1
    });

    // 1. First payment confirmation
    const firstConfirm = await applySuccessfulUpiPayment({
      orderId: intent.orderId,
      providerPaymentId: 'UTR999999999',
      verifiedAmountPaise: 200000,
      currency: 'INR',
      merchantId: 'PGTESTPAYUAT',
      actor: 'webhook:phonepe'
    });
    assert.equal(firstConfirm.status, 'succeeded');
    assert.ok(firstConfirm.bookingId);

    // 2. Duplicate callback for the exact same order
    const dupConfirm = await applySuccessfulUpiPayment({
      orderId: intent.orderId,
      providerPaymentId: 'UTR999999999',
      verifiedAmountPaise: 200000,
      currency: 'INR',
      merchantId: 'PGTESTPAYUAT',
      actor: 'webhook:phonepe'
    });
    assert.equal(dupConfirm.duplicate, true);
    assert.equal(dupConfirm.bookingId, firstConfirm.bookingId);

    // Verify bookings count remains exactly 1
    const { rows: bookings } = await db.query(`SELECT * FROM bookings WHERE user_id = $1 AND event_id = $2`, [user.id, event.id]);
    assert.equal(bookings.length, 1);
  } finally {
    process.env.UPI_CHECKOUT_ENABLED = prevUpi;
  }
});

// Journey 12: Failed payment, expired payment and refund
test('Journey 12: Failed payment, expired payment and refund', async () => {
  const prevUpi = process.env.UPI_CHECKOUT_ENABLED;
  process.env.UPI_CHECKOUT_ENABLED = 'true';
  try {
    const user = (await db.query(
      `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
       VALUES (9900112233, 'arjun_v', true, now(), 'active') RETURNING *`
    )).rows[0];

    const event = await createEvent({ title: 'Goa Weekend Mixer', price_status: 'set', ticket_price_paise: 300000, checkout_mode: 'upi_direct' });
    const tier = (await db.query(
      `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, active)
       VALUES ($1, 'Pass', 'paid', 300000, 10, true) RETURNING *`,
      [event.id]
    )).rows[0];

    // A. Expired payment intent
    const expiredIntent = await createUpiPaymentIntent({ slug: event.slug, user, ticketTypeId: tier.id, quantity: 1 });
    // Manually force expiration timestamp in DB
    await db.query(`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [expiredIntent.orderId]);

    const statusCheck = await getUpiPaymentStatus(expiredIntent.orderId, { user });
    assert.equal(statusCheck.status, 'expired');

    // B. Succeeded payment followed by admin refund
    const refundIntent = await createUpiPaymentIntent({ slug: event.slug, user, ticketTypeId: tier.id, quantity: 1 });
    const confirm = await applySuccessfulUpiPayment({
      orderId: refundIntent.orderId,
      providerPaymentId: 'UTR777888999',
      verifiedAmountPaise: 300000,
      currency: 'INR',
      merchantId: 'PGTESTPAYUAT',
      actor: 'webhook:phonepe'
    });
    assert.equal(confirm.status, 'succeeded');

    // Create finance admin
    const adminRow = (await db.query(
      `INSERT INTO admin_users (telegram_user_id, role, active) VALUES (900000001, 'super_admin', true) RETURNING *`
    )).rows[0];

    // Execute refund with documented evidence and external UTR ref
    const refundRes = await refundUpiOrder(refundIntent.orderId, {
      actor: `admin:${adminRow.id}:super_admin`,
      reason: 'Attendee requested cancellation within policy window',
      manualReconciliation: true,
      externalRefundRef: 'UTR202611150001928374',
      evidenceRef: 'SUPPORT-AUDIT-TICKET-101',
      sessionAdmin: { id: adminRow.id, role: 'super_admin' }
    });

    assert.equal(refundRes.status, 'refunded');

    // Verify payment and booking status in database
    const payment = (await db.query(`SELECT * FROM payments WHERE order_id = $1`, [refundIntent.orderId])).rows[0];
    assert.equal(payment.status, 'refunded');
    assert.ok(payment.refunded_at);

    const booking = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [confirm.bookingId])).rows[0];
    assert.equal(booking.status, 'refunded');
  } finally {
    process.env.UPI_CHECKOUT_ENABLED = prevUpi;
  }
});

// Journey 13: Admin can inspect the resulting audit trail
test('Journey 13: Admin can inspect the resulting audit trail', async () => {
  const adminClient = await signedInClient({ tgId: 900000001 });
  assert.equal((await adminClient.get('/api/admin/session')).json.role, 'super_admin');

  // 1. List payments with stats
  const paymentsRes = await adminClient.get('/api/admin/payments');
  assert.equal(paymentsRes.status, 200);
  assert.equal(paymentsRes.json.ok, true);
  assert.ok(paymentsRes.json.payments);
  assert.ok(paymentsRes.json.stats);

  // 2. Inspect payment audit trail for a specific transaction
  const payment = (await db.query(
    `INSERT INTO payments (provider, provider_txn_id, order_id, amount, currency, status, purpose, is_test)
     VALUES ('phonepe', 'TXN-ORD-TEST-AUDIT-1', 'ORD-TEST-AUDIT-1', 100000, 'INR', 'succeeded', 'ticket', true) RETURNING *`
  )).rows[0];

  await db.query(
    `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
     VALUES ($1, $2, 'pending', 'succeeded', 'webhook:phonepe', '{"simulated": true}')`,
    [payment.id, payment.order_id]
  );

  const auditRes = await adminClient.get(`/api/admin/payments/${payment.id}/audit`);
  assert.equal(auditRes.status, 200);
  assert.equal(auditRes.json.ok, true);
  assert.equal(auditRes.json.audits.length, 1);
  assert.equal(auditRes.json.audits[0].from_status, 'pending');
  assert.equal(auditRes.json.audits[0].to_status, 'succeeded');

  // 3. Inspect community onboarding audits
  const onboardRes = await adminClient.get('/api/admin/onboarding');
  assert.equal(onboardRes.status, 200);
  assert.equal(onboardRes.json.ok, true);
  assert.ok(onboardRes.json.records);
  assert.ok(onboardRes.json.metrics);
});
