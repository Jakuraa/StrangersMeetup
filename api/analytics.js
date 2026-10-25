// api/analytics.js - POST /api/analytics
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['POST'];

const ALLOWED_EVENTS = new Set([
  'landing_page_view',
  'age_gate_pass',
  'age_gate_fail',
  'membership_section_view',
  'tier_selection',
  'checkout_initiation',
  'confirmed_payment',
  'membership_activation',
  'renewal',
  'cancellation',
  'expiration'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  try {
    const { eventName, sessionId, tierId, regionCode, utmSource, utmMedium, utmCampaign, metadata } = req.body || {};

    if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'Invalid or missing eventName' }));
    }

    const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
    const safeSessionId = sessionId || `anon_${crypto.randomBytes(6).toString('hex')}`;

    // Clean metadata: never store tokens or sensitive PII
    const cleanMeta = metadata ? { ...metadata } : {};
    delete cleanMeta.token;
    delete cleanMeta.secret;
    delete cleanMeta.password;
    delete cleanMeta.dob;

    await db.query(
      `INSERT INTO analytics_events (id, event_name, session_id, tier_id, region_code, utm_source, utm_medium, utm_campaign, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        eventId,
        eventName,
        safeSessionId,
        tierId || null,
        regionCode || null,
        utmSource || null,
        utmMedium || null,
        utmCampaign || null,
        JSON.stringify(cleanMeta)
      ]
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, eventId }));
  } catch (err) {
    logger.error('Failed to record analytics event', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'Analytics recording error' }));
  }
}
