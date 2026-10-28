// lib/views/html.js - Auto-escaping HTML template tag. Interpolations are escaped unless raw().

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

export function raw(v) {
  return new SafeHtml(String(v ?? ''));
}

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** JSON for <script type="application/ld+json"> — escapes "<" so it cannot close the tag. */
export function jsonLd(obj) {
  return raw(`<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`);
}

const FORMATS = {
  date: { weekday: 'short', day: 'numeric', month: 'short' },
  time: { hour: 'numeric', minute: '2-digit', hour12: true },
  full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  zone: { timeZoneName: 'short' }
};
const formatters = new Map();

/** Cached Intl formatter per (kind, timezone). Events default to India time. */
function fmt(kind, tz = 'Asia/Kolkata') {
  const key = `${kind}|${tz}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat('en-IN', { ...FORMATS[kind], timeZone: tz }));
  return formatters.get(key);
}

export function fmtDate(iso, tz) {
  return fmt('date', tz).format(new Date(iso));
}
export function fmtTime(iso, tz) {
  return fmt('time', tz).format(new Date(iso)).replace(' ', '\u00a0');
}
export function fmtFullDate(iso, tz) {
  return fmt('full', tz).format(new Date(iso));
}
/** Short zone label for an instant, e.g. "IST". */
export function fmtZone(iso, tz) {
  return fmt('zone', tz).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value || tz;
}
