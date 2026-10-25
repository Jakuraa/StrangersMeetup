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

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const TIME_FMT = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const FULL_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function fmtDate(iso) {
  return DATE_FMT.format(new Date(iso));
}
export function fmtTime(iso) {
  return TIME_FMT.format(new Date(iso)).replace(' ', '\u00a0');
}
export function fmtFullDate(iso) {
  return FULL_FMT.format(new Date(iso));
}
