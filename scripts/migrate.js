// scripts/migrate.js - apply pending Postgres migrations. Usage: npm run migrate
// In the Vercel build it is a no-op (with a warning) when DATABASE_URL is absent, so previews
// without a database still build; /api/health then reports the DB as NOT CONFIGURED.
// On Vercel only production builds migrate unless MIGRATE_ON_PREVIEW=true (see migrationPolicy).
import '../lib/config.js'; // loads a local .env (never on Vercel)
import { db, migrate, migrationPolicy } from '../lib/db.js';

const policy = migrationPolicy();
if (!policy.run) {
  console.warn(`[migrate] skipping migrations — ${policy.reason}`);
  process.exit(0);
}
if (process.argv.includes('--seed-demo')) {
  // Checked before migrating so a refused seed changes nothing.
  const { assertSeedAllowed } = await import('./seed-guard.js');
  try {
    assertSeedAllowed({ kind: 'demo' });
  } catch (err) {
    console.error(`[migrate] ${err.message}`);
    process.exit(1);
  }
}

try {
  const ran = await migrate();
  console.log(`[migrate] done (${ran.length} applied; ${policy.reason})`);
  if (process.argv.includes('--seed-demo')) {
    const { seedDemo } = await import('./seed-demo.js');
    const n = await seedDemo();
    console.log(`[migrate] demo events upserted: ${n}`);
  }
} catch (err) {
  console.error('[migrate] failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
