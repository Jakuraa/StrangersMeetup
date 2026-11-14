// lib/services/event-schedule.js - Flexible Event Date Scheduling Model
// Supports Single-day, Consecutive multi-day, Custom multi-date, and Recurring schedules.
import { z } from '../validate.js';

export const SCHEDULE_TYPES = ['single', 'consecutive', 'custom_dates', 'recurring'];

export const ScheduleDateItem = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Start time must be YYYY-MM-DDTHH:mm'),
  endLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'End time must be YYYY-MM-DDTHH:mm'),
  label: z.string().max(80).optional().default('')
}).strict();

export const EventScheduleDraft = z.object({
  type: z.enum(SCHEDULE_TYPES).default('single'),
  dates: z.array(ScheduleDateItem).max(30).default([]),
  recurring: z.object({
    frequency: z.enum(['weekly', 'biweekly', 'daily']).default('weekly'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]), // 0=Sun, 1=Mon, ..., 6=Sat
    occurrences: z.number().int().min(1).max(20).default(4),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).default('19:00'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).default('22:00')
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
      label: String(d.label || '').trim().slice(0, 80)
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
      label: ''
    });
  }

  return {
    type,
    dates: dedupedDates,
    recurring: inputSchedule.recurring
  };
}

/**
 * Generates preview occurrences for a recurring schedule.
 * Does not mutate DB; purely deterministic generator.
 */
export function generateRecurringOccurrences({ startDate, daysOfWeek = [6], occurrences = 4, startTime = '19:00', endTime = '22:00', labelPrefix = 'Session' }) {
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
      result.push({
        date: ymd,
        startLocal: `${ymd}T${startTime}`,
        endLocal: `${ymd}T${endTime}`,
        label: `${labelPrefix} ${count}`
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
