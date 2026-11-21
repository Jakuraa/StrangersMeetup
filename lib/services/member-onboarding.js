// lib/services/member-onboarding.js - Member onboarding profile completion service.
// Handles mandatory profile fields, step tracking, interest storage, and consent recording.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { logger } from '../logger.js';

// Onboarding steps: 1=Welcome, 2=Age, 3=Profile, 4=Interests, 5=OptionalProfile, 6=Complete
export const ONBOARDING_STEPS = {
  WELCOME: 1,
  AGE_ELIGIBILITY: 2,
  BASIC_PROFILE: 3,
  INTERESTS: 4,
  OPTIONAL_PROFILE: 5,
  COMPLETE: 6
};

export const INTEREST_OPTIONS = [
  { key: 'parties_nightlife', label: 'Parties & Nightlife', icon: '🎉' },
  { key: 'music_concerts', label: 'Music & Concerts', icon: '🎵' },
  { key: 'social_meetups', label: 'Social Meetups', icon: '👋' },
  { key: 'dining_food', label: 'Dining & Food', icon: '🍽️' },
  { key: 'travel_trips', label: 'Travel & Trips', icon: '✈️' },
  { key: 'adventure_outdoors', label: 'Adventure & Outdoors', icon: '🏔️' },
  { key: 'fitness_sports', label: 'Fitness & Sports', icon: '💪' },
  { key: 'arts_culture', label: 'Arts & Culture', icon: '🎭' },
  { key: 'networking_professional', label: 'Networking', icon: '🤝' },
  { key: 'experiences_activities', label: 'Experiences', icon: '⭐' }
];

export const GENDER_OPTIONS = [
  { key: 'female', label: 'Woman' },
  { key: 'male', label: 'Man' },
  { key: 'non_binary', label: 'Non-binary' },
  { key: 'other', label: 'Other' },
  { key: 'prefer_not_to_say', label: 'Prefer not to say' }
];

export const INTEREST_KEYS = INTEREST_OPTIONS.map(o => o.key);

/** Get the current onboarding state for a user. */
export async function getOnboardingStatus(userId) {
  const user = await db.one(
    `SELECT id, onboarding_completed, onboarding_step, display_name, gender, city,
            age_confirmed_21, age_confirmed_at, age_consent_policy_version,
            bio, languages, profile_photo_url
     FROM users WHERE id = $1`, [userId]
  );
  if (!user) throw new HttpError(404, 'not_found', 'User not found');

  const interests = await db.query(
    'SELECT interest_key FROM member_interests WHERE user_id = $1 ORDER BY created_at', [userId]
  );

  return {
    completed: user.onboarding_completed,
    currentStep: user.onboarding_step,
    totalSteps: 6,
    profile: {
      displayName: user.display_name,
      gender: user.gender,
      city: user.city,
      ageConfirmed: user.age_confirmed_21,
      bio: user.bio,
      languages: user.languages || [],
      profilePhotoUrl: user.profile_photo_url,
      interests: interests.rows.map(r => r.interest_key)
    }
  };
}

/** Confirm age eligibility (21+). Step 2. */
export async function confirmAgeEligibility(userId, { ip, userAgent, policyVersion = '1.0' } = {}) {
  return await db.tx(async (client) => {
    await client.query(
      `UPDATE users SET
         age_confirmed_21 = true,
         age_confirmed_at = COALESCE(age_confirmed_at, now()),
         age_consent_policy_version = $2,
         onboarding_step = GREATEST(onboarding_step, $3)
       WHERE id = $1`,
      [userId, policyVersion, ONBOARDING_STEPS.AGE_ELIGIBILITY]
    );

    await client.query(
      `INSERT INTO onboarding_consents (user_id, consent_type, confirmed, policy_version, ip, user_agent, consented_at)
       VALUES ($1, 'age_21_plus', true, $2, $3, $4, now())
       ON CONFLICT (user_id, consent_type) DO UPDATE SET
         confirmed = true, policy_version = $2, ip = $3, user_agent = $4, consented_at = now()`,
      [userId, policyVersion, ip || null, userAgent || null]
    );

    logger.info('age eligibility confirmed', { userId });
    return { confirmed: true };
  });
}

/** Reject age eligibility. The user cannot proceed. */
export async function rejectAgeEligibility(userId) {
  // Record that user declared ineligibility — they cannot create a profile or continue
  return await db.tx(async (client) => {
    await client.query(
      `INSERT INTO onboarding_consents (user_id, consent_type, confirmed, policy_version, consented_at)
       VALUES ($1, 'age_21_plus', false, '1.0', now())
       ON CONFLICT (user_id, consent_type) DO UPDATE SET confirmed = false, consented_at = now()`,
      [userId]
    );
    await client.query(
      `UPDATE users SET age_confirmed_21 = false WHERE id = $1`,
      [userId]
    );
    logger.warn('age eligibility rejected', { userId });
    return { rejected: true };
  });
}

/** Save basic profile. Step 3. */
export async function saveBasicProfile(userId, { displayName, gender, city }) {
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 1) {
    throw new HttpError(400, 'validation', 'Display name is required');
  }
  if (displayName.trim().length > 50) {
    throw new HttpError(400, 'validation', 'Display name must be 50 characters or less');
  }
  const validGenders = GENDER_OPTIONS.map(g => g.key);
  if (!gender || !validGenders.includes(gender)) {
    throw new HttpError(400, 'validation', 'Please select a gender');
  }
  if (!city || typeof city !== 'string' || city.trim().length < 1) {
    throw new HttpError(400, 'validation', 'City is required');
  }
  if (city.trim().length > 100) {
    throw new HttpError(400, 'validation', 'City name must be 100 characters or less');
  }

  await db.query(
    `UPDATE users SET
       display_name = $2,
       gender = $3::user_gender,
       city = $4,
       onboarding_step = GREATEST(onboarding_step, $5)
     WHERE id = $1`,
    [userId, displayName.trim(), gender, city.trim(), ONBOARDING_STEPS.BASIC_PROFILE]
  );

  logger.info('basic profile saved', { userId });
  return { saved: true };
}

/** Save interests. Step 4. Requires at least 1 interest. */
export async function saveInterests(userId, interestKeys) {
  if (!Array.isArray(interestKeys) || interestKeys.length < 1) {
    throw new HttpError(400, 'validation', 'Please select at least one interest');
  }

  const valid = [...new Set(interestKeys.filter(k => INTEREST_KEYS.includes(k)))];
  if (valid.length < 1) {
    throw new HttpError(400, 'validation', 'Please select at least one valid interest');
  }
  if (valid.length > INTEREST_KEYS.length) {
    throw new HttpError(400, 'validation', 'Too many interests selected');
  }

  // Transactional: delete existing + insert new
  return await db.tx(async (client) => {
    await client.query('DELETE FROM member_interests WHERE user_id = $1', [userId]);
    for (const key of valid) {
      await client.query(
        'INSERT INTO member_interests (user_id, interest_key) VALUES ($1, $2) ON CONFLICT (user_id, interest_key) DO NOTHING',
        [userId, key]
      );
    }
    // Also update the legacy interests array on users table for backward compat
    await client.query(
      `UPDATE users SET
         interests = $2::text[],
         onboarding_step = GREATEST(onboarding_step, $3)
       WHERE id = $1`,
      [userId, valid, ONBOARDING_STEPS.INTERESTS]
    );
    logger.info('interests saved', { userId, count: valid.length });
    return { saved: true, count: valid.length };
  });
}

/** Save optional profile enhancements. Step 5. */
export async function saveOptionalProfile(userId, { bio, languages }) {
  const updates = {};
  if (bio !== undefined) {
    updates.bio = typeof bio === 'string' ? bio.trim().slice(0, 500) : null;
  }
  if (languages !== undefined) {
    updates.languages = Array.isArray(languages)
      ? languages.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim()).slice(0, 10)
      : null;
  }

  await db.query(
    `UPDATE users SET
       bio = COALESCE($2, bio),
       languages = COALESCE($3, languages),
       onboarding_step = GREATEST(onboarding_step, $4)
     WHERE id = $1`,
    [userId, updates.bio ?? null, updates.languages ?? null, ONBOARDING_STEPS.OPTIONAL_PROFILE]
  );

  logger.info('optional profile saved', { userId });
  return { saved: true };
}

/** Mark onboarding as complete. Step 6. Validates all mandatory fields and authoritative age consent are present. */
export async function completeOnboarding(userId) {
  return await db.tx(async (client) => {
    // Validate all mandatory fields are actually filled
    const user = (await client.query(
      `SELECT age_confirmed_21, display_name, gender, city FROM users WHERE id = $1`, [userId]
    )).rows[0];
    if (!user) throw new HttpError(404, 'not_found', 'User not found');

    if (!user.age_confirmed_21) {
      throw new HttpError(400, 'validation', 'Age confirmation is required');
    }

    // Authoritative verification: MUST have confirmed=true in onboarding_consents
    const consent = (await client.query(
      `SELECT confirmed, policy_version FROM onboarding_consents WHERE user_id = $1 AND consent_type = 'age_21_plus'`,
      [userId]
    )).rows[0];
    if (!consent || !consent.confirmed) {
      throw new HttpError(403, 'age_ineligible', 'Age confirmation (21+) is required to complete membership');
    }

    if (!user.display_name || user.display_name.trim().length < 1) {
      throw new HttpError(400, 'validation', 'Display name is required');
    }
    if (!user.gender) {
      throw new HttpError(400, 'validation', 'Gender selection is required');
    }
    if (!user.city || user.city.trim().length < 1) {
      throw new HttpError(400, 'validation', 'City is required');
    }

    // Check at least one interest
    const interests = (await client.query(
      'SELECT COUNT(*) AS cnt FROM member_interests WHERE user_id = $1', [userId]
    )).rows[0];
    if (!interests || Number(interests.cnt) < 1) {
      throw new HttpError(400, 'validation', 'At least one interest is required');
    }

    await client.query(
      `UPDATE users SET
         onboarding_completed = true,
         onboarding_completed_at = now(),
         onboarding_step = $2
       WHERE id = $1`,
      [userId, ONBOARDING_STEPS.COMPLETE]
    );

    logger.info('onboarding completed', { userId });
    return { completed: true };
  });
}

/** Check if user needs onboarding and return redirect path if so. */
export async function checkOnboardingRequired(userId) {
  const user = await db.one(
    'SELECT onboarding_completed, onboarding_step FROM users WHERE id = $1', [userId]
  );
  if (!user) return { required: false };

  if (user.onboarding_completed) {
    return { required: false };
  }

  return {
    required: true,
    currentStep: user.onboarding_step || 0,
    redirectTo: '/onboarding'
  };
}
