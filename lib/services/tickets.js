// lib/services/tickets.js - Cryptographically secure, server-authoritative QR ticketing & check-in.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from './permissions.js';
import { encodeQrMatrix } from '../upi/qr.js';

export const TICKET_PREFIX = 'TK-';
export const QR_PAYLOAD_VERSION = 'NLZ1';

function getTicketSecret() {
  const secret = process.env.TICKET_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
      throw new HttpError(503, 'not_configured', 'Ticket signing is not configured yet (TICKET_SECRET or SESSION_SECRET >= 32 chars required)');
    }
    return secret || 'nlz-ticket-signing-secret-local-dev-fallback';
  }
  return secret;
}

/**
 * Computes an HMAC-SHA256 signature for a ticket code bound to an event.
 */
export function signTicketPayload(ticketCode, eventId) {
  const secret = getTicketSecret();
  return crypto.createHmac('sha256', secret)
    .update(`${ticketCode}:${eventId}`)
    .digest('hex');
}

/**
 * Constant-time verification of a ticket QR signature.
 */
export function verifyTicketPayload(ticketCodeOrPayload, eventId, signature = null) {
  if (!ticketCodeOrPayload || !eventId) return false;
  let code = ticketCodeOrPayload;
  let sig = signature;
  if (!sig && typeof ticketCodeOrPayload === 'string' && ticketCodeOrPayload.startsWith('NLZ1:')) {
    const parsed = parseQrPayload(ticketCodeOrPayload);
    if (!parsed) return false;
    code = parsed.ticketCode;
    sig = parsed.signature;
  }
  if (!sig || typeof sig !== 'string') return false;
  const expected = signTicketPayload(code, eventId);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}

/**
 * Generates the compact QR payload string. Does NOT leak any personal data or database IDs.
 */
export function generateQrPayload(ticketCode, eventId) {
  const sig = signTicketPayload(ticketCode, eventId);
  return `${QR_PAYLOAD_VERSION}:${ticketCode}:${sig}`;
}

/**
 * Parses a QR payload string into version, ticketCode, and signature.
 */
export function parseQrPayload(payloadStr) {
  if (typeof payloadStr !== 'string') return null;
  const parts = payloadStr.trim().split(':');
  if (parts.length !== 3 || parts[0] !== QR_PAYLOAD_VERSION) return null;
  return { version: parts[0], ticketCode: parts[1], signature: parts[2] };
}

/**
 * Generates an SVG string of the ticket QR code.
 */
export function generateTicketQrSvg(payload, { size = 260, margin = 3, darkColor = '#0b0f19', lightColor = '#ffffff' } = {}) {
  const qr = encodeQrMatrix(payload);
  const totalCells = qr.size + margin * 2;
  const cellSize = (size / totalCells).toFixed(3);

  let pathData = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.get(r, c)) {
        const x = ((c + margin) * cellSize).toFixed(2);
        const y = ((r + margin) * cellSize).toFixed(2);
        pathData += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-label="NIGHTLIFEZ Admission Ticket QR Code" role="img">
  <rect width="${size}" height="${size}" fill="${lightColor}" rx="12"/>
  <path d="${pathData.trim()}" fill="${darkColor}"/>
</svg>`;
}

/**
 * Generates a high-entropy, cryptographically unguessable ticket code.
 * Format: TK-XXXX-XXXX-XXXX (12 alphanumeric chars, 48+ bits of random entropy)
 */
export function generateTicketCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${TICKET_PREFIX}${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * Issues tickets for a confirmed booking. Idempotent — will not duplicate tickets if they already exist.
 */
export async function issueTicketsForBooking(bookingId, c = db) {
  return c.tx ? c.tx(doIssue) : doIssue(c);

  async function doIssue(client) {
    const b = (await client.query(
      `SELECT id, event_id, user_id, ticket_type_id, quantity, status FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    )).rows[0];
    if (!b) throw new HttpError(404, 'not_found', 'Booking not found');
    if (b.status !== 'confirmed' && b.status !== 'checked_in') {
      throw new HttpError(409, 'not_eligible', 'Tickets can only be issued for confirmed bookings');
    }

    const existing = (await client.query(
      `SELECT * FROM tickets WHERE booking_id = $1 ORDER BY ticket_number ASC`,
      [bookingId]
    )).rows;
    if (existing.length > 0) return existing;

    const tickets = [];
    const qty = Math.max(1, Number(b.quantity) || 1);
    for (let i = 1; i <= qty; i++) {
      const code = generateTicketCode();
      const hash = signTicketPayload(code, b.event_id);
      const initialStatus = b.status === 'checked_in' ? 'checked_in' : 'valid';
      const checkedInAt = initialStatus === 'checked_in' ? 'NOW()' : 'NULL';
      const r = (await client.query(
        `INSERT INTO tickets (booking_id, event_id, user_id, ticket_type_id, ticket_number, ticket_code, security_hash, status, checked_in_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${checkedInAt})
         RETURNING *`,
        [b.id, b.event_id, b.user_id, b.ticket_type_id, i, code, hash, initialStatus]
      )).rows[0];
      tickets.push(r);
    }
    return tickets;
  }
}

/**
 * Returns tickets for a booking with their QR payload and SVG.
 */
export async function getBookingTickets(bookingId, viewerUser = null, c = db) {
  const b = (await c.query(`SELECT * FROM bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b) throw new HttpError(404, 'not_found', 'Booking not found');

  if (viewerUser) {
    const isOwner = b.user_id === viewerUser.id;
    if (!isOwner) {
      const canView = await can(viewerUser, 'event.view_guests', { eventId: b.event_id }, c);
      if (!canView) throw new HttpError(404, 'not_found', 'Booking not found');
    }
  }

  let tickets = (await c.query(
    `SELECT t.*, tt.name AS tier_name, tt.kind AS tier_kind
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.booking_id = $1
      ORDER BY t.ticket_number ASC`,
    [bookingId]
  )).rows;

  if (tickets.length === 0 && (b.status === 'confirmed' || b.status === 'checked_in')) {
    await issueTicketsForBooking(bookingId, c);
    tickets = (await c.query(
      `SELECT t.*, tt.name AS tier_name, tt.kind AS tier_kind
         FROM tickets t
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.booking_id = $1
        ORDER BY t.ticket_number ASC`,
      [bookingId]
    )).rows;
  }

  return tickets.map((t) => {
    const qrPayload = generateQrPayload(t.ticket_code, t.event_id);
    return {
      id: t.id,
      ticketNumber: t.ticket_number,
      ticketCode: t.ticket_code,
      status: t.status,
      checkedInAt: t.checked_in_at,
      tierName: t.tier_name || 'Standard Admission',
      qrPayload,
      qrSvg: generateTicketQrSvg(qrPayload)
    };
  });
}

/**
 * Server-authoritative ticket validation and check-in.
 */
export async function checkInTicket(actor, eventId, { ticketCode = null, qrPayload = null, method = 'camera_qr', overrideReason = null } = {}, c = db) {
  if (!actor || !actor.id) throw new HttpError(401, 'unauthorized', 'Authentication required');

  // Verify permission
  const allowed = await can(actor, 'event.check_in', { eventId }, c);
  if (!allowed) throw new HttpError(403, 'forbidden', 'You do not have permission to check in tickets for this event');

  if (method === 'manual_override') {
    const canOverride = await can(actor, 'event.manual_override', { eventId }, c);
    if (!canOverride) throw new HttpError(403, 'forbidden', 'Only event managers or organisers can perform manual overrides');
    if (!overrideReason || typeof overrideReason !== 'string' || overrideReason.trim().length < 4) {
      throw new HttpError(400, 'validation', 'A specific override reason (at least 4 characters) is required');
    }
  }

  let code = ticketCode ? ticketCode.trim().toUpperCase() : null;
  let signature = null;

  if (qrPayload) {
    const parsed = parseQrPayload(qrPayload);
    if (!parsed) {
      await recordScanLog({
        eventId,
        ticketId: null,
        bookingId: null,
        scannedBy: actor.id,
        result: 'invalid_format',
        method,
        payloadHash: hashPayload(qrPayload),
        metadata: { error: 'malformed_qr' }
      }, c);
      throw new HttpError(400, 'invalid_qr', 'Malformed or invalid ticket QR format');
    }
    code = parsed.ticketCode.toUpperCase();
    signature = parsed.signature;

    const validSig = verifyTicketPayload(code, eventId, signature);
    if (!validSig) {
      await recordScanLog({
        eventId,
        ticketId: null,
        bookingId: null,
        scannedBy: actor.id,
        result: 'invalid_signature',
        method,
        payloadHash: hashPayload(qrPayload),
        metadata: { code, error: 'forged_or_cross_event' }
      }, c);
      throw new HttpError(400, 'invalid_ticket', 'Invalid or forged QR signature');
    }
  }

  if (!code) {
    throw new HttpError(400, 'validation', 'Ticket code or QR payload is required');
  }

  const payloadHash = hashPayload(qrPayload || code);

  try {
    return await db.tx(async (txClient) => {
      const t = (await txClient.query(
        `SELECT t.*, b.status AS booking_status, b.payment_mode, b.amount_paise,
                u.alias AS attendee_alias, tt.name AS tier_name
           FROM tickets t
           JOIN bookings b ON b.id = t.booking_id
           JOIN users u ON u.id = t.user_id
           LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
          WHERE t.ticket_code = $1
          FOR UPDATE OF t`,
        [code]
      )).rows[0];

      if (!t) {
        throw new HttpError(404, 'ticket_not_found', 'Ticket code not found', { code });
      }

      if (t.event_id !== eventId) {
        throw new HttpError(400, 'event_mismatch', 'This ticket belongs to a different event', {
          ticketId: t.id,
          bookingId: t.booking_id,
          code,
          ticketEventId: t.event_id
        });
      }

      if (t.status === 'checked_in') {
        const prevStaff = t.checked_in_by ? (await txClient.query(`SELECT alias FROM users WHERE id = $1`, [t.checked_in_by])).rows[0]?.alias : 'Staff';
        throw new HttpError(409, 'already_checked_in', 'This ticket has already been checked in', {
          ticketId: t.id,
          bookingId: t.booking_id,
          firstCheckIn: {
            checkedInAt: t.checked_in_at,
            checkedInByAlias: prevStaff
          },
          checkedInAt: t.checked_in_at,
          checkedInByAlias: prevStaff,
          attendee: { alias: t.attendee_alias, tier: t.tier_name, ref: t.booking_id.slice(0, 8) }
        });
      }

      if (t.status === 'revoked') {
        if (method !== 'manual_override') {
          throw new HttpError(409, 'ticket_revoked', 'This ticket has been revoked', {
            ticketId: t.id,
            bookingId: t.booking_id,
            reason: t.revocation_reason
          });
        }
      }

      if (t.status === 'reissued') {
        if (method !== 'manual_override') {
          throw new HttpError(409, 'ticket_reissued', 'This ticket has been replaced by a reissued ticket', {
            ticketId: t.id,
            bookingId: t.booking_id,
            newTicketId: t.reissued_to_ticket_id
          });
        }
      }

      if (t.status === 'cancelled' || t.booking_status === 'cancelled') {
        throw new HttpError(409, 'ticket_cancelled', 'This ticket or booking has been cancelled', {
          ticketId: t.id,
          bookingId: t.booking_id,
          code
        });
      }

      if (t.booking_status === 'refunded') {
        throw new HttpError(409, 'ticket_refunded', 'This booking was refunded. Ticket is invalid', {
          ticketId: t.id,
          bookingId: t.booking_id,
          code
        });
      }

      if (t.booking_status !== 'confirmed' && t.booking_status !== 'checked_in') {
        if (method !== 'manual_override') {
          throw new HttpError(409, 'not_eligible', 'Booking is not in a confirmed state', {
            ticketId: t.id,
            bookingId: t.booking_id,
            bookingStatus: t.booking_status
          });
        }
      }

      // Perform atomic check-in
      const now = new Date();
      await txClient.query(
        `UPDATE tickets
            SET status = 'checked_in',
                checked_in_at = $2,
                checked_in_by = $3,
                check_in_method = $4,
                override_reason = $5,
                updated_at = $2
          WHERE id = $1`,
        [t.id, now, actor.id, method, overrideReason || null]
      );

      // Update booking checked_in_at
      await txClient.query(
        `UPDATE bookings
            SET status = 'checked_in',
                checked_in_at = COALESCE(checked_in_at, $2),
                updated_at = $2
          WHERE id = $1`,
        [t.booking_id, now]
      );

      const scanResult = method === 'manual_override' ? 'manual_override' : 'success';
      await recordScanLog({
        eventId,
        ticketId: t.id,
        bookingId: t.booking_id,
        scannedBy: actor.id,
        result: scanResult,
        method,
        overrideReason: overrideReason || null,
        payloadHash,
        metadata: { code, attendeeAlias: t.attendee_alias, tier: t.tier_name }
      }, txClient);

      const auditAction = method === 'manual_override' ? 'ticket.manual_override' : 'ticket.check_in';
      await audit(`user:${actor.id}`, auditAction, t.id, {
        eventId,
        ticketCode: t.ticket_code,
        method,
        overrideReason: overrideReason || null
      }, txClient);

      return {
        ok: true,
        result: scanResult,
        ticket: {
          id: t.id,
          ticketCode: t.ticket_code,
          ticketNumber: t.ticket_number,
          status: 'checked_in',
          checkedInAt: now.toISOString(),
          method
        },
        attendee: {
          alias: t.attendee_alias || 'Guest',
          ticketType: t.tier_name || 'Standard',
          ref: t.booking_id.slice(0, 8).toUpperCase()
        }
      };
    });
  } catch (err) {
    if (err instanceof HttpError && err.code) {
      try {
        await recordScanLog({
          eventId,
          ticketId: err.extra?.ticketId || null,
          bookingId: err.extra?.bookingId || null,
          scannedBy: actor.id,
          result: err.code,
          method,
          overrideReason: overrideReason || null,
          payloadHash,
          metadata: { code, ...(err.extra || {}) }
        }, c);
      } catch {
        // Logging error should not mask rejection
      }
    }
    throw err;
  }
}

/**
 * Reissue a ticket with a fresh unguessable code, revoking the previous one immediately.
 */
export async function reissueTicket(actor, ticketId, reason = 'reissued_by_host', c = db) {
  if (!actor || !actor.id) throw new HttpError(401, 'unauthorized', 'Authentication required');

  return db.tx(async (txClient) => {
    const old = (await txClient.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [ticketId])).rows[0];
    if (!old) throw new HttpError(404, 'not_found', 'Ticket not found');

    const allowed = await can(actor, 'event.reissue_ticket', { eventId: old.event_id }, txClient);
    if (!allowed) throw new HttpError(403, 'forbidden', 'Permission denied to reissue tickets');

    if (old.status === 'revoked' || old.status === 'cancelled') {
      throw new HttpError(409, 'cannot_reissue', 'Cannot reissue a cancelled or revoked ticket');
    }

    const newCode = generateTicketCode();
    const newHash = signTicketPayload(newCode, old.event_id);
    const now = new Date();

    const newTicket = (await txClient.query(
      `INSERT INTO tickets (booking_id, event_id, user_id, ticket_type_id, ticket_number, ticket_code, security_hash, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', $8)
       RETURNING *`,
      [old.booking_id, old.event_id, old.user_id, old.ticket_type_id, old.ticket_number, newCode, newHash, now]
    )).rows[0];

    await txClient.query(
      `UPDATE tickets
          SET status = 'reissued',
              reissued_to_ticket_id = $2,
              reissued_at = $3,
              reissued_by = $4,
              revocation_reason = $5,
              updated_at = $3
        WHERE id = $1`,
      [old.id, newTicket.id, now, actor.id, reason]
    );

    await audit(`user:${actor.id}`, 'ticket.reissue', old.id, {
      eventId: old.event_id,
      oldTicketCode: old.ticket_code,
      newTicketId: newTicket.id,
      newTicketCode: newTicket.ticket_code,
      reason
    }, txClient);

    const qrPayload = generateQrPayload(newTicket.ticket_code, newTicket.event_id);

    return {
      ok: true,
      oldTicketId: old.id,
      newTicket: {
        id: newTicket.id,
        ticketCode: newTicket.ticket_code,
        ticketNumber: newTicket.ticket_number,
        status: newTicket.status,
        qrPayload,
        qrSvg: generateTicketQrSvg(qrPayload)
      }
    };
  });
}

/**
 * Revoke a ticket with immediate effect.
 */
export async function revokeTicket(actor, ticketId, reason = 'revoked_by_host', c = db) {
  if (!actor || !actor.id) throw new HttpError(401, 'unauthorized', 'Authentication required');

  return db.tx(async (txClient) => {
    const t = (await txClient.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [ticketId])).rows[0];
    if (!t) throw new HttpError(404, 'not_found', 'Ticket not found');

    const allowed = await can(actor, 'event.reissue_ticket', { eventId: t.event_id }, txClient);
    if (!allowed) throw new HttpError(403, 'forbidden', 'Permission denied to revoke tickets');

    const now = new Date();
    await txClient.query(
      `UPDATE tickets
          SET status = 'revoked',
              revoked_at = $2,
              revoked_by = $3,
              revocation_reason = $4,
              updated_at = $2
        WHERE id = $1`,
      [t.id, now, actor.id, reason]
    );

    await audit(`user:${actor.id}`, 'ticket.revoke', t.id, {
      eventId: t.event_id,
      ticketCode: t.ticket_code,
      reason
    }, txClient);

    return { ok: true, ticketId: t.id, status: 'revoked' };
  });
}

/**
 * Returns event attendance statistics: checked-in vs eligible, attendance rate.
 */
export async function getEventAttendance(eventId, c = db) {
  const event = (await c.query(`SELECT capacity FROM events WHERE id = $1`, [eventId])).rows[0];
  if (!event) throw new HttpError(404, 'not_found', 'Event not found');

  const stats = (await c.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('valid', 'checked_in'))::int AS eligible_tickets,
       COUNT(*) FILTER (WHERE status = 'checked_in')::int AS checked_in_tickets,
       COUNT(*) FILTER (WHERE status = 'valid')::int AS remaining_tickets,
       COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked_tickets,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_tickets,
       MAX(checked_in_at) AS last_check_in_at
     FROM tickets
     WHERE event_id = $1`,
    [eventId]
  )).rows[0];

  const eligible = stats.eligible_tickets || 0;
  const checkedIn = stats.checked_in_tickets || 0;
  const attendancePct = eligible > 0 ? Math.round((checkedIn / eligible) * 100) : 0;

  return {
    capacity: event.capacity,
    eligibleTickets: eligible,
    checkedInTickets: checkedIn,
    remainingTickets: Math.max(0, eligible - checkedIn),
    revokedTickets: stats.revoked_tickets || 0,
    cancelledTickets: stats.cancelled_tickets || 0,
    attendanceRate: attendancePct,
    lastCheckInAt: stats.last_check_in_at
  };
}

/**
 * Returns recent check-in scan activity logs.
 */
export async function listEventScans(eventId, limit = 50, c = db) {
  const { rows } = await c.query(
    `SELECT ts.id, ts.scan_result, ts.scan_method, ts.override_reason, ts.created_at,
            u.alias AS staff_alias, t.ticket_code, b.id AS booking_id, bu.alias AS attendee_alias
       FROM ticket_scans ts
       JOIN users u ON u.id = ts.scanned_by
       LEFT JOIN tickets t ON t.id = ts.ticket_id
       LEFT JOIN bookings b ON b.id = ts.booking_id
       LEFT JOIN users bu ON bu.id = b.user_id
      WHERE ts.event_id = $1
      ORDER BY ts.created_at DESC
      LIMIT $2`,
    [eventId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    result: r.scan_result,
    method: r.scan_method,
    overrideReason: r.override_reason,
    createdAt: r.created_at,
    staffAlias: r.staff_alias || 'Staff',
    ticketCode: r.ticket_code ? `${r.ticket_code.slice(0, 7)}…` : null,
    attendeeRef: r.booking_id ? r.booking_id.slice(0, 8).toUpperCase() : null,
    attendeeAlias: r.attendee_alias || null
  }));
}

function hashPayload(str) {
  return crypto.createHash('sha256').update(String(str || '')).digest('hex');
}

async function recordScanLog({ eventId, ticketId, bookingId, scannedBy, result, method, overrideReason = null, payloadHash, metadata = {} }, c) {
  await c.query(
    `INSERT INTO ticket_scans (event_id, ticket_id, booking_id, scanned_by, scan_result, scan_method, override_reason, scanned_payload_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [eventId, ticketId, bookingId, scannedBy, result, method, overrideReason, payloadHash, JSON.stringify(metadata)]
  );
}
