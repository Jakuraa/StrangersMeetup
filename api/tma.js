// api/tma.js - Telegram Mini App Authentication & Consent Profile Management
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { validateTelegramInitData } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['GET', 'POST', 'PATCH'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST') {
    // 1. Authenticate Telegram Mini App session from WebApp.initData
    try {
      const { initData } = req.body || {};
      if (!initData) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'initData parameter is required' }));
      }

      const validation = await validateTelegramInitData(initData);
      if (!validation.ok) {
        logger.warn('TMA initData validation failed', { error: validation.error });
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error: validation.error }));
      }

      const user = validation.user;
      if (!user || !user.id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'No user record found in initData' }));
      }

      const telegramUserId = Number(user.id);

      // Check or create pseudonymous profile
      const existingProfile = await db.query(
        'SELECT * FROM tma_profiles WHERE telegram_user_id = $1',
        [telegramUserId]
      );

      let profile = null;
      if (existingProfile.rows && existingProfile.rows.length > 0) {
        profile = existingProfile.rows[0];
      } else {
        // Create initial pseudonymous profile
        const pseudonym = `SM_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        await db.query(
          `INSERT INTO tma_profiles (telegram_user_id, pseudonym, first_name, username, created_at, updated_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [telegramUserId, pseudonym, user.first_name || '', user.username || '']
        );
        profile = {
          telegram_user_id: telegramUserId,
          pseudonym,
          first_name: user.first_name || '',
          username: user.username || '',
          consent_community_rules: 0,
          consent_double_opt_in: 0,
          profile_completed: 0
        };
      }

      logger.info('TMA user authenticated', { telegramUserId, pseudonym: profile.pseudonym });

      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        authenticated: true,
        profile: {
          telegramUserId,
          pseudonym: profile.pseudonym,
          city: profile.city || null,
          ageDeclared: profile.age_declared || null,
          consentCommunityRules: Boolean(profile.consent_community_rules),
          consentDoubleOptIn: Boolean(profile.consent_double_opt_in),
          profileCompleted: Boolean(profile.profile_completed)
        }
      }));
    } catch (err) {
      logger.error('TMA validation exception', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Internal server error in TMA auth' }));
    }
  }

  if (req.method === 'PATCH') {
    // 2. Consent-based profile completion and optional interests
    try {
      const { initData, city, ageDeclared, consentCommunityRules, consentDoubleOptIn, interests } = req.body || {};
      if (!initData) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'initData required to update profile' }));
      }

      const validation = await validateTelegramInitData(initData);
      if (!validation.ok || !validation.user) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error: 'Unauthorized TMA request' }));
      }

      const telegramUserId = Number(validation.user.id);
      const interestsJson = Array.isArray(interests) ? JSON.stringify(interests) : '[]';

      await db.query(
        `UPDATE tma_profiles 
         SET city = $1, age_declared = $2, consent_community_rules = $3, consent_double_opt_in = $4,
             interests_json = $5, profile_completed = 1, updated_at = CURRENT_TIMESTAMP
         WHERE telegram_user_id = $6`,
        [
          city || null,
          ageDeclared ? parseInt(ageDeclared, 10) : null,
          consentCommunityRules ? 1 : 0,
          consentDoubleOptIn ? 1 : 0,
          interestsJson,
          telegramUserId
        ]
      );

      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        message: 'Profile completed with consent. Private event coordination enabled.'
      }));
    } catch (err) {
      logger.error('TMA profile update exception', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Failed to update profile' }));
    }
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
}
