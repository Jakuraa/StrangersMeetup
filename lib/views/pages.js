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
  return env('LEGAL_ENTITY_NAME') || 'NIGHTLIFEZ (legal entity details will be published here before paid bookings open)';
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
  const body = html`${pageHeader(`${city.state}`, `Meetups in ${city.name}`, `Hosted dinners, game nights, mixers and nightlife for adults 21+ in ${city.name}.`, true)}
  <section class="section section-flush">
    <div class="wrap">
      ${events.length ? html`<div class="card-grid">${events.map(eventCard)}</div>` : emptyEvents(`No ${city.name} events are listed right now.`)}
      <p class="note">Other cities: ${CITIES.filter((c) => c.slug !== city.slug).map((c, i) => html`${i ? ' · ' : ''}<a href="/meetups/${c.slug}">${c.name}</a>`)}</p>
    </div>
  </section>`;
  return layout({
    title: `Meetups in ${city.name}`,
    description: `Upcoming NIGHTLIFEZ events in ${city.name}: parties, nightlife, hosted meetups, dinner clubs and mixers for adults 21+.`,
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

export function renderForm(type, { user = null, isOrg = false } = {}) {
  const f = FORMS[type];
  if (type === 'host') {
    const isAlreadyHost = Boolean(isOrg || (user && user.organiser_enabled));
    const prefillName = user?.alias || '';
    const prefillTg = user?.username ? `@${user.username}` : '';
    const cityDatalist = html`<datalist id="host-cities">
      ${CITIES.map((c) => html`<option value="${c.name}"></option>`)}
    </datalist>`;

    const body = html`${pageHeader('Hosting', 'Become an Organiser & Host', 'Love bringing people together? Host curated mixers, supper clubs, nightlife parties, or weekend getaways across South India.')}
    <section class="section section-flush">
      <div class="wrap narrow host-onboarding">
        ${isAlreadyHost ? html`
        <div class="host-already-card" role="status">
          <span class="pill pill-confirmed">Host Access Active</span>
          <h3>You already have host privileges!</h3>
          <p>Your account is approved to create and manage events on NIGHTLIFEZ.</p>
          <div class="org-gate-action">
            <a class="btn btn-primary btn-lg" href="/organiser">Go to Organiser Dashboard</a>
          </div>
        </div>` : ''}

        <div class="host-benefits-grid">
          <div class="host-benefit-card">
            <div class="host-benefit-icon" aria-hidden="true">✨</div>
            <h3>Curated 21+ Community</h3>
            <p>Reach engaged adults across Chennai, Bengaluru, Kochi, Coimbatore, and Puducherry looking for authentic, shared experiences.</p>
          </div>
          <div class="host-benefit-card">
            <div class="host-benefit-icon" aria-hidden="true">🔒</div>
            <h3>Secret Venue Privacy</h3>
            <p>Keep your venue address completely confidential. Exact details and Google Maps directions are disclosed only after a booking is confirmed.</p>
          </div>
          <div class="host-benefit-card">
            <div class="host-benefit-icon" aria-hidden="true">🎟️</div>
            <h3>Full Event Control</h3>
            <p>Set custom booking questions, approve each attendee yourself, manage capacity, and offer instant free RSVP spots without platform fees.</p>
          </div>
        </div>

        <div class="host-safety-card">
          <h4>Platform Safety &amp; Quality Standards</h4>
          <ul class="host-safety-list">
            <li><strong>Adults 21+ Only:</strong> All guests and hosts confirm age 21+ and attendees must carry government photo ID.</li>
            <li><strong>Safe &amp; Vetted Environments:</strong> Venues must be safe, welcoming, and accessible with on-ground check-in.</li>
            <li><strong>Zero-Tolerance Conduct:</strong> Harassment or discrimination results in immediate removal and permanent ban.</li>
          </ul>
        </div>

        <div class="host-form-wrap">
          <h2 class="org-h2" style="margin-top:0;">Host Application</h2>
          <p class="muted small" style="margin-bottom:20px;">Tell us about yourself and the events you want to run. We review every application personally.</p>
          <form class="lead-form" method="post" action="/api/leads/host" data-lead-form="host" novalidate>
            <label class="field">
              <span>Your name</span>
              <input name="name" type="text" maxlength="120" required value="${prefillName}" placeholder="e.g. Maya Krishnan">
            </label>
            <label class="field">
              <span>Telegram username</span>
              <input name="telegram" type="text" maxlength="32" required value="${prefillTg}" placeholder="e.g. @mayak">
              <span class="help small muted">We coordinate host approvals via Telegram. Phone number is never shared.</span>
            </label>
            <label class="field">
              <span>Email (optional)</span>
              <input name="email" type="email" maxlength="200" autocomplete="email" placeholder="you@example.com">
            </label>
            <label class="field">
              <span>City</span>
              <input name="city" type="text" maxlength="80" required list="host-cities" placeholder="e.g. Bengaluru">
              ${cityDatalist}
            </label>
            <label class="field">
              <span>Hosting or community experience</span>
              <textarea name="experience" rows="4" maxlength="2000" required placeholder="Tell us about meetups, dinners, trips, clubs, or gatherings you have hosted..."></textarea>
            </label>
            <label class="field">
              <span>An event you would like to host (optional)</span>
              <textarea name="idea" rows="3" maxlength="2000" placeholder="What kind of gathering or format do you envision hosting on NIGHTLIFEZ?"></textarea>
            </label>
            <label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
            <label class="check">
              <input type="checkbox" name="consent" value="yes" required>
              <span>I confirm I am 21 or older and agree to uphold the <a href="/community-guidelines">Community Guidelines</a> and Host Safety Standards. NIGHTLIFEZ may contact me regarding this enquiry. See our <a href="/privacy">Privacy Policy</a>.</span>
            </label>
            <button class="btn btn-primary btn-lg" type="submit">Submit Host Application</button>
            <p class="help text-center" style="margin-top: 10px;">Applications are reviewed within 24–48 hours. Once approved, organiser creation tools automatically unlock.</p>
            <p class="form-msg" role="status" aria-live="polite" data-form-msg></p>
          </form>
        </div>
      </div>
    </section>`;
    return layout({ title: 'Become a Host', description: 'Apply to host parties, nightlife experiences, social mixers and trips for adults 21+ on NIGHTLIFEZ.', path: '/become-a-host', body, current: '' });
  }

  const field = ([name, label, kind, required]) => html`<label class="field">
    <span>${label}${required ? '' : ''}</span>
    ${kind === 'textarea'
      ? html`<textarea name="${name}" rows="4" maxlength="2000"${required ? raw(' required') : ''}></textarea>`
      : html`<input name="${name}" type="${kind}"${kind === 'number' ? raw(' min="1" max="5000"') : raw(' maxlength="200"')}${required ? raw(' required') : ''}${kind === 'email' ? raw(' autocomplete="email"') : ''}>`}
  </label>`;
  const body = html`${pageHeader(f.eyebrow, f.title, f.lede)}
  <section class="section section-flush">
    <div class="wrap narrow">
      ${type === 'venue' ? html`<div class="venue-partner-shortcut" style="background:rgba(0,217,255,0.08);border:1px solid rgba(0,217,255,0.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div><strong>Already an operating venue partner?</strong><p class="muted small" style="margin:2px 0 0;">Access your booking enquiries, events schedule, and telemetry.</p></div>
        <a class="btn btn-outline-cyan btn-sm" href="/venue">Go to Venue Dashboard &rarr;</a>
      </div>` : ''}
      <form class="lead-form" method="post" action="/api/leads/${type}" data-lead-form="${type}" novalidate>
        ${f.fields.map(field)}
        <label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="consent" value="yes" required> <span>I agree that NIGHTLIFEZ may contact me about this enquiry. See our <a href="/privacy">Privacy policy</a>.</span></label>
        <button class="btn btn-primary btn-lg" type="submit">Send</button>
        <p class="form-msg" role="status" aria-live="polite" data-form-msg></p>
      </form>
    </div>
  </section>`;
  return layout({ title: f.title, description: `${f.title} — ${f.lede}`, path: f.path, body, current: f.path === '/list-your-venue' ? '/list-your-venue' : '' });
}

export function renderFormThanks(type, { user = null, isOrg = false } = {}) {
  const f = FORMS[type];
  if (type === 'host') {
    const body = html`${pageHeader('Hosting', 'Application Received!', 'Thank you for applying to host with NIGHTLIFEZ. We review each application personally within 24 to 48 hours.')}
    <section class="section section-flush">
      <div class="wrap narrow">
        <div class="host-thanks-steps">
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">1</div>
            <div class="host-step-content">
              <h4>Curation &amp; Safety Review</h4>
              <p>Our team reviews your application against our 21+ guidelines, community code of conduct, and venue safety standards.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">2</div>
            <div class="host-step-content">
              <h4>Host Privilege Activation</h4>
              <p>Once accepted, your account gains access to the Organiser Dashboard with full event creation tools.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">3</div>
            <div class="host-step-content">
              <h4>Draft &amp; Publish Your Event</h4>
              <p>You can set up secret venues, configure free RSVP ticket tiers, customize booking questions, and publish to South India discovery.</p>
            </div>
          </div>
        </div>
        <div class="host-thanks-actions">
          <a class="btn btn-primary" href="/events">Explore Current Events</a>
          <a class="btn btn-outline-cyan" href="/organiser">Check Organiser Dashboard</a>
        </div>
        <p style="margin-top:24px;"><a class="link-arrow" href="/">Back to home</a></p>
      </div>
    </section>`;
    return layout({ title: 'Host Application Received', description: 'Thank you for applying to host on NIGHTLIFEZ.', path: f.path, body, noindex: true });
  }

  if (type === 'venue') {
    const body = html`${pageHeader('Venues', 'Thank You — Venue Submission Received!', 'Thank you for offering your space to NIGHTLIFEZ. Our operations team reviews every venue listing within 24 to 48 hours.')}
    <section class="section section-flush">
      <div class="wrap narrow">
        <div class="host-thanks-steps">
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">1</div>
            <div class="host-step-content">
              <h4>Venue &amp; Safety Review</h4>
              <p>We review your capacity, ambiance, acoustic profile, and safety standards to ensure alignment with our 21+ gathering standards.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">2</div>
            <div class="host-step-content">
              <h4>Organiser &amp; Format Matching</h4>
              <p>We connect your space with verified supper club hosts, acoustic musicians, wine tasting curators, and social mixer organizers.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">3</div>
            <div class="host-step-content">
              <h4>Guaranteed Headcounts &amp; Address Privacy</h4>
              <p>Your address remains confidential until bookings are confirmed. You get guaranteed guest counts, advance run-of-show notice, and dedicated coordinator contact.</p>
            </div>
          </div>
        </div>
        <div class="host-thanks-actions">
          <a class="btn btn-primary" href="/events">Explore Current Events</a>
          <a class="btn btn-outline-cyan" href="/venue">Open Venue Dashboard</a>
        </div>
        <p style="margin-top:24px;"><a class="link-arrow" href="/">Back to home</a></p>
      </div>
    </section>`;
    return layout({ title: 'Venue Submission Received', description: 'Thank you for offering your venue to NIGHTLIFEZ.', path: f.path, body, noindex: true });
  }

  if (type === 'partner') {
    const body = html`${pageHeader('Partnerships', 'Thank You — Partner Proposal Received!', 'Thank you for reaching out to collaborate with NIGHTLIFEZ. Our team reviews partnership and service provider proposals within 2 business days.')}
    <section class="section section-flush">
      <div class="wrap narrow">
        <div class="host-thanks-steps">
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">1</div>
            <div class="host-step-content">
              <h4>Capability &amp; Service Review</h4>
              <p>We assess your service offering, technical portfolio, and city coverage against upcoming curated nightlife, dining, and travel itineraries.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">2</div>
            <div class="host-step-content">
              <h4>Host &amp; Community Matching</h4>
              <p>We introduce approved service providers (mixologists, DJs, photographers, sound techs, chefs) directly to verified event organisers.</p>
            </div>
          </div>
          <div class="host-thanks-step">
            <div class="host-step-num" aria-hidden="true">3</div>
            <div class="host-step-content">
              <h4>Transparent Operational Logistics</h4>
              <p>Agreed deliverables, run-of-show timelines, and direct settlements are established per event with zero intermediary commission cuts.</p>
            </div>
          </div>
        </div>
        <div class="host-thanks-actions">
          <a class="btn btn-primary" href="/events">Explore Current Events</a>
          <a class="btn btn-outline-cyan" href="/contact">Contact Support</a>
        </div>
        <p style="margin-top:24px;"><a class="link-arrow" href="/">Back to home</a></p>
      </div>
    </section>`;
    return layout({ title: 'Partner Proposal Received', description: 'Thank you for your partnership enquiry with NIGHTLIFEZ.', path: f.path, body, noindex: true });
  }

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
  return layout({ title: 'FAQ', description: 'How NIGHTLIFEZ works: booking, Telegram sign-in, venues, refunds, membership, privacy and safety.', path: '/faq', body, head: jsonLd(ld), current: '/faq' });
}

function prosePage({ path, title, eyebrow, lede, description, sections, extra = null, noindex = false }) {
  const body = html`${pageHeader(eyebrow, title, lede)}
  <section class="section section-flush"><div class="wrap narrow prose">
    ${sections.map(([h, ps]) => html`<h2>${h}</h2>${ps.map((p) => (typeof p === 'string' ? html`<p>${p}</p>` : p))}`)}
    ${extra || ''}
  </div></section>`;
  return layout({ title, description, path, body, noindex });
}

export function renderTrustSafety() {
  const supportEmail = env('SUPPORT_EMAIL') || '';
  const bot = botUsername() || '';
  const extra = html`<div class="safety-report-card" data-safety-report data-support-email="${supportEmail}" data-bot="${bot}"></div>`;
  return prosePage({
    path: '/trust-safety', title: 'Trust & Safety', eyebrow: 'Community', lede: 'How we look after the people who come to our events.',
    description: 'How NIGHTLIFEZ keeps events safe: 21+ only, private venue details, single-use invites, guidelines and reporting.',
    sections: [
      ['Adults only', ['Every event is for adults 21 and over. You confirm your age when you sign in. Please carry a photo ID.']],
      ['Privacy by default', ['Exact venues for private events are shared only with confirmed attendees, inside a private Telegram group. Group invites are single-use and expire after 24 hours. We never share your contact details with other attendees.']],
      ['Clear guidelines', [html`Our <a href="/community-guidelines">Community Guidelines</a> apply at every event and in every group. People who break them can be removed from events and groups without refund.`]],
      ['How to report', [html`Send <strong>/report</strong> to our Telegram bot, use the confidential reporting form below, or ${contactLine()} Tell us what happened, when, and at which event. Reports are reviewed by our moderators and kept confidential.`, 'If you are in immediate danger, call 112.']],
      ['Payments you can trust', ['Tickets are paid on a licensed payment gateway’s hosted page. A booking is confirmed only after the gateway confirms payment to our server — never on the strength of a browser redirect.']]
    ],
    extra
  });
}

export function renderGuidelines() {
  return prosePage({
    path: '/community-guidelines', title: 'Community Guidelines', eyebrow: 'Community', lede: 'Simple rules so everyone can relax.',
    description: 'NIGHTLIFEZ community guidelines for events and Telegram groups.',
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
    description: 'NIGHTLIFEZ privacy policy.',
    sections: [
      ['Who we are', [`This website and the NIGHTLIFEZ Telegram bot are operated by ${entity()}.`]],
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
    path: '/terms', title: 'Terms of Use', eyebrow: 'Information', lede: 'The basics of using NIGHTLIFEZ.',
    description: 'NIGHTLIFEZ terms of use.',
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
    description: 'NIGHTLIFEZ billing and refund policy for event tickets, trips and membership.',
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
    description: 'Contact NIGHTLIFEZ.',
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
  invalid_phone: 'Please enter a valid 10-digit Indian mobile number (starts with 6-9).',
  invalid_otp: 'The verification code you entered is invalid or has expired.',
  whatsapp_unavailable: 'WhatsApp sign-in is temporarily unavailable on this deployment. Please sign in with Telegram.',
  cooldown: 'Please wait a moment before requesting another verification code.',
  too_many_attempts: 'Too many incorrect verification attempts. Please request a new code.',
  otp_already_used: 'This verification code has already been used. Please request a new code.',
  otp_expired: 'This verification code has expired. Please request a new code.',
  phone_already_linked: 'This WhatsApp number is already linked to another NIGHTLIFEZ account. Please sign in with that account.',
  whatsapp_delivery_failed: 'Failed to deliver WhatsApp message. Please verify your phone number or continue with Telegram.',
  expired: 'That sign-in attempt expired. Please try again.',
  failed: 'Sign-in could not be completed. Please try again.',
  not_configured: 'Telegram sign-in is not configured yet on this deployment.',
  invalid_telegram_auth: 'Telegram sign-in could not be verified. Please try again.',
  replay: 'This sign-in link was already used. Please try again.'
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

export function renderSignin({
  next = '/me',
  error = '',
  step = 'phone',
  maskedPhone = null,
  phone = '',
  activeTab = null,
  whatsappAvailable = false,
  oidc = false,
  devLogin = false,
  previewReviewer = false
} = {}) {
  const bot = botUsername();
  const ageLabel = html`<span>I confirm I am 21 or older and agree to the <a href="/terms">Terms</a> and <a href="/community-guidelines">Community Guidelines</a>.</span>`;
  const isWhatsAppTabActive = activeTab ? activeTab === 'whatsapp' : whatsappAvailable;
  let tgMethod;
  if (oidc) {
    tgMethod = html`<form class="signin" method="get" action="/auth/telegram/start">
      <input type="hidden" name="next" value="${next}">
      <label class="check"><input type="checkbox" name="age" value="1" required> ${ageLabel}</label>
      <button class="btn btn-tg btn-lg btn-block" type="submit">Continue with Telegram</button>
    </form>`;
  } else if (bot) {
    tgMethod = html`<div class="signin tg-auth-card" data-tg-flow>
      <label class="check consent-check-row">
        <input type="checkbox" data-age-confirm id="tg-age-confirm">
        <span>${ageLabel}</span>
      </label>
      <div class="tg-action-wrap" data-tg-action-wrap>
        <button type="button" class="btn btn-tg btn-lg btn-block" data-tg-start-btn>Continue with Telegram</button>
      </div>
      <div class="tg-widget-placeholder" data-tg-widget-wrap hidden>
        <div class="tg-widget-loading" data-tg-widget-loading hidden role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>Connecting to Telegram…</span>
        </div>
        <div class="tg-widget" data-tg-widget data-bot="${bot}"></div>
      </div>
      <noscript>
        <p class="notice" style="margin-top: 10px;">JavaScript is required to sign in with Telegram in this browser. Alternatively, open <a href="https://t.me/${bot}?start=signin">@${bot}</a> in the Telegram app.</p>
      </noscript>
    </div>`;
  } else {
    tgMethod = html`<div class="preview-signin-card">
      <p class="notice">Telegram sign-in is not configured yet on this deployment.</p>
      <p class="muted">On production, attendees and hosts sign in with one tap through Telegram. Telegram handles 21+ identity verification, instant ticket delivery, and secret group invites with no passwords and no stored phone numbers.</p>
      <div class="preview-signin-actions">
        <a class="btn btn-primary btn-sm" href="/events">Explore Events</a>
        <a class="btn btn-outline-cyan btn-sm" href="/become-a-host">Apply to Host</a>
      </div>
    </div>`;
  }

  const body = html`${pageHeader('Sign In', 'Continue to NIGHTLIFEZ', 'Sign in with WhatsApp or Telegram to book passes, view secret venues, and connect with organisers.')}
  <section class="section section-flush"><div class="wrap narrow" data-signin>
    ${error && SIGNIN_ERRORS[error] ? html`<p class="notice">${SIGNIN_ERRORS[error]}</p>` : ''}
    ${previewReviewer ? html`
    <div class="preview-reviewer-box">
      <p class="preview-reviewer-title">Preview Testing Mode</p>
      <p class="preview-reviewer-desc">Sign in as a synthetic reviewer to test event booking, ticket issuance, and secret venue disclosure in this isolated preview environment.</p>
      <form method="post" action="/api/auth/preview-reviewer" class="preview-reviewer-form">
        <input type="hidden" name="next" value="${next}">
        <button class="btn btn-tg btn-sm" type="submit">Sign in as Preview Reviewer</button>
      </form>
    </div>` : ''}
    
    <div class="auth-switcher" role="tablist" aria-label="Sign in method">
      <button type="button" class="auth-tab-btn ${isWhatsAppTabActive ? 'active wa-tab' : ''}" role="tab" data-auth-tab="whatsapp" aria-selected="${isWhatsAppTabActive ? 'true' : 'false'}">Continue with WhatsApp</button>
      <button type="button" class="auth-tab-btn ${!isWhatsAppTabActive ? 'active' : ''}" role="tab" data-auth-tab="telegram" aria-selected="${!isWhatsAppTabActive ? 'true' : 'false'}">Continue with Telegram</button>
    </div>

    <!-- WhatsApp Panel -->
    <div class="auth-panel" data-auth-panel="whatsapp" ${!isWhatsAppTabActive ? 'hidden' : ''}>
      ${!whatsappAvailable ? html`
      <div class="wa-unavailable-card" data-wa-unavailable>
        <div class="wa-unavailable-icon" aria-hidden="true">📱</div>
        <h3 class="wa-unavailable-title">WhatsApp sign-in is temporarily unavailable</h3>
        <p class="wa-unavailable-desc">WhatsApp OTP delivery is currently offline pending Meta template approval. Please sign in with Telegram for instant, passwordless access to your digital passes, secret venues, and bookings.</p>
        <button type="button" class="btn btn-tg btn-lg btn-block" data-switch-to-telegram>Continue with Telegram</button>
      </div>` : html`
      <div data-wa-step="phone" ${step === 'otp' ? 'hidden' : ''}>
        <form class="wa-auth-card" method="POST" action="/api/auth/whatsapp/otp" data-wa-phone-form>
          <input type="hidden" name="next" value="${next}">
          <div class="field">
            <label for="wa-phone">Enter your WhatsApp mobile number</label>
            <div class="phone-field-group">
              <span class="country-code-pill" aria-label="Country code India">+91</span>
              <input type="tel" id="wa-phone" name="phone" class="phone-input" placeholder="98765 43210" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" required aria-required="true" autocomplete="tel-national" value="${phone ? phone.replace(/^\+91/, '').replace(/\D/g, '') : ''}">
            </div>
          </div>
          <fieldset class="auth-consent-fieldset">
            <legend class="sr-only">Permissions and Notification Preferences</legend>
            <label class="check consent-check-row">
              <input type="checkbox" id="wa-age-confirm" name="ageConfirmed" data-wa-age required>
              <span>${ageLabel}</span>
            </label>
            <label class="check consent-check-row promo-consent-row">
              <input type="checkbox" id="wa-promo-optin" name="promotionalOptIn" data-wa-promo aria-describedby="wa-promo-hint">
              <span class="consent-text-wrap">
                <span class="consent-title">Receive WhatsApp event announcements &amp; promotional offers</span>
                <span id="wa-promo-hint" class="consent-hint">Optional. Unchecked by default. Separate from essential login OTPs and booking passes. Opt out anytime.</span>
              </span>
            </label>
          </fieldset>
          <button type="submit" class="btn btn-wa btn-lg btn-block" data-wa-submit-phone>Send WhatsApp OTP</button>
        </form>
      </div>

      <div data-wa-step="otp" class="otp-box" data-wa-otp-card ${step === 'otp' ? '' : 'hidden'}>
        <form id="otp-form" method="POST" action="/api/auth/whatsapp/verify" data-wa-verify-form>
          <input type="hidden" name="next" value="${next}">
          <div class="field">
            <label for="otp-input">Verification code</label>
            <p id="otp-format-hint" class="otp-hint">
              Enter the 6-digit verification code sent to your WhatsApp on <strong data-wa-masked-phone>${maskedPhone || ''}</strong>.
            </p>
            <input
              type="text"
              id="otp-input"
              name="otp"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="\\d{6}"
              maxlength="6"
              aria-describedby="otp-format-hint"
              placeholder="······"
              required>
          </div>
          <div class="otp-actions">
            <button type="submit" class="btn btn-wa btn-lg btn-block" data-wa-verify-btn>Verify &amp; Continue</button>
            <div class="otp-resend-row">
              <button type="button" class="change-phone-link" data-wa-change-phone>Change phone number</button>
              <button type="button" class="resend-link" data-wa-resend-btn disabled>Resend code (60s)</button>
            </div>
          </div>
        </form>
      </div>`}
    </div>

    <!-- Telegram Panel -->
    <div class="auth-panel" data-auth-panel="telegram" ${whatsappAvailable ? 'hidden' : ''}>
      ${tgMethod}
      <div class="tg-switch-tip" data-tg-switch-tip>
        <div class="tg-switch-tip-header">
          <span class="tg-switch-icon" aria-hidden="true">ℹ️</span>
          <strong>Signing in with a different Telegram account?</strong>
        </div>
        <p class="tg-switch-desc">
          Telegram automatically detects the active Telegram session in this browser. To sign in with a different Telegram account:
        </p>
        <ul class="tg-switch-steps">
          <li>Open an <strong>Incognito or Private window</strong> to log in with a different Telegram phone number.</li>
          <li>Or sign out of Telegram Web at <a href="https://web.telegram.org" target="_blank" rel="noopener">web.telegram.org</a>.</li>
          ${bot ? html`<li>Or open our bot <a href="https://t.me/${bot}?start=signin">@${bot}</a> directly in the Telegram app on your phone and tap “Open NIGHTLIFEZ”.</li>` : ''}
        </ul>
      </div>
      ${bot ? html`<p class="muted" style="margin-top: 14px;">Using Telegram on your phone? <a href="https://t.me/${bot}?start=signin">Open our bot</a> and tap “Open NIGHTLIFEZ”.</p>` : ''}
    </div>

    <div class="signin-why" aria-label="Why sign in with Telegram or WhatsApp">
      <h2 class="signin-why-title">Why sign in with Telegram?</h2>
      <ul class="signin-why-list">
        <li><strong>No passwords to manage:</strong> One tap to sign in with WhatsApp or Telegram. No forgotten credentials, password resets, or spam emails.</li>
        <li><strong>Your privacy stays protected:</strong> We never share your contact details with hosts or other attendees. We only send transactional notices and passes.</li>
        <li><strong>Direct venue delivery:</strong> Confirmed booking passes, exact venue locations, and private group invites arrive directly on your verified device.</li>
      </ul>
    </div>
    ${devLogin ? devPersonaPicker() : ''}
    <p class="form-msg" data-signin-msg role="status" aria-live="polite"></p>
  </div></section>`;
  return layout({ title: 'Sign In', description: 'Sign in to NIGHTLIFEZ with WhatsApp or Telegram.', path: '/signin', body, noindex: true });
}

export function renderMe({ user } = {}) {
  const ageBanner = user && !user.age_confirmed_21 ? html`
    <div class="age-gate-banner" data-age-gate-banner style="background: rgba(255, 184, 0, 0.08); border: 1px solid rgba(255, 184, 0, 0.3); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
      <div>
        <strong style="color: var(--gold, #ffb800); display: block; font-size: 0.95rem; margin-bottom: 2px;">🔞 21+ Age Confirmation Required</strong>
        <span class="muted small" style="display: block; font-size: 0.82rem;">NIGHTLIFEZ events and bookings are strictly 21+. Please confirm your eligibility to book tickets and digital passes.</span>
      </div>
      <button class="btn btn-primary btn-sm" type="button" data-confirm-age-btn>Confirm 21+ Eligibility</button>
    </div>` : '';

  const body = html`${pageHeader('Members', 'My bookings', 'Your digital passes, venue reveals, saved events, and host updates.')}
  <section class="section section-flush"><div class="wrap narrow" data-attendee-hub>
    ${ageBanner}
    <div class="hub-tabs" role="tablist" aria-label="Attendee sections">
      <button class="hub-tab-btn active" type="button" role="tab" data-hub-tab="bookings" aria-selected="true">🎟️ My Passes &amp; Bookings</button>
      <button class="hub-tab-btn" type="button" role="tab" data-hub-tab="saved" aria-selected="false">🔖 Saved Events</button>
      <button class="hub-tab-btn" type="button" role="tab" data-hub-tab="announcements" aria-selected="false">📢 Host Updates</button>
      <button class="hub-tab-btn" type="button" role="tab" data-hub-tab="account" aria-selected="false">⚙️ Account &amp; Logins</button>
    </div>

    <div class="hub-section-block" data-hub-section="bookings">
      <div class="booking-filter-bar">
        <button class="org-filter-btn active" type="button" data-booking-filter="all">All Bookings</button>
        <button class="org-filter-btn" type="button" data-booking-filter="upcoming">Upcoming</button>
        <button class="org-filter-btn" type="button" data-booking-filter="past">Past</button>
      </div>
      <div data-my-bookings><p class="muted">Loading bookings…</p></div>
    </div>

    <div class="hub-section-block" data-hub-section="saved" hidden>
      <div data-saved-events><p class="muted">Loading saved events…</p></div>
    </div>

    <div class="hub-section-block" data-hub-section="announcements" hidden>
      <div data-my-announcements><p class="muted">Loading host announcements…</p></div>
    </div>

    <div class="hub-section-block" data-hub-section="account" hidden>
      <div data-account-settings><p class="muted">Loading login methods and communication settings…</p></div>
    </div>

    <div class="profile-block" data-profile></div>
    <div class="safety-block" data-safety-settings></div>
    <p class="note"><button class="btn btn-ghost btn-sm" type="button" data-signout>Sign out</button></p>
  </div></section>`;
  return layout({ title: 'My Bookings & Pass Hub', description: 'Your NIGHTLIFEZ bookings and attendee experience hub.', path: '/me', body, noindex: true });
}

export function renderBookingStatus(id) {
  const body = html`${pageHeader('Booking', 'Your booking', '')}
  <section class="section section-flush"><div class="wrap narrow">
    <div class="booking-status" data-booking-status="${id}"><p class="muted">Loading booking details…</p></div>
  </div></section>`;
  return layout({ title: 'Booking status', description: 'Booking status', path: `/bookings/${id}`, body, noindex: true });
}

export function renderOnboarding({ user = null, next = '/me' } = {}) {
  const currentStep = user?.onboarding_step || 1;
  const initialName = user?.display_name || user?.alias || '';
  const initialCity = user?.city || '';
  const initialGender = user?.gender || '';

  const body = html`<section class="section section-flush onboarding-section">
    <div class="wrap narrow onboarding-wrap" data-onboarding-container data-next="${next}" data-initial-step="${currentStep}">
      
      <!-- Progress Header -->
      <div class="onboarding-progress-bar" role="progressbar" aria-valuemin="1" aria-valuemax="6" aria-valuenow="${currentStep}">
        <div class="onboarding-progress-track">
          <div class="onboarding-progress-fill" data-progress-fill style="width: ${(Math.min(currentStep, 6) / 6) * 100}%"></div>
        </div>
        <div class="onboarding-steps-indicator">
          <span class="onboarding-step-badge" data-step-badge>Step ${Math.min(currentStep, 6)} of 6</span>
          <span class="onboarding-step-label" data-step-label>Welcome</span>
        </div>
      </div>

      <div class="onboarding-card">
        <!-- Error & Status Notification Area -->
        <div class="form-msg" data-onboarding-msg role="status" aria-live="polite"></div>

        <!-- STEP 1: Welcome -->
        <div class="onboarding-step-panel" data-step-panel="1" ${currentStep === 1 ? '' : 'hidden'}>
          <div class="onboarding-welcome-hero">
            <span class="onboarding-sparkle-icon" aria-hidden="true">✨</span>
            <h1 class="onboarding-title">Welcome to NIGHTLIFEZ</h1>
            <p class="onboarding-subheading">Discover your city. Meet your people. Experience more.</p>
          </div>
          <div class="onboarding-features-list">
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">🎉</span>
              <div class="feature-text">
                <strong>Parties &amp; Nightlife</strong>
                <p>Curated weekend parties, secret DJ sets, and private venue bookings.</p>
              </div>
            </div>
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">🍽️</span>
              <div class="feature-text">
                <strong>Dining Experiences</strong>
                <p>Host-approved chef tables, supper clubs, and curated dinner mixers.</p>
              </div>
            </div>
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">👋</span>
              <div class="feature-text">
                <strong>Social Meetups</strong>
                <p>Board game evenings, outdoor gatherings, and singles mixers for adults.</p>
              </div>
            </div>
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">🎵</span>
              <div class="feature-text">
                <strong>Music &amp; Entertainment</strong>
                <p>Live concerts, indie showcases, and rooftop acoustic sessions.</p>
              </div>
            </div>
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">✈️</span>
              <div class="feature-text">
                <strong>Trips &amp; Travel</strong>
                <p>Weekend getaways, hill station retreats, and adventure trail expeditions.</p>
              </div>
            </div>
            <div class="onboarding-feature-item">
              <span class="feature-icon" aria-hidden="true">⭐</span>
              <div class="feature-text">
                <strong>Activities &amp; Unique Experiences</strong>
                <p>Workshops, tasting sessions, and hand-crafted social encounters.</p>
              </div>
            </div>
          </div>
          <div class="onboarding-actions">
            <button type="button" class="btn btn-primary btn-lg btn-block" data-onboard-action="next-step" data-target-step="2">Get Started →</button>
          </div>
        </div>

        <!-- STEP 2: Age Eligibility -->
        <div class="onboarding-step-panel" data-step-panel="2" ${currentStep === 2 ? '' : 'hidden'}>
          <div class="onboarding-step-header">
            <span class="step-icon" aria-hidden="true">🔞</span>
            <h2 class="onboarding-step-title">Strictly 21+ Community</h2>
            <p class="muted">NIGHTLIFEZ is exclusively for adults aged 21 and over. We enforce strict age eligibility to maintain safety, licensed venue compliance, and mutual respect.</p>
          </div>
          <div class="onboarding-legal-card">
            <p><strong>Eligibility Statement:</strong></p>
            <p class="small muted">By confirming below, you declare that you are at least 21 years old on today's date. Self-declarations are legally binding under our platform Terms of Service. Anyone found to be under 21 will have their membership immediately revoked and tickets cancelled without refund.</p>
          </div>
          <form class="onboarding-form" data-step-form="2">
            <label class="check consent-check-row">
              <input type="checkbox" id="onboard-age-check" name="ageConfirmed" ${user?.age_confirmed_21 ? 'checked' : ''} required>
              <span><strong>I confirm that I am 21 years of age or older</strong> and agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/community-guidelines" target="_blank" rel="noopener">Community Guidelines</a>.</span>
            </label>
            <div class="onboarding-actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-onboard-action="reject-age">I am under 21</button>
              <button type="submit" class="btn btn-primary btn-lg" data-onboard-submit="2">Confirm &amp; Continue →</button>
            </div>
          </form>
          <div class="under-21-notice" data-under-21-notice hidden>
            <div class="notice-box error-box">
              <p><strong>Age Restriction:</strong> NIGHTLIFEZ is strictly for adults aged 21 and older. You cannot proceed at this time. We invite you to join us once you celebrate your 21st birthday!</p>
              <p><a class="btn btn-ghost btn-sm" href="/">Return to Home</a></p>
            </div>
          </div>
        </div>

        <!-- STEP 3: Basic Profile -->
        <div class="onboarding-step-panel" data-step-panel="3" ${currentStep === 3 ? '' : 'hidden'}>
          <div class="onboarding-step-header">
            <span class="step-icon" aria-hidden="true">👤</span>
            <h2 class="onboarding-step-title">Basic Profile</h2>
            <p class="muted">Tell us what to call you and where you're based. You can update this later in your settings.</p>
          </div>
          <form class="onboarding-form" data-step-form="3">
            <div class="field">
              <label for="onboard-display-name">Display Name <span class="required-indicator">*</span></label>
              <input type="text" id="onboard-display-name" name="displayName" value="${initialName}" placeholder="e.g. Maya or Arjun" minlength="1" maxlength="50" required autocomplete="name">
              <span class="field-hint">This is the name hosts and fellow attendees will see at events.</span>
            </div>
            <div class="field">
              <label for="onboard-gender">Gender <span class="required-indicator">*</span></label>
              <select id="onboard-gender" name="gender" required>
                <option value="">Select your gender</option>
                <option value="female" ${initialGender === 'female' ? 'selected' : ''}>Woman</option>
                <option value="male" ${initialGender === 'male' ? 'selected' : ''}>Man</option>
                <option value="non_binary" ${initialGender === 'non_binary' ? 'selected' : ''}>Non-binary</option>
                <option value="other" ${initialGender === 'other' ? 'selected' : ''}>Other</option>
                <option value="prefer_not_to_say" ${initialGender === 'prefer_not_to_say' ? 'selected' : ''}>Prefer not to say</option>
              </select>
              <span class="field-hint">Used for curated mixer balance. Selecting "Prefer not to say" is completely respected.</span>
            </div>
            <div class="field">
              <label for="onboard-city">City <span class="required-indicator">*</span></label>
              <select id="onboard-city" name="city" required>
                <option value="">Select your primary city</option>
                <optgroup label="Primary Hubs">
                  ${CITIES.filter((c) => c.marketTier === 'primary_market').map((c) => html`<option value="${c.name}" ${initialCity === c.name ? 'selected' : ''}>${c.name} (${c.state})</option>`)}
                </optgroup>
                <optgroup label="Expansion Cities">
                  ${CITIES.filter((c) => c.marketTier === 'expansion_market').map((c) => html`<option value="${c.name}" ${initialCity === c.name ? 'selected' : ''}>${c.name} (${c.state})</option>`)}
                </optgroup>
                <optgroup label="Getaway Hubs">
                  ${CITIES.filter((c) => c.marketTier === 'getaway_destination').map((c) => html`<option value="${c.name}" ${initialCity === c.name ? 'selected' : ''}>${c.name} (${c.state})</option>`)}
                </optgroup>
              </select>
            </div>
            <div class="onboarding-actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-onboard-action="prev-step" data-target-step="2">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg" data-onboard-submit="3">Save &amp; Continue →</button>
            </div>
          </form>
        </div>

        <!-- STEP 4: Interests -->
        <div class="onboarding-step-panel" data-step-panel="4" ${currentStep === 4 ? '' : 'hidden'}>
          <div class="onboarding-step-header">
            <span class="step-icon" aria-hidden="true">🎯</span>
            <h2 class="onboarding-step-title">What are you into?</h2>
            <p class="muted">Select at least one category to personalize your feed, invites, and secret venue reveals.</p>
          </div>
          <form class="onboarding-form" data-step-form="4">
            <div class="interests-grid" data-interests-grid>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="parties_nightlife">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🎉</span>
                  <span class="interest-chip-label">Parties &amp; Nightlife</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="music_concerts">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🎵</span>
                  <span class="interest-chip-label">Music &amp; Concerts</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="social_meetups">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">👋</span>
                  <span class="interest-chip-label">Social Meetups</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="dining_food">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🍽️</span>
                  <span class="interest-chip-label">Dining &amp; Food</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="travel_trips">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">✈️</span>
                  <span class="interest-chip-label">Travel &amp; Trips</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="adventure_outdoors">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🏔️</span>
                  <span class="interest-chip-label">Adventure &amp; Outdoors</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="fitness_sports">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">💪</span>
                  <span class="interest-chip-label">Fitness &amp; Sports</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="arts_culture">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🎭</span>
                  <span class="interest-chip-label">Arts &amp; Culture</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="networking_professional">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">🤝</span>
                  <span class="interest-chip-label">Networking</span>
                </span>
              </label>
              <label class="interest-chip-card">
                <input type="checkbox" name="interest" value="experiences_activities">
                <span class="interest-chip-body">
                  <span class="interest-chip-icon" aria-hidden="true">⭐</span>
                  <span class="interest-chip-label">Experiences &amp; Activities</span>
                </span>
              </label>
            </div>
            <div class="interests-counter" data-interests-counter>
              <span class="muted small">Please select at least 1 interest to continue.</span>
            </div>
            <div class="onboarding-actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-onboard-action="prev-step" data-target-step="3">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg" data-onboard-submit="4">Save Interests →</button>
            </div>
          </form>
        </div>

        <!-- STEP 5: Profile Completion (Optional Enhancements) -->
        <div class="onboarding-step-panel" data-step-panel="5" ${currentStep === 5 ? '' : 'hidden'}>
          <div class="onboarding-step-header">
            <span class="step-icon" aria-hidden="true">✨</span>
            <h2 class="onboarding-step-title">About You <span class="badge-optional">Optional</span></h2>
            <p class="muted">Add a short bio and languages you speak. You can always fill this in later.</p>
          </div>
          <form class="onboarding-form" data-step-form="5">
            <div class="field">
              <label for="onboard-bio">Short Introduction (Optional)</label>
              <textarea id="onboard-bio" name="bio" rows="3" maxlength="500" placeholder="A little about yourself, your vibe, or what kind of evenings you enjoy..."></textarea>
              <span class="field-hint">Max 500 characters. Visible to hosts reviewing private dinners and mixers.</span>
            </div>
            <div class="field">
              <label>Languages Spoken (Optional)</label>
              <div class="languages-chips-wrap" data-languages-wrap>
                ${['English', 'Tamil', 'Kannada', 'Malayalam', 'Hindi', 'Telugu'].map((lang) => html`
                  <label class="lang-chip">
                    <input type="checkbox" name="language" value="${lang}">
                    <span>${lang}</span>
                  </label>
                `)}
              </div>
            </div>
            <div class="onboarding-privacy-reassurance">
              <span class="privacy-icon" aria-hidden="true">🔒</span>
              <p class="small muted">We never share your phone number or authentication identifier with anyone. Your privacy is paramount.</p>
            </div>
            <div class="onboarding-actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-onboard-action="skip-optional">Skip for now</button>
              <button type="submit" class="btn btn-primary btn-lg" data-onboard-submit="5">Continue →</button>
            </div>
          </form>
        </div>

        <!-- STEP 6: Personalised Welcome & Completion -->
        <div class="onboarding-step-panel" data-step-panel="6" ${currentStep === 6 ? '' : 'hidden'}>
          <div class="onboarding-completion-hero">
            <div class="completion-badge-icon" aria-hidden="true">🎉</div>
            <h2 class="onboarding-title">You’re In!</h2>
            <p class="onboarding-subheading" data-welcome-subheading>Welcome to your NIGHTLIFEZ community.</p>
          </div>
          <div class="onboarding-summary-card" data-onboarding-summary>
            <h3>Your Member Pass is Active</h3>
            <p class="muted">You now have full access to South India’s premier social experiences platform.</p>
            <ul class="completion-perks-list">
              <li>✓ Instant reservation for parties, mixers &amp; dinners</li>
              <li>✓ Mystery venue unlock on confirmed bookings</li>
              <li>✓ Verified 21+ member badge</li>
              <li>✓ Secret group invites and host updates</li>
            </ul>
          </div>
          <div class="onboarding-actions">
            <button type="button" class="btn btn-primary btn-lg btn-block" data-onboard-action="finish-onboarding">Explore Experiences →</button>
          </div>
        </div>

      </div>

      <!-- Navigation & Help Footer -->
      <div class="onboarding-footer">
        <p class="muted small">Need assistance? <a href="/faq" target="_blank" rel="noopener">FAQ</a> · <a href="/trust-safety" target="_blank" rel="noopener">Trust &amp; Safety</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></p>
        <p class="muted small"><button type="button" class="link-button" data-signout>Sign out</button></p>
      </div>

    </div>
  </section>`;

  return layout({
    title: 'Member Onboarding',
    description: 'Complete your NIGHTLIFEZ profile to unlock social discovery, secret venues, and events.',
    path: '/onboarding',
    body,
    noindex: true
  });
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
