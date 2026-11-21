// lib/services/member-onboarding.js - Member onboarding profile completion service.
// Handles mandatory profile fields, phone verification, community joins, structured interests, and consent recording.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { logger } from '../logger.js';
import { maskPhone } from './phone.js';

// Onboarding steps: 1=Welcome, 2=Age, 3=Profile, 4=Interests, 5=OptionalProfile, 6=Complete
export const ONBOARDING_STEPS = {
  WELCOME: 1,
  AGE_ELIGIBILITY: 2,
  BASIC_PROFILE: 3,
  INTERESTS: 4,
  OPTIONAL_PROFILE: 5,
  COMPLETE: 6
};

// 6 Scalable categories with 33 curated nightlife and experiences options (Phase 4)
export const INTEREST_CATEGORIES = [
  {
    id: 'nightlife',
    label: 'Nightlife',
    icon: '🍸',
    interests: [
      { key: 'nightclubs', label: 'Nightclubs', icon: '🪩' },
      { key: 'dj_nights', label: 'DJ nights', icon: '🎧' },
      { key: 'live_music', label: 'Live music', icon: '🎸' },
      { key: 'music_festivals', label: 'Music festivals', icon: '🎪' },
      { key: 'rooftop_parties', label: 'Rooftop parties', icon: '🌆' },
      { key: 'lounge_experiences', label: 'Lounge experiences', icon: '✨' },
      { key: 'themed_parties', label: 'Themed parties', icon: '🎭' }
    ]
  },
  {
    id: 'social_meetups',
    label: 'Social & Meetups',
    icon: '👋',
    interests: [
      { key: 'new_friendships', label: 'New friendships', icon: '🤝' },
      { key: 'social_mixers', label: 'Social mixers', icon: '🥂' },
      { key: 'group_meetups', label: 'Group meetups', icon: '👥' },
      { key: 'board_games', label: 'Board games', icon: '🎲' },
      { key: 'community_events', label: 'Community events', icon: '🌟' },
      { key: 'networking', label: 'Networking', icon: '💼' }
    ]
  },
  {
    id: 'food_dining',
    label: 'Food & Dining',
    icon: '🍽️',
    interests: [
      { key: 'fine_dining', label: 'Fine dining', icon: '🍷' },
      { key: 'casual_dining', label: 'Casual dining', icon: '🍕' },
      { key: 'food_festivals', label: 'Food festivals', icon: '🌮' },
      { key: 'cafe_hopping', label: 'Café hopping', icon: '☕' },
      { key: 'food_trails', label: 'Food trails', icon: '🍜' }
    ]
  },
  {
    id: 'travel_outdoors',
    label: 'Travel & Outdoors',
    icon: '✈️',
    interests: [
      { key: 'weekend_trips', label: 'Weekend trips', icon: '🎒' },
      { key: 'road_trips', label: 'Road trips', icon: '🚗' },
      { key: 'trekking', label: 'Trekking', icon: '🥾' },
      { key: 'adventure_activities', label: 'Adventure activities', icon: '🧗' },
      { key: 'beach_trips', label: 'Beach trips', icon: '🏖️' },
      { key: 'staycations', label: 'Staycations', icon: '🏨' }
    ]
  },
  {
    id: 'entertainment',
    label: 'Entertainment',
    icon: '🎭',
    interests: [
      { key: 'movies', label: 'Movies', icon: '🎬' },
      { key: 'comedy_shows', label: 'Comedy shows', icon: '🎤' },
      { key: 'theatre', label: 'Theatre', icon: '🎭' },
      { key: 'live_performances', label: 'Live performances', icon: '🎷' },
      { key: 'art_cultural_events', label: 'Art & cultural events', icon: '🎨' }
    ]
  },
  {
    id: 'wellness_activities',
    label: 'Wellness & Activities',
    icon: '⚡',
    interests: [
      { key: 'fitness_activities', label: 'Fitness activities', icon: '🏃' },
      { key: 'sports', label: 'Sports', icon: '⚽' },
      { key: 'workshops', label: 'Workshops', icon: '🛠️' },
      { key: 'creative_experiences', label: 'Creative experiences', icon: '✨' }
    ]
  }
];

export const ALL_NEW_INTERESTS = INTEREST_CATEGORIES.flatMap(c => c.interests.map(i => ({ ...i, categoryId: c.id })));

// Backward compatibility with historical interest keys
export const LEGACY_INTEREST_OPTIONS = [
  { key: 'parties_nightlife', label: 'Parties & Nightlife', icon: '🎉', categoryId: 'nightlife' },
  { key: 'music_concerts', label: 'Music & Concerts', icon: '🎵', categoryId: 'nightlife' },
  { key: 'social_meetups', label: 'Social Meetups', icon: '👋', categoryId: 'social_meetups' },
  { key: 'dining_food', label: 'Dining & Food', icon: '🍽️', categoryId: 'food_dining' },
  { key: 'travel_trips', label: 'Travel & Trips', icon: '✈️', categoryId: 'travel_outdoors' },
  { key: 'adventure_outdoors', label: 'Adventure & Outdoors', icon: '🏔️', categoryId: 'travel_outdoors' },
  { key: 'fitness_sports', label: 'Fitness & Sports', icon: '💪', categoryId: 'wellness_activities' },
  { key: 'arts_culture', label: 'Arts & Culture', icon: '🎭', categoryId: 'entertainment' },
  { key: 'networking_professional', label: 'Networking', icon: '🤝', categoryId: 'social_meetups' },
  { key: 'experiences_activities', label: 'Experiences', icon: '⭐', categoryId: 'wellness_activities' }
];

export const INTEREST_OPTIONS = [
  ...ALL_NEW_INTERESTS,
  ...LEGACY_INTEREST_OPTIONS.filter(l => !ALL_NEW_INTERESTS.some(n => n.key === l.key))
];

export const INTEREST_KEYS = INTEREST_OPTIONS.map(o => o.key);

// Mandatory Gender choices (Phase 3)
export const GENDER_OPTIONS = [
  { key: 'female', value: 'female', label: 'Woman', icon: '👩' },
  { key: 'male', value: 'male', label: 'Man', icon: '👨' },
  { key: 'non_binary', value: 'non_binary', label: 'Non-binary', icon: '🧑' },
  { key: 'other', value: 'other', label: 'Self-describe', icon: '✏️', allowsCustom: true },
  { key: 'prefer_not_to_say', value: 'prefer_not_to_say', label: 'Prefer not to say', icon: '🤐' }
];

// Community Social Cards (Phase 6)
export const COMMUNITY_CHANNELS = [
  {
    id: 'telegram',
    name: 'Telegram Community',
    handle: '@nightlifezcom',
    url: 'https://t.me/nightlifezcom',
    description: 'Instant event alerts, secret venue drops, and direct host community.',
    icon: 'telegram'
  },
  {
    id: 'whatsapp_channel',
    name: 'WhatsApp Channel',
    handle: 'NIGHTLIFEZ Official',
    url: 'https://whatsapp.com/channel/0029Vb9EhJ0Bqbr9aQ8gjN3d',
    description: 'Weekly curated weekend guides, guest list passes, and announcements.',
    icon: 'whatsapp'
  },
  {
    id: 'instagram',
    name: 'Instagram',
    handle: '@nightlifez_',
    url: 'https://www.instagram.com/nightlifez_/',
    description: 'Visual stories, party highlights, venue teasers, and member features.',
    icon: 'instagram'
  }
];

/** Get the current onboarding state for a user. */
export async function getOnboardingStatus(userId) {
  const user = await db.one(
    `SELECT id, onboarding_completed, onboarding_step, display_name, gender, gender_custom, city, phone,
            age_confirmed_21, age_confirmed_at, age_consent_policy_version,
            bio, languages, profile_photo_url
     FROM users WHERE id = $1`, [userId]
  );
  if (!user) throw new HttpError(404, 'not_found', 'User not found');

  const interests = await db.query(
    'SELECT interest_key FROM member_interests WHERE user_id = $1 ORDER BY created_at', [userId]
  );

  const communityRows = await db.query(
    'SELECT channel, confirmed_at FROM member_community_joins WHERE user_id = $1', [userId]
  );

  return {
    completed: user.onboarding_completed,
    currentStep: user.onboarding_step,
    totalSteps: 6,
    profile: {
      displayName: user.display_name,
      gender: user.gender,
      genderCustom: user.gender_custom || null,
      city: user.city,
      phone: user.phone ? maskPhone(user.phone) : null,
      phoneVerified: Boolean(user.phone),
      ageConfirmed: user.age_confirmed_21,
      bio: user.bio,
      languages: user.languages || [],
      profilePhotoUrl: user.profile_photo_url,
      interests: interests.rows.map(r => r.interest_key)
    },
    community: {
      channelsJoined: communityRows.rows.map(r => r.channel)
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

/** Save community channel follow confirmation (Phase 6). */
export async function recordCommunityJoin(userId, { channel, ip = null, userAgent = null } = {}) {
  const validChannels = ['telegram', 'whatsapp_channel', 'instagram'];
  if (!channel || !validChannels.includes(channel)) {
    throw new HttpError(400, 'validation', 'Please select a valid community channel');
  }

  await db.query(
    `INSERT INTO member_community_joins (user_id, channel, confirmed, confirmed_at, ip, user_agent)
     VALUES ($1, $2, true, now(), $3, $4)
     ON CONFLICT (user_id, channel) DO UPDATE SET confirmed = true, confirmed_at = now()`,
    [userId, channel, ip, userAgent]
  );

  logger.info('community channel join confirmed', { userId, channel });
  return { saved: true, channel };
}

/** Get community channel joins for a user. */
export async function getCommunityJoins(userId) {
  const { rows } = await db.query(
    `SELECT channel, confirmed_at FROM member_community_joins WHERE user_id = $1 ORDER BY confirmed_at ASC`,
    [userId]
  );
  return rows;
}

/** Save basic profile. Step 3. */
export async function saveBasicProfile(userId, { displayName, gender, genderCustom, city }) {
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 1) {
    throw new HttpError(400, 'validation', 'Display name is required');
  }
  if (displayName.trim().length > 50) {
    throw new HttpError(400, 'validation', 'Display name must be 50 characters or less');
  }

  // Normalize gender inputs
  let mappedGender = gender;
  if (gender === 'woman') mappedGender = 'female';
  if (gender === 'man') mappedGender = 'male';

  const validGenders = ['female', 'male', 'non_binary', 'other', 'prefer_not_to_say', 'self_describe'];
  if (!mappedGender || !validGenders.includes(mappedGender)) {
    throw new HttpError(400, 'validation', 'Please select a gender');
  }

  const customText = (mappedGender === 'other' || mappedGender === 'self_describe') && typeof genderCustom === 'string'
    ? genderCustom.trim().slice(0, 100)
    : null;

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
       gender_custom = $4,
       city = $5,
       onboarding_step = GREATEST(onboarding_step, $6)
     WHERE id = $1`,
    [userId, displayName.trim(), mappedGender, customText, city.trim(), ONBOARDING_STEPS.BASIC_PROFILE]
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
  if (valid.length > 50) {
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

/** Mark onboarding as complete. Step 6. Validates all mandatory fields, phone, and authoritative age consent are present. */
export async function completeOnboarding(userId, { requirePhone = (process.env.NODE_ENV !== 'test' && process.env.DEV_LOGIN !== 'true') } = {}) {
  return await db.tx(async (client) => {
    // Validate all mandatory fields are actually filled
    const user = (await client.query(
      `SELECT id, age_confirmed_21, display_name, gender, city, phone, telegram_user_id FROM users WHERE id = $1`, [userId]
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

    // Mandatory mobile phone verification (Phase 3)
    if (requirePhone && (!user.phone || !user.phone.trim())) {
      throw new HttpError(400, 'validation', 'Verified mobile number is required to complete membership');
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

/** Save account type selection (Attendee vs Business). Step 2. */
export async function saveAccountType(userId, { accountType }) {
  const valid = ['attendee', 'business'];
  if (!accountType || !valid.includes(accountType)) {
    throw new HttpError(400, 'validation', 'Please choose Attendee or Business account type');
  }

  await db.query(
    `UPDATE users SET
       onboarding_flow = $2,
       active_mode = $2
     WHERE id = $1`,
    [userId, accountType]
  );

  logger.info('account type selected', { userId, accountType });
  return { saved: true, accountType };
}

/** Save attendee recommendation and experience preferences. */
export async function saveAttendeePreferences(userId, {
  preferredGroupSizes = [],
  preferredEventTimes = [],
  preferredEventTypes = [],
  preferredMusic = [],
  preferredDining = [],
  socialDiscoveryOptIn = false,
  profileVisibility = 'public'
} = {}) {
  const validVisibilities = ['public', 'connections_only', 'private'];
  const visibility = validVisibilities.includes(profileVisibility) ? profileVisibility : 'public';

  const row = (await db.query(
    `INSERT INTO user_preferences (
       user_id, preferred_group_sizes, preferred_event_times, preferred_event_types,
       preferred_music, preferred_dining, social_discovery_opt_in, profile_visibility
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id) DO UPDATE SET
       preferred_group_sizes = EXCLUDED.preferred_group_sizes,
       preferred_event_times = EXCLUDED.preferred_event_times,
       preferred_event_types = EXCLUDED.preferred_event_types,
       preferred_music = EXCLUDED.preferred_music,
       preferred_dining = EXCLUDED.preferred_dining,
       social_discovery_opt_in = EXCLUDED.social_discovery_opt_in,
       profile_visibility = EXCLUDED.profile_visibility,
       updated_at = now()
     RETURNING *`,
    [
      userId,
      Array.isArray(preferredGroupSizes) ? preferredGroupSizes.slice(0, 10) : [],
      Array.isArray(preferredEventTimes) ? preferredEventTimes.slice(0, 10) : [],
      Array.isArray(preferredEventTypes) ? preferredEventTypes.slice(0, 15) : [],
      Array.isArray(preferredMusic) ? preferredMusic.slice(0, 15) : [],
      Array.isArray(preferredDining) ? preferredDining.slice(0, 15) : [],
      Boolean(socialDiscoveryOptIn),
      visibility
    ]
  )).rows[0];

  logger.info('attendee preferences saved', { userId });
  return { saved: true, preferences: row };
}

/** Get attendee recommendation preferences. */
export async function getAttendeePreferences(userId) {
  const { rows } = await db.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

/** Create or update self-service Business Workspace. */
export async function createBusinessWorkspace(userId, {
  businessType = 'organiser',
  businessName,
  description = '',
  city = '',
  operatingCities = [],
  services = [],
  logoUrl = null,
  coverImageUrl = null,
  contactEmail = null,
  contactPhone = null
}) {
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    throw new HttpError(400, 'validation', 'Business name is required');
  }

  const validTypes = [
    'organiser', 'venue', 'host', 'trip_operator', 'artist_dj',
    'photographer', 'transport', 'activity_provider', 'production_supplier', 'supplier', 'other'
  ];
  const bType = validTypes.includes(businessType) ? businessType : 'organiser';

  return await db.tx(async (client) => {
    // 1. Ensure user has an organisation for their business
    let org = (await client.query(
      `SELECT o.id FROM organisations o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = $1 AND m.role = 'owner'
        LIMIT 1`,
      [userId]
    )).rows[0];

    if (!org) {
      org = (await client.query(
        `INSERT INTO organisations (kind, name, status, created_at)
         VALUES ('business', $1, 'active', now())
         RETURNING id`,
        [businessName.trim()]
      )).rows[0];

      await client.query(
        `INSERT INTO org_memberships (user_id, org_id, role, status)
         VALUES ($1, $2, 'owner', 'active')
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [userId, org.id]
      );
    } else {
      await client.query('UPDATE organisations SET name = $1 WHERE id = $2', [businessName.trim(), org.id]);
    }

    // 2. Grant capabilities based on business type
    const capabilityCodes = ['organise_events'];
    if (bType === 'venue') capabilityCodes.push('manage_venue');
    if (bType === 'host') capabilityCodes.push('host_staff');
    if (bType === 'artist_dj') capabilityCodes.push('dj');
    if (bType === 'photographer') capabilityCodes.push('photography');

    for (const code of capabilityCodes) {
      await client.query(
        `INSERT INTO user_capabilities (user_id, capability_code, status)
         VALUES ($1, $2, 'claimed')
         ON CONFLICT (user_id, capability_code) DO NOTHING`,
        [userId, code]
      );
    }

    // Also update users.organiser_enabled for backward compatibility
    await client.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [userId]);

    // 3. Upsert into business_workspaces
    const workspace = (await client.query(
      `INSERT INTO business_workspaces (
         org_id, owner_user_id, business_type, business_name, description,
         city, operating_cities, services, logo_url, cover_image_url,
         contact_email, contact_phone, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')
       ON CONFLICT (org_id) DO UPDATE SET
         business_type = EXCLUDED.business_type,
         business_name = EXCLUDED.business_name,
         description = EXCLUDED.description,
         city = EXCLUDED.city,
         operating_cities = EXCLUDED.operating_cities,
         services = EXCLUDED.services,
         logo_url = EXCLUDED.logo_url,
         cover_image_url = EXCLUDED.cover_image_url,
         contact_email = EXCLUDED.contact_email,
         contact_phone = EXCLUDED.contact_phone,
         updated_at = now()
       RETURNING *`,
      [
        org.id,
        userId,
        bType,
        businessName.trim(),
        description ? description.trim() : null,
        city ? city.trim() : null,
        Array.isArray(operatingCities) ? operatingCities : [],
        Array.isArray(services) ? services : [],
        logoUrl || null,
        coverImageUrl || null,
        contactEmail || null,
        contactPhone || null
      ]
    )).rows[0];

    // If venue, ensure a venue row exists
    if (bType === 'venue') {
      await client.query(
        `INSERT INTO venues (org_id, name, description, address_public, contact_email, contact_phone, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         ON CONFLICT DO NOTHING`,
        [org.id, businessName.trim(), description || null, city || null, contactEmail || null, contactPhone || null]
      );
    }

    logger.info('business workspace created/updated', { userId, orgId: org.id, businessType: bType });
    return { ok: true, workspace, orgId: org.id };
  });
}

/** Complete business onboarding and switch active mode. */
export async function completeBusinessOnboarding(userId) {
  return await db.tx(async (client) => {
    // Validate workspace exists
    const ws = (await client.query(
      `SELECT id FROM business_workspaces WHERE owner_user_id = $1 LIMIT 1`, [userId]
    )).rows[0];
    if (!ws) throw new HttpError(400, 'validation', 'Please complete your business details before finishing onboarding');

    await client.query(
      `UPDATE users SET
         onboarding_completed = true,
         onboarding_completed_at = now(),
         onboarding_flow = 'business',
         active_mode = 'business'
       WHERE id = $1`,
      [userId]
    );

    logger.info('business onboarding completed', { userId });
    return { completed: true, activeMode: 'business', onboardingFlow: 'business' };
  });
}
