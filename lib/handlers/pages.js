// lib/handlers/pages.js - Public, CDN-cacheable server-rendered pages + sitemap/robots.
import { sendHtml, sendText, sendJson, redirect, HttpError, PUBLIC_CACHE } from '../http.js';
import { siteUrl, isProductionRuntime } from '../config.js';
import {
  listPublicEvents, getPublicEventBySlug, listSitemapEvents, socialProof, listVisibleMedia, listTiers,
  CATEGORY_LABELS, CITIES
} from '../services/events.js';
import { renderHome } from '../views/home.js';
import { renderEvent } from '../views/event.js';
import { eventPath, whenRange } from '../views/components.js';
import * as P from '../views/pages.js';

function readFilter(query) {
  const city = CITIES.find((c) => c.slug === query.get('city'));
  const category = Object.hasOwn(CATEGORY_LABELS, query.get('category') || '') ? query.get('category') : '';
  const when = ['week', 'month'].includes(query.get('when')) ? query.get('when') : '';
  return { city: city?.slug || '', cityName: city?.name, category, when };
}

export async function home({ res, query }) {
  const filter = readFilter(query);
  const range = whenRange(filter.when);
  const [events, trips, tiers, proof, media] = await Promise.all([
    listPublicEvents({ city: filter.cityName, category: filter.category || undefined, kind: filter.category ? 'all' : 'events', ...range, limit: 12 }),
    listPublicEvents({ kind: 'trips', limit: 6 }),
    listTiers(),
    socialProof(),
    listVisibleMedia(6)
  ]);
  sendHtml(res, 200, renderHome({ events, trips, tiers, proof, media, filter }), { cache: PUBLIC_CACHE });
}

export async function eventPage({ res, params, pathname }) {
  const e = await getPublicEventBySlug(params.slug);
  if (!e) throw new HttpError(404, 'not_found', 'Event not found');
  const canonical = eventPath(e);
  if (canonical !== pathname.replace(/\/$/, '')) return redirect(res, canonical, 301);
  sendHtml(res, 200, renderEvent(e), { cache: PUBLIC_CACHE });
}

export async function tripsPage({ res }) {
  const events = await listPublicEvents({ kind: 'trips' });
  sendHtml(res, 200, P.renderListing({
    title: 'Weekend trips & resort getaways', eyebrow: 'Trips', path: '/trips', current: '/trips',
    lede: 'Small-group trips within South India. Every trip lists inclusions, exclusions and its refund policy.',
    description: 'Small-group weekend trips and resort getaways for adults 21+ from Chennai, Bengaluru, Coimbatore, Kochi and Puducherry.',
    events
  }), { cache: PUBLIC_CACHE });
}

export async function nightlifePage({ res }) {
  const events = await listPublicEvents({ category: 'nightlife' });
  sendHtml(res, 200, P.renderListing({
    title: 'Nightlife', eyebrow: 'After dark', path: '/nightlife', current: '/nightlife',
    lede: 'Hosted nights out where arriving alone is the norm.',
    description: 'Hosted nightlife events for adults 21+ across South India.',
    events
  }), { cache: PUBLIC_CACHE });
}

export async function datingPage({ res }) {
  const events = await listPublicEvents({ category: 'dating_mixer' });
  sendHtml(res, 200, P.renderDating(events), { cache: PUBLIC_CACHE });
}

export async function cityPage({ res, params }) {
  const city = CITIES.find((c) => c.slug === params.city);
  if (!city) throw new HttpError(404, 'not_found', 'City not found');
  const events = await listPublicEvents({ city: city.name });
  sendHtml(res, 200, P.renderCity(city, events), { cache: PUBLIC_CACHE });
}

const FORM_BY_PATH = { '/partner-with-us': 'partner', '/become-a-host': 'host', '/list-your-venue': 'venue' };

export async function formPage({ res, pathname, query }) {
  const type = FORM_BY_PATH[pathname.replace(/\/$/, '')];
  const html = query.get('sent') === '1' ? P.renderFormThanks(type) : P.renderForm(type);
  sendHtml(res, 200, html, { cache: PUBLIC_CACHE });
}

const STATIC = {
  '/faq': P.renderFaq,
  '/trust-safety': P.renderTrustSafety,
  '/community-guidelines': P.renderGuidelines,
  '/privacy': P.renderPrivacy,
  '/terms': P.renderTerms,
  '/refunds': P.renderRefunds,
  '/contact': P.renderContact
};

export async function staticPage({ res, pathname }) {
  sendHtml(res, 200, STATIC[pathname.replace(/\/$/, '')](), { cache: PUBLIC_CACHE });
}

export async function memberPage({ res, pathname }) {
  const html = pathname.startsWith('/me') ? P.renderMe() : P.renderSignin();
  sendHtml(res, 200, html, { cache: 'no-store' });
}

export async function bookingPage({ res, params }) {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, 'not_found', 'Not found');
  sendHtml(res, 200, P.renderBookingStatus(params.id), { cache: 'no-store' });
}

export async function eventsApi({ res, query }) {
  const filter = readFilter(query);
  const kind = ['events', 'trips'].includes(query.get('kind')) ? query.get('kind') : 'all';
  const events = await listPublicEvents({ city: filter.cityName, category: filter.category || undefined, kind, ...whenRange(filter.when) });
  sendJson(res, 200, { ok: true, events }, { 'Cache-Control': PUBLIC_CACHE });
}

export async function sitemap({ res }) {
  const base = siteUrl();
  const staticPaths = ['/', '/trips', '/nightlife', '/dating', '/faq', '/trust-safety', '/community-guidelines',
    '/partner-with-us', '/become-a-host', '/list-your-venue', '/privacy', '/terms', '/refunds', '/contact',
    ...CITIES.map((c) => `/meetups/${c.slug}`)];
  const events = await listSitemapEvents();
  const urls = [
    ...staticPaths.map((p) => `<url><loc>${base}${p}</loc></url>`),
    ...events.map((e) => `<url><loc>${base}${['weekend_trip', 'resort_getaway'].includes(e.category) ? '/trips' : '/events'}/${e.slug}</loc><lastmod>${new Date(e.updated_at).toISOString()}</lastmod></url>`)
  ];
  sendText(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    'application/xml; charset=utf-8', PUBLIC_CACHE);
}

export async function robots({ res }) {
  // Only the production deployment is indexable; previews are not.
  const body = isProductionRuntime()
    ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /me\nDisallow: /bookings/\nDisallow: /signin\n\nSitemap: ${siteUrl()}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  sendText(res, 200, body);
}
