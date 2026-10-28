// lib/views/pages.js - Listing pages, forms, content and utility pages.
import { html, raw, jsonLd } from './html.js';
import { layout, pageHeader, INSTAGRAM_URL } from './layout.js';
import { eventCard, emptyEvents, faqList, filters } from './components.js';
import { FAQ } from './content.js';
import { env, botUsername } from '../config.js';
import { CITIES } from '../services/events.js';
import { PERSONAS, PERSONA_KEYS } from '../dev-personas.js';

function contactLine() {
  const email = env('SUPPORT_EMAIL');
  const bot = botUsername();
  return html`${bot ? html`Message <a href="https://t.me/${bot}">@${bot}</a> on Telegram` : 'Our Telegram bot is being set up'}${email ? html`, or email <a href="mailto:${email}">${email}</a>` : ''}.`;
}

function entity() {
  return env('LEGAL_ENTITY_NAME') || 'StrangersMeetup (legal entity details will be published here before paid bookings open)';
}

// ---------- listings ----------

export function renderListing({ title, eyebrow, lede, path, events, description, filter, current, extra = '' }) {
  const body = html`${pageHeader(eyebrow, title, lede)}
  <section class="section section-flush">
    <div class="wrap">
      ${filter ? filters(filter, path) : ''}
      ${extra}
      ${events.length ? html`<div class="card-grid">${events.map(eventCard)}</div>` : emptyEvents()}
    </div>
  </section>`;
  return layout({ title, description, path, body, current });
}

export function renderCity(city, events) {
  const body = html`${pageHeader(`${city.state}`, `Meetups in ${city.name}`, `Hosted dinners, game nights, mixers and nightlife for adults 21+ in ${city.name}.`)}
  <section class="section section-flush">
    <div class="wrap">
      ${events.length ? html`<div class="card-grid">${events.map(eventCard)}</div>` : emptyEvents(`No ${city.name} events are listed right now.`)}
      <p class="note">Other cities: ${CITIES.filter((c) => c.slug !== city.slug).map((c, i) => html`${i ? ' · ' : ''}<a href="/meetups/${c.slug}">${c.name}</a>`)}</p>
    </div>
  </section>`;
  return layout({
    title: `Meetups in ${city.name}`,
    description: `Upcoming StrangersMeetup events in ${city.name}: small hosted meetups, dinner clubs and dating mixers for adults 21+.`,
    path: `/meetups/${city.slug}`,
    body
  });
}

export function renderDating(events) {
  const extra = html`<div class="prose narrow-block">
    <p>Dating mixers are hosted evenings: a short welcome, a few timed one-to-one conversations, then an open social hour. Hosts keep the pace relaxed and step in if anyone feels uncomfortable.</p>
    <p><strong>Consent first.</strong> We never share anyone’s Telegram handle or contact details. If you want to stay in touch with someone, exchange details yourselves — or wait for mutual introductions (<span class="soon">coming soon</span>), where both people must opt in.</p>
    <p>There are no compatibility scores or algorithms here — just a well-run room.</p>
    <h2>Upcoming dating events</h2>
  </div>`;
  return renderListing({
    title: 'Dating & Matchmaking', eyebrow: 'Consent-based introductions', lede: 'In-person dating mixers for adults 21+, run by hosts.',
    path: '/dating', events, extra, current: '/dating',
    description: 'Hosted, consent-first dating mixers for adults 21+ in Chennai, Bengaluru, Coimbatore, Kochi and Puducherry.'
  });
}

// ---------- forms ----------

const FORMS = {
  partner: {
    path: '/partner-with-us', title: 'Partner With Us', eyebrow: 'Partnerships',
    lede: 'Brands, communities and organisers who want to create something with us.',
    fields: [
      ['name', 'Your name', 'text', true], ['organization', 'Organisation', 'text', true], ['email', 'Work email', 'email', true],
      ['city', 'City', 'text', false], ['message', 'What would you like to do together?', 'textarea', true]
    ]
  },
  host: {
    path: '/become-a-host', title: 'Become a Host', eyebrow: 'Hosting',
    lede: 'Love bringing people together? Tell us about yourself and the kind of evening you would run.',
    fields: [
      ['name', 'Your name', 'text', true], ['telegram', 'Telegram username', 'text', true], ['email', 'Email (optional)', 'email', false],
      ['city', 'City', 'text', true], ['experience', 'Hosting or community experience', 'textarea', true], ['idea', 'An event you would like to host', 'textarea', false]
    ]
  },
  venue: {
    path: '/list-your-venue', title: 'List Your Venue', eyebrow: 'Venues',
    lede: 'Cafés, restaurants, bars, studios and resorts that welcome small groups.',
    fields: [
      ['name', 'Your name', 'text', true], ['venue_name', 'Venue name', 'text', true], ['email', 'Email', 'email', true],
      ['phone', 'Phone (optional)', 'tel', false], ['city', 'City', 'text', true], ['area', 'Area / neighbourhood', 'text', false],
      ['capacity', 'Comfortable group size', 'number', false], ['message', 'Anything else we should know?', 'textarea', false]
    ]
  }
};

export function formDefinition(type) {
  return FORMS[type];
}

export function renderForm(type) {
  const f = FORMS[type];
  const field = ([name, label, kind, required]) => html`<label class="field">
    <span>${label}${required ? '' : ''}</span>
    ${kind === 'textarea'
      ? html`<textarea name="${name}" rows="4" maxlength="2000"${required ? raw(' required') : ''}></textarea>`
      : html`<input name="${name}" type="${kind}"${kind === 'number' ? raw(' min="1" max="5000"') : raw(' maxlength="200"')}${required ? raw(' required') : ''}${kind === 'email' ? raw(' autocomplete="email"') : ''}>`}
  </label>`;
  const body = html`${pageHeader(f.eyebrow, f.title, f.lede)}
  <section class="section section-flush">
    <div class="wrap narrow">
      <form class="lead-form" method="post" action="/api/leads/${type}" data-lead-form="${type}" novalidate>
        ${f.fields.map(field)}
        <label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="consent" value="yes" required> <span>I agree that StrangersMeetup may contact me about this enquiry. See our <a href="/privacy">Privacy policy</a>.</span></label>
        <button class="btn btn-primary btn-lg" type="submit">Send</button>
        <p class="form-msg" role="status" aria-live="polite" data-form-msg></p>
      </form>
    </div>
  </section>`;
  return layout({ title: f.title, description: `${f.title} — ${f.lede}`, path: f.path, body, current: f.path === '/list-your-venue' ? '/list-your-venue' : '' });
}

export function renderFormThanks(type) {
  const f = FORMS[type];
  const body = html`${pageHeader(f.eyebrow, 'Thank you', 'We have received your details and will get back to you.')}
  <section class="section section-flush"><div class="wrap narrow"><p><a class="link-arrow" href="/">Back to home</a></p></div></section>`;
  return layout({ title: `${f.title} — received`, description: 'Thank you', path: f.path, body, noindex: true });
}

// ---------- content pages ----------

export function renderFaq() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
  };
  const body = html`${pageHeader('Help', 'Frequently asked questions', '')}
  <section class="section section-flush"><div class="wrap narrow">${faqList(FAQ)}
  <p class="note">Still stuck? ${contactLine()}</p></div></section>`;
  return layout({ title: 'FAQ', description: 'How StrangersMeetup works: booking, Telegram sign-in, venues, refunds, membership, privacy and safety.', path: '/faq', body, head: jsonLd(ld), current: '/faq' });
}

function prosePage({ path, title, eyebrow, lede, description, sections, noindex = false }) {
  const body = html`${pageHeader(eyebrow, title, lede)}
  <section class="section section-flush"><div class="wrap narrow prose">
    ${sections.map(([h, ps]) => html`<h2>${h}</h2>${ps.map((p) => (typeof p === 'string' ? html`<p>${p}</p>` : p))}`)}
  </div></section>`;
  return layout({ title, description, path, body, noindex });
}

export function renderTrustSafety() {
  return prosePage({
    path: '/trust-safety', title: 'Trust & Safety', eyebrow: 'Community', lede: 'How we look after the people who come to our events.',
    description: 'How StrangersMeetup keeps events safe: 21+ only, private venue details, single-use invites, guidelines and reporting.',
    sections: [
      ['Adults only', ['Every event is for adults 21 and over. You confirm your age when you sign in. Please carry a photo ID.']],
      ['Privacy by default', ['Exact venues for private events are shared only with confirmed attendees, inside a private Telegram group. Group invites are single-use and expire after 24 hours. We never share your contact details with other attendees.']],
      ['Clear guidelines', [html`Our <a href="/community-guidelines">Community Guidelines</a> apply at every event and in every group. People who break them can be removed from events and groups without refund.`]],
      ['How to report', [html`Send <strong>/report</strong> to our Telegram bot, or ${contactLine()} Tell us what happened, when, and at which event. Reports are reviewed by our moderators and kept confidential.`, 'If you are in immediate danger, call 112.']],
      ['Payments you can trust', ['Tickets are paid on a licensed payment gateway’s hosted page. A booking is confirmed only after the gateway confirms payment to our server — never on the strength of a browser redirect.']]
    ]
  });
}

export function renderGuidelines() {
  return prosePage({
    path: '/community-guidelines', title: 'Community Guidelines', eyebrow: 'Community', lede: 'Simple rules so everyone can relax.',
    description: 'StrangersMeetup community guidelines for events and Telegram groups.',
    sections: [
      ['Consent, always', ['No unwanted touching, following, or persistent messaging. “No”, silence, or walking away means no.']],
      ['Respect everyone', ['No harassment, hate speech, or discrimination based on gender, sexuality, religion, caste, ethnicity, disability or appearance.']],
      ['Keep it private', ['Do not photograph or record other attendees without their permission. Do not share the venue or group content outside the group.']],
      ['Drink responsibly', ['Hosts may ask anyone who is intoxicated or disruptive to leave.']],
      ['No selling', ['No promotions, MLM, or soliciting in events or groups.']],
      ['Consequences', ['Breaking these guidelines can lead to removal from an event or group and a ban from future events, without refund.']]
    ]
  });
}

export function renderPrivacy() {
  return prosePage({
    path: '/privacy', title: 'Privacy Policy', eyebrow: 'Information', lede: 'What we collect, why, and your choices.',
    description: 'StrangersMeetup privacy policy.',
    sections: [
      ['Who we are', [`This website and the StrangersMeetup Telegram bot are operated by ${entity()}.`]],
      ['What we collect from members', ['Your Telegram user ID and the display name Telegram shares when you sign in; your confirmation that you are 21+; optionally your city; your bookings, membership and payment status. We do not ask members for phone numbers or email addresses.']],
      ['Payments', ['Card, UPI and bank details are handled by the payment provider on its own pages. We receive only a transaction reference, amount and status. Telegram Stars payments are handled by Telegram.']],
      ['Partner, host and venue enquiries', ['If you submit one of these forms we store what you enter so we can reply. We delete enquiries we no longer need.']],
      ['Why we use it', ['To confirm bookings, deliver group invites, run events safely, handle refunds and reports, and meet legal obligations. We do not sell personal data or use it for third-party advertising.']],
      ['Cookies', ['We set one essential cookie to keep you signed in. We use privacy-friendly, cookieless page analytics.']],
      ['Retention and your rights', [html`You can ask us to access, correct or delete your data. ${contactLine()} Some payment records must be kept for tax and legal reasons.`]],
      ['Grievance officer', [env('GRIEVANCE_EMAIL') ? `${env('GRIEVANCE_OFFICER_NAME') || 'Grievance Officer'} — ${env('GRIEVANCE_EMAIL')}` : 'Details will be published here before paid bookings open.']]
    ]
  });
}

export function renderTerms() {
  return prosePage({
    path: '/terms', title: 'Terms of Use', eyebrow: 'Information', lede: 'The basics of using StrangersMeetup.',
    description: 'StrangersMeetup terms of use.',
    sections: [
      ['Eligibility', ['You must be 21 or older and able to enter into a binding contract under Indian law.']],
      ['Bookings', ['A booking is confirmed only when you receive a confirmation from our Telegram bot after payment is verified. Tickets are personal and non-transferable unless the event page says otherwise.']],
      ['Conduct', [html`You agree to follow our <a href="/community-guidelines">Community Guidelines</a>. We may cancel bookings or remove access for breaches.`]],
      ['Changes and cancellations', ['If we cancel an event, you receive a full refund. If we materially change an event (date, city or format), you may cancel for a full refund.']],
      ['Membership', ['Memberships are paid with Telegram Stars, renew every 30 days until cancelled in Telegram, and give access to private Telegram groups for the paid period.']],
      ['Liability', ['Events take place at third-party venues. Please look after your own belongings and safety; nothing in these terms limits liability that cannot be limited by law.']],
      ['Operator', [`These terms are with ${entity()}.`]]
    ]
  });
}

export function renderRefunds() {
  return prosePage({
    path: '/refunds', title: 'Billing & Refunds', eyebrow: 'Information', lede: 'How payments, cancellations and refunds work.',
    description: 'StrangersMeetup billing and refund policy for event tickets, trips and membership.',
    sections: [
      ['Event tickets and trips', ['Each event page states its own refund window. Within that window, request a refund and it will be returned to your original payment method via the payment provider. Bank processing usually takes 5–7 working days.']],
      ['If we cancel', ['If we cancel an event or trip, every confirmed attendee receives a full refund to their original payment method.']],
      ['If a payment goes through but the event is full', ['Rarely, a payment can complete after a seat hold expires and the event fills up. In that case your booking is not confirmed and we refund you in full.']],
      ['Membership (Telegram Stars)', ['Memberships renew every 30 days. Cancel any time in Telegram (Settings → My Stars / Subscriptions); access continues until the end of the paid period. Stars purchases are governed by Telegram’s terms.']],
      ['How to ask', [html`${contactLine()} Include the event name and your booking reference from the bot message.`]]
    ]
  });
}

export function renderContact() {
  return prosePage({
    path: '/contact', title: 'Contact', eyebrow: 'Information', lede: 'We would love to hear from you.',
    description: 'Contact StrangersMeetup.',
    sections: [
      ['Members', [html`${contactLine()}`]],
      ['Partners, hosts and venues', [html`Use <a href="/partner-with-us">Partner With Us</a>, <a href="/become-a-host">Become a Host</a> or <a href="/list-your-venue">List Your Venue</a>.`]],
      ['Instagram', [html`<a href="${INSTAGRAM_URL}" target="_blank" rel="noopener">@the.strangers.meetup</a> — our only official account.`]]
    ]
  });
}

// ---------- member pages (client-rendered, never cached) ----------

const SIGNIN_ERRORS = {
  age: 'Please confirm you are 21 or older to continue.',
  expired: 'That sign-in attempt expired. Please try again.',
  failed: 'Telegram sign-in could not be completed. Please try again.',
  not_configured: 'Telegram sign-in is not configured yet on this deployment.'
};

/** Local-only persona sign-in (rendered only when devLoginEnabled(); the API enforces the same gate). */
function devPersonaPicker() {
  return html`<section class="dev-personas" aria-labelledby="dev-personas-title">
    <h2 id="dev-personas-title">Local test personas</h2>
    <p class="muted">Development only. Seeded by <code>npm run seed:local</code>; never available on a deployment.</p>
    <ul class="dev-persona-list">
      ${PERSONA_KEYS.map((k) => html`<li><button class="btn btn-ghost btn-sm" type="button" data-dev-login="${k}">
        <span>${PERSONAS[k].alias}</span> <span class="muted">${PERSONAS[k].role}</span></button></li>`)}
    </ul>
  </section>`;
}

export function renderSignin({ next = '/me', error = '', oidc = false, devLogin = false } = {}) {
  const bot = botUsername();
  const ageLabel = html`<span>I confirm I am 21 or older and agree to the <a href="/terms">Terms</a> and <a href="/community-guidelines">Community Guidelines</a>.</span>`;
  let method;
  if (oidc) {
    method = html`<form class="signin" method="get" action="/auth/telegram/start">
      <input type="hidden" name="next" value="${next}">
      <label class="check"><input type="checkbox" name="age" value="1" required> ${ageLabel}</label>
      <button class="btn btn-tg btn-lg" type="submit">Continue with Telegram</button>
    </form>`;
  } else if (bot) {
    method = html`<div class="signin">
      <label class="check"><input type="checkbox" data-age-confirm> ${ageLabel}</label>
      <div class="tg-widget" data-tg-widget data-bot="${bot}"></div>
    </div>`;
  } else {
    method = html`<p class="notice">Telegram sign-in is not configured yet on this deployment.</p>`;
  }
  const body = html`${pageHeader('Members', 'Continue with Telegram', 'Sign in to book tickets and manage your bookings. We never see your phone number.')}
  <section class="section section-flush"><div class="wrap narrow" data-signin>
    ${error && SIGNIN_ERRORS[error] ? html`<p class="notice">${SIGNIN_ERRORS[error]}</p>` : ''}
    ${method}
    ${bot ? html`<p class="muted">Using Telegram on your phone? <a href="https://t.me/${bot}?start=signin">Open our bot</a> and tap “Open StrangersMeetup”.</p>` : ''}
    ${devLogin ? devPersonaPicker() : ''}
    <p class="form-msg" data-signin-msg role="status" aria-live="polite"></p>
  </div></section>`;
  return layout({ title: 'Continue with Telegram', description: 'Sign in to StrangersMeetup with Telegram.', path: '/signin', body, noindex: true });
}

export function renderMe() {
  const body = html`${pageHeader('Members', 'My bookings', '')}
  <section class="section section-flush"><div class="wrap narrow">
    <div data-my-bookings><p class="muted">Loading…</p></div>
    <div class="profile-block" data-profile></div>
    <p class="note"><button class="btn btn-ghost btn-sm" type="button" data-signout>Sign out</button></p>
  </div></section>`;
  return layout({ title: 'My bookings', description: 'Your StrangersMeetup bookings.', path: '/me', body, noindex: true });
}

export function renderBookingStatus(id) {
  const body = html`${pageHeader('Booking', 'Your booking', '')}
  <section class="section section-flush"><div class="wrap narrow">
    <div class="booking-status" data-booking-status="${id}"><p class="muted">Checking payment status…</p></div>
  </div></section>`;
  return layout({ title: 'Booking status', description: 'Booking status', path: `/bookings/${id}`, body, noindex: true });
}

export function renderNotFound() {
  const body = html`${pageHeader('404', 'Page not found', 'That page does not exist or has moved.')}
  <section class="section section-flush"><div class="wrap narrow"><p><a class="link-arrow" href="/">Back to home</a></p></div></section>`;
  return layout({ title: 'Page not found', description: 'Page not found', path: '/404', body, noindex: true });
}

export function renderError() {
  const body = html`${pageHeader('Error', 'Something went wrong', 'Please try again in a moment.')}`;
  return layout({ title: 'Error', description: 'Error', path: '/', body, noindex: true });
}
