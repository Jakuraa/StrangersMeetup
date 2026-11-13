// lib/services/users.js - Telegram-identity users. Identity always comes from a validated source.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { botUsername } from '../config.js';

function aliasFrom(tgUser) {
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() || tgUser.name || tgUser.username || tgUser.preferred_username;
  return name ? String(name).slice(0, 64) : null;
}

/**
 * Create or refresh a user from a *validated* Telegram identity.
 * Age confirmation is sticky: once true it never reverts.
 */
export async function upsertTelegramUser(tgUser, { ageConfirmed = false, botStarted = false } = {}, client = db) {
  const { rows } = await client.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, bot_started)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() END, $4)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       alias = COALESCE(EXCLUDED.alias, users.alias),
       age_confirmed_21 = users.age_confirmed_21 OR EXCLUDED.age_confirmed_21,
       age_confirmed_at = COALESCE(users.age_confirmed_at, EXCLUDED.age_confirmed_at),
       bot_started = users.bot_started OR EXCLUDED.bot_started
     RETURNING id, telegram_user_id, alias, age_confirmed_21, status, bot_started`,
    [tgUser.id, aliasFrom(tgUser), Boolean(ageConfirmed), Boolean(botStarted)]
  );
  const user = rows[0];
  await client.query(
    `INSERT INTO user_identities (user_id, provider, subject, verified_at) VALUES ($1, 'telegram', $2, now())
     ON CONFLICT (provider, subject) DO NOTHING`, [user.id, String(user.telegram_user_id)]);
  if (user.status !== 'active') throw new HttpError(403, 'account_restricted', 'This account cannot sign in. Contact support if you think this is a mistake.');
  return user;
}

export async function confirmAge(userId) {
  await db.query(
    `UPDATE users SET age_confirmed_21 = true, age_confirmed_at = COALESCE(age_confirmed_at, now()) WHERE id = $1`, [userId]);
}

export async function userByTelegramId(telegramUserId, client = db) {
  const { rows } = await client.query('SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  return rows[0] || null;
}

/**
 * Creates a cryptographically random, single-use, 15-minute account linking token.
 */
export async function createAccountLinkToken(userId = null) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await db.query(
    `INSERT INTO account_link_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  const bot = botUsername();
  const linkUrl = bot ? `https://t.me/${bot}?start=link_${token}` : null;
  return { token, linkUrl, expiresAt };
}

/**
 * Redeems an account link token from Telegram, associating the Telegram account.
 */
export async function redeemAccountLinkToken(token, tgUser) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing_token' };
  return await db.tx(async (c) => {
    const row = (await c.query(
      `SELECT id, user_id, expires_at, used_at FROM account_link_tokens
        WHERE token = $1 FOR UPDATE`, [token]
    )).rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.used_at) return { ok: false, reason: 'already_used' };
    if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };

    // Resolve or upsert the Telegram user
    const tgDbUser = await upsertTelegramUser(tgUser, { botStarted: true }, c);

    // If token was issued for an existing web user, link identities
    if (row.user_id && row.user_id !== tgDbUser.id) {
      await c.query(
        `INSERT INTO user_identities (user_id, provider, subject, verified_at)
         VALUES ($1, 'telegram', $2, now())
         ON CONFLICT (provider, subject) DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = now()`,
        [row.user_id, String(tgUser.id)]
      );
      // Transfer bot_started flag to the web user
      await c.query(`UPDATE users SET bot_started = true WHERE id = $1`, [row.user_id]);
    }

    await c.query(
      `UPDATE account_link_tokens SET used_at = now(), telegram_user_id = $2 WHERE id = $1`,
      [row.id, tgUser.id]
    );

    return { ok: true, userId: row.user_id || tgDbUser.id, telegramUserId: tgUser.id };
  });
}

/**
 * Checks the status of an account link token.
 */
export async function getAccountLinkStatus(token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await db.query(
    `SELECT token, telegram_user_id, used_at, expires_at FROM account_link_tokens WHERE token = $1`,
    [token]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const isExpired = new Date(r.expires_at) < new Date();
  return {
    token: r.token,
    linked: Boolean(r.used_at),
    telegramUserId: r.telegram_user_id,
    usedAt: r.used_at,
    expired: isExpired && !r.used_at
  };
}

/**
 * Updates notification preferences and quiet hours for a user.
 */
export async function updateNotificationPreferences(userId, { remindersEnabled, quietHoursEnabled, quietHoursStart, quietHoursEnd }) {
  const sets = [];
  const vals = [userId];
  let idx = 2;
  if (remindersEnabled !== undefined) { sets.push(`reminders_enabled = $${idx++}`); vals.push(Boolean(remindersEnabled)); }
  if (quietHoursEnabled !== undefined) { sets.push(`quiet_hours_enabled = $${idx++}`); vals.push(Boolean(quietHoursEnabled)); }
  if (quietHoursStart !== undefined) { sets.push(`quiet_hours_start = $${idx++}`); vals.push(quietHoursStart); }
  if (quietHoursEnd !== undefined) { sets.push(`quiet_hours_end = $${idx++}`); vals.push(quietHoursEnd); }
  if (!sets.length) return getNotificationPreferences(userId);
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
     RETURNING reminders_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end`,
    vals
  );
  return rows[0] || null;
}

/**
 * Retrieves notification preferences and quiet hours for a user.
 */
export async function getNotificationPreferences(userId) {
  const { rows } = await db.query(
    `SELECT reminders_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}
