// scripts/vercel-ignore.js - Vercel Ignored Build Step for database isolation protection.
// Exit code 0: CANCEL / SKIP the build (Vercel treats 0 as "ignore this deployment").
// Exit code 1: PROCEED with the build (Vercel treats non-zero as "proceed with build").

const env = process.env.VERCEL_ENV || '';
const branch = process.env.VERCEL_GIT_COMMIT_REF || '';
const isProduction = env === 'production' || branch === 'main' || branch === 'launch-mvp';
const isIsolatedPreview = process.env.ISOLATED_PREVIEW_DB === 'true' || Boolean(process.env.PREVIEW_DATABASE_URL);

if (isProduction) {
  console.log(`[vercel-ignore] Production deployment on '${branch || env}' — proceeding with build.`);
  process.exit(1);
}

if (isIsolatedPreview) {
  console.log(`[vercel-ignore] Preview deployment on '${branch}' with verified isolated database — proceeding with build.`);
  process.exit(1);
}

// Preview and Production share DATABASE_URL: cancel the preview build to protect shared database
console.log(
  `[vercel-ignore] CANCELLED preview deployment for branch '${branch}'.\n` +
  'Reason: Preview and Production currently share the production Neon database.\n' +
  'To enable preview deployments safely: create an isolated Neon branch and set ISOLATED_PREVIEW_DB=true in Vercel Preview environment variables.'
);
process.exit(0);
