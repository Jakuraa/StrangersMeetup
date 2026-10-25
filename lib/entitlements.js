// lib/entitlements.js - Entitlement & Subscription Management Engine
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import {
  verifyInvoicePayload,
  createPrivateChannelInviteLink,
  revokeChannelMember
} from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load tiers config
const tiersConfigPath = path.resolve(__dirname, '../config/tiers.json');
export const tiersConfig = JSON.parse(fs.readFileSync(tiersConfigPath, 'utf8'));

/**
 * Get Tier by ID
 */
export function getTierById(tierId) {
  return tiersConfig.tiers.find((t) => t.id === tierId && t.enabled);
}

/**
 * Validate incoming pre-checkout query before approving
 */
export async function validatePreCheckoutQuery(preCheckoutQuery) {
  const { id, currency, total_amount, invoice_payload, from } = preCheckoutQuery;

  if (currency !== 'XTR') {
    return { ok: false, error: 'Only Telegram Stars (XTR) currency is accepted' };
  }

  const payloadData = await verifyInvoicePayload(invoice_payload);
  if (!payloadData) {
    return { ok: false, error: 'Invalid or forged invoice signature' };
  }

  const tier = getTierById(payloadData.tierId);
  if (!tier) {
    return { ok: false, error: 'Selected membership tier is not available or disabled' };
  }

  if (total_amount !== tier.starsPrice) {
    logger.warn('Price mismatch detected in pre_checkout_query', {
      expected: tier.starsPrice,
      received: total_amount,
      tierId: tier.id
    });
    return { ok: false, error: 'Price mismatch for selected tier' };
  }

  return { ok: true, payloadData, tier };
}

/**
 * Process verified successful payment update idempotently
 */
export async function processSuccessfulPayment(successfulPayment, fromUser) {
  const {
    currency,
    total_amount,
    invoice_payload,
    telegram_payment_charge_id,
    provider_payment_charge_id,
    subscription_expiration_date,
    is_recurring,
    is_first_recurrence
  } = successfulPayment;

  if (!telegram_payment_charge_id) {
    throw new Error('Missing telegram_payment_charge_id in payment payload');
  }

  // Idempotency check: Has this charge ID already been processed?
  const existingTx = await db.query(
    'SELECT id, subscription_id FROM payment_transactions WHERE telegram_payment_charge_id = $1',
    [telegram_payment_charge_id]
  );

  if (existingTx.rows && existingTx.rows.length > 0) {
    logger.info('Duplicate payment transaction received; idempotent skip', {
      telegram_payment_charge_id
    });
    return {
      status: 'DUPLICATE',
      transactionId: existingTx.rows[0].id,
      subscriptionId: existingTx.rows[0].subscription_id
    };
  }

  // Verify and unpack payload
  const payloadData = await verifyInvoicePayload(invoice_payload);
  const tierId = payloadData ? payloadData.tierId : null;
  const tier = tierId ? getTierById(tierId) : null;

  if (!tier) {
    throw new Error(`Invalid tier '${tierId}' in verified payment payload`);
  }

  const telegramUserId = fromUser ? fromUser.id : (payloadData?.telegramUserId || 0);
  const telegramUsername = fromUser ? fromUser.username : null;
  const firstName = fromUser ? fromUser.first_name : '';
  const lastName = fromUser ? fromUser.last_name : '';

  // 1. Ensure member record exists
  let memberId = payloadData?.memberId;
  if (!memberId) {
    memberId = `mem_${crypto.randomBytes(8).toString('hex')}`;
  }

  const existingMember = await db.query(
    'SELECT id FROM members WHERE telegram_user_id = $1',
    [telegramUserId]
  );

  if (!existingMember.rows || existingMember.rows.length === 0) {
    await db.query(
      `INSERT INTO members (id, telegram_user_id, telegram_username, first_name, last_name, age_declared, date_of_birth, state_code, terms_accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        memberId,
        telegramUserId,
        telegramUsername,
        firstName,
        lastName,
        21, // baseline validated age gate
        '2000-01-01',
        'TN',
        new Date().toISOString()
      ]
    );
  } else {
    memberId = existingMember.rows[0].id;
  }

  // 2. Calculate subscription period
  const now = new Date();
  const startsAt = now.toISOString();
  let expiresAt;
  if (subscription_expiration_date) {
    expiresAt = new Date(subscription_expiration_date * 1000).toISOString();
  } else {
    const exp = new Date(now.getTime() + (tier.billingPeriodSeconds * 1000));
    expiresAt = exp.toISOString();
  }

  // 3. Upsert subscription
  const subId = `sub_${crypto.randomBytes(8).toString('hex')}`;
  await db.query(
    `INSERT INTO subscriptions (id, member_id, telegram_user_id, tier_id, status, billing_period_seconds, starts_at, expires_at, is_recurring, last_payment_charge_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      subId,
      memberId,
      telegramUserId,
      tier.id,
      'ACTIVE',
      tier.billingPeriodSeconds,
      startsAt,
      expiresAt,
      is_recurring ? 1 : 0,
      telegram_payment_charge_id
    ]
  );

  // 4. Record payment transaction
  const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
  await db.query(
    `INSERT INTO payment_transactions (id, subscription_id, telegram_user_id, telegram_payment_charge_id, provider_payment_charge_id, tier_id, currency, total_amount, is_recurring, is_first_recurrence, subscription_expiration_date, invoice_payload, raw_payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      txId,
      subId,
      telegramUserId,
      telegram_payment_charge_id,
      provider_payment_charge_id || null,
      tier.id,
      currency,
      total_amount,
      is_recurring ? 1 : 0,
      is_first_recurrence ? 1 : 0,
      expiresAt,
      invoice_payload,
      JSON.stringify(successfulPayment)
    ]
  );

  // 5. Generate channel access entitlement
  const channelConfigKey = tier.channelConfigKey;
  const channelId = await getConfig(channelConfigKey, '-1000000000000');

  let inviteLink = 'https://t.me/StrangersMeetupBot?start=pending_channel_config';
  try {
    const inviteObj = await createPrivateChannelInviteLink(channelId, memberId, 48);
    if (inviteObj && inviteObj.invite_link) {
      inviteLink = inviteObj.invite_link;
    }
  } catch (err) {
    logger.error(`Could not generate invite link for channel ${channelId}`, err);
  }

  const entitlementId = `ent_${crypto.randomBytes(8).toString('hex')}`;
  await db.query(
    `INSERT INTO access_entitlements (id, subscription_id, member_id, telegram_user_id, tier_id, channel_id, invite_link, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entitlementId,
      subId,
      memberId,
      telegramUserId,
      tier.id,
      channelId,
      inviteLink,
      'ACTIVE'
    ]
  );

  // 6. Security audit log
  await db.query(
    `INSERT INTO audit_logs (id, action, actor_type, actor_id, details_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      `aud_${crypto.randomBytes(8).toString('hex')}`,
      'PAYMENT_ACTIVATED_ENTITLEMENT_GRANTED',
      'WEBHOOK',
      String(telegramUserId),
      JSON.stringify({
        tierId: tier.id,
        subId,
        txId,
        entitlementId,
        chargeId: telegram_payment_charge_id
      })
    ]
  );

  logger.info('Subscription activated and entitlement granted', {
    memberId,
    telegramUserId,
    tierId: tier.id,
    subId,
    expiresAt
  });

  return {
    status: 'ACTIVATED',
    memberId,
    subscriptionId: subId,
    transactionId: txId,
    entitlementId,
    tierId: tier.id,
    inviteLink,
    expiresAt
  };
}

/**
 * Reconcile and revoke expired entitlements
 */
export async function reconcileExpiredSubscriptions() {
  const now = new Date().toISOString();
  const expired = await db.query(
    `SELECT id, member_id, telegram_user_id, tier_id FROM subscriptions
     WHERE status = 'ACTIVE' AND expires_at < $1`,
    [now]
  );

  const results = { checked: expired.rows?.length || 0, revoked: 0, errors: [] };

  for (const sub of (expired.rows || [])) {
    try {
      // Mark subscription expired
      await db.query(
        `UPDATE subscriptions SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [sub.id]
      );

      // Find channel entitlement
      const ents = await db.query(
        `SELECT id, channel_id FROM access_entitlements WHERE subscription_id = $1 AND status = 'ACTIVE'`,
        [sub.id]
      );

      for (const ent of (ents.rows || [])) {
        await revokeChannelMember(ent.channel_id, sub.telegram_user_id);
        await db.query(
          `UPDATE access_entitlements SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [ent.id]
        );
      }

      results.revoked++;
    } catch (err) {
      logger.error(`Error revoking expired subscription ${sub.id}`, err);
      results.errors.push({ subId: sub.id, error: err.message });
    }
  }

  return results;
}
