// lib/dev-personas.js - Local test personas (seeded by `npm run seed:local`) and the gates that
// decide whether persona sign-in or preview reviewer testing exist.
import { isLocalDatabaseUrl } from './db.js';
import { isBlockedProductionDatabaseUrl } from './config.js';

/** Synthetic Telegram ids live in a reserved range no real Telegram account uses in practice. */
export const PERSONA_TG_MIN = 9_100_000_000;
export const PERSONA_TG_MAX = 9_100_999_999;

// role: what the persona is for. adminRole: its admin_users row (if any). organiser: users.organiser_enabled.
export const PERSONAS = {
  guest: { tg: 9_100_000_001, alias: 'Test Guest Asha', role: 'guest', landing: '/me' },
  guest2: { tg: 9_100_000_002, alias: 'Test Guest Bala', role: 'guest', landing: '/me' },
  organiser: { tg: 9_100_000_011, alias: 'Test Organiser Chitra', role: 'organiser', organiser: true, landing: '/organiser' },
  organiser2: { tg: 9_100_000_012, alias: 'Test Organiser Dev', role: 'organiser', organiser: true, landing: '/organiser' },
  staff: { tg: 9_100_000_021, alias: 'Test Staff Esha', role: 'event staff (support)', adminRole: 'support', landing: '/admin' },
  admin: { tg: 9_100_000_031, alias: 'Test Admin Farah', role: 'super admin', adminRole: 'super_admin', landing: '/admin' },
  finance: { tg: 9_100_000_032, alias: 'Test Finance Gita', role: 'finance admin', adminRole: 'finance', landing: '/admin' },
  manager: { tg: 9_100_000_013, alias: 'Test Manager Hari', role: 'manager in Chitra’s team org', orgRole: 'manager', landing: '/me' },
  teamstaff: { tg: 9_100_000_014, alias: 'Test Team Staff Indu', role: 'staff in Chitra’s team org', orgRole: 'staff', landing: '/me' },
  venue: { tg: 9_100_000_041, alias: 'Test Venue Owner Jai', role: 'venue org owner', landing: '/venue' },
  dj: { tg: 9_100_000_051, alias: 'Test DJ Kavya', role: 'DJ (dj capability)', capabilities: ['dj'], landing: '/me' }
};

/** Synthetic orgs seeded with the personas. members: [persona key, org role]. */
export const PERSONA_ORGS = [
  { name: 'Test Org: Chitra Events', kind: 'organiser_team', members: [['organiser', 'owner'], ['manager', 'manager'], ['teamstaff', 'staff']] },
  { name: 'Test Org: Jai Venues', kind: 'venue_operator', members: [['venue', 'owner']],
    venues: [{ name: 'Test venue: Rooftop 9', capacity: 80, address: 'Test address — 9 Private Lane (members only)', lat: 13.0, lng: 80.2 }] }
];

export const PERSONA_KEYS = Object.keys(PERSONAS);
export const PERSONA_TG_IDS = PERSONA_KEYS.map((k) => PERSONAS[k].tg);

/** Restricted synthetic reviewer persona for Preview environments only. */
export const REVIEWER_TG_ID = 9_100_000_100;
export const REVIEWER_ALIAS = 'Preview Reviewer (Synthetic)';

/** Persona sign-in: local machine only, explicitly switched on, never production, local database only. */
export function devLoginEnabled(e = process.env) {
  return !e.VERCEL && e.DEV_LOGIN === 'true' && e.NODE_ENV !== 'production' && e.VERCEL_ENV !== 'production' &&
    isLocalDatabaseUrl(e.DATABASE_URL);
}

/**
 * Preview reviewer sign-in: strictly restricted to verified Preview environments.
 * - Allows the reviewer mechanism ONLY when VERCEL_ENV === 'preview' (or strict preview test harness flag IS_PREVIEW === 'true').
 * - Explicitly rejects VERCEL_ENV === 'production' (fail-closed against Production deployments).
 * - Explicitly rejects unconfigured, missing, or local environments (VERCEL_ENV not set and IS_PREVIEW not 'true').
 * - In Vercel Serverless Functions, VERCEL_ENV='preview' runs under NODE_ENV='production'.
 *   This policy safely allows VERCEL_ENV='preview' while maintaining strict production endpoint guards.
 * - Rejects any blocked production database endpoint (ep-dawn-glitter-b4mkwxkl, etc.) on DATABASE_URL or PREVIEW_DATABASE_URL.
 * - Regular guest attendee privileges only (REVIEWER_TG_ID) — zero admin, organiser, finance, or staff escalation.
 */
export function previewReviewerEnabled(e = process.env) {
  if (!e || typeof e !== 'object') return false;

  // 1. Explicitly reject Production environments
  if (e.VERCEL_ENV === 'production') return false;

  // 2. Reject blocked production database endpoints across both connection strings
  if (isBlockedProductionDatabaseUrl(e.DATABASE_URL, e)) return false;
  if (isBlockedProductionDatabaseUrl(e.PREVIEW_DATABASE_URL, e)) return false;

  // 3. Strict Preview authorization: MUST be Vercel Preview (VERCEL_ENV === 'preview')
  // or explicitly authorized isolated preview test runner (IS_PREVIEW === 'true').
  // Missing VERCEL_ENV, ambiguous values, or local development without IS_PREVIEW fail closed.
  const isVercelPreview = e.VERCEL_ENV === 'preview';
  const isPreviewTest = e.IS_PREVIEW === 'true';

  if (!isVercelPreview && !isPreviewTest) {
    return false;
  }

  // 4. When not running in a verified Vercel Preview (VERCEL_ENV === 'preview'),
  // IS_PREVIEW='true' is only accepted in an authorized isolated test runner.
  // Ambiguous deployed environments (e.g. VERCEL, VERCEL_URL, or serverless/cloud runtime indicators)
  // or production runtime (NODE_ENV === 'production') are strictly rejected.
  if (!isVercelPreview) {
    const isDeployed = Boolean(
      e.VERCEL ||
      e.VERCEL_URL ||
      e.AWS_LAMBDA_FUNCTION_NAME ||
      e.FLY_APP_NAME ||
      e.RENDER ||
      e.K_SERVICE ||
      e.HEROKU_APP_NAME
    );
    if (isDeployed || e.NODE_ENV === 'production') {
      return false;
    }
  }

  return true;
}
