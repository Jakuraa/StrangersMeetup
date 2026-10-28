// lib/dev-personas.js - Local test personas (seeded by `npm run seed:local`) and the one gate that
// decides whether persona sign-in exists at all. Never available on Vercel, in production, or
// against a database that is not on this machine.
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

/** Persona sign-in: local machine only, explicitly switched on, never production, local database only. */
export function devLoginEnabled(e = process.env) {
  return !e.VERCEL && e.DEV_LOGIN === 'true' && e.NODE_ENV !== 'production' && e.VERCEL_ENV !== 'production' &&
    isLocalDatabaseUrl(e.DATABASE_URL);
}
