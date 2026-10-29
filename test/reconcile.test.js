// test/reconcile.test.js - SuperProfile reconciliation: the pure diff, plus the endpoint the daily
// Claude Code task posts to (bearer CRON_SECRET).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db, callsTo, clearCalls } from './helpers.js';
import { diffOrders, isClean, normaliseSale } from '../lib/services/reconcile.js';

const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(clearCalls);

test('diff: flags missing in DB, missing on SuperProfile, amount drift and status drift; clean otherwise', () => {
  const ours = [
    { order_id: 'A1', amount_paise: '49900', status: 'paid' },
    { order_id: 'A2', amount_paise: 49900, status: 'paid' },
    { order_id: 'A3', amount_paise: 49900, status: 'paid' },
    { order_id: 'ONLY-OURS', amount_paise: 100, status: 'paid' }
  ];
  const sp = [
    { orderId: 'a1', amountPaise: 49900, status: 'paid' },
    { orderId: 'A2', amountPaise: 39900, status: 'paid' },
    { orderId: 'A3', amountPaise: 49900, status: 'refunded' },
    { orderId: 'ONLY-THEIRS', amountPaise: 49900, status: 'paid' }
  ];
  const d = diffOrders(sp, ours);
  assert.deepEqual(d.missingInDb.map((x) => x.orderId), ['ONLY-THEIRS']);
  assert.deepEqual(d.missingInSuperprofile.map((x) => x.orderId), ['ONLY-OURS']);
  assert.deepEqual(d.amountDrift, [{ orderId: 'A2', superprofilePaise: 39900, ourPaise: 49900 }]);
  assert.deepEqual(d.statusDrift, [{ orderId: 'A3', superprofile: 'refunded', ours: 'paid' }]);
  assert.equal(isClean(d), false);
  assert.equal(isClean(diffOrders([{ orderId: 'x', amountPaise: 1, status: 'paid' }], [{ order_id: 'X', amount_paise: 1, status: 'paid' }])), true);
  // An unknown amount on either side is not drift.
  assert.equal(isClean(diffOrders([{ orderId: 'x', amountPaise: null, status: 'paid' }], [{ order_id: 'x', amount_paise: 500, status: 'paid' }])), true);
});

test('normaliseSale reads rupees or paise and rejects rows without an id', () => {
  assert.deepEqual(normaliseSale({ id: 77, amount: '₹499.00', status: 'Refunded' }), { orderId: '77', amountPaise: 49900, status: 'refunded' });
  assert.deepEqual(normaliseSale({ orderId: 'x', amountPaise: 100 }), { orderId: 'x', amountPaise: 100, status: 'paid' });
  assert.throws(() => normaliseSale({ amount: 5 }));
});

test('endpoint: needs the cron secret; reports drift once per day and alerts admins', async () => {
  await db.query(`INSERT INTO external_orders (order_id, amount_paise, status, received_at) VALUES ('OURS-1', 49900, 'paid', now() - interval '1 hour')`);
  const body = { since: new Date(Date.now() - 86400e3).toISOString(), until: new Date().toISOString(), sales: [{ id: 'THEIRS-1', amount: '499', status: 'paid' }] };
  assert.equal((await new Client().post('/api/reconcile/superprofile', body)).status, 401);
  assert.equal((await new Client().post('/api/reconcile/superprofile', body, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await new Client().post('/api/reconcile/superprofile', { sales: [] }, CRON)).status, 400);

  const r = await new Client().post('/api/reconcile/superprofile', body, CRON);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.counts.missingInDb, 1);
  assert.equal(r.json.counts.missingInSuperprofile, 1);
  assert.ok(callsTo('sendMessage').some((m) => m.params.chat_id === 900000001 && /reconciliation/.test(m.params.text)));
  assert.ok(await db.one(`SELECT 1 AS x FROM integration_errors WHERE kind = 'reconcile_drift'`));
  clearCalls();
  await new Client().post('/api/reconcile/superprofile', body, CRON);
  assert.equal(callsTo('sendMessage').length, 0, 'the same finding is not re-sent');

  // A clean window sends nothing.
  await db.query('DELETE FROM external_orders');
  const clean = await new Client().post('/api/reconcile/superprofile', { ...body, sales: [] }, CRON);
  assert.equal(clean.json.counts.missingInDb, 0);
  assert.equal(callsTo('sendMessage').length, 0);
});
