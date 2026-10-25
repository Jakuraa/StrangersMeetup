// lib/views/components.js - Reusable fragments: event cards, filters, FAQ accordion, empty states.
import { html, raw, fmtDate, fmtTime } from './html.js';
import { CATEGORY_LABELS, CITIES } from '../services/events.js';
import { botUsername } from '../config.js';

export function eventPath(e) {
  return `${e.isTrip ? '/trips' : '/events'}/${e.slug}`;
}

export function badges(e) {
  const out = [];
  if (e.isDemo) out.push(html`<span class="badge badge-sample" title="Sample listing for preview — not a real event">Sample</span>`);
  if (e.foodAvailable && e.stayAvailable && e.category === 'resort_getaway') out.push(html`<span class="badge">Resort venue · Food &amp; stay available</span>`);
  else if (e.foodAvailable && e.stayAvailable) out.push(html`<span class="badge">Food &amp; stay available</span>`);
  if (e.bookmyshowUrl) out.push(html`<span class="badge">Also on BookMyShow</span>`);
  return out;
}

export function eventCard(e) {
  const href = eventPath(e);
  return html`<article class="card event-card reveal" data-state="${e.state}">
    ${e.coverUrl ? html`<img class="card-img" src="${e.coverUrl}" alt="" loading="lazy" width="640" height="400">` : html`<div class="card-art card-art-${e.category}" aria-hidden="true"></div>`}
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
        <a class="btn ${e.bookable ? 'btn-primary' : 'btn-ghost'}" href="${href}${e.bookable ? '#book' : ''}">${e.bookable ? 'Book Tickets' : 'View details'}</a>
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
