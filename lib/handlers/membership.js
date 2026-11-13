// lib/handlers/membership.js - POST /api/membership/checkout → Telegram Stars invoice link.
// (The SuperProfile webhook lives in handlers/superprofile.js.)
import { readJson, sendJson, hashIp } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { createMembershipInvoice } from '../services/membership.js';

const Body = z.object({ tierCode: z.string().regex(/^[a-z0-9_]{1,24}$/) });

export async function membershipCheckout({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`mem:${hashIp(ip)}`, 10, 600);
  const { tierCode } = parse(Body, await readJson(req));
  const { invoiceLink, tier } = await createMembershipInvoice(user, tierCode);
  sendJson(res, 200, { ok: true, invoiceLink, tier });
}
