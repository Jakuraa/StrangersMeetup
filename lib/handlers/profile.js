// lib/handlers/profile.js - Voluntary profile data (gender, age band, city, interests).
// Every field is optional and clearable; admins only ever see suppressed aggregates.
import { db } from '../db.js';
import { readJson, sendJson } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { CITIES } from '../services/events.js';

export const INTERESTS = ['nightlife', 'strangers_trips', 'meetups', 'dinners', 'weekend_parties', 'dating', 'matchmaking', 'board_games', 'movies'];
export const AGE_BANDS = ['21_24', '25_29', '30_34', '35_39', '40_plus', 'prefer_not_to_say'];
export const GENDERS = ['female', 'male', 'non_binary', 'prefer_not_to_say'];

const nullable = (schema) => z.union([schema, z.null(), z.literal('')]).optional().transform((v) => (v === '' ? null : v));

const ProfileBody = z.object({
  gender: nullable(z.enum(GENDERS)),
  age_band: nullable(z.enum(AGE_BANDS)),
  city: nullable(z.enum(CITIES.map((c) => c.name))),
  interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length).optional().transform((v) => (v ? [...new Set(v)] : v))
}).strict();

function view(u) {
  return { gender: u.gender, ageBand: u.age_band, city: u.city, interests: u.interests || [], updatedAt: u.profile_updated_at };
}

export async function getProfile({ req, res }) {
  const user = await requireUser(req);
  const u = await db.one('SELECT gender, age_band, city, interests, profile_updated_at FROM users WHERE id = $1', [user.id]);
  sendJson(res, 200, { ok: true, profile: view(u), options: { interests: INTERESTS, ageBands: AGE_BANDS, genders: GENDERS, cities: CITIES.map((c) => c.name) } });
}

export async function updateProfile({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`profile:${user.id}`, 30, 600);
  const p = parse(ProfileBody, await readJson(req));
  const u = await db.one(
    `UPDATE users SET
       gender = CASE WHEN $2 THEN $3::user_gender ELSE gender END,
       age_band = CASE WHEN $4 THEN $5::age_band ELSE age_band END,
       city = CASE WHEN $6 THEN $7 ELSE city END,
       interests = CASE WHEN $8 THEN $9::text[] ELSE interests END,
       profile_updated_at = now()
     WHERE id = $1 RETURNING gender, age_band, city, interests, profile_updated_at`,
    [user.id, p.gender !== undefined, p.gender ?? null, p.age_band !== undefined, p.age_band ?? null,
      p.city !== undefined, p.city ?? null, p.interests !== undefined, p.interests ?? []]);
  sendJson(res, 200, { ok: true, profile: view(u) });
}
