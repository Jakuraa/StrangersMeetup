// lib/after.js - Run side effects after the HTTP response on Vercel (waitUntil keeps the function
// alive), so webhook senders (Zapier/Pabbly, Telegram) that expect a fast 2xx are acknowledged first.
// Locally and in tests the work is awaited before responding, which keeps behaviour deterministic.
import { logger } from './logger.js';

export async function afterResponse(work) {
  const guarded = Promise.resolve().then(work).catch((err) => logger.error('post-response work failed', err));
  if (process.env.VERCEL) {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(guarded);
    return;
  }
  await guarded;
}
