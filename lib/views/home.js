// lib/views/home.js - Homepage in the order set by the launch brief.
import { html, raw, jsonLd } from './html.js';
import { layout, INSTAGRAM_URL } from './layout.js';
import { eventCard, emptyEvents, filters, faqList } from './components.js';
import { FAQ, HOW_STEPS } from './content.js';
import { siteUrl } from '../config.js';

// Words are wrapped server-side so the headline can rise in word by word; it reads normally without JS.
function splitWords(text) {
  return text.split(' ').map((w, i) => html`<span class="w"><span style="--i:${i}">${w}</span></span> `);
}

function cinemaHero() {
  // Non-photo composition: two lights drifting into overlap — strangers becoming acquaintances.
  return html`<section class="cine-hero" data-cine-hero>
    <div class="cine-stage" aria-hidden="true">
      <div class="cine-orb cine-orb-a"></div>
      <div class="cine-orb cine-orb-b"></div>
      <div class="cine-lens"></div>
      <div class="cine-grain"></div>
      <div class="cine-vignette"></div>
    </div>
    <div class="cine-bar cine-bar-top" aria-hidden="true"></div>
    <div class="cine-bar cine-bar-bottom" aria-hidden="true"></div>
    <div class="wrap cine-copy">
      <p class="eyebrow cine-eyebrow">Meetups · Dinners · Nightlife · Trips · 21+</p>
      <h1 class="cine-title">${splitWords('Your next favourite people are still strangers.')}</h1>
      <p class="lede cine-lede">Small, hosted evenings and weekend trips across South India, designed so that walking in alone feels easy.</p>
      <div class="hero-cta cine-cta">
        <a class="btn btn-light btn-lg" href="/signin" data-auth-button>Continue with Telegram</a>
        <a class="btn btn-outline-light btn-lg" href="#upcoming">Explore upcoming meetups</a>
      </div>
    </div>
    <a class="cine-cue" href="#scenes" aria-label="Scroll to how an evening unfolds"><span></span></a>
  </section>`;
}

// How an evening unfolds — describes the format, not any specific event or outcome.
const SCENES = [
  ['01', 'You arrive alone', 'Come solo. Evenings are designed for first-timers, so you never need a plus-one.'],
  ['02', 'Someone is hosting', 'A host runs the evening — dinners, games, mixers — so the first conversation is never on you.'],
  ['03', 'One table, a few hours', 'Small groups, a few unhurried hours, room to talk. Strangers start to overlap.'],
  ['04', 'The group chat keeps going', 'Confirmed guests get a one-time invite to the event’s private Telegram group. The next plan can start there.']
];

function scenes() {
  return html`<section class="scenes" id="scenes" data-scenes aria-labelledby="scenes-title">
    <div class="scenes-sticky">
      <div class="scenes-visual" aria-hidden="true">
        <span class="sv sv-a"></span><span class="sv sv-b"></span>
        <span class="sv sv-c"></span><span class="sv sv-d"></span><span class="sv sv-e"></span>
      </div>
      <div class="wrap scenes-inner">
        <p class="eyebrow">How an evening unfolds</p>
        <h2 id="scenes-title" class="visually-hidden">How an evening unfolds</h2>
        <ol class="scene-list">
          ${SCENES.map(([n, t, d], i) => html`<li class="scene" data-scene="${i}">
            <span class="scene-n">Scene ${n}</span>
            <h3>${t}</h3>
            <p>${d}</p>
          </li>`)}
        </ol>
        <div class="scene-progress" aria-hidden="true">${SCENES.map(() => html`<span></span>`)}</div>
      </div>
    </div>
  </section>`;
}

const REEL = ['Dinner clubs', 'Nightlife', 'Dating mixers', 'Weekend trips', 'Board-game evenings', 'Movie nights', 'Resort getaways'];

function reel() {
  const items = REEL.map((r) => html`<li>${r}</li>`);
  return html`<div class="reel" aria-label="Event formats">
    <ul class="reel-track">${items}</ul>
    <ul class="reel-track" aria-hidden="true">${items}</ul>
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
  ${cinemaHero()}
  ${scenes()}
  ${reel()}

  <section class="section" id="upcoming">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">Upcoming experiences</p>
        <h2>Pick an evening</h2>
      </div>
      ${filters(filter)}
      ${events.length
        ? html`<div class="card-grid stagger">${events.map(eventCard)}</div>`
        : emptyEvents(filtered ? 'Nothing matches those filters yet.' : 'No upcoming experiences are listed right now.')}
    </div>
  </section>

  <section class="section section-alt" id="how-it-works">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">How it works</p>
        <h2>From browsing to the group chat in five steps</h2>
      </div>
      <ol class="steps stagger">
        ${HOW_STEPS.map(([t, d], i) => html`<li class="step"><span class="step-n">${i + 1}</span><h3>${t}</h3><p>${d}</p></li>`)}
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
      ${trips.length ? html`<div class="card-grid stagger">${trips.map(eventCard)}</div>` : emptyEvents('No trips are listed right now.')}
    </div>
  </section>

  <section class="section" id="membership">
    <div class="wrap">
      <div class="section-head reveal">
        <p class="eyebrow">Access Meetup</p>
        <h2>Membership</h2>
        <p class="muted">${tiers.some((t) => t.provider === 'superprofile')
          ? 'Optional. Checkout and private Telegram group access are handled by SuperProfile.'
          : 'Optional. Paid with Telegram Stars inside Telegram, renews every 30 days, cancel any time in Telegram.'} <a href="/membership">How membership works</a></p>
      </div>
      <div class="tiers stagger">
        ${tiers.map((t) => html`<article class="tier">
          <h3>${t.name}</h3>
          <p class="tier-price">${t.priceLabel}</p>
          <ul>${t.benefits.map((b) => html`<li>${b}</li>`)}</ul>
          ${t.purchasable && t.provider === 'superprofile'
            ? html`<a class="btn btn-primary" href="${t.superprofileUrl}" rel="noopener" data-web-only data-membership-click="${t.code}">Join on SuperProfile</a>`
            : t.purchasable
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
    current: '/#upcoming',
    bodyClass: 'home-cinema'
  });
}
