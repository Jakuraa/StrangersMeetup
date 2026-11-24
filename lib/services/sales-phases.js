// lib/services/sales-phases.js - Sales Timeline & Scheduled Pricing Phases Module.
// Multi-phase scheduled pricing, automatic phase transitions, quotas & server-time enforcement.

import { db } from '../db.js';
import { HttpError } from '../http.js';

export async function saveEventSalesPhases(c, eventId, phases = []) {
  await c.query(`DELETE FROM event_sales_phases WHERE event_id = $1`, [eventId]);
  if (!Array.isArray(phases) || phases.length === 0) {
    await c.query(`UPDATE events SET has_sales_phases = false WHERE id = $1`, [eventId]);
    return [];
  }

  const valid = [];
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    const name = String(p.name || '').trim();
    if (!name) continue;
    if (!p.startsAt || !p.endsAt) continue;

    const startsAt = new Date(p.startsAt);
    const endsAt = new Date(p.endsAt);
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      continue;
    }

    const tz = String(p.timezone || 'Asia/Kolkata').trim();
    const pricePaise = p.pricePaise != null ? Math.max(0, parseInt(p.pricePaise, 10)) : null;
    const quota = p.quota != null ? Math.max(1, parseInt(p.quota, 10)) : null;
    const maxPerBooking = p.maxPerBooking != null ? Math.max(1, parseInt(p.maxPerBooking, 10)) : 10;
    const tierIds = Array.isArray(p.applicableTierIds) ? p.applicableTierIds.filter(Boolean) : [];
    const accessCode = p.accessCode ? String(p.accessCode).trim().toUpperCase() : null;
    const isActive = p.isActive !== false;

    const res = await c.query(
      `INSERT INTO event_sales_phases (
         event_id, name, starts_at, ends_at, timezone, price_paise, quota,
         max_per_booking, applicable_tier_ids, access_code, is_active, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        eventId, name, startsAt, endsAt, tz, pricePaise, quota,
        maxPerBooking, tierIds, accessCode, isActive, i
      ]
    );
    valid.push(res.rows[0]);
  }

  await c.query(`UPDATE events SET has_sales_phases = $2 WHERE id = $1`, [eventId, valid.length > 0]);
  return valid;
}

export async function getEventSalesPhases(eventId, c = db) {
  const { rows } = await c.query(
    `SELECT * FROM event_sales_phases WHERE event_id = $1 ORDER BY sort_order ASC, starts_at ASC`,
    [eventId]
  );
  return rows;
}

/**
 * Resolves active, upcoming and expired phases according to authoritative server clock.
 */
export function categorizePhases(phases = [], { now = new Date(), tierId = null, accessCode = null } = {}) {
  const currentTime = now.getTime();
  let currentActive = null;
  const upcoming = [];
  const past = [];

  for (const p of phases) {
    if (p.is_active === false || p.isActive === false) continue;
    if (Array.isArray(p.applicable_tier_ids) && p.applicable_tier_ids.length > 0 && tierId) {
      if (!p.applicable_tier_ids.includes(tierId)) continue;
    }

    const start = new Date(p.starts_at || p.startsAt).getTime();
    const end = new Date(p.ends_at || p.endsAt).getTime();
    const sold = p.tickets_sold ?? p.soldCount ?? 0;
    const isExhausted = p.quota != null && sold >= p.quota;

    if (currentTime >= start && currentTime < end && !isExhausted) {
      if (p.access_code && accessCode !== p.access_code) {
        // Requires code to unlock
        continue;
      }
      if (!currentActive) {
        currentActive = p;
      }
    } else if (currentTime < start) {
      upcoming.push(p);
    } else {
      past.push(p);
    }
  }

  return {
    current: currentActive,
    activePhase: currentActive,
    upcoming,
    upcomingPhases: upcoming,
    past,
    pastPhases: past
  };
}

/**
 * Atomically records phase ticket allocation and asserts quota under row locks.
 */
export async function assertAndRecordPhaseSale(c, phaseId, quantity = 1) {
  if (!phaseId) return null;
  const phase = (await c.query(
    `SELECT * FROM event_sales_phases WHERE (id::text = $1 OR name = $1) FOR UPDATE`,
    [String(phaseId)]
  )).rows[0];

  if (!phase) throw new HttpError(404, 'phase_not_found', 'Sales phase not found.');
  const now = Date.now();
  if (new Date(phase.starts_at).getTime() > now) {
    throw new HttpError(409, 'phase_not_started', `Sales phase "${phase.name}" has not started yet.`);
  }
  if (new Date(phase.ends_at).getTime() <= now) {
    throw new HttpError(409, 'phase_ended', `Sales phase "${phase.name}" has ended.`);
  }
  if (phase.quota != null && phase.tickets_sold + quantity > phase.quota) {
    const remaining = Math.max(0, phase.quota - phase.tickets_sold);
    throw new HttpError(
      409,
      'phase_quota_exhausted',
      remaining > 0
        ? `Only ${remaining} ticket(s) remaining in ${phase.name}.`
        : `Sales phase "${phase.name}" has sold out.`
    );
  }

  await c.query(
    `UPDATE event_sales_phases SET tickets_sold = tickets_sold + $2, updated_at = now() WHERE id = $1`,
    [phase.id, quantity]
  );

  return phase;
}
