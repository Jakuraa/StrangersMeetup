// lib/views/event.js - Event / trip detail page.
import { html, raw, jsonLd, fmtFullDate, fmtTime } from './html.js';
import { layout } from './layout.js';
import { badges, eventPath } from './components.js';
import { siteUrl, livePayments } from '../config.js';
import { CITIES } from '../services/events.js';

function eventJsonLd(e) {
  // Only real, published, non-demo events get structured data.
  if (e.isDemo || e.status !== 'published') return '';
  const region = CITIES.find((c) => c.name.toLowerCase() === e.city.toLowerCase())?.state;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: e.title,
    description: e.summary || e.description,
    startDate: e.startAt,
    ...(e.endAt ? { endDate: e.endAt } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: e.venue || e.area || e.city,
      address: { '@type': 'PostalAddress', addressLocality: e.city, ...(region ? { addressRegion: region } : {}), addressCountry: 'IN' }
    },
    organizer: { '@type': 'Organization', name: 'StrangersMeetup', url: siteUrl() },
    url: `${siteUrl()}${eventPath(e)}`
  };
  if (e.pricePaise) {
    ld.offers = {
      '@type': 'Offer',
      price: (e.pricePaise / 100).toFixed(2),
      priceCurrency: 'INR',
      availability: e.state === 'sold_out' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      url: `${siteUrl()}${eventPath(e)}`
    };
  }
  return jsonLd(ld);
}

function bookBox(e) {
  let action;
  if (e.bookable) {
    action = html`<button class="btn btn-primary btn-lg btn-block" type="button" data-book="${e.id}">Book Tickets</button>
      ${!livePayments() ? html`<p class="test-note">Test mode — sandbox checkout, no real money is charged.</p>` : ''}`;
  } else {
    action = html`<button class="btn btn-ghost btn-lg btn-block" type="button" disabled>${e.stateLabel}</button>`;
  }
  return html`<aside class="book-box" id="book" aria-label="Booking">
    <p class="price price-lg">${e.priceLabel}</p>
    <p class="state state-${e.state}">${e.stateLabel}</p>
    ${action}
    <p class="book-msg" data-book-msg role="status" aria-live="polite"></p>
    ${e.bookmyshowUrl ? html`<a class="btn btn-ghost btn-block" href="${e.bookmyshowUrl}" target="_blank" rel="noopener nofollow">Also available on BookMyShow</a>` : ''}
    ${e.externalPaymentUrl ? html`<a class="btn btn-ghost btn-block" href="${e.externalPaymentUrl}" target="_blank" rel="noopener nofollow">Alternative payment page</a>` : ''}
    <ul class="book-facts">
      <li>Confirmation and private group invite arrive via our Telegram bot.</li>
      ${e.venuePrivacy === 'disclosed_after_booking' ? html`<li>Exact venue shared inside the private Telegram group after booking, to protect attendee privacy.</li>` : ''}
    </ul>
  </aside>`;
}

export function renderEvent(e) {
  const sameDay = e.endAt && fmtFullDate(e.endAt) === fmtFullDate(e.startAt);
  const when = html`${fmtFullDate(e.startAt)}, ${fmtTime(e.startAt)}${e.endAt
    ? (sameDay ? html` – ${fmtTime(e.endAt)}` : html` – ${fmtFullDate(e.endAt)}, ${fmtTime(e.endAt)}`)
    : ''}`;
  const body = html`
  <article class="event">
    <header class="event-head">
      <div class="wrap">
        <p class="crumbs"><a href="${e.isTrip ? '/trips' : '/#upcoming'}">${e.isTrip ? 'Trips' : 'Upcoming'}</a> / ${e.city}</p>
        <div class="badges">${badges(e)}</div>
        <h1>${e.title}</h1>
        ${e.summary ? html`<p class="lede">${e.summary}</p>` : ''}
        ${e.isDemo ? html`<p class="sample-note">This is a sample listing used to preview the site. It is not a real event and cannot be booked for real.</p>` : ''}
      </div>
    </header>
    <div class="wrap event-grid">
      <div class="event-main">
        <dl class="facts">
          <div><dt>When</dt><dd><time datetime="${e.startAt}">${when}</time></dd></div>
          <div><dt>Where</dt><dd>${e.venue || e.area ? html`${e.venue || e.area}, ` : ''}${e.city}${e.venuePrivacy === 'disclosed_after_booking' ? html` <span class="muted">(exact venue after booking)</span>` : ''}</dd></div>
          <div><dt>Format</dt><dd>${e.categoryLabel}</dd></div>
          <div><dt>Group size</dt><dd>Up to ${e.capacity} people</dd></div>
          ${e.genderPolicy ? html`<div><dt>Group balance</dt><dd>${e.genderPolicy}</dd></div>` : ''}
          <div><dt>Hosted by</dt><dd>${e.organizer}</dd></div>
        </dl>
        ${e.description && e.description !== e.summary ? html`<section class="prose"><h2>About</h2>${e.description.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</section>` : ''}
        ${e.inclusions.length ? html`<section class="prose"><h2>Included</h2><ul class="ticks">${e.inclusions.map((i) => html`<li>${i}</li>`)}</ul></section>` : ''}
        ${e.exclusions.length ? html`<section class="prose"><h2>Not included</h2><ul class="crosses">${e.exclusions.map((i) => html`<li>${i}</li>`)}</ul></section>` : ''}
        <section class="prose"><h2>Refund policy</h2><p>${e.refundPolicy || 'The refund policy will be published before bookings open.'}</p><p><a href="/refunds">Billing &amp; Refunds</a></p></section>
        <section class="prose"><h2>Good to know</h2><ul><li>Adults 21+ only. Please carry a photo ID.</li><li>Our <a href="/community-guidelines">Community Guidelines</a> apply.</li></ul></section>
      </div>
      ${bookBox(e)}
    </div>
  </article>`;

  return layout({
    title: `${e.title} — ${e.city}`,
    description: (e.summary || `${e.categoryLabel} in ${e.city} for adults 21+.`).slice(0, 160),
    path: eventPath(e),
    body,
    head: eventJsonLd(e),
    noindex: e.isDemo,
    current: e.isTrip ? '/trips' : '/#upcoming',
    ogImage: e.coverUrl || undefined
  });
}

export { raw };
