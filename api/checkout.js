// api/checkout.js - POST /api/checkout
import { getTierById } from '../lib/entitlements.js';
import { createRecurringStarsInvoiceLink } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['POST'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  try {
    const body = req.body || {};
    const { tierId, telegramUserId, memberId } = body;

    if (!tierId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'tierId is required' }));
    }

    const tier = getTierById(tierId);
    if (!tier) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: `Tier '${tierId}' not found or disabled` }));
    }

    logger.info('Initiating recurring Stars checkout link', {
      tierId: tier.id,
      starsPrice: tier.starsPrice,
      telegramUserId
    });

    const checkoutResult = await createRecurringStarsInvoiceLink({
      title: `StrangersMeetup ${tier.name}`,
      description: `${tier.headline} — 30-Day Recurring Membership. Billed in Telegram Stars.`,
      tierId: tier.id,
      starsPrice: tier.starsPrice,
      telegramUserId: telegramUserId ? Number(telegramUserId) : undefined,
      memberId,
      billingPeriodSeconds: tier.billingPeriodSeconds
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      orderId: checkoutResult.orderId,
      invoiceLink: checkoutResult.invoiceLink,
      tier: {
        id: tier.id,
        name: tier.name,
        starsPrice: tier.starsPrice,
        inrTarget: tier.inrTarget,
        billingPeriodDays: tier.billingPeriodDays
      },
      instructions: 'Click the checkout link to open Telegram and complete payment with Telegram Stars. Your channel invite link will be unlocked upon payment confirmation.'
    }));
  } catch (err) {
    logger.error('Failed to initiate checkout', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      error: err.message || 'Failed to initiate checkout'
    }));
  }
}
