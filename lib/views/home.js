// lib/views/home.js - Discovery-first event homepage inspired by BookMyShow.
import { html, raw, jsonLd } from './html.js';
import { layout, INSTAGRAM_URL } from './layout.js';
import { eventCard, emptyEvents, filters } from './components.js';
import { siteUrl } from '../config.js';

function categoryNav(activeCat = '') {
  const items = [
    { label: 'All Events', icon: '🎉', href: '/events', cat: '' },
    { label: 'Parties', icon: '🪩', href: '/events?category=weekend_party', cat: 'weekend_party' },
    { label: 'Nightlife', icon: '🍸', href: '/nightlife', cat: 'nightlife' },
    { label: 'Social Meetups', icon: '👥', href: '/events?category=meetup', cat: 'meetup' },
    { label: 'Music', icon: '🎵', href: '/events?category=nightlife', cat: 'music' },
    { label: 'Dining', icon: '🍷', href: '/events?category=dinner_club', cat: 'dinner_club' },
    { label: 'Trips', icon: '🎒', href: '/trips', cat: 'weekend_trip' },
    { label: 'Experiences', icon: '✨', href: '/events?category=workshop', cat: 'workshop' }
  ];
  return html`<nav class="cat-bar" aria-label="Event Categories">
    <div class="wrap cat-bar-inner">
      <ul class="cat-bar-list">
        ${items.map((it) => html`<li><a class="cat-pill${activeCat === it.cat ? ' active' : ''}" href="${it.href}"><span class="cat-icon" aria-hidden="true">${it.icon}</span> <span>${it.label}</span></a></li>`)}
      </ul>
    </div>
  </nav>`;
}

function promoCarousel() {
  const slides = [
    {
      badge: 'Trending This Weekend',
      title: "South India's Hottest Weekend Parties & Nightlife",
      sub: 'Curated crowds · Secret venues · Solo-friendly dance floors & cocktail lounges',
      cta: 'Explore Parties',
      href: '/events?category=weekend_party',
      theme: 'theme-nightlife'
    },
    {
      badge: 'Curated Getaways',
      title: 'Camp, Trek & Connect: Strangers Weekend Trips',
      sub: 'Scenic mountain getaways, sunrise treks, and shared road trips across South India',
      cta: 'Explore Trips',
      href: '/trips',
      theme: 'theme-trips'
    },
    {
      badge: 'Reserved Tables',
      title: 'Curated Dinner Clubs & Social Mixers',
      sub: 'One reserved table, good food, and zero awkwardness. Meet 8–12 new people over dinner',
      cta: 'Find a Table',
      href: '/events?category=dinner_club',
      theme: 'theme-dining'
    }
  ];

  return html`<section class="promo-carousel" data-promo-carousel aria-label="Featured Experiences">
    <div class="wrap promo-wrap">
      <div class="carousel-container">
        <div class="carousel-track" data-carousel-track>
          ${slides.map((s, i) => html`<div class="carousel-slide ${s.theme}${i === 0 ? ' is-active' : ''}" data-slide="${i}">
            <div class="slide-overlay" aria-hidden="true"></div>
            <div class="slide-content">
              <span class="slide-badge">${s.badge}</span>
              <h2 class="slide-title">${s.title}</h2>
              <p class="slide-sub">${s.sub}</p>
              <div class="slide-actions">
                <a class="btn btn-primary btn-lg" href="${s.href}">${s.cta}</a>
                <a class="btn btn-ghost btn-lg" href="/events">Explore All Events</a>
              </div>
            </div>
          </div>`)}
        </div>
        <div class="carousel-controls" aria-label="Carousel navigation">
          <button class="carousel-btn prev" type="button" data-carousel-prev aria-label="Previous slide">‹</button>
          <div class="carousel-dots" data-carousel-dots>
            ${slides.map((_, i) => html`<button class="dot${i === 0 ? ' active' : ''}" type="button" data-carousel-dot="${i}" aria-label="Slide ${i + 1}"></button>`)}
          </div>
          <button class="carousel-btn next" type="button" data-carousel-next aria-label="Next slide">›</button>
        </div>
      </div>
    </div>
  </section>`;
}

function discoveryShelf({ id, title, icon, items, seeAllHref, emptyMessage = '' }) {
  if (!items.length && !emptyMessage) return '';
  return html`<section class="discovery-shelf" id="${id}">
    <div class="wrap">
      <div class="shelf-header">
        <div class="shelf-heading">
          <span class="shelf-icon" aria-hidden="true">${icon}</span>
          <h2>${title}</h2>
        </div>
        <a class="shelf-see-all" href="${seeAllHref}">See All <span aria-hidden="true">→</span></a>
      </div>
      ${items.length
        ? html`<div class="shelf-grid">${items.slice(0, 4).map(eventCard)}</div>`
        : html`<div class="shelf-empty"><p class="muted">${emptyMessage || 'New experiences dropping soon. Check back shortly.'}</p><a class="btn btn-ghost btn-sm" href="${seeAllHref}">Browse all</a></div>`}
    </div>
  </section>`;
}

export function renderHome({ events = [], trips = [], tiers = [], proof = null, media = [], filter = {} }) {
  const filtered = Boolean(filter.city || filter.category || filter.when);
  const allEvents = [...events];

  // Helper partition filters
  const trending = allEvents.filter((e) => e.state === 'open' || e.state === 'external').slice(0, 4);
  const now = Date.now();
  const next7Days = now + 7 * 86400000;
  const weekend = allEvents.filter((e) => {
    const t = new Date(e.startAt).getTime();
    const day = new Date(e.startAt).getDay(); // 0 is Sun, 5 is Fri, 6 is Sat
    return t >= now && t <= next7Days && (day === 0 || day === 5 || day === 6);
  });
  const parties = allEvents.filter((e) => e.category === 'nightlife' || e.category === 'weekend_party');
  const meetups = allEvents.filter((e) => ['meetup', 'board_games', 'movie'].includes(e.category));
  const mixers = allEvents.filter((e) => ['dating_mixer', 'matchmaking'].includes(e.category));
  const dining = allEvents.filter((e) => ['dinner_club', 'workshop', 'networking'].includes(e.category));
  const tripsList = trips.length ? trips : allEvents.filter((e) => ['weekend_trip', 'resort_getaway'].includes(e.category));

  const hasAnyEvents = allEvents.length > 0 || tripsList.length > 0;

  const proofBlock = proof || media.length
    ? html`<section class="section section-tight" id="community">
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
        </div>
      </section>`
    : '';

  // Minimal membership block to preserve test invariant for unseeded tier display
  const tierBlock = tiers.length
    ? html`<section class="section section-tight" id="membership">
        <div class="wrap">
          <div class="section-head reveal">
            <p class="eyebrow">Membership</p>
            <h2>Access Meetup Circle</h2>
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
      </section>`
    : '';

  const body = html`
    ${categoryNav(filter.category || '')}
    ${promoCarousel()}

    ${filtered ? html`<section class="filter-summary"><div class="wrap"><div class="filter-bar">${filters(filter, '/')}</div></div></section>` : ''}

    ${hasAnyEvents ? html`
      ${discoveryShelf({
        id: 'trending',
        title: filter.cityName ? `Trending in ${filter.cityName}` : 'Trending Near You',
        icon: '🔥',
        items: trending.length ? trending : allEvents.slice(0, 4),
        seeAllHref: '/events',
        emptyMessage: 'No trending events listed right now.'
      })}

      ${discoveryShelf({
        id: 'this-weekend',
        title: 'This Weekend',
        icon: '⚡',
        items: weekend.length ? weekend : allEvents.slice(0, 4),
        seeAllHref: '/events?when=week',
        emptyMessage: 'Weekend events will be posted Wednesday by 6 PM.'
      })}

      ${discoveryShelf({
        id: 'parties-nightlife',
        title: 'Parties & Nightlife',
        icon: '🪩',
        items: parties,
        seeAllHref: '/nightlife',
        emptyMessage: 'Next party announcing soon. Stay tuned.'
      })}

      ${discoveryShelf({
        id: 'meet-people',
        title: 'Meet New People',
        icon: '👥',
        items: meetups,
        seeAllHref: '/events?category=meetup',
        emptyMessage: 'Casual social meetups and game nights coming up.'
      })}

      ${discoveryShelf({
        id: 'social-mixers',
        title: 'Social Mixers & Dating',
        icon: '❤️',
        items: mixers,
        seeAllHref: '/dating',
        emptyMessage: 'Hosted dating mixers and introductions coming soon.'
      })}

      ${discoveryShelf({
        id: 'dining-experiences',
        title: 'Dining & Experiences',
        icon: '🍷',
        items: dining,
        seeAllHref: '/events?category=dinner_club',
        emptyMessage: 'Dinner club tables and culinary experiences announced weekly.'
      })}

      ${discoveryShelf({
        id: 'weekend-trips',
        title: 'Weekend Trips & Escapes',
        icon: '🎒',
        items: tripsList,
        seeAllHref: '/trips',
        emptyMessage: 'Upcoming camping treks and resort getaways in planning.'
      })}
    ` : html`
      <section class="section">
        <div class="wrap">
          ${emptyEvents(filtered ? 'Nothing matches those filters yet.' : 'No upcoming experiences are listed right now.')}
        </div>
      </section>
    `}

    ${proofBlock}
    ${tierBlock}
  `;

  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'StrangersMeetup',
    url: siteUrl(),
    sameAs: [INSTAGRAM_URL]
  };

  return layout({
    title: 'Events, Parties, Meetups & Trips in South India',
    description: 'Discover South India’s best parties, nightlife, curated dinners, social mixers and weekend trips for adults 21+. Book with Telegram.',
    path: '/',
    body,
    head: raw(`${jsonLd(org)}`),
    current: '/',
    bodyClass: 'home-discovery'
  });
}
