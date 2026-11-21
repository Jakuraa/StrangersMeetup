// lib/handlers/onboarding.js - Member onboarding API handlers.
// Guides new members through mandatory profile completion, community follow, and server-side validation.
import { readJson, sendJson, hashIp } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import {
  getOnboardingStatus,
  confirmAgeEligibility,
  rejectAgeEligibility,
  recordCommunityJoin,
  getCommunityJoins,
  saveBasicProfile,
  saveInterests,
  saveOptionalProfile,
  completeOnboarding,
  INTEREST_CATEGORIES,
  INTEREST_OPTIONS,
  GENDER_OPTIONS,
  COMMUNITY_CHANNELS
} from '../services/member-onboarding.js';

/** GET /api/onboarding/status — Get current onboarding state. */
export async function getStatus({ req, res }) {
  const user = await requireUser(req);
  const status = await getOnboardingStatus(user.id);
  sendJson(res, 200, {
    ok: true,
    ...status,
    options: {
      interests: INTEREST_OPTIONS,
      interestCategories: INTEREST_CATEGORIES,
      genders: GENDER_OPTIONS,
      communityChannels: COMMUNITY_CHANNELS
    }
  });
}

const AgeBody = z.object({
  confirmed: z.boolean(),
  policyVersion: z.string().max(20).optional().default('1.0')
}).strict();

/** POST /api/onboarding/age — Confirm or reject age eligibility. */
export async function confirmAge({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 30, 300);

  const body = parse(AgeBody, await readJson(req));
  if (!body.confirmed) {
    const result = await rejectAgeEligibility(user.id);
    return sendJson(res, 200, { ok: true, eligible: false, ...result });
  }

  const userAgent = req.headers['user-agent'] || null;
  const result = await confirmAgeEligibility(user.id, {
    ip: hashIp(ip),
    userAgent,
    policyVersion: body.policyVersion
  });
  sendJson(res, 200, { ok: true, eligible: true, ...result });
}

const CommunityJoinBody = z.object({
  channel: z.enum(['telegram', 'whatsapp', 'whatsapp_channel', 'instagram']),
  confirmed: z.boolean().optional()
}).strict();

/** POST /api/onboarding/community — Record user-confirmed community join (Phase 6). */
export async function saveCommunityJoinHandler({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 30, 300);

  const body = parse(CommunityJoinBody, await readJson(req));
  const channel = body.channel === 'whatsapp' ? 'whatsapp_channel' : body.channel;
  const userAgent = req.headers['user-agent'] || null;
  const result = await recordCommunityJoin(user.id, {
    channel,
    ip: hashIp(ip),
    userAgent
  });
  sendJson(res, 200, { ok: true, channel, ...result });
}

/** GET /api/onboarding/community — Retrieve confirmed community channels. */
export async function getCommunityJoinsHandler({ req, res }) {
  const user = await requireUser(req);
  const joins = await getCommunityJoins(user.id);
  sendJson(res, 200, {
    ok: true,
    channels: joins.map((j) => j.channel),
    joins
  });
}

const ProfileBody = z.object({
  displayName: z.string().min(1).max(50),
  gender: z.enum(['female', 'male', 'non_binary', 'other', 'prefer_not_to_say', 'self_describe', 'woman', 'man']),
  genderCustom: z.string().max(100).optional().nullable(),
  city: z.string().min(1).max(100)
}).strict();

/** POST /api/onboarding/profile — Save basic profile (display name, gender, custom gender, city). */
export async function saveProfile({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 30, 300);

  const body = parse(ProfileBody, await readJson(req));
  const result = await saveBasicProfile(user.id, body);
  sendJson(res, 200, { ok: true, ...result });
}

const InterestsBody = z.object({
  interests: z.array(z.string()).min(1).max(50)
}).strict();

/** POST /api/onboarding/interests — Save selected interests. */
export async function saveInterestsHandler({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 30, 300);

  const body = parse(InterestsBody, await readJson(req));
  const result = await saveInterests(user.id, body.interests);
  sendJson(res, 200, { ok: true, ...result });
}

const OptionalBody = z.object({
  bio: z.string().max(500).optional(),
  languages: z.array(z.string().max(50)).max(10).optional()
}).strict();

/** POST /api/onboarding/optional — Save optional profile enhancements. */
export async function saveOptional({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 30, 300);

  const body = parse(OptionalBody, await readJson(req));
  const result = await saveOptionalProfile(user.id, body);
  sendJson(res, 200, { ok: true, ...result });
}

/** POST /api/onboarding/complete — Finalize onboarding (validates all mandatory fields). */
export async function complete({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`onboard:${user.id}`, 10, 300);

  const requirePhone = process.env.DEV_LOGIN !== 'true' && process.env.NODE_ENV !== 'test';
  const result = await completeOnboarding(user.id, { requirePhone });
  sendJson(res, 200, { ok: true, ...result });
}
