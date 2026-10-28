// test/organiser.test.js - Organiser wizard: drafts, tiers, features, preview, publish, and guest
// booking of tiers (free, paid without a provider, approval, questions, pickup, concurrency, privacy).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, db, signedInClient, clearCalls, calls } from './helpers.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(() => { clearCalls(); delete process.env.TICKET_CHECKOUT_ENABLED; });

/** IST wall-clock 'YYYY-MM-DDTHH:mm', `days` from now at 19:00. */
function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function organiserClient() {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

function validData(overrides = {}) {
  return {
    template: 'social', category: 'meetup', title: 'Sunday Board Games Social', timezone: 'Asia/Kolkata',
    startLocal: istLocal(10, '17:00'), endLocal: istLocal(10, '21:00'), multiDay: false,
    venue: 'Cafe Tabletop, 4th Cross', city: 'Bengaluru', area: 'Indiranagar', privateVenue: false,
    description: 'Board games with strangers. Arrive by 5, games till 9. Snacks available to buy. 21+ only, photo ID needed.',
    tickets: [{ id: 'free1', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2, validOn: 'all' }],
    features: {},
    ...overrides
  };
}

async function newDraft(c, data) {
  const r = await c.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(r.status, 201, r.text);
  let draft = r.json.draft;
  if (data) {
    const s = await c.req('PUT', `/api/organiser/drafts/${draft.id}`, { data, step: 'preview', version: draft.version });
    assert.equal(s.status, 200, s.text);
    draft = s.json.draft;
  }
  return draft;
}

async function publish(c, data) {
  const d = await newDraft(c, data);
  const r = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: true });
  assert.equal(r.status, 200, r.text);
  const event = await db.one('SELECT * FROM events WHERE id = $1', [r.json.eventId]);
  const tiers = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY sort_order', [event.id])).rows;
  return { ...r.json, event, tiers, draft: d };
}

test('only organisers can use the wizard; others see an access notice', async () => {
  const guest = await signedInClient();
  assert.equal((await guest.post('/api/organiser/drafts', {})).status, 403);
  assert.equal((await new Client().get('/api/organiser/drafts')).status, 401);
  const page = await guest.get('/organiser/new');
  assert.equal(page.status, 200);
  assert.match(page.text, /Organiser access is by invitation/);
  assert.match((await new Client().get('/organiser/new')).text, /Sign in with Telegram to create/);

  const org = await organiserClient();
  const ok = await org.get('/organiser/new');
  assert.match(ok.text, /id="wz-config"/);
  assert.match(ok.text, /noindex/);
});

test('super admin grants organiser access (audited)', async () => {
  const admin = await signedInClient({ tgId: 900000001 });
  const person = await signedInClient();
  const r = await admin.post('/api/admin/organisers', { telegram_user_id: person.tgId, enabled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal((await person.post('/api/organiser/drafts', {})).status, 201);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'organiser.set'`));
  assert.equal((await person.post('/api/admin/organisers', { telegram_user_id: person.tgId, enabled: true })).status, 403);
});

test('create a draft from a template, save progress, and resume it later', async () => {
  const c = await organiserClient();
  const r = await c.post('/api/organiser/drafts', { template: 'trip' });
  assert.equal(r.status, 201);
  const d = r.json.draft;
  assert.equal(d.data.category, 'weekend_trip');
  assert.equal(d.data.multiDay, true);
  assert.equal(d.data.features.pickup.enabled, true);
  assert.equal(d.data.tickets[0].name, 'General');
  assert.equal(d.data.tickets[0].pricePaise, undefined, 'templates never invent prices');

  const data = { ...d.data, title: 'Coorg Weekend', city: 'Bengaluru' };
  const s = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data, step: 'tickets', version: d.version });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.draft.version, d.version + 1);
  assert.ok(Array.isArray(s.json.draft.issues), 'save returns publish issues for inline display');

  // "Come back later": list + fetch return the saved state and step.
  const list = await c.get('/api/organiser/drafts');
  assert.equal(list.json.drafts.find((x) => x.id === d.id).data.title, 'Coorg Weekend');
  const again = await c.get(`/api/organiser/drafts/${d.id}`);
  assert.equal(again.json.draft.step, 'tickets');
  assert.equal(again.json.draft.data.title, 'Coorg Weekend');
});

test('moving between steps keeps every field; stale saves are rejected, not overwritten', async () => {
  const c = await organiserClient();
  const d = await newDraft(c);
  let v = d.version;
  const data = validData({ features: { questions: { enabled: true, items: [{ id: 'q1', label: 'Instagram handle', type: 'short', required: false }] } } });
  for (const step of ['tickets', 'features', 'preview', 'basics', 'tickets']) {
    const s = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data, step, version: v });
    assert.equal(s.status, 200, s.text);
    v = s.json.draft.version;
    assert.deepEqual(s.json.draft.data, data);
  }
  // Another tab still holds the old version.
  const stale = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data: { ...data, title: 'Older tab' }, step: 'basics', version: v - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'version_conflict');
  assert.equal(stale.json.draft.version, v);
  assert.equal(stale.json.draft.data.title, data.title);
});

test('drafts are private to their organiser', async () => {
  const owner = await organiserClient();
  const other = await organiserClient();
  const d = await newDraft(owner, validData());
  assert.equal((await other.get(`/api/organiser/drafts/${d.id}`)).status, 404);
  assert.equal((await other.req('PUT', `/api/organiser/drafts/${d.id}`, { data: validData({ title: 'Hijack' }), step: 'basics', version: d.version })).status, 404);
  assert.equal((await other.req('DELETE', `/api/organiser/drafts/${d.id}`)).status, 404);
  assert.equal((await other.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: true })).status, 404);
  assert.equal((await other.get(`/organiser/drafts/${d.id}/preview`)).status, 404);
  assert.equal((await other.get(`/api/organiser/drafts/${d.id}/check`)).status, 404);
  assert.ok(!(await other.get('/api/organiser/drafts')).json.drafts.some((x) => x.id === d.id));
  assert.equal((await owner.get(`/api/organiser/drafts/${d.id}`)).json.draft.data.title, 'Sunday Board Games Social');
});

test('start fresh discards the old draft; it cannot be resumed or edited', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData());
  assert.equal((await c.req('DELETE', `/api/organiser/drafts/${d.id}`)).status, 200);
  assert.ok(!(await c.get('/api/organiser/drafts')).json.drafts.some((x) => x.id === d.id));
  const s = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data: validData(), step: 'basics', version: d.version });
  assert.equal(s.status, 409);
  assert.equal(s.json.error, 'draft_closed');
});

test('ticket tiers: multiple tiers and price / quantity / booking-limit validation', async () => {
  const c = await organiserClient();
  const bad = validData({
    tickets: [
      { id: 'a', name: 'Early bird', kind: 'paid', pricePaise: -500, quantity: 10, maxPerBooking: 2 },
      { id: 'b', name: 'General', kind: 'paid', pricePaise: 49900, quantity: -1, maxPerBooking: 2 },
      { id: 'c', name: 'VIP', kind: 'paid', pricePaise: 150000, quantity: 3, maxPerBooking: 5 },
      { id: 'd', name: 'Free entry', kind: 'free', pricePaise: 20000, quantity: 5, maxPerBooking: 0 },
      { id: 'e', name: 'general', kind: 'paid', pricePaise: 50, quantity: 5, maxPerBooking: 1 }
    ]
  });
  const d = await newDraft(c, bad);
  const fields = (await c.get(`/api/organiser/drafts/${d.id}/check`)).json.issues.filter((i) => i.severity === 'error').map((i) => i.field);
  for (const f of ['tickets.0.pricePaise', 'tickets.1.quantity', 'tickets.2.maxPerBooking', 'tickets.3.pricePaise', 'tickets.3.maxPerBooking', 'tickets.4.name', 'tickets.4.pricePaise', 'refundPolicy']) {
    assert.ok(fields.includes(f), `expected issue for ${f}; got ${fields.join(', ')}`);
  }
  const r = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: true });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'not_ready');
  assert.equal(await db.one('SELECT 1 FROM events WHERE draft_id = $1', [d.id]), null);

  const good = await publish(c, validData({
    refundPolicy: 'Full refund up to 48 hours before the event.',
    tickets: [
      { id: 'f', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 2 },
      { id: 'g', name: 'General', kind: 'paid', pricePaise: 49900, quantity: 20, maxPerBooking: 4 },
      { id: 'h', name: 'VIP', kind: 'paid', pricePaise: 150000, quantity: 5, maxPerBooking: 2 }
    ]
  }));
  assert.deepEqual(good.tiers.map((t) => [t.name, t.kind, t.price_paise, t.quantity]), [['Free entry', 'free', 0, 10], ['General', 'paid', 49900, 20], ['VIP', 'paid', 150000, 5]]);
  assert.equal(good.event.capacity, 35);
  assert.equal(good.event.ticketing, 'tiers');
});

test('the database itself refuses a priced free tier', async () => {
  const c = await organiserClient();
  const { event } = await publish(c, validData());
  await assert.rejects(db.query(`INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity) VALUES ($1, 'Sneaky', 'free', 100, 1)`, [event.id]), /ticket_price_kind/);
});

test('free ticket books without any payment integration', async () => {
  const c = await organiserClient();
  const { event, tiers } = await publish(c, validData());
  const guest = await signedInClient();
  const r = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'confirmed');
  assert.equal(r.json.checkoutUrl, null);
  const b = await db.one('SELECT * FROM bookings WHERE id = $1', [r.json.bookingId]);
  assert.equal(b.payment_mode, 'free');
  assert.equal(b.payment_id, null);
  assert.equal(b.quantity, 2);
  assert.equal((await db.query('SELECT 1 FROM payments WHERE booking_id = $1', [b.id])).rowCount, 0);
  assert.equal(calls.filter((x) => x.api === 'razorpay' || x.api === 'cashfree').length, 0);
  const view = (await guest.get(`/api/bookings/${b.id}`)).json.booking;
  assert.equal(view.paymentStatus, 'not_required');
  assert.equal(view.isTest, false, 'no payment, so no "test mode" label');
  // Over the per-booking limit.
  const g2 = await signedInClient();
  const over = await g2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 3 });
  assert.equal(over.status, 400);
  // Same guest again: returns the existing booking, never a second one.
  const again = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  assert.equal(again.json.bookingId, r.json.bookingId);
  assert.equal(again.json.existing, true);
});

test('paid tiers with no payment provider: honest UI, no checkout, all-paid events cannot publish', async () => {
  const c = await organiserClient();
  const allPaid = await newDraft(c, validData({ refundPolicy: 'No refunds within 24 hours.', tickets: [{ id: 'p', name: 'General', kind: 'paid', pricePaise: 49900, quantity: 10, maxPerBooking: 2 }] }));
  const r = await c.post(`/api/organiser/drafts/${allPaid.id}/publish`, { version: allPaid.version, confirm: true });
  assert.equal(r.status, 422);
  assert.match(r.json.issues.map((i) => i.message).join(' '), /Online payment is not available yet/);

  const { event, tiers } = await publish(c, validData({
    refundPolicy: 'No refunds within 24 hours.',
    tickets: [{ id: 'f', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 2 }, { id: 'p', name: 'Supporter', kind: 'paid', pricePaise: 49900, quantity: 10, maxPerBooking: 2 }]
  }));
  const page = await new Client().get(`/events/${event.slug}`);
  assert.match(page.text, /Online payment isn’t available yet/);
  assert.match(page.text, /Online payment not available yet/);
  const guest = await signedInClient();
  const paid = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[1].id, quantity: 1 });
  assert.equal(paid.status, 409);
  assert.equal(paid.json.error, 'payment_unavailable');
  assert.equal((await db.query('SELECT 1 FROM bookings WHERE event_id = $1', [event.id])).rowCount, 0);
  assert.equal(calls.filter((x) => x.api === 'razorpay').length, 0);
  const ctx = await c.get('/api/organiser/context');
  assert.equal(ctx.json.checkout.available, false);
});

test('an unverified payment never becomes paid: only a signed provider webhook confirms', async () => {
  process.env.TICKET_CHECKOUT_ENABLED = 'true'; // explicit opt-in, sandbox keys from the test env
  const c = await organiserClient();
  const { event, tiers } = await publish(c, validData({ refundPolicy: 'Full refund up to 48 hours before.', tickets: [{ id: 'p', name: 'General', kind: 'paid', pricePaise: 49900, quantity: 5, maxPerBooking: 2 }] }));
  const guest = await signedInClient();
  // A client cannot claim payment.
  const claim = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 2, paid: true });
  assert.equal(claim.status, 400);
  const r = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'pending_payment');
  assert.match(r.json.checkoutUrl, /^https:\/\/rzp\.io\//);
  const pay = await db.one('SELECT * FROM payments WHERE booking_id = $1', [r.json.bookingId]);
  assert.equal(Number(pay.amount), 99800);
  // "I have paid" style redirect params do nothing.
  await guest.get(`/bookings/${r.json.bookingId}?razorpay_payment_link_status=paid&razorpay_payment_id=pay_fake`);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [r.json.bookingId])).status, 'pending_payment');
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [pay.id])).status, 'created');
  const view = await guest.get(`/api/bookings/${r.json.bookingId}`);
  assert.equal(view.json.booking.venue, null);

  const body = JSON.stringify({ entity: 'event', event: 'payment_link.paid', payload: {
    payment_link: { entity: { id: pay.provider_txn_id, amount: 99800, amount_paid: 99800, status: 'paid', currency: 'INR' } },
    payment: { entity: { id: 'pay_real1', amount: 99800, currency: 'INR', status: 'captured', notes: {} } } } });
  const sig = crypto.createHmac('sha256', 'test_rzp_webhook_secret').update(body).digest('hex');
  const forged = await new Client().req('POST', '/api/payments/webhook/razorpay', body, { 'content-type': 'application/json', 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'evt_x' });
  assert.equal(forged.status, 401);
  const wh = await new Client().req('POST', '/api/payments/webhook/razorpay', body, { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_tier1' });
  assert.equal(wh.json.result, 'confirmed');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [r.json.bookingId])).status, 'confirmed');
});

test('guest approval on: requests wait for the host; decline blocks; approve confirms a free ticket', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ features: { approval: { enabled: true } } }));
  assert.equal(event.requires_approval, true);
  const page = await new Client().get(`/events/${event.slug}`);
  assert.match(page.text, /Request to join/);

  const g1 = await signedInClient();
  const req1 = await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  assert.equal(req1.json.status, 'pending_approval');
  const dup = await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  assert.equal(dup.json.bookingId, req1.json.bookingId, 'no duplicate requests');
  assert.equal((await db.one(`SELECT count(*)::int n FROM bookings WHERE event_id = $1`, [event.id])).n, 1);
  assert.ok(await db.one(`SELECT 1 FROM notifications WHERE kind = 'booking_request' AND booking_id = $1`, [req1.json.bookingId]));

  // Someone else cannot decide it.
  const stranger = await organiserClient();
  assert.equal((await stranger.post(`/api/organiser/bookings/${req1.json.bookingId}/approve`, {})).status, 404);
  assert.equal((await g1.post(`/api/organiser/bookings/${req1.json.bookingId}/approve`, {})).status, 404);

  const dec = await host.post(`/api/organiser/bookings/${req1.json.bookingId}/decline`, {});
  assert.equal(dec.json.status, 'declined');
  const retry = await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 1 });
  assert.equal(retry.status, 409);
  assert.equal(retry.json.error, 'declined');

  const g2 = await signedInClient();
  const req2 = await g2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, quantity: 2 });
  const ok = await host.post(`/api/organiser/bookings/${req2.json.bookingId}/approve`, {});
  assert.equal(ok.json.status, 'confirmed');
  assert.equal((await host.post(`/api/organiser/bookings/${req2.json.bookingId}/approve`, {})).status, 409);
  const guests = await host.get(`/api/organiser/events/${event.id}/guests`);
  assert.deepEqual(guests.json.guests.map((x) => x.status).sort(), ['confirmed', 'declined']);
  assert.equal((await stranger.get(`/api/organiser/events/${event.id}/guests`)).status, 404);
});

test('approval does not imply payment: a paid request cannot be approved without a provider', async () => {
  process.env.TICKET_CHECKOUT_ENABLED = 'true';
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ refundPolicy: 'Refund until 2 days before.', features: { approval: { enabled: true } },
    tickets: [{ id: 'p', name: 'General', kind: 'paid', pricePaise: 30000, quantity: 5, maxPerBooking: 1 }] }));
  const g = await signedInClient();
  const req = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id });
  assert.equal(req.json.status, 'pending_approval');
  assert.equal((await db.query('SELECT 1 FROM payments WHERE booking_id = $1', [req.json.bookingId])).rowCount, 0, 'a request creates no payment');
  delete process.env.TICKET_CHECKOUT_ENABLED; // provider withdrawn before the host decides
  const r = await host.post(`/api/organiser/bookings/${req.json.bookingId}/approve`, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'payment_unavailable');
  const b = await db.one('SELECT status, payment_id FROM bookings WHERE id = $1', [req.json.bookingId]);
  assert.equal(b.status, 'pending_approval');
  assert.equal(b.payment_id, null);

  process.env.TICKET_CHECKOUT_ENABLED = 'true';
  const ok = await host.post(`/api/organiser/bookings/${req.json.bookingId}/approve`, {});
  assert.equal(ok.json.status, 'pending_payment', 'approved, but not paid');
  const pay = await db.one('SELECT status FROM payments WHERE booking_id = $1', [req.json.bookingId]);
  assert.equal(pay.status, 'created');
});

test('guest approval off: free bookings confirm immediately', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ features: { approval: { enabled: false } } }));
  assert.equal(event.requires_approval, false);
  const g = await signedInClient();
  assert.equal((await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id })).json.status, 'confirmed');
});

test('required custom questions are enforced; answers reach the organiser only', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ features: { questions: { enabled: true, items: [
    { id: 'diet', label: 'Dietary preference', type: 'single', options: ['Vegetarian', 'Non-vegetarian'], required: true },
    { id: 'ig', label: 'Instagram handle', type: 'short', required: false },
    { id: 'likes', label: 'Games you like', type: 'multi', options: ['Catan', 'Codenames', 'Uno'], required: false }
  ] } } }));
  const g = await signedInClient();
  const missing = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, answers: { ig: '@me' } });
  assert.equal(missing.status, 400);
  assert.ok(missing.json.fields.some((f) => f.field === 'answers.diet'));
  const invalid = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, answers: { diet: 'Pizza' } });
  assert.equal(invalid.status, 400);
  const badMulti = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, answers: { diet: 'Vegetarian', likes: ['Chess'] } });
  assert.equal(badMulti.status, 400);
  const ok = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, answers: { diet: 'Vegetarian', ig: '@me', likes: ['Uno', 'Catan'] } });
  assert.equal(ok.status, 200, ok.text);
  const guests = (await host.get(`/api/organiser/events/${event.id}/guests`)).json;
  assert.deepEqual(guests.guests[0].answers, { diet: 'Vegetarian', ig: '@me', likes: ['Uno', 'Catan'] });
  const pub = await new Client().get('/api/events');
  assert.ok(!pub.text.includes('@me'));
});

test('question setup is validated before publishing', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData({ features: { questions: { enabled: true, items: [{ id: 'x', label: 'Pick one', type: 'single', options: ['Only'], required: false }] } } }));
  const issues = (await c.get(`/api/organiser/drafts/${d.id}/check`)).json.issues;
  assert.ok(issues.some((i) => i.field === 'features.questions.items.0.options'));
});

test('inventory holds under concurrent bookings (no overselling a tier)', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ tickets: [
    { id: 'a', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 3, maxPerBooking: 1 },
    { id: 'b', name: 'Standing', kind: 'free', pricePaise: 0, quantity: 50, maxPerBooking: 1 }
  ] }));
  const guests = await Promise.all(Array.from({ length: 8 }, () => signedInClient()));
  const results = await Promise.all(guests.map((g) => g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id })));
  assert.equal(results.filter((r) => r.json?.status === 'confirmed').length, 3);
  assert.equal(results.filter((r) => r.status === 409 && r.json.error === 'sold_out').length, 5);
  const n = await db.one(`SELECT COALESCE(sum(quantity),0)::int n FROM bookings WHERE ticket_type_id = $1 AND status = 'confirmed'`, [tiers[0].id]);
  assert.equal(n.n, 3);
  const page = await new Client().get(`/events/${event.slug}`);
  assert.match(page.text, /Sold out/);
  assert.match(page.text, /Bookings open/, 'other tier still open');
});

test('private venue, maps link and contact number never reach public pages, APIs or metadata', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({
    title: 'Rooftop House Party', category: 'nightlife', privateVenue: true, venue: 'Flat 9B, Secret Towers, 12 Hidden Lane',
    area: 'Koramangala', mapsUrl: 'https://maps.app.goo.gl/SecretPlace123',
    features: { contact: { enabled: true, name: 'Asha', phone: '98765 43210' } }
  }));
  assert.equal(event.venue_privacy, 'disclosed_after_booking');
  assert.equal(event.contact_phone, '+919876543210');
  const secrets = /Secret Towers|Hidden Lane|SecretPlace123|9876543210/;
  const anon = new Client();
  for (const path of [`/events/${event.slug}`, '/api/events', '/events', '/nightlife', '/sitemap.xml', '/']) {
    const r = await anon.get(path);
    assert.doesNotMatch(r.text, secrets, `leak on ${path}`);
  }
  assert.match((await anon.get(`/events/${event.slug}`)).text, /Koramangala/);
  // A guest who has not booked doesn't see it either.
  const g = await signedInClient();
  assert.doesNotMatch((await g.get(`/events/${event.slug}`)).text, secrets);
  const b = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id });
  const mine = await g.get(`/api/bookings/${b.json.bookingId}`);
  assert.equal(mine.json.booking.venue, 'Flat 9B, Secret Towers, 12 Hidden Lane');
  assert.equal(mine.json.booking.mapsUrl, 'https://maps.app.goo.gl/SecretPlace123');
  assert.equal(mine.json.booking.contact.phone, '+919876543210');
  assert.equal(mine.json.booking.contact.whatsappUrl, 'https://wa.me/919876543210');
  const other = await signedInClient();
  assert.equal((await other.get(`/api/bookings/${b.json.bookingId}`)).status, 404);
});

test('maps links must be Google Maps over https', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData({ mapsUrl: 'https://evil.example/maps' }));
  const issues = (await c.get(`/api/organiser/drafts/${d.id}/check`)).json.issues;
  assert.ok(issues.some((i) => i.field === 'mapsUrl'));
});

test('preview renders the attendee page without publishing', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData({ title: 'Secret Preview Mixer' }));
  const p = await c.get(`/organiser/drafts/${d.id}/preview`);
  assert.equal(p.status, 200);
  assert.match(p.text, /Secret Preview Mixer/);
  assert.match(p.text, /only you can see it/);
  assert.match(p.text, /booking is switched off/);
  assert.match(p.text, /noindex/);
  assert.equal(await db.one('SELECT 1 FROM events WHERE title = $1', ['Secret Preview Mixer']), null);
  assert.doesNotMatch((await new Client().get('/api/events')).text, /Secret Preview Mixer/);
  // Saving with step=preview changes nothing public either.
  assert.equal((await db.one('SELECT status FROM event_drafts WHERE id = $1', [d.id])).status, 'active');
});

test('publishing needs explicit confirmation and the current version; then shows up for the organiser', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData({ title: 'Confirmed Publish Social' }));
  assert.equal((await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version })).status, 400);
  assert.equal((await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: 'yes' })).status, 400);
  assert.equal((await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version - 1, confirm: true })).status, 409);
  assert.equal(await db.one('SELECT 1 FROM events WHERE title = $1', ['Confirmed Publish Social']), null);
  const r = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version, confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.url, /^https:\/\/sm\.test\/events\/confirmed-publish-social-[a-f0-9]{6}$/);
  assert.equal(r.json.manageUrl, `/organiser/events/${r.json.eventId}`);
  assert.equal((await new Client().get(r.json.path)).status, 200);
  const ctx = await c.get('/api/organiser/context');
  assert.ok(ctx.json.events.some((e) => e.id === r.json.eventId));
  assert.ok(!ctx.json.drafts.some((x) => x.id === d.id));
  assert.equal((await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: d.version + 1, confirm: true })).json.error, 'draft_closed');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'event.publish' AND target = $1`, [r.json.eventId]));
});

test('multi-day events with day-specific tickets', async () => {
  const c = await organiserClient();
  const start = istLocal(20, '08:00');
  const end = istLocal(22, '18:00');
  const day2 = istLocal(21).slice(0, 10);
  const wrongDay = await newDraft(c, validData({ multiDay: true, startLocal: start, endLocal: end,
    tickets: [{ id: 'x', name: 'Day pass', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, validOn: istLocal(40).slice(0, 10) }] }));
  assert.ok((await c.get(`/api/organiser/drafts/${wrongDay.id}/check`)).json.issues.some((i) => i.field === 'tickets.0.validOn'));
  const tooLong = await newDraft(c, validData({ startLocal: start, endLocal: end }));
  assert.ok((await c.get(`/api/organiser/drafts/${tooLong.id}/check`)).json.issues.some((i) => i.field === 'multiDay'));

  const { event, tiers } = await publish(c, validData({ category: 'weekend_trip', title: 'Three Day Festival', multiDay: true, startLocal: start, endLocal: end,
    tickets: [
      { id: 'all', name: 'Full pass', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, validOn: 'all' },
      { id: 'd2', name: 'Day 2 only', kind: 'free', pricePaise: 0, quantity: 10, maxPerBooking: 1, validOn: day2 }
    ] }));
  assert.equal(event.is_multi_day, true);
  assert.equal(tiers[0].valid_on, null);
  assert.equal(tiers[1].valid_on, day2);
  const page = await new Client().get(`/trips/${event.slug}`);
  assert.match(page.text, /All days/);
  assert.match(page.text, /Valid /);
});

test('pickup points: guests must pick one and it shows on their booking and the guest list', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ category: 'weekend_trip', venue: '', title: 'Coorg Trek',
    features: { pickup: { enabled: true, points: [
      { id: 'p1', name: 'Silk Board', location: 'Near the bus stop', time: istLocal(10, '05:30') },
      { id: 'p2', name: 'Majestic', location: 'Platform 1', time: istLocal(10, '06:00') }
    ] } } }));
  const page = await new Client().get(`/trips/${event.slug}`);
  assert.match(page.text, /Pickup points/);
  assert.match(page.text, /Silk Board/);
  const g = await signedInClient();
  const none = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id });
  assert.equal(none.status, 400);
  const bad = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, pickupPointId: 'nope' });
  assert.equal(bad.status, 400);
  const ok = await g.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, pickupPointId: 'p2' });
  assert.equal(ok.json.status, 'confirmed');
  assert.equal((await g.get(`/api/bookings/${ok.json.bookingId}`)).json.booking.pickup.name, 'Majestic');
  assert.equal((await host.get(`/api/organiser/events/${event.id}/guests`)).json.guests[0].pickup, 'Majestic');
});

test('crowd balance: eligibility must be confirmed and per-ticket caps hold', async () => {
  const host = await organiserClient();
  const { event, tiers } = await publish(host, validData({ category: 'matchmaking', features: { balance: { enabled: true } }, tickets: [
    { id: 'w', name: 'Women', kind: 'free', pricePaise: 0, quantity: 1, maxPerBooking: 1, eligibility: 'Women' },
    { id: 'm', name: 'Men', kind: 'free', pricePaise: 0, quantity: 1, maxPerBooking: 1, eligibility: 'Men' }
  ] }));
  const page = await new Client().get(`/events/${event.slug}`);
  assert.match(page.text, /1 of 1 left/);
  const g1 = await signedInClient();
  const noConfirm = await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[1].id });
  assert.equal(noConfirm.status, 400);
  assert.equal((await g1.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[1].id, eligibilityConfirmed: true })).json.status, 'confirmed');
  const g2 = await signedInClient();
  const full = await g2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[1].id, eligibilityConfirmed: true });
  assert.equal(full.json.error, 'sold_out');
  assert.equal((await g2.post(`/api/events/${event.id}/book`, { ticketTypeId: tiers[0].id, eligibilityConfirmed: true })).json.status, 'confirmed');
  const after = await new Client().get(`/events/${event.slug}`);
  assert.match(after.text, /0 of 1 left/);
});

test('event images: content-checked uploads, private until publish', async () => {
  const c = await organiserClient();
  const d = await newDraft(c, validData());
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
  const fake = await c.req('POST', `/api/organiser/drafts/${d.id}/images`, Buffer.from('<svg onload=alert(1)>hello world</svg>'), { 'content-type': 'image/png' });
  assert.equal(fake.status, 415);
  const lying = await c.req('POST', `/api/organiser/drafts/${d.id}/images`, png, { 'content-type': 'image/jpeg' });
  assert.equal(lying.status, 415);
  const up = await c.req('POST', `/api/organiser/drafts/${d.id}/images`, png, { 'content-type': 'image/png' });
  assert.equal(up.status, 201, up.text);
  const imgUrl = up.json.image.url;
  assert.equal((await c.get(imgUrl)).status, 200);
  assert.equal((await new Client().get(imgUrl)).status, 404, 'draft images are private');
  const other = await organiserClient();
  assert.equal((await other.req('POST', `/api/organiser/drafts/${d.id}/images`, png, { 'content-type': 'image/png' })).status, 404);

  const cur = (await c.get(`/api/organiser/drafts/${d.id}`)).json.draft;
  const noRights = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data: { ...cur.data, coverImageId: up.json.image.id }, step: 'preview', version: cur.version });
  assert.ok(noRights.json.draft.issues.some((i) => i.field === 'imageRightsConfirmed'));
  const s = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data: { ...cur.data, coverImageId: up.json.image.id, imageRightsConfirmed: true }, step: 'preview', version: noRights.json.draft.version });
  const pub = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: s.json.draft.version, confirm: true });
  assert.equal(pub.status, 200, pub.text);
  const anon = await new Client().get(imgUrl);
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('content-type'), 'image/png');
  assert.match((await new Client().get(pub.json.path)).text, new RegExp(imgUrl));
});

test('organiser pages: dashboard and manage page shells, preview of the wizard config', async () => {
  const c = await organiserClient();
  const dash = await c.get('/organiser');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /data-org-dashboard/);
  const wiz = await c.get('/organiser/new');
  const cfg = JSON.parse(/<script type="application\/json" id="wz-config">([\s\S]*?)<\/script>/.exec(wiz.text)[1]);
  assert.deepEqual(cfg.templates.map((t) => t.key), ['trip', 'party', 'business', 'social', 'workshop', 'general']);
  assert.deepEqual(Object.keys(cfg.ticketPresets), ['general', 'early_bird', 'couple', 'vip', 'free']);
  assert.equal(cfg.checkout.available, false);
});
