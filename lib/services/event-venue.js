// lib/services/event-venue.js - Interactive Venue Layout & Section-Based Ticketing Module.
// Visual venue diagram, section-based capacity, coordinates & section pricing.

import { db } from '../db.js';
import { HttpError } from '../http.js';

export const SECTION_PRESETS = {
  stage: { name: 'Stage', color: '#1f2937', category: 'stage', shape: 'rect' },
  general: { name: 'General Admission / Standing', color: '#3b82f6', category: 'general', shape: 'rect' },
  silver: { name: 'Silver Section', color: '#94a3b8', category: 'silver', shape: 'rect' },
  gold: { name: 'Gold Section', color: '#eab308', category: 'gold', shape: 'rect' },
  platinum: { name: 'Platinum Section', color: '#06b6d4', category: 'platinum', shape: 'rect' },
  fanpit: { name: 'Fanpit', color: '#ec4899', category: 'fanpit', shape: 'rect' },
  vip: { name: 'VIP Lounge', color: '#a855f7', category: 'vip', shape: 'rect' },
  backstage: { name: 'Backstage Pass', color: '#f97316', category: 'backstage', shape: 'rect' },
  custom: { name: 'Custom Section', color: '#10b981', category: 'custom', shape: 'rect' }
};

export async function saveEventVenueLayout(c, eventId, layoutConfig = {}, sections = [], tierMapping = {}) {
  await c.query(`DELETE FROM event_venue_layouts WHERE event_id = $1`, [eventId]);

  const layoutType = layoutConfig.layoutType || (sections.length > 0 ? 'section_based' : 'none');
  if (layoutType === 'none' || !sections || sections.length === 0) {
    await c.query(`UPDATE events SET has_venue_layout = false WHERE id = $1`, [eventId]);
    return null;
  }

  const canvasWidth = parseInt(layoutConfig.canvasWidth, 10) || 800;
  const canvasHeight = parseInt(layoutConfig.canvasHeight, 10) || 500;

  const layoutRow = (await c.query(
    `INSERT INTO event_venue_layouts (event_id, layout_type, canvas_width, canvas_height, config)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [eventId, layoutType, canvasWidth, canvasHeight, JSON.stringify(layoutConfig.config || {})]
  )).rows[0];

  const savedSections = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const sectionKey = String(s.sectionKey || s.key || `sec_${i}`).trim();
    const name = String(s.name || `Section ${i + 1}`).trim();
    const category = s.category || 'custom';
    const color = s.color || SECTION_PRESETS[category]?.color || '#6366f1';
    const shape = s.shape || 'rect';
    const x = parseInt(s.x, 10) || 0;
    const y = parseInt(s.y, 10) || 0;
    const width = parseInt(s.width, 10) || 120;
    const height = parseInt(s.height, 10) || 80;
    const capacity = Math.max(0, parseInt(s.capacity, 10) || 100);
    const pricePaise = Math.max(0, parseInt(s.pricePaise, 10) || 0);
    const minPerBooking = Math.max(1, parseInt(s.minPerBooking, 10) || 1);
    const maxPerBooking = Math.max(minPerBooking, parseInt(s.maxPerBooking, 10) || 10);
    const status = s.status === 'unavailable' ? 'unavailable' : (s.status === 'sold_out' ? 'sold_out' : 'available');
    const ticketTypeId = tierMapping[sectionKey] || s.ticketTypeId || null;

    const secRow = (await c.query(
      `INSERT INTO event_venue_sections (
         layout_id, event_id, ticket_type_id, section_key, name, category, color, shape,
         x, y, width, height, capacity, price_paise, min_per_booking, max_per_booking,
         status, sort_order, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        layoutRow.id, eventId, ticketTypeId, sectionKey, name, category, color, shape,
        x, y, width, height, capacity, pricePaise, minPerBooking, maxPerBooking,
        status, i, JSON.stringify(s.metadata || {})
      ]
    )).rows[0];
    savedSections.push(secRow);
  }

  await c.query(`UPDATE events SET has_venue_layout = true WHERE id = $1`, [eventId]);
  return { ...layoutRow, sections: savedSections };
}

export async function getEventVenueLayout(first, second = db) {
  const c = (first && typeof first.query === 'function') ? first : second;
  const eventId = (first && typeof first.query === 'function') ? second : first;

  const layout = (await c.query(
    `SELECT * FROM event_venue_layouts WHERE event_id = $1`,
    [eventId]
  )).rows[0];

  if (!layout) return null;

  // Fetch sections with calculated sold seats
  const { rows: sections } = await c.query(
    `SELECT s.*,
            COALESCE((
              SELECT SUM(b.quantity)::int
                FROM bookings b
               WHERE b.section_id = s.id
                 AND b.status IN ('pending_payment', 'confirmed', 'checked_in')
                 AND (b.status != 'pending_payment' OR b.hold_expires_at > now())
            ), 0) as seats_taken
       FROM event_venue_sections s
      WHERE s.layout_id = $1
      ORDER BY s.sort_order ASC, s.created_at ASC`,
    [layout.id]
  );

  const formattedSections = sections.map((sec) => {
    const taken = sec.seats_taken || 0;
    const remaining = Math.max(0, sec.capacity - taken);
    const isSoldOut = sec.capacity > 0 && remaining <= 0;
    const effectiveStatus = sec.status === 'unavailable' ? 'unavailable' : (isSoldOut ? 'sold_out' : 'available');
    return {
      ...sec,
      seatsTaken: taken,
      remainingSeats: remaining,
      effectiveStatus
    };
  });

  return {
    ...layout,
    layoutType: layout.layout_type,
    sections: formattedSections
  };
}

/**
 * Validates section availability and reserves inventory with row locks.
 */
export async function assertSectionInventory(c, sectionId, quantity) {
  if (!sectionId) return null;
  const sec = (await c.query(
    `SELECT * FROM event_venue_sections WHERE (id::text = $1 OR section_key = $1) FOR UPDATE`,
    [String(sectionId)]
  )).rows[0];

  if (!sec) throw new HttpError(404, 'section_not_found', 'Venue section not found.');
  if (sec.status === 'unavailable' || sec.status === 'sold_out') {
    throw new HttpError(409, 'section_sold_out', `${sec.name} is ${sec.status === 'sold_out' ? 'sold out' : 'currently unavailable'}.`);
  }

  const taken = (await c.query(
    `SELECT COALESCE(SUM(quantity), 0)::int as count
       FROM bookings
      WHERE section_id = $1
        AND status IN ('pending_payment', 'confirmed', 'checked_in')
        AND (status != 'pending_payment' OR hold_expires_at > now())`,
    [sectionId]
  )).rows[0]?.count || 0;

  if (sec.capacity - taken < quantity) {
    const left = Math.max(0, sec.capacity - taken);
    throw new HttpError(
      409,
      'section_sold_out',
      left > 0 ? `Only ${left} seat(s) remaining in ${sec.name}.` : `${sec.name} is sold out.`
    );
  }

  return sec;
}
