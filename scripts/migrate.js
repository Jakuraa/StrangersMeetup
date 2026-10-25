// scripts/migrate.js - apply pending Postgres migrations. Usage: npm run migrate
// In the Vercel build it is a no-op (with a warning) when DATABASE_URL is absent, so previews
// without a database still build; /api/health then reports the DB as NOT CONFIGURED.
import { db, migrate, isDbConfigured } from '../lib/db.js';

if (!isDbConfigured()) {
  console.warn('[migrate] DATABASE_URL not set — skipping migrations');
  process.exit(0);
}

try {
  const ran = await migrate();
  console.log(`[migrate] done (${ran.length} applied)`);
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
