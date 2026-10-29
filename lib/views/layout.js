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

function nav(current) {
  return html`<header class="site-header">
    <div class="wrap header-inner">
      ${logo()}
      <nav class="nav" id="site-nav" aria-label="Main">
        <ul>
          ${NAV.map(([label, href]) => html`<li><a href="${href}"${current === href ? raw(' aria-current="page"') : ''}>${label}</a></li>`)}
        </ul>
      </nav>
      <div class="header-actions">
        <span class="age-chip" title="Adults only">21+</span>
        <a class="btn btn-tg btn-sm header-auth" href="/signin" data-auth-button aria-label="Continue with Telegram">Continue with Telegram</a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Menu">
          <span></span><span></span>
        </button>
      </div>
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
        <p>Affordable strangers meetups across South India. Adults 21+ in Tamil Nadu, Puducherry, Karnataka and Kerala.</p>
      </div>
      ${col('Discover', [['All events', '/events'], ['Nightlife', '/nightlife'], ['Weekend parties', '/weekend-parties'], ['Dinners', '/dinners'], ['Meetups', '/meetups'], ['Dating & Matchmaking', '/dating'], ['Strangers trips', '/trips'], ['Membership', '/membership'], ['Submit an event', '/submit-event'],['Chennai', '/meetups/chennai'], ['Bengaluru', '/meetups/bengaluru'], ['Coimbatore', '/meetups/coimbatore'], ['Kochi', '/meetups/kochi'], ['Puducherry', '/meetups/puducherry']])}
      ${col('Partner With Us', [['Partner With Us', '/partner-with-us'], ['Become a Host', '/become-a-host'], ['Create an event', '/organiser'], ['List Your Venue', '/list-your-venue']])}
      ${col('Community', [['How it works', '/#how-it-works'], ['FAQ', '/faq'], ['Trust & Safety', '/trust-safety'], ['Community Guidelines', '/community-guidelines'], ['Instagram', INSTAGRAM_URL, true]])}
      ${col('Information', [['Privacy', '/privacy'], ['Terms', '/terms'], ['Billing & Refunds', '/refunds'], ['Contact', '/contact']])}
    </div>
    <div class="wrap footer-base">
      <p>© ${new Date().getFullYear()} ${BRAND}. For adults 21 and over.</p>
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
<meta name="theme-color" content="#FBF8F4">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400&display=optional">
<link rel="stylesheet" href="/css/site.css?v=11">
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
