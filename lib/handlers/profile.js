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

/** GET /api/me/recommendations — Explainable, privacy-preserving event recommendations. */
export async function getRecommendationsApi({ req, res }) {
  const user = await requireUser(req);
  const u = await db.one('SELECT city, interests FROM users WHERE id = $1', [user.id]);
  const prefs = (await db.query('SELECT * FROM user_preferences WHERE user_id = $1', [user.id])).rows[0] || {};

  const userCity = u.city || '';
  const userInterests = Array.isArray(u.interests) ? u.interests : [];
  const preferredTypes = Array.isArray(prefs.preferred_event_types) ? prefs.preferred_event_types : [];
  const preferredMusic = Array.isArray(prefs.preferred_music) ? prefs.preferred_music : [];

  // Query active published events
  const { rows: events } = await db.query(
    `SELECT e.id, e.slug, e.title, e.category, e.start_at, e.end_at, e.ticket_price_paise AS price_paise,
            e.capacity, e.features, e.city, e.venue_private AS venue_name, e.status
       FROM events e
      WHERE e.status = 'published' AND e.start_at >= now() AND COALESCE(e.is_deleted, false) = false
      ORDER BY e.start_at ASC
      LIMIT 20`
  );

  const recommendations = events.map((e) => {
    const reasons = [];
    if (userCity && e.city && e.city.toLowerCase() === userCity.toLowerCase()) {
      reasons.push(`in ${e.city}`);
    }
    const cat = e.category || '';
    if (userInterests.some((i) => i.toLowerCase().includes(cat.toLowerCase())) ||
        preferredTypes.some((t) => t.toLowerCase().includes(cat.toLowerCase()))) {
      reasons.push(`matches your interest in ${cat.replace(/_/g, ' ')}`);
    }
    if (preferredMusic.length && (cat === 'nightlife' || cat === 'weekend_party')) {
      reasons.push('features live music and nightlife');
    }

    let reasonText = 'Popular experience near you';
    if (reasons.length) {
      reasonText = `Recommended because it’s ${reasons.join(' and ')}`;
    }

    return {
      ...e,
      recommendationReason: reasonText
    };
  });

  sendJson(res, 200, { ok: true, recommendations });
}

/** GET /api/me/connections — List user connections, pending requests, and mutual network. */
export async function getConnectionsApi({ req, res }) {
  const user = await requireUser(req);

  // Accepted connections
  const { rows: accepted } = await db.query(
    `SELECT c.id, c.status, c.created_at,
            CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END AS partner_id,
            u.display_name, u.alias, u.city, u.profile_photo_url
       FROM user_connections c
       JOIN users u ON u.id = (CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END)
      WHERE (c.requester_id = $1 OR c.addressee_id = $1) AND c.status = 'accepted'
      ORDER BY c.updated_at DESC`,
    [user.id]
  );

  // Pending incoming requests
  const { rows: pendingIncoming } = await db.query(
    `SELECT c.id, c.requester_id, c.created_at, u.display_name, u.alias, u.city, u.profile_photo_url
       FROM user_connections c
       JOIN users u ON u.id = c.requester_id
      WHERE c.addressee_id = $1 AND c.status = 'pending'
      ORDER BY c.created_at DESC`,
    [user.id]
  );

  // Pending outgoing requests
  const { rows: pendingOutgoing } = await db.query(
    `SELECT c.id, c.addressee_id, c.created_at, u.display_name, u.alias, u.city
       FROM user_connections c
       JOIN users u ON u.id = c.addressee_id
      WHERE c.requester_id = $1 AND c.status = 'pending'
      ORDER BY c.created_at DESC`,
    [user.id]
  );

  sendJson(res, 200, {
    ok: true,
    connections: accepted,
    pendingRequests: pendingIncoming,
    sentRequests: pendingOutgoing
  });
}

const ConnectionReqBody = z.object({
  targetUserId: z.string().uuid()
}).strict();

/** POST /api/me/connections/request — Send connection request to another attendee. */
export async function requestConnectionApi({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`conn:${user.id}`, 20, 600);

  const body = parse(ConnectionReqBody, await readJson(req));
  if (body.targetUserId === user.id) {
    throw new HttpError(400, 'validation', 'Cannot connect with yourself');
  }

  // Verify target user exists and allows connections
  const target = (await db.query(
    `SELECT u.id, p.profile_visibility
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.id = $1`,
    [body.targetUserId]
  )).rows[0];

  if (!target) throw new HttpError(404, 'not_found', 'User not found');
  if (target.profile_visibility === 'private') {
    throw new HttpError(403, 'private_profile', 'This user does not accept connection requests');
  }

  const row = (await db.query(
    `INSERT INTO user_connections (requester_id, addressee_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (requester_id, addressee_id) DO UPDATE SET
       status = CASE WHEN user_connections.status = 'declined' THEN 'pending' ELSE user_connections.status END,
       updated_at = now()
     RETURNING id, status`,
    [user.id, body.targetUserId]
  )).rows[0];

  sendJson(res, 201, { ok: true, connection: row });
}

/** POST /api/me/connections/:id/accept — Accept connection request. */
export async function acceptConnectionApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const connId = params.id;
  const resUpdate = await db.query(
    `UPDATE user_connections
        SET status = 'accepted', updated_at = now()
      WHERE id = $1 AND addressee_id = $2 AND status = 'pending'`,
    [connId, user.id]
  );

  if (resUpdate.rowCount === 0) {
    throw new HttpError(404, 'not_found', 'Pending request not found');
  }

  sendJson(res, 200, { ok: true, accepted: true });
}

/** POST /api/me/connections/:id/decline — Decline connection request. */
export async function declineConnectionApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const connId = params.id;
  await db.query(
    `UPDATE user_connections
        SET status = 'declined', updated_at = now()
      WHERE id = $1 AND (addressee_id = $2 OR requester_id = $2)`,
    [connId, user.id]
  );

  sendJson(res, 200, { ok: true, declined: true });
}
