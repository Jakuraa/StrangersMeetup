// api/inquiries.js - Native Inquiries for Partner, Host, Venue & Contact Forms
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['POST'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  try {
    const body = req.body || {};
    const { type, name, email, phone, city, organization, message, details } = body;

    const allowedTypes = ['partner', 'host', 'venue', 'contact'];
    if (!type || !allowedTypes.includes(type)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        ok: false,
        error: `Invalid inquiry type. Must be one of: ${allowedTypes.join(', ')}`
      }));
    }

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'Full name is required (min 2 characters)' }));
    }

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'A valid email address is required' }));
    }

    const inquiryId = `inq_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const payloadDetails = {
      message: message || '',
      ...(typeof details === 'object' && details !== null ? details : {})
    };

    await db.query(
      `INSERT INTO inquiries (id, type, name, email, phone, city, organization, details_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW')`,
      [
        inquiryId,
        type,
        name.trim(),
        email.trim(),
        phone ? phone.trim() : null,
        city ? city.trim() : null,
        organization ? organization.trim() : null,
        JSON.stringify(payloadDetails)
      ]
    );

    // Audit log
    await db.query(
      `INSERT INTO audit_logs (id, action, actor_type, actor_id, details_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `aud_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        `INQUIRY_SUBMITTED_${type.toUpperCase()}`,
        'USER',
        email.trim(),
        JSON.stringify({ inquiryId, type, city })
      ]
    );

    logger.info(`Inquiry received: ${type}`, { inquiryId, email: email.trim(), city });

    let successMessage = 'Thank you for reaching out! A StrangersMeetup coordinator will review your application and respond within 24 business hours.';
    if (type === 'venue') {
      successMessage = 'Thank you for listing your venue! Our regional experience curator will review your space and schedule a walkthrough.';
    } else if (type === 'host') {
      successMessage = 'Thank you for applying to host! Our community lead will connect with you on Telegram or email for an introductory conversation.';
    } else if (type === 'partner') {
      successMessage = 'Partnership request received. Our business development team will review your proposal promptly.';
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      inquiryId,
      message: successMessage
    }));
  } catch (err) {
    logger.error('Failed to submit inquiry', err);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'Failed to record inquiry' }));
  }
}
