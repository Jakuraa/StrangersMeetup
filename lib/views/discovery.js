// lib/views/discovery.js - All-events listing, format collections, event submission, membership.
import { html, raw } from './html.js';
import { layout, pageHeader } from './layout.js';
import { eventCard, emptyEvents, filters } from './components.js';
import { CATEGORY_LABELS, CITIES } from '../services/events.js';

const grid = (events, empty) => (events.length ? html`<div class="card-grid">${events.map(eventCard)}</div>` : emptyEvents(empty));

const FORMATS = [
  ['/nightlife', 'Nightlife'], ['/trips', 'Weekend trips'], ['/meetups', 'Meetups'], ['/dinners', 'Dinners'],
  ['/weekend-parties', 'Weekend parties'], ['/dating', 'Dating & matchmaking']
];

function formatNav(current) {
  return html`<nav class="format-nav" aria-label="Formats"><ul>
    ${FORMATS.map(([href, label]) => html`<li><a href="${href}"${href === current ? raw(' aria-current="page"') : ''}>${label}</a></li>`)}
  </ul></nav>`;
}

const submitNote = html`<p class="note">Running an event in South India? <a href="/submit-event">Submit it for review</a> — every listing is checked by a person before it appears.</p>`;

export function renderAllEvents({ events, filter = {} }) {
  const isFiltered = Boolean(filter.city || filter.category || filter.when || filter.q);
  const emptyMsg = filter.q
    ? `No upcoming events match "${filter.q}". Try searching for dinner, party, meetup, or trip.`
    : isFiltered
      ? 'No upcoming events match these filters.'
      : 'No upcoming events are listed right now.';
  const searchNotice = filter.q ? html`<div class="search-notice" role="status"><p>Showing results for <strong>“${filter.q}”</strong> · <a class="clear-search" href="/events${filter.city ? `?city=${filter.city}` : ''}">Clear search</a></p></div>` : '';
  const body = html`${pageHeader('Discover', 'All upcoming events', 'Hosted meetups, dinners, nightlife, parties, dating mixers and trips for adults 21+. Listings from other organisers are clearly labelled with their source.', true)}
  <section class="section section-flush">
    <div class="wrap" data-discovery-feed>
      ${formatNav('/events')}
      ${searchNotice}
      ${filters(filter, '/events')}
      <div data-discovery-results>
        ${grid(events, emptyMsg)}
      </div>
      ${submitNote}
    </div>
  </section>`;
  return layout({
    title: filter.q ? `Events matching "${filter.q}"` : 'All upcoming events',
    description: 'Upcoming meetups, dinners, nightlife, weekend parties, dating mixers and weekend trips across South India, for adults 21+.',
    path: '/events', body, current: '/#upcoming'
  });
}

const COLLECTION_COPY = {
  parties: {
    path: '/weekend-parties', title: 'Weekend parties', eyebrow: 'Friday to Sunday',
    lede: 'Hosted weekend socials where most people arrive solo. Each listing shows who runs it and how booking works.',
    description: 'Hosted weekend parties and socials for adults 21+ in Chennai, Bengaluru, Coimbatore, Kochi and Puducherry.'
  },
  dinners: {
    path: '/dinners', title: 'Dinners', eyebrow: 'Dinner club',
    lede: 'Small tables of strangers, a host, and a good kitchen.',
    description: 'Dinner clubs with strangers for adults 21+ across South India.'
  },
  meetups: {
    path: '/meetups', title: 'Meetups', eyebrow: 'Meet new people',
    lede: 'Board-game nights, movie nights and easy-going meetups. Pick a city below or browse everything.',
    description: 'Social meetups, board-game nights and movie nights for adults 21+ across South India.'
  }
};

export function renderCollection(key, events) {
  const c = COLLECTION_COPY[key];
  const body = html`${pageHeader(c.eyebrow, c.title, c.lede, true)}
  <section class="section section-flush">
    <div class="wrap">
      ${formatNav(c.path)}
      ${grid(events, `No ${c.title.toLowerCase()} are listed right now.`)}
      ${key === 'meetups' ? html`<p class="note">By city: ${CITIES.map((x, i) => html`${i ? ' · ' : ''}<a href="/meetups/${x.slug}">${x.name}</a>`)}</p>` : ''}
      ${submitNote}
    </div>
  </section>`;
  return layout({ title: c.title, description: c.description, path: c.path, body });
}

// ---------- submissions ----------

export function renderSubmitEvent() {
  const opt = (v, l) => html`<option value="${v}">${l}</option>`;
  const body = html`${pageHeader('Organisers', 'Submit an event', 'Tell us about an upcoming event in South India. Our team reviews every submission; we publish only what we can verify, with credit and a link to your booking page.')}
  <section class="section section-flush">
    <div class="wrap narrow">
      <form class="lead-form" method="post" action="/api/events/submit" data-lead-form="submit" novalidate>
        <label class="field"><span>Event title</span><input name="title" maxlength="140" required></label>
        <label class="field"><span>Format</span><select name="category" required>${opt('', 'Choose…')}${Object.entries(CATEGORY_LABELS).map(([v, l]) => opt(v, l))}</select></label>
        <label class="field"><span>City</span><select name="city" required>${opt('', 'Choose…')}${CITIES.map((c) => opt(c.name, c.name))}</select></label>
        <label class="field"><span>Starts (IST)</span><input name="start_at" type="datetime-local" required></label>
        <label class="field"><span>Ends (IST, optional)</span><input name="end_at" type="datetime-local"></label>
        <label class="field"><span>Venue or area (optional)</span><input name="venue" maxlength="200"></label>
        <label class="field"><span>Booking or details page (https://, optional)</span><input name="link" type="url" maxlength="500" inputmode="url"></label>
        <label class="field"><span>Organiser (optional)</span><input name="organizer" maxlength="120"></label>
        <label class="field"><span>Description</span><textarea name="description" rows="5" maxlength="2000" required></textarea></label>
        <label class="field"><span>Your email or Telegram username (only our team sees this)</span><input name="contact" maxlength="200" required></label>
        <label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="consent" value="yes" required> <span>I organise this event or have permission to share it, and I agree NIGHTLIFEZ may contact me about it. See our <a href="/privacy">Privacy policy</a>.</span></label>
        <button class="btn btn-primary btn-lg" type="submit">Submit for review</button>
        <p class="form-msg" role="status" aria-live="polite" data-form-msg></p>
      </form>
    </div>
  </section>`;
  return layout({ title: 'Submit an event', description: 'Submit an upcoming event in South India for review and listing on NIGHTLIFEZ.', path: '/submit-event', body });
}

export function renderSubmitThanks() {
  const body = html`${pageHeader('Organisers', 'Thank you', 'We have your submission. A person reviews it before anything is listed.')}
  <section class="section section-flush"><div class="wrap narrow"><p><a class="link-arrow" href="/events">Browse events</a></p></div></section>`;
  return layout({ title: 'Submission received', description: 'Thank you', path: '/submit-event', body, noindex: true });
}

// ---------- membership ----------

export function renderMembership(tiers) {
  const anySp = tiers.some((t) => t.provider === 'superprofile');
  const anyStars = tiers.some((t) => t.provider === 'telegram_stars');
  const how = [
    anySp ? 'SuperProfile memberships are bought on SuperProfile’s secure checkout. SuperProfile then gives you access to the private Telegram group and removes access if the membership ends.' : null,
    anyStars ? 'Telegram Stars memberships are paid inside Telegram and renew every 30 days until you cancel in Telegram.' : null
  ].filter(Boolean);
  const cta = (t) => {
    if (!t.purchasable) return html`<button class="btn btn-ghost" type="button" disabled>Announcing soon</button>`;
    if (t.provider === 'superprofile') {
      // Hidden inside Telegram: digital goods sold inside Telegram apps must use Stars.
      return html`<a class="btn btn-primary" href="${t.superprofileUrl}" rel="noopener" data-web-only data-membership-click="${t.code}">Join on SuperProfile</a>
        <p class="muted" data-tg-only hidden>Membership checkout is not available inside Telegram.</p>`;
    }
    return html`<button class="btn btn-primary" type="button" data-join-tier="${t.code}">Join with Telegram Stars</button>`;
  };
  const body = html`${pageHeader('Membership', 'Private community access', 'Optional membership for regulars: access to private Telegram groups. Events stay open to everyone.')}
  <section class="section section-flush">
    <div class="wrap">
      ${tiers.length ? html`<div class="tiers">
        ${tiers.map((t) => html`<article class="tier">
          <h3>${t.name}</h3>
          <p class="tier-price">${t.priceLabel}</p>
          <ul>${t.benefits.map((b) => html`<li>${b}</li>`)}</ul>
          ${cta(t)}
        </article>`)}
      </div>` : html`<p class="muted">Membership details are being finalised.</p>`}
      ${how.length ? html`<div class="prose narrow-block"><h2>How it works</h2>${how.map((p) => html`<p>${p}</p>`)}<p>Questions about a payment? See <a href="/refunds">Billing &amp; Refunds</a>.</p></div>` : ''}
    </div>
  </section>`;
  return layout({ title: 'Membership', description: 'Optional NIGHTLIFEZ membership with access to private Telegram groups.', path: '/membership', body });
}
