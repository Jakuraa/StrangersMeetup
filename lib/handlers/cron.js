// lib/handlers/cron.js - GET /api/cron/:job  (Vercel Cron sends Authorization: Bearer $CRON_SECRET)
// Every job is idempotent: running it twice changes nothing the second time.
import { sendJson, safeEqual, HttpError, readJson } from '../http.js';
import { env } from '../config.js';
import { releaseExpiredHolds } from '../services/bookings.js';
import { queueExpiryReminders, expireAndRevoke } from '../services/membership.js';
import { deliverDue, deliverMany } from '../services/notifications.js';
import { pruneNonces } from '../telegram/auth.js';
import { pruneRateLimits } from '../ratelimit.js';
import { pruneSessions } from '../session.js';
import { logger } from '../logger.js';
import { z, parse } from '../validate.js';
import { reconcileWindow } from '../services/reconcile.js';
import { runFeeds } from '../services/feeds.js';
import { pruneCheckoutIntents } from '../services/checkout.js';

const JOBS = {
  'expire-holds': async () => ({ released: await releaseExpiredHolds() }),
  memberships: async () => {
    const reminders = await queueExpiryReminders();
    const revoke = await expireAndRevoke();
    await deliverMany([...reminders, ...revoke.notificationIds]);
    return { reminders: reminders.length, revoked: revoke.revoked, revokeFailed: revoke.failed };
  },
  notifications: async () => deliverDue(100),
  feeds: async () => {
    const r = await runFeeds();
    return { fetched: r.length, failed: r.filter((x) => !['ok', 'not_modified'].includes(x.status)).length, newItems: r.reduce((n, x) => n + x.new, 0) };
  },
  cleanup: async () => ({ nonces: await pruneNonces(), rateLimits: await pruneRateLimits(), sessions: await pruneSessions(), intents: await pruneCheckoutIntents() })
};

function requireCronSecret(req) {
  const secret = env('CRON_SECRET');
  const auth = req.headers.authorization || '';
  if (secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) throw new HttpError(401, 'unauthorized', 'Unauthorized');
}

const ReconcileBody = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  sales: z.array(z.object({
    orderId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    amount: z.union([z.string().max(40), z.number()]).optional(),
    amountPaise: z.number().int().min(0).optional(),
    status: z.string().max(20).optional()
  }).passthrough()).max(2000)
}).strict();

/** POST /api/reconcile/superprofile — the daily Claude Code task posts SuperProfile's sales for a window. */
export async function reconcileSuperprofile({ req, res }) {
  requireCronSecret(req);
  const b = parse(ReconcileBody, await readJson(req, 512 * 1024));
  const r = await reconcileWindow({ sales: b.sales, since: b.since, until: b.until });
  await deliverMany([r.notificationId]);
  sendJson(res, 200, { ok: true, counts: r.counts, diff: r.diff });
}

export async function runCron({ req, res, params }) {
  requireCronSecret(req);
  const names = params.job === 'daily' ? Object.keys(JOBS) : [params.job];
  if (!names.every((n) => JOBS[n])) throw new HttpError(404, 'not_found', 'Unknown job');
  const results = {};
  for (const n of names) {
    try {
      results[n] = await JOBS[n]();
    } catch (err) {
      logger.error(`cron ${n} failed`, err);
      results[n] = { error: 'failed' };
    }
  }
  logger.info('cron run', { job: params.job, results });
  sendJson(res, 200, { ok: true, results });
}
