// lib/services/reconcile.js - Compare SuperProfile's own sales list with external_orders.
//
// The SuperProfile MCP needs the owner's OAuth, so the daily reconciliation is a Claude Code scheduled
// task (not a Vercel cron): it reads sales through the MCP and POSTs them to /api/reconcile/superprofile
// (bearer CRON_SECRET), where diffOrders() runs. Nothing is fixed automatically: the result is an alert.
import { db } from '../db.js';
import { rupeesToPaise } from './superprofile.js';
import { recordIntegrationError } from './insights.js';
import { enqueue } from './notifications.js';

/**
 * @param {{ orderId: string, amountPaise: number|null, status: 'paid'|'refunded'|'cancelled' }[]} sp  SuperProfile's view
 * @param {{ order_id: string, amount_paise: number|string|null, status: string }[]} ours             external_orders rows
 */
export function diffOrders(sp, ours) {
  const key = (id) => String(id).trim().toLowerCase();
  const mine = new Map(ours.map((o) => [key(o.order_id), o]));
  const theirs = new Map(sp.map((o) => [key(o.orderId), o]));
  const out = { missingInDb: [], missingInSuperprofile: [], amountDrift: [], statusDrift: [] };
  for (const [k, s] of theirs) {
    const o = mine.get(k);
    if (!o) { out.missingInDb.push({ orderId: s.orderId, amountPaise: s.amountPaise ?? null, status: s.status }); continue; }
    const ours$ = o.amount_paise === null || o.amount_paise === undefined ? null : Number(o.amount_paise);
    if (s.amountPaise !== null && s.amountPaise !== undefined && ours$ !== null && Number(s.amountPaise) !== ours$) {
      out.amountDrift.push({ orderId: s.orderId, superprofilePaise: Number(s.amountPaise), ourPaise: ours$ });
    }
    if (s.status !== o.status) out.statusDrift.push({ orderId: s.orderId, superprofile: s.status, ours: o.status });
  }
  for (const [k, o] of mine) if (!theirs.has(k)) out.missingInSuperprofile.push({ orderId: o.order_id, status: o.status });
  return out;
}

export const isClean = (d) => !d.missingInDb.length && !d.missingInSuperprofile.length && !d.amountDrift.length && !d.statusDrift.length;

/** Normalise one sale as the scheduled task reads it from the MCP. Throws on a row without an id. */
export function normaliseSale(s) {
  const id = String(s.orderId ?? s.id ?? '').trim();
  if (!id || id.length > 200) throw new Error('sale without an order id');
  const status = ['refunded', 'cancelled'].includes(String(s.status || '').toLowerCase()) ? String(s.status).toLowerCase() : 'paid';
  const amountPaise = s.amountPaise !== undefined ? Number(s.amountPaise) : rupeesToPaise(s.amount);
  return { orderId: id, amountPaise: Number.isFinite(amountPaise) ? amountPaise : null, status };
}

/**
 * Diff a window of SuperProfile sales against our orders, record the findings and, when something is
 * off, queue one Telegram alert to the admins. Safe to run repeatedly (alerts dedupe per day and result).
 */
export async function reconcileWindow({ sales, since, until }) {
  const sp = sales.map(normaliseSale);
  const { rows } = await db.query(
    `SELECT order_id, amount_paise, status FROM external_orders WHERE received_at >= $1 AND received_at <= $2`, [since, until]);
  const diff = diffOrders(sp, rows);
  const counts = { checked: sp.length, missingInDb: diff.missingInDb.length, missingInSuperprofile: diff.missingInSuperprofile.length, amountDrift: diff.amountDrift.length, statusDrift: diff.statusDrift.length };
  let notificationId = null;
  if (!isClean(diff)) {
    await recordIntegrationError('superprofile_webhook', 'reconcile_drift',
      `missing in app: ${counts.missingInDb}, missing on SuperProfile: ${counts.missingInSuperprofile}, amount drift: ${counts.amountDrift}, status drift: ${counts.statusDrift}`);
    notificationId = await db.tx((c) => enqueue(c, {
      kind: 'reconcile_alert',
      dedupeKey: `rc:${new Date().toISOString().slice(0, 10)}:${counts.missingInDb}:${counts.missingInSuperprofile}:${counts.amountDrift}:${counts.statusDrift}`
    }));
  }
  return { counts, diff, notificationId };
}
