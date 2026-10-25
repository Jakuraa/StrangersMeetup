// api/events.js - Public Events & Group Trips Discovery API
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['GET', 'POST'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const city = url.searchParams.get('city');
      const category = url.searchParams.get('category');
      const scope = url.searchParams.get('scope'); // 'south_india', 'domestic_trip', 'international_trip', 'all'
      const type = url.searchParams.get('type');   // 'local_meetup', 'trip', 'all'
      const budget = url.searchParams.get('budget');
      const eventId = url.searchParams.get('id');
      const slug = url.searchParams.get('slug');

      let query = `
        SELECT 
          id, title, slug, category, city, area_name,
          start_time, end_time, capacity, tickets_sold,
          price_inr, ticketing_status, ticketing_provider, ticketing_url,
          description, inclusions, confirmed_resort_food_lodging,
          accessibility_notes, cancellation_terms, organizer_name,
          is_demo, is_published, created_at,
          event_scope, event_type, duration_label, image_url, exclusions, booking_terms
        FROM events
        WHERE is_published = 1
      `;
      const params = [];
      let paramIdx = 1;

      if (eventId) {
        query += ` AND id = $${paramIdx++}`;
        params.push(eventId);
      } else if (slug) {
        query += ` AND slug = $${paramIdx++}`;
        params.push(slug);
      }

      if (city && city !== 'all') {
        query += ` AND city = $${paramIdx++}`;
        params.push(city.toLowerCase());
      }

      if (category && category !== 'all') {
        query += ` AND category = $${paramIdx++}`;
        params.push(category.toLowerCase());
      }

      if (scope && scope !== 'all') {
        query += ` AND event_scope = $${paramIdx++}`;
        params.push(scope.toLowerCase());
      }

      if (type && type !== 'all') {
        query += ` AND event_type = $${paramIdx++}`;
        params.push(type.toLowerCase());
      }

      if (budget && budget !== 'all') {
        if (budget === 'under_500') {
          query += ` AND price_inr <= 500`;
        } else if (budget === '500_1500') {
          query += ` AND price_inr > 500 AND price_inr <= 1500`;
        } else if (budget === 'above_1500') {
          query += ` AND price_inr > 1500`;
        } else if (budget === 'tba') {
          query += ` AND (price_inr = 0 OR ticketing_status = 'opening_soon')`;
        }
      }

      query += ` ORDER BY start_time ASC`;

      const result = await db.query(query, params);

      // Map rows with honest availability states, privacy protection, and transparent demo badges
      const events = (result.rows || []).map((evt) => {
        let inclusions = [];
        try {
          inclusions = typeof evt.inclusions === 'string' ? JSON.parse(evt.inclusions) : (evt.inclusions || []);
        } catch {
          inclusions = [];
        }

        let exclusions = [];
        try {
          exclusions = typeof evt.exclusions === 'string' ? JSON.parse(evt.exclusions) : (evt.exclusions || []);
        } catch {
          exclusions = [];
        }

        const capacity = Number(evt.capacity);
        const sold = Number(evt.tickets_sold);
        const remaining = Math.max(0, capacity - sold);

        let calculatedStatus = evt.ticketing_status;
        let availabilityLabel = 'Book Tickets';

        if (evt.ticketing_status === 'opening_soon') {
          calculatedStatus = 'opening_soon';
          availabilityLabel = 'Bookings opening soon';
        } else if (remaining === 0) {
          calculatedStatus = 'sold_out';
          availabilityLabel = 'Sold Out — Join Waitlist';
        } else if (sold === 0) {
          availabilityLabel = 'Be the first to join';
        } else if (remaining <= 5) {
          availabilityLabel = `Limited availability (${remaining} slots remaining)`;
        } else {
          availabilityLabel = `Book Tickets (${remaining} slots available)`;
        }

        let priceLabel = 'Price to be announced';
        if (evt.price_inr && Number(evt.price_inr) > 0) {
          priceLabel = `₹${Number(evt.price_inr).toLocaleString('en-IN')}`;
        }

        return {
          id: evt.id,
          title: evt.title,
          slug: evt.slug,
          category: evt.category,
          scope: evt.event_scope || 'south_india',
          type: evt.event_type || 'local_meetup',
          city: evt.city,
          areaName: evt.area_name,
          destination: evt.area_name,
          startTime: evt.start_time,
          endTime: evt.end_time,
          durationLabel: evt.duration_label || '3 Hours',
          capacity,
          ticketsSold: sold,
          remainingSlots: remaining,
          priceInr: evt.price_inr,
          priceLabel,
          ticketingStatus: calculatedStatus,
          availabilityLabel,
          ticketingProvider: evt.ticketing_provider || null,
          imageUrl: evt.image_url || 'https://images.unsplash.com/photo-1543807535-eceef0bc6599?auto=format&fit=crop&w=800&q=80',
          description: evt.description,
          inclusions,
          exclusions,
          bookingTerms: evt.booking_terms || evt.cancellation_terms || 'Transparent cancellation policy applies.',
          confirmedResortFoodLodging: Boolean(evt.confirmed_resort_food_lodging),
          accessibilityNotes: evt.accessibility_notes,
          cancellationTerms: evt.cancellation_terms,
          organizerName: evt.organizer_name || 'StrangersMeetup Curated Cohorts',
          isDemo: Boolean(evt.is_demo),
          privacyNotice: 'Exact venue address and host direct contacts are disclosed through the private Telegram community 24 hours prior to the event.'
        };
      });

      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, events, count: events.length }));
    } catch (err) {
      logger.error('Failed to list events', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Failed to retrieve events' }));
    }
  }

  if (req.method === 'POST') {
    // Ticket Booking / RSVP reservation endpoint
    try {
      const body = req.body || {};
      const { eventId, attendeeName, attendeeContact, ticketCount = 1, notes } = body;

      if (!eventId || !attendeeName || !attendeeContact) {
        res.statusCode = 400;
        return res.end(JSON.stringify({
          ok: false,
          error: 'eventId, attendeeName, and attendeeContact are required fields'
        }));
      }

      // Check event existence and real capacity
      const eventRes = await db.query('SELECT * FROM events WHERE id = $1 AND is_published = 1', [eventId]);
      if (!eventRes.rows || eventRes.rows.length === 0) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ ok: false, error: 'Event not found or not published' }));
      }

      const event = eventRes.rows[0];
      const count = Math.max(1, parseInt(ticketCount, 10) || 1);
      const remaining = event.capacity - event.tickets_sold;

      let rsvpStatus = 'CONFIRMED';
      if (remaining < count) {
        rsvpStatus = 'WAITLIST';
      }

      const rsvpId = `rsvp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      // Insert RSVP record
      await db.query(
        `INSERT INTO event_rsvps (id, event_id, attendee_name, attendee_contact, ticket_count, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rsvpId, eventId, attendeeName.trim(), attendeeContact.trim(), count, rsvpStatus, notes || null]
      );

      // If confirmed, update real tickets_sold
      if (rsvpStatus === 'CONFIRMED') {
        await db.query(
          `UPDATE events SET tickets_sold = tickets_sold + $1 WHERE id = $2`,
          [count, eventId]
        );
      }

      logger.info('Event RSVP processed', { rsvpId, eventId, rsvpStatus, count });

      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        rsvpId,
        status: rsvpStatus,
        eventTitle: event.title,
        city: event.city,
        area: event.area_name,
        ticketCount: count,
        message: rsvpStatus === 'CONFIRMED'
          ? 'Ticket reserved successfully! Join the Telegram coordination channel for private venue reveal and updates.'
          : 'Event is currently at capacity. You have been added to the priority waitlist.'
      }));
    } catch (err) {
      logger.error('Failed to process event RSVP', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'Failed to process ticket reservation' }));
    }
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
}
