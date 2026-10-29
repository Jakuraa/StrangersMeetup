// lib/views/components.js - Reusable fragments: event cards, filters, FAQ accordion, empty states.
import { html, raw, fmtDate, fmtTime } from './html.js';
import { CATEGORY_LABELS, CITIES } from '../services/events.js';
import { botUsername } from '../config.js';

export function eventPath(e) {
  return `${e.isTrip ? '/trips' : '/events'}/${e.slug}`;
}

export function badges(e) {
  const out = [];
  if (e.isExternal) out.push(html`<span class="badge" title="Listed from ${e.sourceName}; booked on the organiser’s page">Via ${e.sourceName}</span>`);
  if (e.isDemo) out.push(html`<span class="badge badge-sample" title="Sample listing for preview — not a real event">Sample</span>`);
  if (e.foodAvailable && e.stayAvailable && e.category === 'resort_getaway') out.push(html`<span class="badge">Resort venue · Food &amp; stay available</span>`);
  else if (e.foodAvailable && e.stayAvailable) out.push(html`<span class="badge">Food &amp; stay available</span>`);
  if (e.bookmyshowUrl) out.push(html`<span class="badge">Also on BookMyShow</span>`);
  return out;
}

// Decorative per-category glyphs for events without a cover photo (64x64 grid, stroke only).
const GLYPHS = {
  meetup: '<circle cx="24" cy="24" r="7"/><circle cx="42" cy="26" r="6"/><path d="M10 50c0-9 6-15 14-15s14 6 14 15M38 37c8-1 16 4 16 13"/>',
  dating_mixer: '<path d="M32 52S10 38 10 24a11 11 0 0 1 22-3 11 11 0 0 1 22 3c0 14-22 28-22 28z"/>',
  nightlife: '<path d="M14 14h36L32 36zM32 36v16M22 52h20"/>',
  dinner_club: '<circle cx="32" cy="34" r="16"/><circle cx="32" cy="34" r="8"/><path d="M8 14v14M14 14v14M8 21h6M11 28v22M56 14c-5 4-5 14 0 18v18"/>',
  movie: '<rect x="8" y="16" width="48" height="34" rx="4"/><path d="M8 26h48M26 34l14 8-14 8z"/>',
  board_games: '<rect x="12" y="12" width="40" height="40" rx="8"/><circle cx="24" cy="24" r="2.5"/><circle cx="40" cy="24" r="2.5"/><circle cx="32" cy="32" r="2.5"/><circle cx="24" cy="40" r="2.5"/><circle cx="40" cy="40" r="2.5"/>',
  weekend_trip: '<path d="M6 52 24 22l10 16 8-10 16 24z"/><circle cx="46" cy="14" r="5"/>',
  resort_getaway: '<circle cx="32" cy="26" r="10"/><path d="M6 44c6-5 10-5 16 0s10 5 16 0 10-5 16 0M6 54c6-5 10-5 16 0s10 5 16 0 10-5 16 0"/>',
  weekend_party: '<path d="M32 8l5 15 15 5-15 5-5 15-5-15-15-5 15-5zM50 40l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  matchmaking: '<circle cx="24" cy="32" r="13"/><circle cx="40" cy="32" r="13"/>',
  networking: '<circle cx="32" cy="14" r="6"/><circle cx="14" cy="48" r="6"/><circle cx="50" cy="48" r="6"/><path d="M29 20 17 42M35 20l12 22M20 48h24"/>',
  workshop: '<path d="M22 44c-6-4-9-9-9-15a19 19 0 0 1 38 0c0 6-3 11-9 15v6H22zM24 56h16"/>'
};

function cardArt(category) {
  const glyph = GLYPHS[category];
  return html`<div class="card-art card-art-${category}" aria-hidden="true">${glyph ? raw(`<svg class="card-glyph" viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" focusable="false">${glyph}</svg>`) : ''}</div>`;
}

export function eventCard(e) {
  const href = eventPath(e);
  return html`<article class="card event-card reveal" data-state="${e.state}">
    ${e.coverUrl ? html`<img class="card-img" src="${e.coverUrl}" alt="" loading="lazy" width="640" height="400">` : cardArt(e.category)}
    <div class="card-body">
      <p class="card-meta"><span>${e.categoryLabel}</span><span>${e.city}</span></p>
      <h3 class="card-title"><a href="${href}">${e.title}</a></h3>
      <p class="card-when"><time datetime="${e.startAt}">${fmtDate(e.startAt)} · ${fmtTime(e.startAt)}</time>${e.area ? html` · ${e.area}` : ''}</p>
      ${e.inclusions.length ? html`<p class="card-incl">${e.inclusions.slice(0, 3).join(' · ')}</p>` : ''}
      <div class="badges">${badges(e)}</div>
      <div class="card-foot">
        <div>
          <p class="price">${e.priceLabel}</p>
          <p class="state state-${e.state}">${e.stateLabel}</p>
        </div>
        <a class="btn ${e.bookable ? 'btn-primary' : 'btn-ghost'}" href="${href}${e.bookable ? '#book' : ''}">${e.bookable ? 'Book Tickets' : e.isExternal ? 'Details' : 'View details'}</a>
      </div>
    </div>
  </article>`;
}

export function alertsCta() {
  const bot = botUsername();
  if (!bot) return html`<p class="muted">Event alerts on Telegram are coming soon.</p>`;
  return html`<a class="btn btn-tg" href="https://t.me/${bot}?start=alerts" rel="noopener">Get event alerts on Telegram</a>`;
}

export function emptyEvents(message = 'No upcoming experiences match right now.') {
  return html`<div class="empty">
    <p>${message}</p>
    <p class="muted">New meetups are announced on Telegram first.</p>
    ${alertsCta()}
  </div>`;
}

export function filters({ city = '', category = '', when = '' }, action = '/#upcoming') {
  const cats = Object.entries(CATEGORY_LABELS);
  const opt = (value, label, current) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;
  return html`<form class="filters" method="get" action="${action.split('#')[0]}" data-filters>
    <label><span>City</span>
      <select name="city">${opt('', 'All cities', city)}${CITIES.map((c) => opt(c.slug, c.name, city))}</select>
    </label>
    <label><span>When</span>
      <select name="when">${opt('', 'Any time', when)}${opt('week', 'Next 7 days', when)}${opt('month', 'Next 30 days', when)}</select>
    </label>
    <label><span>Format</span>
      <select name="category">${opt('', 'All formats', category)}${cats.map(([v, l]) => opt(v, l, category))}</select>
    </label>
    <button class="btn btn-ghost" type="submit">Apply</button>
  </form>`;
}

export function faqList(items) {
  return html`<div class="faq">
    ${items.map((f, i) => html`<details class="faq-item"${i === 0 ? raw(' open') : ''}>
      <summary><h3>${f.q}</h3><span class="faq-icon" aria-hidden="true"></span></summary>
      <div class="faq-a"><p>${f.a}</p></div>
    </details>`)}
  </div>`;
}

/** Translate a `when` filter to a date window. */
export function whenRange(when) {
  const now = Date.now();
  if (when === 'week') return { from: new Date(now).toISOString(), to: new Date(now + 7 * 864e5).toISOString() };
  if (when === 'month') return { from: new Date(now).toISOString(), to: new Date(now + 30 * 864e5).toISOString() };
  return {};
}
