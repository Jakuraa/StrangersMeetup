// lib/views/layout.js - Document shell: SEO head, nav, footer.
import { html, raw, esc } from './html.js';
import { siteUrl, botUsername, livePayments, env } from '../config.js';

export const INSTAGRAM_URL = 'https://www.instagram.com/the.strangers.meetup/';
export const BRAND = 'StrangersMeetup';

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
    <svg class="logo-mark" viewBox="0 0 32 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/><circle cx="22" cy="10" r="8.5"/></svg>
    <span>Strangers<span class="logo-soft">Meetup</span></span>
  </a>`;
}

function locationSelector() {
  return html`<div class="header-location" data-location-selector>
    <svg class="loc-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    <select name="city" id="headerCitySelect" aria-label="Select City" data-header-city>
      <option value="">All Cities</option>
      <option value="chennai">Chennai</option>
      <option value="bengaluru">Bengaluru</option>
      <option value="coimbatore">Coimbatore</option>
      <option value="kochi">Kochi</option>
      <option value="puducherry">Puducherry</option>
    </select>
  </div>`;
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
        <p>Curated social meetups, nightlife, mixers, dinners and trips across South India. Adults 21+ only.</p>
      </div>
      ${col('Discover', [['All events', '/events'], ['Nightlife', '/nightlife'], ['Weekend parties', '/weekend-parties'], ['Dinners', '/dinners'], ['Meetups', '/meetups'], ['Dating & Matchmaking', '/dating'], ['Strangers trips', '/trips']])}
      ${col('Organisers', [['List Your Event', '/organiser'], ['Become a Host', '/become-a-host'], ['List Your Venue', '/list-your-venue'], ['Partner With Us', '/partner-with-us']])}
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
