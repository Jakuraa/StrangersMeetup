// lib/time.js - Wall-clock times in an event's own timezone (no dependencies; uses Intl).

/** Timezones an organiser can pick. The site is India-first; the rest cover nearby travel. */
export const TIMEZONES = [
  ['Asia/Kolkata', 'India (IST)'],
  ['Asia/Colombo', 'Sri Lanka'],
  ['Asia/Kathmandu', 'Nepal'],
  ['Asia/Dubai', 'UAE'],
  ['Asia/Bangkok', 'Thailand'],
  ['Asia/Singapore', 'Singapore'],
  ['Europe/London', 'United Kingdom']
];
export const TIMEZONE_IDS = TIMEZONES.map(([id]) => id);

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const parts = new Map();

function partsFormatter(tz) {
  if (!parts.has(tz)) {
    parts.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  return parts.get(tz);
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function offsetAt(ms, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** True for a well-formed 'YYYY-MM-DDTHH:mm' that names a real calendar date/time. */
export function isLocalDateTime(s) {
  const m = LOCAL_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[4] < 24;
}

/** 'YYYY-MM-DDTHH:mm' in `tz` → Date (UTC instant). Returns null when invalid. */
export function zonedToUtc(local, tz) {
  if (!isLocalDateTime(local) || !TIMEZONE_IDS.includes(tz)) return null;
  const m = LOCAL_RE.exec(local);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes settle DST edges; the listed zones mostly have no DST.
  let ms = guess - offsetAt(guess, tz);
  ms = guess - offsetAt(ms, tz);
  return new Date(ms);
}

/** The calendar date part of a local datetime string. */
export function localDate(local) {
  return isLocalDateTime(local) ? local.slice(0, 10) : null;
}

/** Inclusive list of 'YYYY-MM-DD' dates between two local datetimes (capped). */
export function datesBetween(startLocal, endLocal, max = 31) {
  const a = localDate(startLocal);
  const b = localDate(endLocal) || a;
  if (!a) return [];
  const out = [];
  let d = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  while (d <= end && out.length < max) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 864e5);
  }
  return out;
}
