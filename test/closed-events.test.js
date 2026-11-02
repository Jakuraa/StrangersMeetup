// test/closed-events.test.js - Past and cancelled events: no ticket picker on the page, no new bookings
// through the API, and the signed-out /admin access screen. Reuses the organiser publish flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db, signedInClient } from './helpers.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

const istLocal = (days, hh = '19:00') => `${new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10)}T${hh}`;

async function publishTiered({ approval = false } = {}) {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  const data = {
    template: 'social', category: 'meetup', title: 'Closed Event Check', timezone: 'Asia/Kolkata',
    startLocal: istLocal(10, '17:00'), endLocal: istLocal(10, '21:00'), multiDay: false,
    venue: 'Secret Cellar, 9 Hidden Lane', city: 'Chennai', area: 'Adyar', privateVenue: true,
    description: 'A gathering of strangers. Arrive by 5, finish by 9. Snacks to buy. 21+ only, photo ID needed.',
    tickets: [{ id: 'free1', name: 'Free entry', kind: 'free', pricePaise: 0, quantity: 20, maxPerBooking: 2, validOn: 'all' }],
    features: approval ? { approval: { enabled: true } } : {}
  };
  const d = (await c.post('/api/organiser/drafts', { template: 'social' })).json.draft;
  const s = await c.req('PUT', `/api/organiser/drafts/${d.id}`, { data, step: 'preview', version: d.version });
  const r = await c.post(`/api/organiser/drafts/${d.id}/publish`, { version: s.json.draft.version, confirm: true });
  assert.equal(r.status, 200, r.text);
  const event = await db.one('SELECT * FROM events WHERE id = $1', [r.json.eventId]);
  const tiers = (await db.query('SELECT * FROM ticket_types WHERE event_id = $1', [event.id])).rows;
  return { event, tier: tiers[0], host: c };
}

const makePast = (id) => db.query(`UPDATE events SET start_at = now() - interval '3 days', end_at = now() - interval '3 days' + interval '3 hours' WHERE id = $1`, [id]);
const makeCancelled = (id) => db.query(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [id]);

test('open event keeps its ticket picker (control)', async () => {
  const { event } = await publishTiered();
  const page = await new Client().get(`/events/${event.slug}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /name="ticketTypeId"/);
  assert.match(page.text, /Book now/);
});

for (const [label, make, message] of [
  ['past', makePast, /This event has ended/],
  ['cancelled', makeCancelled, /This event has been cancelled/]
]) {
  test(`${label} event page shows a status notice, not a ticket picker`, async () => {
    const { event } = await publishTiered();
    await make(event.id);
    const page = await new Client().get(`/events/${event.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, message);
    for (const bad of [/name="ticketTypeId"/, /name="quantity"/, /Choose a ticket/, /data-tier-form/, /Number of tickets/, /type="submit"/, /Book now/, /Request to join/, /address appears on your booking/, /confirmation arrives via our Telegram bot/]) {
      assert.doesNotMatch(page.text, bad, `${label} page must not contain ${bad}`);
    }
    assert.doesNotMatch(page.text, /Secret Cellar|Hidden Lane/, 'private venue stays private');
    assert.match(page.text, /href="\/events"/, 'offers a way back to upcoming events');
  });

  test(`${label} event rejects new bookings server-side, with no booking or payment row`, async () => {
    const { event, tier } = await publishTiered();
    await make(event.id);
    const guest = await signedInClient();
    const r = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
    assert.ok([404, 409].includes(r.status), `expected refusal, got ${r.status}`);
    assert.equal((await db.query('SELECT 1 FROM bookings WHERE event_id = $1', [event.id])).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE event_id = $1)', [event.id])).rowCount, 0);
  });
}

test('a request pending when the event is cancelled cannot be approved into a booking', async () => {
  const { event, tier, host } = await publishTiered({ approval: true });
  const guest = await signedInClient();
  const r = await guest.post(`/api/events/${event.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'pending_approval');
  await makeCancelled(event.id);
  const a = await host.post(`/api/organiser/bookings/${r.json.bookingId}/approve`, {});
  assert.ok(a.status >= 400, `approve must be refused, got ${a.status}`);
  const b = await db.one('SELECT status FROM bookings WHERE id = $1', [r.json.bookingId]);
  assert.equal(b.status, 'pending_approval', 'cancelling does not confirm anyone');
});

test('legacy single-price event page: past shows no Book button or invite promise', async () => {
  const orig = process.env.ENABLE_LIVE_PAYMENTS;
  process.env.ENABLE_LIVE_PAYMENTS = 'true';
  try {
    const { event } = await publishTiered();
    await db.query(`UPDATE events SET ticketing = 'single', price_status = 'set', ticket_price_paise = 50000, checkout_mode = 'superprofile',
                                      superprofile_url = 'https://superprofile.bio/meetup/x' WHERE id = $1`, [event.id]);
    assert.match((await new Client().get(`/events/${event.slug}`)).text, /data-sp-buy=/);
    await makePast(event.id);
    const page = (await new Client().get(`/events/${event.slug}`)).text;
    assert.doesNotMatch(page, /data-sp-buy=/);
    assert.doesNotMatch(page, /private group invite arrive/);
    assert.match(page, /This event has ended/);
  } finally {
    process.env.ENABLE_LIVE_PAYMENTS = orig;
  }
});

test('signed-out /admin is a branded access-required screen with the right status and no admin data', async () => {
  const r = await new Client().get('/admin');
  assert.equal(r.status, 401);
  assert.match(r.text, /<h1[^>]*>Sign in to continue<\/h1>/);
  assert.match(r.text, /site-header/, 'uses the site header');
  assert.match(r.text, /href="\/signin\?next=\/admin"/);
  assert.match(r.text, /href="\/"/, 'has a way back to the site');
  assert.match(r.text, /noindex/);
  assert.doesNotMatch(r.text, /admin\.js|data-csrf|data-role|Loading…/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('signed-in non-admin /admin is a 403 access screen that reveals nothing about admins', async () => {
  const r = await (await signedInClient()).get('/admin');
  assert.equal(r.status, 403);
  assert.match(r.text, /<h1[^>]*>You don’t have access to this page<\/h1>/);
  assert.match(r.text, /site-header/);
  assert.doesNotMatch(r.text, /allowlist|admin\.js|data-csrf|data-role/);
  assert.match(r.text, /href="\/"/);
});
