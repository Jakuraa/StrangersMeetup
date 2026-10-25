// lib/views/home.js - Homepage in the order set by the launch brief.
import { html, raw, jsonLd } from './html.js';
import { layout, INSTAGRAM_URL } from './layout.js';
import { eventCard, emptyEvents, filters, faqList } from './components.js';
import { FAQ, HOW_STEPS } from './content.js';
import { siteUrl } from '../config.js';

function heroArt() {
  // Non-photo composition: two circles drifting into overlap — strangers becoming acquaintances.
  return html`<div class="hero-art" aria-hidden="true">
    <svg viewBox="0 0 400 320">
      <circle class="ha ha-1" cx="150" cy="160" r="110"/>
      <circle class="ha ha-2" cx="250" cy="160" r="110"/>
      <path class="ha-lens" d="M200 68 A110 110 0 0 1 200 252 A110 110 0 0 1 200 68Z"/>
    </svg>
  </div>`;
}

export function renderHome({ events, trips, tiers, proof, media, filter }) {
  const filtered = Boolean(filter.city || filter.category || filter.when);
  const proofBlock = proof || media.length
    ? html`<section class="section" id="community">
        <div class="wrap">
          <div class="section-head reveal">
            <p class="eyebrow">Community</p>
            <h2>From people who came along</h2>
          </div>
          ${proof ? html`<p class="proof-stat reveal"><strong>${proof.confirmedBookings.toLocaleString('en-IN')}</strong> confirmed bookings so far.</p>` : ''}
          ${media.length ? html`<div class="media-grid">${media.map((m) => m.type === 'review'
            ? html`<blockquote class="quote reveal"><p>${m.caption}</p>${m.author_alias ? html`<cite>${m.author_alias}</cite>` : ''}</blockquote>`
            : m.type === 'photo' && m.url
              ? html`<figure class="media reveal"><img src="${m.url}" alt="${m.caption || ''}" loading="lazy">${m.caption ? html`<figcaption>${m.caption}</figcaption>` : ''}</figure>`
              : '')}</div>` : ''}
          <p class="reveal"><a class="link-arrow" href="${INSTAGRAM_URL}" target="_blank" rel="noopener">Follow @the.strangers.meetup on Instagram</a></p>
        </div>
      </section>`
    : html`<section class="section section-tight" id="community">
        <div class="wrap center reveal">
          <p class="muted">Follow along on Instagram: <a href="${INSTAGRAM_URL}" target="_blank" rel="noopener">@the.strangers.meetup</a></p>
        </div>
      </section>`;

  const body = html`
  <section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">Meetups · Dinners · Trips · 21+</p>
        <h1>Your next favourite people are still strangers.</h1>
        <p class="lede">Small, hosted evenings and weekend trips across South India, designed so that walking in alone feels easy.</p>
        <div class="hero-cta">
          <a class="btn btn-tg btn-lg" href="/signin" data-auth-button>Continue with Telegram</a>
          <a class="btn btn-ghost btn-lg" href="#upcoming">Explore upcoming meetups</a>
        </div>
      </div>
      ${heroArt()}
    </div>
  </section>

  <section class="section" id="upcoming">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">Upcoming experiences</p>
        <h2>Pick an evening</h2>
      </div>
      ${filters(filter)}
      ${events.length
        ? html`<div class="card-grid">${events.map(eventCard)}</div>`
        : emptyEvents(filtered ? 'Nothing matches those filters yet.' : 'No upcoming experiences are listed right now.')}
    </div>
  </section>

  <section class="section section-alt" id="how-it-works">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">How it works</p>
        <h2>From browsing to the group chat in five steps</h2>
      </div>
      <ol class="steps">
        ${HOW_STEPS.map(([t, d], i) => html`<li class="step reveal"><span class="step-n">${i + 1}</span><h3>${t}</h3><p>${d}</p></li>`)}
      </ol>
      <p class="note reveal">For events marked “venue shared after booking”, the exact venue is shared inside the private Telegram group after booking, to protect attendee privacy.</p>
    </div>
  </section>

  <section class="section" id="dating">
    <div class="wrap split">
      <div class="reveal">
        <p class="eyebrow">Dating &amp; matchmaking</p>
        <h2>Introductions that start with consent</h2>
        <p>Our dating mixers are hosted, in-person evenings with short one-to-one conversations and an open social hour. Nobody’s contact details are shared unless both people want that.</p>
        <a class="link-arrow" href="/dating">How dating events work</a>
      </div>
      <ul class="soon-list reveal">
        <li><strong>Hosted dating mixers</strong><span>Available — see upcoming events</span></li>
        <li><strong>Mutual, opt-in introductions after an event</strong><span class="soon">Coming soon</span></li>
        <li><strong>Small curated matchmaking dinners</strong><span class="soon">Coming soon</span></li>
      </ul>
    </div>
  </section>

  <section class="section section-alt" id="trips">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">Trips</p>
        <h2>Weekend trips and resort getaways</h2>
        <p class="muted">Each trip lists what is included, what is not, and its refund policy.</p>
      </div>
      ${trips.length ? html`<div class="card-grid">${trips.map(eventCard)}</div>` : emptyEvents('No trips are listed right now.')}
    </div>
  </section>

  <section class="section" id="membership">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">Access Meetup</p>
        <h2>Membership</h2>
        <p class="muted">Optional. Paid with Telegram Stars inside Telegram, renews every 30 days, cancel any time in Telegram.</p>
      </div>
      <div class="tiers">
        ${tiers.map((t) => html`<article class="tier reveal">
          <h3>${t.name}</h3>
          <p class="tier-price">${t.priceLabel}</p>
          <ul>${t.benefits.map((b) => html`<li>${b}</li>`)}</ul>
          ${t.purchasable
            ? html`<button class="btn btn-primary" type="button" data-join-tier="${t.code}">Join with Telegram Stars</button>`
            : html`<button class="btn btn-ghost" type="button" disabled>Announcing soon</button>`}
        </article>`)}
      </div>
    </div>
  </section>

  ${proofBlock}

  <section class="section section-tight">
    <div class="wrap center reveal">
      <p class="tagline">Affordable strangers meetups across South India.</p>
    </div>
  </section>

  <section class="section section-alt" id="faq">
    <div class="wrap narrow">
      <div class="section-head reveal">
        <p class="eyebrow">FAQ</p>
        <h2>Questions, answered</h2>
      </div>
      ${faqList(FAQ)}
      <p class="note"><a class="link-arrow" href="/trust-safety">Trust &amp; Safety, and how to report</a></p>
    </div>
  </section>`;

  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'StrangersMeetup',
    url: siteUrl(),
    sameAs: [INSTAGRAM_URL]
  };

  return layout({
    title: 'Meetups, dinners & trips for adults in South India',
    description: 'Small hosted meetups, dinner clubs, dating mixers and weekend trips for adults 21+ in Chennai, Bengaluru, Coimbatore, Kochi and Puducherry. Book with Telegram.',
    path: '/',
    body,
    head: raw(`${jsonLd(org)}`),
    current: '/#upcoming'
  });
}
