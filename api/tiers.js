// api/tiers.js - GET /api/tiers
import { tiersConfig } from '../lib/entitlements.js';

export const access = 'public';
export const methods = ['GET'];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.end(JSON.stringify({
    ok: true,
    commercialStatus: tiersConfig.commercialStatus,
    disclaimer: tiersConfig.disclaimer,
    currency: tiersConfig.currency,
    currencyLabel: tiersConfig.currencyLabel,
    billingIntervalDays: tiersConfig.billingIntervalDays,
    cancellationPolicy: tiersConfig.cancellationPolicy,
    expirationPolicy: tiersConfig.expirationPolicy,
    refundPolicy: tiersConfig.refundPolicy,
    tiers: tiersConfig.tiers.filter((t) => t.enabled).map((t) => ({
      id: t.id,
      name: t.name,
      headline: t.headline,
      inrTarget: t.inrTarget,
      inrTargetLabel: t.inrTargetLabel,
      starsPrice: t.starsPrice,
      starsPriceLabel: t.starsPriceLabel,
      starsAwaitingValidation: t.starsAwaitingValidation,
      billingPeriodDays: t.billingPeriodDays,
      badge: t.badge,
      isPopular: t.isPopular,
      benefits: t.benefits
    }))
  }));
}
