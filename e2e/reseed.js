// e2e/reseed.js - Put the e2e database back to the seeded state from inside a test (for specs that
// change data, such as check-in). Same guards as the rest of the suite: local e2e database only.
import { assertE2eSafe, serverEnv } from './env.js';

let handle;

async function load() {
  if (handle) return handle;
  assertE2eSafe();
  Object.assign(process.env, { SKIP_DOTENV: 'true', DATABASE_URL: serverEnv.DATABASE_URL, LOG_SILENT: 'true' });
  const { db } = await import('../lib/db.js');
  const { seedLocal } = await import('../scripts/seed-local.js');
  handle = { db, seedLocal };
  return handle;
}

/** Re-run the local seed and clear rate-limit windows. Revokes persona sessions, so sign in again afterwards. */
export async function reseed() {
  const { db, seedLocal } = await load();
  await seedLocal();
  await db.query('DELETE FROM rate_limits');
}

export async function closeDb() {
  if (handle) { await handle.db.close(); handle = null; }
}
