// lib/views/layout.js - Document shell: SEO head, nav, footer.
import { html, raw, esc } from './html.js';
import { siteUrl, botUsername, livePayments, env } from '../config.js';

export const INSTAGRAM_URL = 'https://www.instagram.com/the.strangers.meetup/';
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
      <option value="chennai">Chennai</option>
      <option value="bengaluru">Bengaluru</option>
      <option value="coimbatore">Coimbatore</option>
      <option value="kochi">Kochi</option>
      <option value="puducherry">Puducherry</option>
      <option value="mysuru">Mysuru</option>
      <option value="mangaluru">Mangaluru</option>
      <option value="madurai">Madurai</option>
      <option value="salem">Salem</option>
      <option value="tiruchirappalli">Tiruchirappalli</option>
      <option value="thiruvananthapuram">Thiruvananthapuram</option>
      <option value="kozhikode">Kozhikode</option>
      <option value="ooty">Ooty</option>
      <option value="kodaikanal">Kodaikanal</option>
      <option value="coorg">Coorg</option>
      <option value="gokarna">Gokarna</option>
      <option value="chikmagalur">Chikmagalur</option>
      <option value="varkala">Varkala</option>
      <option value="wayanad">Wayanad</option>
    </select>
  </div>`;
}

function locationModal() {
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
        <input type="search" class="loc-search-input" data-loc-search placeholder="Search city or alias (e.g. Bangalore, Kovai, Trichy)…" autocomplete="off" aria-label="Search city or alias">
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
          <button type="button" class="loc-pill" data-city-slug="coimbatore" data-city-name="Coimbatore">Coimbatore</button>
          <button type="button" class="loc-pill" data-city-slug="kochi" data-city-name="Kochi">Kochi</button>
          <button type="button" class="loc-pill" data-city-slug="puducherry" data-city-name="Puducherry">Puducherry</button>
        </div>
      </div>

      <div class="loc-state-filter">
        <label for="locStateFilterSelect" class="loc-section-label">Filter by Region</label>
        <select id="locStateFilterSelect" class="loc-state-select" data-loc-state-filter aria-label="Filter cities by state">
          <option value="">All Regions</option>
          <option value="Tamil Nadu">Tamil Nadu</option>
          <option value="Karnataka">Karnataka</option>
          <option value="Kerala">Kerala</option>
          <option value="Puducherry">Puducherry</option>
        </select>
      </div>

      <div class="loc-city-groups" data-loc-results tabindex="0" role="region" aria-label="Available cities">
        <div class="loc-tier-section" data-tier="primary_market">
          <h3 class="loc-tier-heading">Primary Markets</h3>
          <ul class="loc-city-list">
            <li><button type="button" class="loc-city-item" data-city-slug="chennai" data-city-name="Chennai" data-state="Tamil Nadu" data-aliases="madras,maa,singara chennai"><span class="loc-city-title">Chennai</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="bengaluru" data-city-name="Bengaluru" data-state="Karnataka" data-aliases="bangalore,blr,bengaluru urban,silicon valley"><span class="loc-city-title">Bengaluru</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="coimbatore" data-city-name="Coimbatore" data-state="Tamil Nadu" data-aliases="kovai,cjb"><span class="loc-city-title">Coimbatore</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="kochi" data-city-name="Kochi" data-state="Kerala" data-aliases="cochin,ernakulam,cok"><span class="loc-city-title">Kochi</span><span class="loc-city-sub">Kerala</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="puducherry" data-city-name="Puducherry" data-state="Puducherry" data-aliases="pondicherry,pondi,pondy,pny"><span class="loc-city-title">Puducherry</span><span class="loc-city-sub">Union Territory</span></button></li>
          </ul>
        </div>

        <div class="loc-tier-section" data-tier="expansion_market">
          <h3 class="loc-tier-heading">Expansion Markets</h3>
          <ul class="loc-city-list">
            <li><button type="button" class="loc-city-item" data-city-slug="mysuru" data-city-name="Mysuru" data-state="Karnataka" data-aliases="mysore,myq"><span class="loc-city-title">Mysuru</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="mangaluru" data-city-name="Mangaluru" data-state="Karnataka" data-aliases="mangalore,ixe,kudla"><span class="loc-city-title">Mangaluru</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="madurai" data-city-name="Madurai" data-state="Tamil Nadu" data-aliases="temple city,ixm"><span class="loc-city-title">Madurai</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="salem" data-city-name="Salem" data-state="Tamil Nadu" data-aliases="sxv,mango city"><span class="loc-city-title">Salem</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="tiruchirappalli" data-city-name="Tiruchirappalli" data-state="Tamil Nadu" data-aliases="trichy,tiruchi,trz"><span class="loc-city-title">Tiruchirappalli</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="thiruvananthapuram" data-city-name="Thiruvananthapuram" data-state="Kerala" data-aliases="trivandrum,trv"><span class="loc-city-title">Thiruvananthapuram</span><span class="loc-city-sub">Kerala</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="kozhikode" data-city-name="Kozhikode" data-state="Kerala" data-aliases="calicut,ccj"><span class="loc-city-title">Kozhikode</span><span class="loc-city-sub">Kerala</span></button></li>
          </ul>
        </div>

        <div class="loc-tier-section" data-tier="getaway_destination">
          <h3 class="loc-tier-heading">Getaway Destinations</h3>
          <ul class="loc-city-list">
            <li><button type="button" class="loc-city-item" data-city-slug="ooty" data-city-name="Ooty" data-state="Tamil Nadu" data-aliases="udhagamandalam,udhagai,nilgiris"><span class="loc-city-title">Ooty</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="kodaikanal" data-city-name="Kodaikanal" data-state="Tamil Nadu" data-aliases="kodai,princess of hill stations"><span class="loc-city-title">Kodaikanal</span><span class="loc-city-sub">Tamil Nadu</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="coorg" data-city-name="Coorg" data-state="Karnataka" data-aliases="kodagu,madikeri"><span class="loc-city-title">Coorg</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="gokarna" data-city-name="Gokarna" data-state="Karnataka" data-aliases="om beach,gokarn"><span class="loc-city-title">Gokarna</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="chikmagalur" data-city-name="Chikmagalur" data-state="Karnataka" data-aliases="chikkamagaluru,coffee land"><span class="loc-city-title">Chikmagalur</span><span class="loc-city-sub">Karnataka</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="varkala" data-city-name="Varkala" data-state="Kerala" data-aliases="varkala cliff,papanasam"><span class="loc-city-title">Varkala</span><span class="loc-city-sub">Kerala</span></button></li>
            <li><button type="button" class="loc-city-item" data-city-slug="wayanad" data-city-name="Wayanad" data-state="Kerala" data-aliases="kalpetta,sulthan bathery"><span class="loc-city-title">Wayanad</span><span class="loc-city-sub">Kerala</span></button></li>
          </ul>
        </div>
        <div class="loc-empty-state" data-loc-empty hidden>
          <p>No matching cities found.</p>
          <button type="button" class="btn btn-ghost btn-sm" data-loc-reset-search>Clear filter</button>
        </div>
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

function nav(current) {
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
          <li><a href="/nightlife"${current === '/nightlife' ? raw(' aria-current="page"') : ''}>Nightlife</a></li>
          <li><a href="/dating"${current === '/dating' ? raw(' aria-current="page"') : ''}>Dating &amp; Matchmaking</a></li>
          <li><a href="/trips"${current === '/trips' ? raw(' aria-current="page"') : ''}>Trips</a></li>
          <li><a href="/organiser"${current === '/organiser' ? raw(' aria-current="page"') : ''}>Organiser Portal</a></li>
          <li><a href="/become-a-host">Become a Host</a></li>
          <li><a href="/faq">FAQ</a></li>
          <li class="mobile-nav-auth"><a href="/signin" data-nav-auth-link>Sign in with Telegram</a></li>
        </ul>
      </nav>
    </div>
  </header>`;
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
${nav(current)}
<main id="main">${body}</main>
${footer()}
${locationModal()}
<script src="/js/site.js?v=5" defer></script>
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
