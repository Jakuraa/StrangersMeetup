// lib/services/event-schedule.js - Flexible Event Date Scheduling Model
// Supports Single-day, Consecutive multi-day, Custom multi-date, and Recurring schedules.
import { z } from '../validate.js';

export const SCHEDULE_TYPES = ['single', 'consecutive', 'custom_dates', 'recurring'];

export const ScheduleDateItem = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Start time must be YYYY-MM-DDTHH:mm'),
  endLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'End time must be YYYY-MM-DDTHH:mm'),
  label: z.string().max(80).optional().default(''),
  venueId: z.string().uuid().nullable().optional(),
  venueName: z.string().max(120).optional().default(''),
  venueAddress: z.string().max(255).optional().default(''),
  city: z.string().max(80).optional().default(''),
  mapsUrl: z.string().max(500).optional().default(''),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  timezone: z.string().max(50).optional().default('Asia/Kolkata')
}).strict();

export const EventScheduleDraft = z.object({
  type: z.enum(SCHEDULE_TYPES).default('single'),
  venueArrangement: z.enum(['same', 'different']).default('same'),
  dates: z.array(ScheduleDateItem).max(30).default([]),
  recurring: z.object({
    frequency: z.enum(['weekly', 'biweekly', 'daily']).default('weekly'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]), // 0=Sun, 1=Mon, ..., 6=Sat
    occurrences: z.number().int().min(1).max(20).default(4),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).default('19:00'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
    venueArrangement: z.enum(['same', 'different']).default('same')
  }).optional()
}).strict();

/**
 * Validates date ordering, time ordering, duplicate dates, and ensures chronological sorting.
 */
export function normalizeSchedule(inputSchedule, defaultStartLocal, defaultEndLocal) {
  if (!inputSchedule || typeof inputSchedule !== 'object') {
    // Fall back to legacy single/consecutive date range
    if (defaultStartLocal) {
      const datePart = defaultStartLocal.slice(0, 10);
      return {
        type: 'single',
        dates: [{
          date: datePart,
          startLocal: defaultStartLocal,
          endLocal: defaultEndLocal || defaultStartLocal,
          label: ''
        }]
      };
    }
    return { type: 'single', dates: [] };
  }

  const type = SCHEDULE_TYPES.includes(inputSchedule.type) ? inputSchedule.type : 'single';
  let dates = Array.isArray(inputSchedule.dates) ? inputSchedule.dates : [];

  // Deduplicate by date string while preserving earliest entry or merging
  const seenDates = new Set();
  const dedupedDates = [];

  for (const d of dates) {
    if (!d || !d.date) continue;
    if (seenDates.has(d.date)) continue;
    seenDates.add(d.date);

    const startLocal = d.startLocal || `${d.date}T19:00`;
    const endLocal = d.endLocal || `${d.date}T22:00`;

    dedupedDates.push({
      date: d.date,
      startLocal,
      endLocal,
      label: String(d.label || '').trim().slice(0, 80),
      venueId: d.venueId || null,
      venueName: String(d.venueName || '').trim().slice(0, 120),
      venueAddress: String(d.venueAddress || '').trim().slice(0, 255),
      city: String(d.city || '').trim().slice(0, 80),
      mapsUrl: String(d.mapsUrl || '').trim().slice(0, 500),
      lat: typeof d.lat === 'number' ? d.lat : null,
      lng: typeof d.lng === 'number' ? d.lng : null,
      timezone: String(d.timezone || 'Asia/Kolkata').trim().slice(0, 50)
    });
  }

  // Sort chronologically by startLocal
  dedupedDates.sort((a, b) => a.startLocal.localeCompare(b.startLocal));

  // If no dates provided but startLocal exists, create primary date
  if (!dedupedDates.length && defaultStartLocal) {
    const datePart = defaultStartLocal.slice(0, 10);
    dedupedDates.push({
      date: datePart,
      startLocal: defaultStartLocal,
      endLocal: defaultEndLocal || defaultStartLocal,
      label: '',
      venueId: null,
      venueName: '',
      venueAddress: '',
      city: '',
      mapsUrl: '',
      lat: null,
      lng: null,
      timezone: 'Asia/Kolkata'
    });
  }

  return {
    type,
    venueArrangement: inputSchedule.venueArrangement || inputSchedule.recurring?.venueArrangement || 'same',
    dates: dedupedDates,
    recurring: inputSchedule.recurring
  };
}

/**
 * Generates preview occurrences for a recurring schedule.
 * Does not mutate DB; purely deterministic generator.
 */
export function generateRecurringOccurrences({
  startDate,
  daysOfWeek = [6],
  occurrences = 4,
  startTime = '19:00',
  endTime = '22:00',
  labelPrefix = 'Session',
  venueArrangement = 'same',
  defaultVenue = null
}) {
  const result = [];
  if (!startDate) return result;

  const current = new Date(`${startDate}T12:00:00Z`);
  let count = 0;
  let safety = 0;

  // Maximum 120 days ahead safety cap
  while (count < occurrences && safety < 120) {
    safety++;
    const day = current.getUTCDay();
    if (daysOfWeek.includes(day)) {
      count++;
      const ymd = current.toISOString().slice(0, 10);
      const occVenue = (venueArrangement === 'same' && defaultVenue) ? defaultVenue : {};
      result.push({
        date: ymd,
        startLocal: `${ymd}T${startTime}`,
        endLocal: `${ymd}T${endTime}`,
        label: `${labelPrefix} ${count}`,
        venueId: occVenue.venueId || null,
        venueName: occVenue.venueName || '',
        venueAddress: occVenue.venueAddress || '',
        city: occVenue.city || '',
        mapsUrl: occVenue.mapsUrl || '',
        lat: occVenue.lat || null,
        lng: occVenue.lng || null,
        timezone: occVenue.timezone || 'Asia/Kolkata'
      });
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return result;
}

/**
 * Derives overall event startLocal and endLocal from a normalized schedule.
 */
export function deriveEventBounds(schedule, fallbackStart, fallbackEnd) {
  if (!schedule || !schedule.dates || !schedule.dates.length) {
    return {
      startLocal: fallbackStart,
      endLocal: fallbackEnd,
      isMultiDay: false
    };
  }

  const sorted = [...schedule.dates].sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const isMultiDay = sorted.length > 1 || first.date !== last.date || schedule.type !== 'single';

  return {
    startLocal: first.startLocal,
    endLocal: last.endLocal,
    isMultiDay
  };
}
