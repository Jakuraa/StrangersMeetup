// lib/views/layout.js - Document shell: SEO head, nav, footer.
import { html, raw, esc } from './html.js';
import { siteUrl, botUsername, livePayments, env } from '../config.js';
import { CITIES } from '../services/events.js';

export const INSTAGRAM_URL = 'https://www.instagram.com/nightlifez_/';
export const BRAND = 'NIGHTLIFEZ';
export const TAGLINE = 'Discover. Connect. Experience.';

const NAV = [
  ['Discover', '/#upcoming'],
  ['Nightlife', '/nightlife'],
  ['Dating & Matchmaking', '/dating'],
  ['Trips', '/trips'],
  ['List Your Venue', '/list-your-venue'],
  ['FAQ', '/faq']
];

function logo() {
  return html`<a class="logo" href="/">
    <svg class="logo-mark" viewBox="0 0 32 20" aria-hidden="true"><path d="M5 16V4l11 12V4l11 12V4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>NIGHT<span class="logo-soft">LIFEZ</span></span>
  </a>`;
}

function locationSelector() {
  return html`<div class="header-location" data-location-selector>
    <button type="button" class="loc-trigger-btn" data-loc-trigger aria-haspopup="dialog" aria-expanded="false">
      <svg class="loc-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
      <span class="loc-label" data-loc-current-label>All Cities</span>
      <svg class="chevron-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <select name="city" class="header-city-select-fallback" aria-label="Select City" data-header-city>
      <option value="">All Cities</option>
      ${CITIES.map((c) => html`<option value="${c.slug}">${c.name}</option>`)}
    </select>
  </div>`;
}

const CITY_ALIASES = {
  chennai: 'madras,maa,singara chennai',
  bengaluru: 'bangalore,blr,bengaluru urban,silicon valley',
  hyderabad: 'hyd,secunderabad,cyberabad',
  kochi: 'cochin,ernakulam,cok',
  coimbatore: 'kovai,cjb',
  puducherry: 'pondicherry,pondi,pondy,pny',
  mysuru: 'mysore,myq',
  mangaluru: 'mangalore,ixe,kudla',
  madurai: 'temple city,ixm',
  salem: 'sxv,mango city',
  tiruchirappalli: 'trichy,tiruchi,trz',
  trivandrum: 'thiruvananthapuram,trv',
  kozhikode: 'calicut,ccj',
  vijayawada: 'vga,bezawada',
  visakhapatnam: 'vizag,vtz,waltair',
  warangal: 'wgl,tri-city',
  guntur: 'gnt',
  'hubli-dharwad': 'hubballi,hbx',
  mumbai: 'bombay,bom,navi mumbai,thane',
  pune: 'poona,pnq,pimpri-chinchwad',
  ahmedabad: 'amdavad,amd,gandhinagar',
  surat: 'stv,diamond city',
  vadodara: 'baroda,bdq',
  goa: 'panaji,panjim,goi,north goa,south goa',
  nagpur: 'nag,orange city',
  nashik: 'nasik,isk,wine capital',
  rajkot: 'raj',
  kolhapur: 'klh',
  indore: 'idr,cleanest city',
  bhopal: 'bho,city of lakes',
  'delhi-ncr': 'delhi,new delhi,del,ncr,gurugram,gurgaon,noida,greater noida,ghaziabad,faridabad',
  gurugram: 'gurgaon,millennium city',
  noida: 'greater noida',
  chandigarh: 'ixc,mohali,panchkula,tricity',
  jaipur: 'jai,pink city',
  lucknow: 'lko,city of nawabs',
  dehradun: 'ded,doon',
  amritsar: 'atq,golden city',
  ludhiana: 'luh',
  jammu: 'ixj,city of temples',
  agra: 'agr,taj city',
  varanasi: 'banaras,kashi,vns',
  kanpur: 'knu,leather city',
  kolkata: 'calcutta,ccu,city of joy',
  bhubaneswar: 'bbi,bhubaneshwar,temple city',
  guwahati: 'gau,gauhati,gateway to northeast',
  patna: 'pat,pataliputra',
  ranchi: 'ixr,city of waterfalls',
  raipur: 'rpr'
};

function locationModal() {
  const primaryMarkets = CITIES.filter(c => c.marketTier === 'primary_market');
  const expansionMarkets = CITIES.filter(c => c.marketTier === 'expansion_market');
  const getawayMarkets = CITIES.filter(c => c.marketTier === 'getaway_destination');

  const renderCityBtn = (c) => html`<li><button type="button" class="loc-city-item" data-city-slug="${c.slug}" data-city-name="${c.name}" data-state="${c.state}" data-region="${c.region || ''}" data-aliases="${CITY_ALIASES[c.slug] || ''}"><span class="loc-city-title">${c.name}</span><span class="loc-city-sub">${c.state}</span></button></li>`;

  return html`<dialog class="location-dialog" data-location-dialog aria-labelledby="locDialogTitle">
    <div class="location-dialog-inner">
      <div class="loc-dialog-header">
        <div class="loc-title-wrap">
          <h2 id="locDialogTitle" class="loc-dialog-title">Select Location</h2>
          <p class="loc-dialog-subtitle">Find nightlife, parties and meetups near you</p>
        </div>
        <button type="button" class="loc-dialog-close" data-loc-close aria-label="Close location picker">✕</button>
      </div>

      <div class="loc-search-box">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" class="loc-search-input" data-loc-search placeholder="Search city or alias (e.g. Bangalore, Mumbai, Delhi, Kovai)…" autocomplete="off" aria-label="Search city or alias">
      </div>

      <div class="loc-device-action">
        <button type="button" class="btn btn-outline-cyan loc-gps-btn" data-loc-gps>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>
          <span>Use my current location</span>
        </button>
        <div class="loc-status-msg" data-loc-status aria-live="polite"></div>
      </div>

      <div class="loc-quick-picks">
        <span class="loc-section-label">Popular Hubs</span>
        <div class="loc-pills">
          <button type="button" class="loc-pill" data-city-slug="" data-city-name="All Cities">All Cities</button>
          <button type="button" class="loc-pill" data-city-slug="chennai" data-city-name="Chennai">Chennai</button>
          <button type="button" class="loc-pill" data-city-slug="bengaluru" data-city-name="Bengaluru">Bengaluru</button>
          <button type="button" class="loc-pill" data-city-slug="mumbai" data-city-name="Mumbai">Mumbai</button>
          <button type="button" class="loc-pill" data-city-slug="delhi-ncr" data-city-name="Delhi NCR">Delhi NCR</button>
          <button type="button" class="loc-pill" data-city-slug="hyderabad" data-city-name="Hyderabad">Hyderabad</button>
          <button type="button" class="loc-pill" data-city-slug="goa" data-city-name="Goa / Panaji">Goa</button>
          <button type="button" class="loc-pill" data-city-slug="pune" data-city-name="Pune">Pune</button>
          <button type="button" class="loc-pill" data-city-slug="kolkata" data-city-name="Kolkata">Kolkata</button>
        </div>
      </div>

      <div class="loc-state-filter">
        <label for="locStateFilterSelect" class="loc-section-label">Filter by Region</label>
        <select id="locStateFilterSelect" class="loc-state-select" data-loc-state-filter aria-label="Filter cities by region or state">
          <option value="">All Regions</option>
          <option value="South">South India</option>
          <option value="West">West India</option>
          <option value="North">North India</option>
          <option value="East">East India</option>
          <option value="Central">Central India</option>
          <option value="Tamil Nadu">Tamil Nadu</option>
          <option value="Karnataka">Karnataka</option>
          <option value="Kerala">Kerala</option>
          <option value="Maharashtra">Maharashtra</option>
          <option value="Delhi">Delhi NCR</option>
          <option value="Telangana">Telangana</option>
          <option value="Gujarat">Gujarat</option>
          <option value="West Bengal">West Bengal</option>
        </select>
      </div>

      <div class="loc-city-groups" data-loc-results tabindex="0" role="region" aria-label="Available cities">
        <div class="loc-tier-section" data-tier="primary_market">
          <h3 class="loc-tier-heading">Primary Markets</h3>
          <ul class="loc-city-list">
            ${primaryMarkets.map(renderCityBtn)}
          </ul>
        </div>

        <div class="loc-tier-section" data-tier="expansion_market">
          <h3 class="loc-tier-heading">Expansion Markets</h3>
          <ul class="loc-city-list">
            ${expansionMarkets.map(renderCityBtn)}
          </ul>
        </div>

        <div class="loc-tier-section" data-tier="getaway_destination">
          <h3 class="loc-tier-heading">Getaway Destinations</h3>
          <ul class="loc-city-list">
            ${getawayMarkets.map(renderCityBtn)}
          </ul>
        </div>
      </div>

      <div class="loc-empty-state" data-loc-empty hidden>
        <p>No cities matching your search.</p>
        <button type="button" class="btn btn-ghost btn-sm" data-loc-reset-search>Reset Search</button>
      </div>
    </div>
  </dialog>`;
}

function searchBar() {
  return html`<form class="header-search" action="/events" method="get" role="search">
    <svg class="search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="search" name="q" placeholder="Search events, parties, dinners…" aria-label="Search events" autocomplete="off">
  </form>`;
}

function nav(current, path = '') {
  if (path === '/onboarding') {
    return html`<header class="site-header site-header-focused">
      <div class="wrap header-inner">
        <div class="header-left">
          ${logo()}
        </div>
        <div class="header-actions">
          <span class="age-chip" title="Adults only">21+</span>
          <button type="button" class="btn btn-ghost btn-sm" data-signout aria-label="Sign out">Sign out</button>
        </div>
      </div>
    </header>`;
  }

  return html`<header class="site-header">
    <div class="wrap header-inner">
      <div class="header-left">
        ${logo()}
        ${locationSelector()}
      </div>
      <div class="header-center">
        ${searchBar()}
      </div>
      <div class="header-actions">
        <a class="btn btn-outline-cyan btn-sm header-list-cta" href="/organiser" aria-label="List Your Event">List Your Event</a>
        <span class="age-chip" title="Adults only">21+</span>
        <a class="btn btn-tg btn-sm header-auth" href="/signin" data-auth-button aria-label="Continue with Telegram">Continue with Telegram</a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Menu">
          <span></span><span></span>
        </button>
      </div>
      <nav class="nav" id="site-nav" aria-label="Main">
        <div class="mobile-cta-wrap">
          <a class="btn btn-primary btn-block" href="/organiser">✨ List Your Event</a>
        </div>
        <div class="mobile-search-wrap">
          ${searchBar()}
        </div>
        <div class="mobile-loc-wrap">
          ${locationSelector()}
        </div>
        <ul>
          <li><a href="/events"${current === '/events' ? raw(' aria-current="page"') : ''}>All Events</a></li>
          <li><a href="/weekend-parties"${current === '/weekend-parties' ? raw(' aria-current="page"') : ''}>Parties</a></li>
          <li><a href="/meetups"${current === '/meetups' ? raw(' aria-current="page"') : ''}>Meetups</a></li>
          <li><a href="/dinners"${current === '/dinners' ? raw(' aria-current="page"') : ''}>Dining</a></li>
          <li><a href="/trips"${current === '/trips' ? raw(' aria-current="page"') : ''}>Trips</a></li>
          <li><a href="/nightlife"${current === '/nightlife' ? raw(' aria-current="page"') : ''}>Nightlife</a></li>
          <li><a href="/dating"${current === '/dating' ? raw(' aria-current="page"') : ''}>Dating &amp; Matchmaking</a></li>
          <li><a href="/organiser"${current === '/organiser' ? raw(' aria-current="page"') : ''}>Organiser Portal</a></li>
          <li><a href="/become-a-host">Become a Host</a></li>
          <li><a href="/faq">FAQ</a></li>
          <li class="mobile-nav-user" data-nav-user-li hidden><span class="muted small">Signed in as </span><strong data-nav-user-name></strong></li>
          <li class="mobile-nav-bookings" data-nav-bookings-li hidden><a href="/me">🎟️ My Bookings &amp; Passes</a></li>
          <li class="mobile-nav-auth"><a href="/signin" data-nav-auth-link>Sign in with Telegram</a></li>
          <li class="mobile-nav-signout" data-nav-signout-li hidden><button type="button" class="btn btn-ghost btn-sm btn-block mobile-signout-btn" data-signout>Sign out</button></li>
        </ul>
      </nav>
    </div>
  </header>`;
}

function mobileBottomNav(current, path = '') {
  if (path === '/onboarding' || path === '/signin') return '';
  return html`<nav class="mobile-bottom-nav" data-bottom-nav aria-label="Mobile Quick Navigation">
    <a href="/" class="bottom-nav-item${current === '/' ? ' active' : ''}" aria-label="Home">
      <span class="bottom-nav-icon" aria-hidden="true">🏠</span>
      <span class="bottom-nav-label">Home</span>
    </a>
    <a href="/events" class="bottom-nav-item${current === '/events' ? ' active' : ''}" aria-label="Discover Events">
      <span class="bottom-nav-icon" aria-hidden="true">🔍</span>
      <span class="bottom-nav-label">Discover</span>
    </a>
    <a href="/weekend-parties" class="bottom-nav-item${current === '/weekend-parties' ? ' active' : ''}" aria-label="Parties">
      <span class="bottom-nav-icon" aria-hidden="true">🎉</span>
      <span class="bottom-nav-label">Parties</span>
    </a>
    <a href="/me" class="bottom-nav-item${current === '/me' ? ' active' : ''}" data-bottom-nav-me aria-label="Passes &amp; Bookings">
      <span class="bottom-nav-icon" aria-hidden="true">🎟️</span>
      <span class="bottom-nav-label">Passes</span>
    </a>
  </nav>`;
}

function footer() {
  const col = (title, links) => html`<div class="footer-col">
    <h2 class="footer-title">${title}</h2>
    <ul>${links.map(([l, h, ext]) => html`<li><a href="${h}"${ext ? raw(' target="_blank" rel="noopener"') : ''}>${l}</a></li>`)}</ul>
  </div>`;
  return html`<footer class="site-footer">
    <div class="wrap footer-grid">
      <div class="footer-brand">
        ${logo()}
        <p>A vibrant social discovery and experiences marketplace across South India. Discover events, meet new people, and explore nightlife. Adults 21+ only.</p>
      </div>
      ${col('Discover', [['All events', '/events'], ['Nightlife', '/nightlife'], ['Weekend parties', '/weekend-parties'], ['Dinners', '/dinners'], ['Meetups', '/meetups'], ['Dating & Matchmaking', '/dating'], ['Weekend trips', '/trips']])}
      ${col('Organisers', [['List Your Event', '/organiser'], ['Become a Host', '/become-a-host'], ['List Your Venue', '/list-your-venue'], ['Venue Dashboard', '/venue'], ['Partner With Us', '/partner-with-us']])}
      ${col('Information', [['FAQ', '/faq'], ['Trust & Safety', '/trust-safety'], ['Community Guidelines', '/community-guidelines'], ['Privacy', '/privacy'], ['Terms', '/terms'], ['Contact', '/contact']])}
    </div>
    <div class="wrap footer-base">
      <p>© ${new Date().getFullYear()} ${BRAND}. For adults 21 and over. <a href="${INSTAGRAM_URL}" target="_blank" rel="noopener">Follow @the.strangers.meetup on Instagram</a></p>
    </div>
  </footer>`;
}

/**
 * @param {object} o
 * @param {string} o.title       unique page title (without brand suffix)
 * @param {string} o.description meta description
 * @param {string} o.path        canonical path
 * @param {*}      o.body        SafeHtml main content
 * @param {*}      [o.head]      extra head html (JSON-LD etc.)
 * @param {boolean}[o.noindex]
 */
export function layout({ title, description, path, body, head = '', noindex = false, current = '', ogImage, bodyClass = '' }) {
  const base = siteUrl();
  const canonical = `${base}${path}`;
  const fullTitle = path === '/' ? `${BRAND} — ${title}` : `${title} · ${BRAND}`;
  const og = ogImage || `${base}/img/og.png`;
  const testMode = !livePayments();
  return `<!doctype html>${html`<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
${noindex ? raw('<meta name="robots" content="noindex, nofollow">') : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#090B16">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.json">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400&display=optional">
<link rel="stylesheet" href="/css/site.css?v=12">
${head}
</head>
<body class="${bodyClass}" data-bot="${botUsername()}" data-test-mode="${testMode ? '1' : '0'}">
<a class="skip" href="#main">Skip to content</a>
${nav(current, path)}
<main id="main">${body}</main>
${footer()}
${locationModal()}
${mobileBottomNav(current, path)}
<script src="/js/site.js?v=6" defer></script>
${process.env.VERCEL && env('DISABLE_WEB_ANALYTICS') !== 'true' ? raw('<script src="/_vercel/insights/script.js" defer></script>') : ''}
</body>
</html>`}`;
}

export function pageHeader(eyebrow, title, lede, wide = false) {
  return html`<section class="page-head">
    <div class="wrap${wide ? '' : ' narrow'}">
      ${eyebrow ? html`<p class="eyebrow">${eyebrow}</p>` : ''}
      <h1>${title}</h1>
      ${lede ? html`<p class="lede">${lede}</p>` : ''}
    </div>
  </section>`;
}

export { esc };
