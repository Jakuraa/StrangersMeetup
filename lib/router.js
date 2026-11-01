// lib/router.js - Single entry point for all dynamic routes (pages + API). Handlers load lazily.
import crypto from 'node:crypto';
import { logger, requestContext } from './logger.js';
import { HttpError, sendJson, sendHtml, clientIp } from './http.js';

const h = (file, name) => async () => (await import(`./handlers/${file}.js`))[name];

// [method, pattern, loader]. Patterns support :params.
const ROUTES = [
  // Pages
  ['GET', '/', h('pages', 'home')],
  ['GET', '/events/:slug', h('pages', 'eventPage')],
  ['GET', '/trips/:slug', h('pages', 'eventPage')],
  ['GET', '/trips', h('pages', 'tripsPage')],
  ['GET', '/nightlife', h('pages', 'nightlifePage')],
  ['GET', '/dating', h('pages', 'datingPage')],
  ['GET', '/events', h('discovery', 'allEventsPage')],
  ['GET', '/weekend-parties', h('discovery', 'collectionPage')],
  ['GET', '/dinners', h('discovery', 'collectionPage')],
  ['GET', '/meetups', h('discovery', 'collectionPage')],
  ['GET', '/membership', h('discovery', 'membershipPage')],
  ['GET', '/submit-event', h('discovery', 'submitEventPage')],
  ['GET', '/meetups/:city', h('pages', 'cityPage')],
  ['GET', '/partner-with-us', h('pages', 'formPage')],
  ['GET', '/become-a-host', h('pages', 'formPage')],
  ['GET', '/list-your-venue', h('pages', 'formPage')],
  ['GET', '/faq', h('pages', 'staticPage')],
  ['GET', '/trust-safety', h('pages', 'staticPage')],
  ['GET', '/community-guidelines', h('pages', 'staticPage')],
  ['GET', '/privacy', h('pages', 'staticPage')],
  ['GET', '/terms', h('pages', 'staticPage')],
  ['GET', '/refunds', h('pages', 'staticPage')],
  ['GET', '/contact', h('pages', 'staticPage')],
  ['GET', '/signin', h('pages', 'memberPage')],
  ['GET', '/me', h('pages', 'memberPage')],
  ['GET', '/bookings/:id', h('pages', 'bookingPage')],
  ['GET', '/checkout/:slug', h('checkout', 'checkoutRedirect')],
  ['GET', '/admin', h('admin', 'adminPage')],
  ['GET', '/admin/preview/:id', h('admin', 'adminPreview')],
  ['GET', '/organiser', h('organiser', 'dashboardPage')],
  ['GET', '/organiser/new', h('organiser', 'wizardPage')],
  ['GET', '/organiser/drafts/:id/preview', h('organiser', 'draftPreviewPage')],
  ['GET', '/organiser/events/:id', h('organiser', 'managePage')],
  ['GET', '/media/event-images/:id', h('organiser', 'serveImage')],
  ['GET', '/auth/telegram/start', h('auth', 'oidcStart')],
  ['GET', '/auth/telegram/callback', h('auth', 'oidcCallback')],
  ['GET', '/sitemap.xml', h('pages', 'sitemap')],
  ['GET', '/robots.txt', h('pages', 'robots')],

  // Public API
  ['GET', '/api/health', h('health', 'health')],
  ['GET', '/api/events', h('pages', 'eventsApi')],
  ['POST', '/api/leads/:type', h('leads', 'submitLead')],
  ['POST', '/api/events/submit', h('discovery', 'submitEvent')],
  ['POST', '/api/analytics', h('leads', 'trackEvent')],

  // Auth & member
  ['POST', '/api/auth/telegram', h('auth', 'telegramAuth')],
  ['POST', '/api/auth/dev', h('auth', 'devAuth')],
  ['POST', '/api/auth/preview-reviewer', h('auth', 'previewReviewerAuth')],
  ['POST', '/api/auth/logout', h('auth', 'logout')],
  ['POST', '/api/auth/logout-all', h('auth', 'logoutAll')],
  ['POST', '/api/auth/confirm-age', h('auth', 'confirmAge')],
  ['GET', '/api/me', h('auth', 'me')],
  ['GET', '/api/me/bookings', h('bookings', 'myBookings')],
  ['GET', '/api/me/profile', h('profile', 'getProfile')],
  ['PATCH', '/api/me/profile', h('profile', 'updateProfile')],
  ['GET', '/api/me/reports', h('safety', 'listMyReports')],
  ['POST', '/api/reports', h('safety', 'submitReport')],
  ['GET', '/api/me/blocks', h('safety', 'listBlocks')],
  ['POST', '/api/me/blocks', h('safety', 'blockUser')],
  ['DELETE', '/api/me/blocks/:id', h('safety', 'unblockUser')],
  ['GET', '/api/bookings/:id', h('bookings', 'getBooking')],
  ['POST', '/api/membership/checkout', h('membership', 'membershipCheckout')],
  ['POST', '/api/events/:id/book', h('organiser', 'bookTicket')],

  // Organiser (session + organiser access; drafts and events are owner-scoped)
  ['GET', '/api/organiser/context', h('organiser', 'context')],
  ['GET', '/api/organiser/drafts', h('organiser', 'listDrafts')],
  ['POST', '/api/organiser/drafts', h('organiser', 'createDraft')],
  ['GET', '/api/organiser/drafts/:id', h('organiser', 'getDraft')],
  ['PUT', '/api/organiser/drafts/:id', h('organiser', 'saveDraft')],
  ['DELETE', '/api/organiser/drafts/:id', h('organiser', 'discardDraft')],
  ['GET', '/api/organiser/drafts/:id/check', h('organiser', 'checkDraft')],
  ['POST', '/api/organiser/drafts/:id/publish', h('organiser', 'publishDraft')],
  ['POST', '/api/organiser/drafts/:id/images', h('organiser', 'uploadImage')],
  ['DELETE', '/api/organiser/drafts/:id/images/:image', h('organiser', 'deleteImage')],
  ['GET', '/api/organiser/events', h('organiser', 'listEvents')],
  ['GET', '/api/organiser/events/:id/guests', h('organiser', 'eventGuests')],
  ['POST', '/api/organiser/bookings/:id/approve', h('organiser', 'approveBooking')],
  ['POST', '/api/organiser/bookings/:id/decline', h('organiser', 'declineBooking')],

  // Webhooks
  ['POST', '/api/telegram/webhook', h('telegram', 'telegramWebhook')],
  ['POST', '/api/webhooks/superprofile', h('superprofile', 'superprofileWebhook')],
  ['POST', '/api/membership/superprofile/webhook', h('superprofile', 'superprofileWebhook')],

  ['POST', '/api/reconcile/superprofile', h('cron', 'reconcileSuperprofile')],

  // Cron (Vercel Cron sends GET with Authorization: Bearer CRON_SECRET)
  ['GET', '/api/cron/:job', h('cron', 'runCron')],

  // Admin API
  ['GET', '/api/admin/session', h('admin', 'adminSession')],
  ['GET', '/api/admin/overview', h('admin', 'overview')],
  ['GET', '/api/admin/insights', h('admin', 'insights')],
  ['GET', '/api/admin/integrations/telegram', h('admin', 'telegramStatus')],
  ['GET', '/api/admin/feeds', h('admin', 'listFeeds')],
  ['POST', '/api/admin/feeds', h('admin', 'createFeed')],
  ['PATCH', '/api/admin/feeds/:id', h('admin', 'updateFeed')],
  ['POST', '/api/admin/feeds/:id/fetch', h('admin', 'fetchFeed')],
  ['GET', '/api/admin/candidates', h('admin', 'listCandidates')],
  ['POST', '/api/admin/candidates/:id/approve', h('admin', 'approveCandidate')],
  ['POST', '/api/admin/candidates/:id/reject', h('admin', 'rejectCandidate')],
  ['GET', '/api/admin/superprofile', h('admin', 'listSuperprofile')],
  ['GET', '/api/admin/events', h('admin', 'listEvents')],
  ['POST', '/api/admin/events', h('admin', 'createEvent')],
  ['GET', '/api/admin/events/:id', h('admin', 'getEvent')],
  ['PATCH', '/api/admin/events/:id', h('admin', 'updateEvent')],
  ['POST', '/api/admin/events/:id/status', h('admin', 'setEventStatus')],
  ['GET', '/api/admin/events/:id/attendees', h('admin', 'attendees')],
  ['POST', '/api/admin/bookings/:id/check-in', h('admin', 'checkIn')],
  ['GET', '/api/admin/bookings', h('admin', 'listBookings')],
  ['GET', '/api/admin/orders', h('admin', 'listOrders')],
  ['POST', '/api/admin/orders/:id/link', h('admin', 'linkOrder')],
  ['POST', '/api/admin/payments/:id/refund', h('admin', 'refundPayment')],
  ['GET', '/api/admin/memberships', h('admin', 'listMemberships')],
  ['POST', '/api/admin/entitlements/:id/revoke', h('admin', 'revokeEntitlement')],
  ['GET', '/api/admin/leads', h('admin', 'listLeads')],
  ['PATCH', '/api/admin/leads/:id', h('admin', 'updateLead')],
  ['PATCH', '/api/admin/reports/:id', h('admin', 'updateReport')],
  ['GET', '/api/admin/media', h('admin', 'listMedia')],
  ['POST', '/api/admin/media', h('admin', 'createMedia')],
  ['PATCH', '/api/admin/media/:id', h('admin', 'updateMedia')],
  ['GET', '/api/admin/tiers', h('admin', 'listTiers')],
  ['PATCH', '/api/admin/tiers/:id', h('admin', 'updateTier')],
  ['GET', '/api/admin/admins', h('admin', 'listAdmins')],
  ['POST', '/api/admin/admins', h('admin', 'upsertAdmin')],
  ['GET', '/api/admin/audit', h('admin', 'listAudit')],
  ['GET', '/api/admin/organisers', h('admin', 'listOrganisers')],
  ['POST', '/api/admin/organisers', h('admin', 'setOrganiser')]
];

const COMPILED = ROUTES.map(([method, pattern, load]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\/:([a-z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
  return { method, pattern, re, keys, load };
});

export function match(method, pathname) {
  let pathMatched = false;
  for (const r of COMPILED) {
    const m = pathname.match(r.re);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; }
    });
    return { route: r, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

function wantsHtml(pathname) {
  return !pathname.startsWith('/api/');
}

export async function handle(req, res) {
  const reqId = req.headers['x-vercel-id']?.split('::').pop() || crypto.randomBytes(6).toString('hex');
  return requestContext.run({ reqId }, async () => {
    const url = new URL(req.url, 'http://local');
    // vercel.json rewrites pass the original path as __path.
    const pathname = (url.searchParams.get('__path') || url.pathname).replace(/\/{2,}/g, '/');
    url.searchParams.delete('__path');
    res.setHeader('X-Request-Id', reqId);

    const m = match(req.method, pathname);
    const ctx = { req, res, url, pathname, query: url.searchParams, params: m?.params || {}, ip: clientIp(req), reqId };
    try {
      if (!m) throw new HttpError(404, 'not_found', 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      const fn = await m.route.load();
      await fn(ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : (err.code === 'DB_NOT_CONFIGURED' || err.code === 'PREVIEW_DB_WRITE_BLOCKED') ? 503 : 500;
      if (status >= 500) logger.error('request failed', err, { path: pathname, method: req.method });
      if (res.headersSent) { res.end(); return; }
      if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      if (wantsHtml(pathname)) {
        const { renderNotFound, renderError } = await import('./views/pages.js');
        sendHtml(res, status, status === 404 ? renderNotFound() : renderError());
      } else {
        const safe = err instanceof HttpError
          ? { ok: false, error: err.code, message: err.message, ...(err.extra?.fields ? { fields: err.extra.fields } : {}),
            ...(err.extra?.issues ? { issues: err.extra.issues } : {}), ...(err.extra?.draft ? { draft: err.extra.draft } : {}) }
          : { ok: false, error: status === 503 ? 'not_configured' : 'internal', message: status === 503 ? 'Service not configured yet' : 'Something went wrong' };
        sendJson(res, status, safe);
      }
    }
  });
}
