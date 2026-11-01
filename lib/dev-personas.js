// lib/dev-personas.js - Local test personas (seeded by `npm run seed:local`) and the gates that
// decide whether persona sign-in or preview reviewer testing exist.
import { isLocalDatabaseUrl } from './db.js';

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
  admin: { tg: 9_100_000_031, alias: 'Test Admin Farah', role: 'super admin', adminRole: 'super_admin', landing: '/admin' }
};

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
 * - Preview environment only (VERCEL_ENV === 'preview' or IS_PREVIEW === 'true' in tests).
 * - Never in production (VERCEL_ENV/NODE_ENV === 'production' or Production Neon endpoint).
 * - Regular guest attendee privileges only — no admin or organiser escalation.
 */
export function previewReviewerEnabled(e = process.env) {
  if (e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production') return false;
  if (e.DATABASE_URL && e.DATABASE_URL.includes('ep-dawn-glitter-b4mkwxkl')) return false;
  return e.VERCEL_ENV === 'preview' || e.IS_PREVIEW === 'true';
}
