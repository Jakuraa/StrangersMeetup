// lib/views/event.js - Event / trip detail page.
import { html, raw, jsonLd, fmtFullDate, fmtTime, fmtDate, fmtZone } from './html.js';
import { layout } from './layout.js';
import { badges, eventPath } from './components.js';
import { siteUrl, livePayments } from '../config.js';
import { CITIES } from '../services/events.js';

function eventJsonLd(e) {
  // Only real, published, non-demo events we organise get structured data.
  if (e.isDemo || e.isExternal || e.status !== 'published') return '';
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
    organizer: e.organiserManaged ? { '@type': 'Organization', name: e.organizer } : { '@type': 'Organization', name: 'StrangersMeetup', url: siteUrl() },
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

function externalBox(e) {
  return html`<aside class="book-box" id="book" aria-label="Booking">
    <p class="price price-lg">${e.priceLabel}</p>
    <p class="state state-external">Listed from ${e.sourceName}</p>
    ${e.state === 'external'
      ? html`<a class="btn btn-primary btn-lg btn-block" href="${e.externalUrl}" target="_blank" rel="noopener nofollow">View &amp; book on ${e.sourceName}</a>`
      : html`<button class="btn btn-ghost btn-lg btn-block" type="button" disabled>${e.stateLabel}</button>`}
    <ul class="book-facts">
      <li>StrangersMeetup does not run this event. Price, availability, tickets and refunds are handled by the organiser.</li>
      <li>Always confirm details on the organiser’s page before you go.</li>
    </ul>
  </aside>`;
}

/** 'YYYY-MM-DD' → "Sat, 14 Dec". */
const dayLabel = (d) => fmtDate(`${d}T12:00:00Z`, 'UTC');
/** A local 'YYYY-MM-DDTHH:mm' (already in the event's timezone) → "Sat, 14 Dec, 6:30 am". */
const localLabel = (t) => `${fmtDate(`${t}:00Z`, 'UTC')}, ${fmtTime(`${t}:00Z`, 'UTC')}`;

function questionField(q, disabled) {
  const name = `answers.${q.id}`;
  const req = q.required ? raw(' required') : '';
  const dis = disabled ? raw(' disabled') : '';
  const label = html`${q.label}${q.required ? '' : html` <span class="muted">(optional)</span>`}`;
  if (q.type === 'single' || q.type === 'multi') {
    const type = q.type === 'single' ? 'radio' : 'checkbox';
    return html`<fieldset class="field q-field" data-field="${name}"${q.type === 'multi' ? raw(' data-multi="1"') : ''}><legend>${label}</legend>
      ${q.options.map((o) => html`<label class="check"><input type="${type}" name="${name}" value="${o}"${type === 'radio' ? req : ''}${dis}> <span>${o}</span></label>`)}
    </fieldset>`;
  }
  return html`<label class="field q-field" data-field="${name}"><span>${label}</span>
    ${q.type === 'long'
      ? html`<textarea name="${name}" rows="3" maxlength="2000"${req}${dis}></textarea>`
      : html`<input type="text" name="${name}" maxlength="200"${req}${dis}>`}
  </label>`;
}

/** Booking box for organiser events with ticket tiers. `preview` renders it switched off. */
function tierBookBox(e, { preview = false } = {}) {
  const open = e.bookable && !preview;
  const dis = open ? '' : raw(' disabled');
  const first = e.tiers.find((t) => t.available) || null;
  const max = first ? first.maxPerBooking : 1;
  const hasPaid = e.tiers.some((t) => t.kind === 'paid');
  const cta = e.requiresApproval ? 'Request to join' : 'Book now';
  return html`<aside class="book-box" id="book" aria-label="Booking">
    <p class="price price-lg">${e.priceLabel}</p>
    <p class="state state-${e.state}">${e.stateLabel}</p>
    ${preview ? html`<p class="notice">Preview — booking is switched off until you publish.</p>` : ''}
    ${hasPaid && !e.checkoutAvailable ? html`<p class="pay-note">Online payment isn’t available yet, so paid tickets can’t be booked right now.${e.tiers.some((t) => t.kind === 'free') ? ' Free tickets can.' : ''}</p>` : ''}
    <form class="tier-form" data-tier-form="${preview ? '' : e.id}" novalidate>
      <fieldset class="tiers"${dis}>
        <legend>Choose a ticket</legend>
        ${e.tiers.map((t) => html`<label class="tier-opt${t.available ? '' : ' is-off'}">
          <input type="radio" name="ticketTypeId" value="${t.id}" data-max="${t.maxPerBooking}" data-elig="${t.eligibility || ''}"${t === first ? raw(' checked') : ''}${t.available ? '' : raw(' disabled')}>
          <span class="tier-main"><span class="tier-name">${t.name}</span><span class="tier-price">${t.priceLabel}</span></span>
          <span class="tier-meta">${[
            e.isMultiDay ? (t.validOn ? `Valid ${dayLabel(t.validOn)}` : 'All days') : null,
            t.eligibility ? `For: ${t.eligibility}` : null,
            t.remainingLabel,
            `Up to ${t.maxPerBooking} per booking`
          ].filter(Boolean).join(' · ')}</span>
          ${t.unavailable ? html`<span class="tier-off">${t.unavailable}</span>` : ''}
        </label>`)}
      </fieldset>
      <label class="field"><span>Number of tickets</span>
        <select name="quantity" data-qty${dis}>${Array.from({ length: max }, (_, i) => html`<option value="${i + 1}">${i + 1}</option>`)}</select>
      </label>
      <label class="check" data-elig-wrap${first?.eligibility ? '' : raw(' hidden')}><input type="checkbox" name="eligibilityConfirmed"${dis}> <span>I meet this ticket’s eligibility: <strong data-elig-text>${first?.eligibility || ''}</strong></span></label>
      ${e.pickupPoints.length ? html`<label class="field"><span>Pickup point</span>
        <select name="pickupPointId" required${dis}><option value="">Choose where you’ll join</option>
          ${e.pickupPoints.map((p) => html`<option value="${p.id}">${p.name}${p.time ? ` — ${localLabel(p.time)}` : ''}</option>`)}
        </select></label>` : ''}
      ${e.questions.length ? html`<div class="q-list"><p class="q-head">The host asks</p>${e.questions.map((q) => questionField(q, !open))}</div>` : ''}
      <button class="btn btn-primary btn-lg btn-block" type="submit"${dis}>${open || preview ? cta : e.stateLabel}</button>
      <p class="book-msg" data-book-msg role="status" aria-live="polite"></p>
    </form>
    <ul class="book-facts">
      ${e.requiresApproval ? html`<li>The host reviews each request and you’ll hear back on Telegram.${hasPaid ? ' Paid tickets are only charged after approval.' : ''}</li>` : ''}
      ${e.venuePrivacy === 'disclosed_after_booking' ? html`<li>The exact address appears on your booking once it’s confirmed.</li>` : ''}
      ${e.hasContact ? html`<li>An on-ground contact number is shared with confirmed guests.</li>` : ''}
      <li>Your confirmation arrives via our Telegram bot.</li>
    </ul>
  </aside>`;
}

function bookBox(e) {
  if (e.isExternal) return externalBox(e);
  if (e.ticketing === 'tiers') return tierBookBox(e);
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

export function renderEvent(e, { preview = false, previewBanner = '' } = {}) {
  const tz = e.timezone || 'Asia/Kolkata';
  const sameDay = e.endAt && fmtFullDate(e.endAt, tz) === fmtFullDate(e.startAt, tz);
  const when = html`${fmtFullDate(e.startAt, tz)}, ${fmtTime(e.startAt, tz)}${e.endAt
    ? (sameDay ? html` – ${fmtTime(e.endAt, tz)}` : html` – ${fmtFullDate(e.endAt, tz)}, ${fmtTime(e.endAt, tz)}`)
    : ''} ${fmtZone(e.startAt, tz)}`;
  const tiered = e.ticketing === 'tiers';
  const body = html`
  <article class="event">
    <header class="event-head">
      <div class="wrap">
        <p class="crumbs"><a href="${e.isTrip ? '/trips' : '/#upcoming'}">${e.isTrip ? 'Trips' : 'Upcoming'}</a> / ${e.city}</p>
        <div class="badges">${badges(e)}</div>
        <h1>${e.title}</h1>
        ${e.summary ? html`<p class="lede">${e.summary}</p>` : ''}
        ${e.isExternal ? html`<p class="sample-note">Listed from ${e.sourceUrl ? html`<a href="${e.sourceUrl}" target="_blank" rel="noopener nofollow">${e.sourceName}</a>` : e.sourceName}. Details may change — the organiser’s page is the source of truth.</p>` : ''}
        ${e.isDemo ? html`<p class="sample-note">This is a sample listing used to preview the site. It is not a real event and cannot be booked for real.</p>` : ''}
      </div>
    </header>
    ${previewBanner}
    ${e.coverUrl && tiered ? html`<div class="wrap"><img class="event-cover" src="${e.coverUrl}" alt="" width="1200" height="675"></div>` : ''}
    <div class="wrap event-grid">
      <div class="event-main">
        <dl class="facts">
          <div><dt>When</dt><dd><time datetime="${e.startAt}">${when}</time></dd></div>
          <div><dt>Where</dt><dd>${e.venue || e.area ? html`${e.venue || e.area}, ` : ''}${e.city}${!e.isExternal && e.venuePrivacy === 'disclosed_after_booking' ? html` <span class="muted">(exact venue after booking)</span>` : ''}${e.mapsUrl ? html` · <a href="${e.mapsUrl}" target="_blank" rel="noopener nofollow">Open in Maps</a>` : ''}</dd></div>
          <div><dt>Format</dt><dd>${e.categoryLabel}</dd></div>
          ${e.isExternal ? '' : tiered ? html`<div><dt>Tickets</dt><dd>${e.capacity} in total</dd></div>` : html`<div><dt>Group size</dt><dd>Up to ${e.capacity} people</dd></div>`}
          ${tiered && e.requiresApproval ? html`<div><dt>Entry</dt><dd>Host approves each guest</dd></div>` : ''}
          ${e.genderPolicy ? html`<div><dt>Group balance</dt><dd>${e.genderPolicy}</dd></div>` : ''}
          <div><dt>Hosted by</dt><dd>${e.organizer}</dd></div>
        </dl>
        ${e.description && e.description !== e.summary ? html`<section class="prose"><h2>About</h2>${e.description.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</section>` : ''}
        ${e.gallery?.length ? html`<section class="gallery" aria-label="Photos">${e.gallery.map((u) => html`<img src="${u}" alt="" loading="lazy" width="480" height="320">`)}</section>` : ''}
        ${e.pickupPoints?.length ? html`<section class="prose"><h2>Pickup points</h2><ul>${e.pickupPoints.map((p) => html`<li><strong>${p.name}</strong>${p.location ? html` — ${p.location}` : ''}${p.time ? html` · ${localLabel(p.time)}` : ''}</li>`)}</ul></section>` : ''}
        ${e.inclusions.length ? html`<section class="prose"><h2>Included</h2><ul class="ticks">${e.inclusions.map((i) => html`<li>${i}</li>`)}</ul></section>` : ''}
        ${e.exclusions.length ? html`<section class="prose"><h2>Not included</h2><ul class="crosses">${e.exclusions.map((i) => html`<li>${i}</li>`)}</ul></section>` : ''}
        ${e.isExternal ? '' : html`<section class="prose"><h2>Refund policy</h2><p>${e.refundPolicy || 'The refund policy will be published before bookings open.'}</p><p><a href="/refunds">Billing &amp; Refunds</a></p></section>`}
        <section class="prose"><h2>Good to know</h2><ul><li>Adults 21+ only. Please carry a photo ID.</li>${e.isExternal ? '' : html`<li>Our <a href="/community-guidelines">Community Guidelines</a> apply.</li>`}</ul></section>
      </div>
      ${preview ? tierBookBox(e, { preview: true }) : bookBox(e)}
    </div>
  </article>`;

  return layout({
    title: preview ? `Preview: ${e.title}` : `${e.title} — ${e.city}`,
    description: (e.summary || `${e.categoryLabel} in ${e.city} for adults 21+.`).slice(0, 160),
    path: preview ? '/organiser' : eventPath(e),
    body,
    head: preview ? '' : eventJsonLd(e),
    noindex: e.isDemo || preview,
    current: e.isTrip ? '/trips' : '/#upcoming',
    ogImage: e.coverUrl ? (/^https:/.test(e.coverUrl) ? e.coverUrl : `${siteUrl()}${e.coverUrl}`) : undefined
  });
}

export { raw };
