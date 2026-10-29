// lib/services/users.js - Telegram-identity users. Identity always comes from a validated source.
import { db } from '../db.js';
import { HttpError } from '../http.js';

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
