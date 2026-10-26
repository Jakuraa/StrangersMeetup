// lib/services/superprofile.js - SuperProfile digital membership (checkout + private Telegram group
// access are run by SuperProfile). SuperProfile has no public API; it emits "New Purchase" and
// "Subscription Expired" triggers through Zapier / Pabbly Connect. Those tools POST here with a
// shared secret header. We keep lifecycle counts only: buyer email is stored as a keyed hash.
//
// Expected JSON (map these fields in the Zapier/Pabbly "Webhook" step):
//   { "event": "purchase" | "subscription_expired" | "purchase_abandoned",
//     "id": "<SuperProfile order / payment id>",       required, idempotency key
//     "product": "<product name or id>",               required except for abandons
//     "email": "<buyer email>",                        optional, hashed immediately
//     "amount": "499" | 499,                           optional, rupees
//     "currency": "INR", "occurred_at": "<date>" }      optional
import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../config.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { z } from '../validate.js';

export const SUPERPROFILE_SECRET_HEADER = 'x-webhook-secret';

export function superprofileConfigured() {
  return env('SUPERPROFILE_WEBHOOK_SECRET').length >= 24;
}

function hashKey() {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new HttpError(503, 'not_configured', 'Not configured');
  return crypto.createHmac('sha256', s).update('superprofile-email-v1').digest();
}

export function emailHash(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return crypto.createHmac('sha256', hashKey()).update(e).digest('hex');
}

export function rupeesToPaise(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export const WebhookBody = z.object({
  event: z.enum(['purchase', 'subscription_expired', 'purchase_abandoned']),
  id: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => v.length >= 1 && v.length <= 200, 'id required'),
  product: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? undefined : String(v).trim().slice(0, 200) || undefined)),
  email: z.string().max(320).optional(),
  amount: z.union([z.string().max(40), z.number()]).optional(),
  currency: z.string().max(8).optional(),
  occurred_at: z.string().max(64).optional()
}).passthrough().refine((b) => b.event === 'purchase_abandoned' || Boolean(b.product), { message: 'product required', path: ['product'] });

/** Apply one webhook. Idempotent on (event, id). Returns { result, tierMapped }. */
export async function applySuperprofileEvent(b) {
  const hash = b.email ? emailHash(b.email) : null;
  const occurred = b.occurred_at && !Number.isNaN(new Date(b.occurred_at).getTime()) ? new Date(b.occurred_at) : new Date();
  // Automations send product names with inconsistent case/spacing; key memberships on a normalised form.
  const productKey = b.product ? b.product.toLowerCase().replace(/\s+/g, ' ') : null;
  return db.tx(async (c) => {
    const tier = b.product
      ? (await c.query(`SELECT id, code FROM membership_tiers WHERE lower(superprofile_product_ref) = lower($1)`, [b.product])).rows[0]
      : null;
    const ins = await c.query(
      `INSERT INTO superprofile_events (event_type, external_id, product_ref, tier_id, email_hash, amount_paise, currency, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_type, external_id) DO NOTHING RETURNING id`,
      [b.event, b.id, b.product || null, tier?.id || null, hash, rupeesToPaise(b.amount), (b.currency || 'INR').toUpperCase().slice(0, 8), occurred]);
    if (!ins.rowCount) return { result: 'duplicate', tierMapped: Boolean(tier) };

    let result = 'recorded';
    if (b.event === 'purchase' && hash) {
      const r = await c.query(
        `INSERT INTO superprofile_memberships (tier_id, product_ref, email_hash, status, started_at, last_purchase_at)
         VALUES ($1, $2, $3, 'active', $4, $4)
         ON CONFLICT (product_ref, email_hash) DO UPDATE SET
           status = 'active', tier_id = COALESCE(EXCLUDED.tier_id, superprofile_memberships.tier_id),
           started_at = CASE WHEN superprofile_memberships.status = 'expired' THEN EXCLUDED.started_at ELSE superprofile_memberships.started_at END,
           last_purchase_at = GREATEST(superprofile_memberships.last_purchase_at, EXCLUDED.last_purchase_at),
           expired_at = NULL, purchases = superprofile_memberships.purchases + 1
         RETURNING purchases`, [tier?.id || null, productKey, hash, occurred]);
      result = r.rows[0].purchases > 1 ? 'renewed' : 'activated';
    } else if (b.event === 'subscription_expired' && hash) {
      const r = await c.query(
        `UPDATE superprofile_memberships SET status = 'expired', expired_at = $3
          WHERE product_ref = $1 AND email_hash = $2 AND status = 'active' RETURNING id`, [productKey, hash, occurred]);
      result = r.rowCount ? 'expired' : 'expired_unknown_member';
    }
    await audit('webhook:superprofile', `superprofile.${b.event}`, ins.rows[0].id, { result, tier: tier?.code || null }, c);
    return { result, tierMapped: Boolean(tier) };
  });
}
