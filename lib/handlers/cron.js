// lib/handlers/cron.js - GET /api/cron/:job  (Vercel Cron sends Authorization: Bearer $CRON_SECRET)
// Every job is idempotent: running it twice changes nothing the second time.
import { sendJson, safeEqual, HttpError } from '../http.js';
import { env } from '../config.js';
import { releaseExpiredHolds, reconcilePayments } from '../services/bookings.js';
import { queueExpiryReminders, expireAndRevoke } from '../services/membership.js';
import { deliverDue, deliverMany } from '../services/notifications.js';
import { ticketProvider } from '../payments/index.js';
import { pruneNonces } from '../telegram/auth.js';
import { pruneRateLimits } from '../ratelimit.js';
import { pruneSessions } from '../session.js';
import { logger } from '../logger.js';
import { runFeeds } from '../services/feeds.js';

const JOBS = {
  'expire-holds': async () => ({ released: await releaseExpiredHolds() }),
  reconcile: async () => {
    let provider;
    try { provider = ticketProvider(); } catch (err) { return { skipped: err.message }; }
    const r = await reconcilePayments(provider);
    await deliverMany(r.notificationIds);
    return { checked: r.checked, applied: r.applied };
  },
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
  cleanup: async () => ({ nonces: await pruneNonces(), rateLimits: await pruneRateLimits(), sessions: await pruneSessions() })
};

export async function runCron({ req, res, params }) {
  const secret = env('CRON_SECRET');
  const auth = req.headers.authorization || '';
  if (secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) throw new HttpError(401, 'unauthorized', 'Unauthorized');
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
