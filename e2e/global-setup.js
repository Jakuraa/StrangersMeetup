// e2e/global-setup.js - Migrate and (re)seed the dedicated local e2e database before every run,
// so each run starts from the same personas and events.
import { assertE2eSafe, serverEnv } from './env.js';

export default async function globalSetup() {
  assertE2eSafe();
  Object.assign(process.env, { SKIP_DOTENV: 'true', DATABASE_URL: serverEnv.DATABASE_URL, LOG_SILENT: 'true' });
  const { db, migrate } = await import('../lib/db.js');
  const { seedLocal } = await import('../scripts/seed-local.js');
  try {
    await migrate({ log: false });
    await seedLocal();
    // Rate-limit windows outlive a re-seed; back-to-back runs would otherwise hit "Too many requests".
    await db.query('DELETE FROM rate_limits');
  } finally {
    await db.close();
  }
}
