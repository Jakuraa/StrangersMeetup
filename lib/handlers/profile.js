// lib/handlers/profile.js - Member profile data (gender, city, interests, display name).
// Every field is validated, CSRF-protected, and synced with member_interests.
import { db } from '../db.js';
import { readJson, sendJson } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { CITIES } from '../services/events.js';
import {
  INTEREST_CATEGORIES,
  INTEREST_OPTIONS,
  INTEREST_KEYS,
  GENDER_OPTIONS,
  saveInterests
} from '../services/member-onboarding.js';

// Historical interests retained for backward-compatibility with insights and existing profile tests
export const HISTORICAL_INTERESTS = ['nightlife', 'strangers_trips', 'meetups', 'dinners', 'weekend_parties', 'dating', 'matchmaking', 'board_games', 'movies'];
export const INTERESTS = [...new Set([...INTEREST_KEYS, ...HISTORICAL_INTERESTS])];
export const AGE_BANDS = ['21_24', '25_29', '30_34', '35_39', '40_plus', 'prefer_not_to_say'];
export const GENDERS = ['female', 'male', 'non_binary', 'other', 'prefer_not_to_say', 'self_describe', 'woman', 'man'];

const nullable = (schema) => z.union([schema, z.null(), z.literal('')]).optional().transform((v) => (v === '' ? null : v));

const ProfileBody = z.object({
  displayName: z.string().min(1).max(50).optional(),
  gender: nullable(z.enum(GENDERS)),
  genderCustom: nullable(z.string().max(100)),
  age_band: nullable(z.enum(AGE_BANDS)),
  city: nullable(z.enum(CITIES.map((c) => c.name))),
  interests: z.array(z.enum(INTERESTS)).max(50).optional().transform((v) => (v ? [...new Set(v)] : v))
}).strict();

function view(u) {
  return {
    displayName: u.display_name,
    gender: u.gender,
    genderCustom: u.gender_custom,
    ageBand: u.age_band,
    city: u.city,
    interests: u.interests || [],
    updatedAt: u.profile_updated_at
  };
}

export async function getProfile({ req, res }) {
  const user = await requireUser(req);
  const u = await db.one(
    `SELECT display_name, gender, gender_custom, age_band, city, interests, profile_updated_at FROM users WHERE id = $1`,
    [user.id]
  );
  sendJson(res, 200, {
    ok: true,
    profile: view(u),
    options: {
      interests: INTERESTS,
      interestCategories: INTEREST_CATEGORIES,
      interestOptions: INTEREST_OPTIONS,
      ageBands: AGE_BANDS,
      genders: GENDERS,
      genderOptions: GENDER_OPTIONS,
      cities: CITIES.map((c) => c.name)
    }
  });
}

export async function updateProfile({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`profile:${user.id}`, 30, 600);
  const p = parse(ProfileBody, await readJson(req));

  // Map user-friendly gender aliases
  let mappedGender = p.gender;
  if (p.gender === 'woman') mappedGender = 'female';
  if (p.gender === 'man') mappedGender = 'male';
  if (p.gender === 'self_describe') mappedGender = 'other';

  const u = await db.one(
    `UPDATE users SET
       display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
       gender = CASE WHEN $4 THEN $5::user_gender ELSE gender END,
       gender_custom = CASE WHEN $6 THEN $7 ELSE gender_custom END,
       age_band = CASE WHEN $8 THEN $9::age_band ELSE age_band END,
       city = CASE WHEN $10 THEN $11 ELSE city END,
       interests = CASE WHEN $12 THEN $13::text[] ELSE interests END,
       profile_updated_at = now()
     WHERE id = $1 RETURNING display_name, gender, gender_custom, age_band, city, interests, profile_updated_at`,
    [
      user.id,
      p.displayName !== undefined, p.displayName ?? null,
      p.gender !== undefined, mappedGender ?? null,
      p.genderCustom !== undefined, p.genderCustom ?? null,
      p.age_band !== undefined, p.age_band ?? null,
      p.city !== undefined, p.city ?? null,
      p.interests !== undefined, p.interests ?? []
    ]
  );

  // If interests array was provided, sync to member_interests structured table
  if (Array.isArray(p.interests)) {
    await saveInterests(user.id, p.interests).catch(() => {});
  }

  sendJson(res, 200, { ok: true, profile: view(u) });
}
