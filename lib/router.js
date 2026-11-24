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
  ['GET', '/list-your-venue', h('pages', 'listYourVenuePage')],
  ['GET', '/faq', h('pages', 'staticPage')],
  ['GET', '/trust-safety', h('pages', 'staticPage')],
  ['GET', '/community-guidelines', h('pages', 'staticPage')],
  ['GET', '/privacy', h('pages', 'staticPage')],
  ['GET', '/terms', h('pages', 'staticPage')],
  ['GET', '/refunds', h('pages', 'staticPage')],
  ['GET', '/contact', h('pages', 'staticPage')],
  ['GET', '/signin', h('pages', 'memberPage')],
  ['GET', '/onboarding', h('pages', 'onboardingPage')],
  ['GET', '/me', h('pages', 'memberPage')],
  ['GET', '/bookings/:id', h('pages', 'bookingPage')],
  ['GET', '/checkout/:slug', h('checkout', 'checkoutRedirect')],
  ['GET', '/checkout/:slug/upi', h('upi-checkout', 'upiCheckoutPage')],
  ['GET', '/admin', h('admin', 'adminPage')],
  ['GET', '/admin/preview/:id', h('admin', 'adminPreview')],
  ['GET', '/business', h('business', 'businessDashboardPage')],
  ['GET', '/business/new', h('business', 'businessOnboardingPage')],
  ['GET', '/venue', h('venue', 'venuePage')],
  ['GET', '/organiser', h('organiser', 'dashboardPage')],
  ['GET', '/organiser/new', h('organiser', 'wizardPage')],
  ['GET', '/organiser/drafts/:id/preview', h('organiser', 'draftPreviewPage')],
  ['GET', '/organiser/events/:id', h('organiser', 'managePage')],
  ['GET', '/organiser/events/:id/scan', h('organiser', 'scanPage')],
  ['GET', '/staff/join', h('organiser', 'staffJoinPage')],
  ['GET', '/media/event-images/:id', h('organiser', 'serveImage')],
  ['GET', '/auth/telegram/start', h('auth', 'oidcStart')],
  ['POST', '/auth/telegram/state', h('auth', 'createTelegramWidgetState')],
  ['POST', '/api/auth/telegram/state', h('auth', 'createTelegramWidgetState')],
  ['GET', '/auth/telegram/state', h('auth', 'createTelegramWidgetState')],
  ['GET', '/api/auth/telegram/state', h('auth', 'createTelegramWidgetState')],
  ['GET', '/auth/telegram/callback', h('auth', 'oidcCallback')],
  ['GET', '/auth/telegram/widget-callback', h('auth', 'widgetCallback')],
  ['GET', '/sitemap.xml', h('pages', 'sitemap')],
  ['GET', '/robots.txt', h('pages', 'robots')],

  // Public API
  ['GET', '/api/health', h('health', 'health')],
  ['GET', '/api/events', h('pages', 'eventsApi')],
  ['GET', '/api/discovery/feed', h('discovery', 'discoveryFeedApi')],
  ['GET', '/api/events/nearby', h('locations', 'nearbyEventsHandler')],
  ['GET', '/api/locations/states', h('locations', 'listStatesHandler')],
  ['GET', '/api/locations/districts', h('locations', 'listDistrictsHandler')],
  ['GET', '/api/locations/cities', h('locations', 'listCitiesHandler')],
  ['GET', '/api/locations/cities/:slug', h('locations', 'getCityHandler')],
  ['GET', '/api/locations/localities', h('locations', 'listLocalitiesHandler')],
  ['POST', '/api/leads/:type', h('leads', 'submitLead')],
  ['POST', '/api/events/submit', h('discovery', 'submitEvent')],
  ['POST', '/api/analytics', h('leads', 'trackEvent')],

  // Auth & member
  ['POST', '/api/auth/telegram', h('auth', 'telegramAuth')],
  ['POST', '/api/auth/telegram/link-token', h('auth', 'createTelegramLinkToken')],
  ['GET', '/api/auth/telegram/link-status', h('auth', 'getTelegramLinkStatus')],
  ['POST', '/api/auth/whatsapp/otp', h('auth', 'requestWhatsAppOtpHandler')],
  ['POST', '/api/auth/whatsapp/verify', h('auth', 'verifyWhatsAppOtpHandler')],
  ['POST', '/api/auth/whatsapp/link', h('auth', 'linkWhatsAppHandler')],
  ['POST', '/api/auth/whatsapp/unlink', h('auth', 'unlinkWhatsAppHandler')],
  ['GET', '/api/me/identities', h('auth', 'getMyIdentitiesHandler')],
  ['GET', '/api/me/communication-preferences', h('auth', 'getMyCommunicationPreferences')],
  ['PATCH', '/api/me/communication-preferences', h('auth', 'updateMyCommunicationPreferences')],
  ['GET', '/api/me/onboarding', h('auth', 'getMyOnboardingHandler')],
  ['POST', '/api/onboarding/track', h('auth', 'trackOnboardingHandler')],
  ['GET', '/api/onboarding/status', h('onboarding', 'getStatus')],
  ['GET', '/api/onboarding/community', h('onboarding', 'getCommunityJoinsHandler')],
  ['POST', '/api/onboarding/community', h('onboarding', 'saveCommunityJoinHandler')],
  ['POST', '/api/onboarding/age', h('onboarding', 'confirmAge')],
  ['POST', '/api/onboarding/account-type', h('onboarding', 'saveAccountTypeHandler')],
  ['POST', '/api/onboarding/profile', h('onboarding', 'saveProfile')],
  ['POST', '/api/onboarding/interests', h('onboarding', 'saveInterestsHandler')],
  ['POST', '/api/onboarding/preferences', h('onboarding', 'savePreferencesHandler')],
  ['GET', '/api/onboarding/preferences', h('onboarding', 'getPreferencesHandler')],
  ['POST', '/api/onboarding/optional', h('onboarding', 'saveOptional')],
  ['POST', '/api/onboarding/business/workspace', h('onboarding', 'saveBusinessWorkspaceHandler')],
  ['POST', '/api/onboarding/business/complete', h('onboarding', 'completeBusinessHandler')],
  ['POST', '/api/onboarding/complete', h('onboarding', 'complete')],
  ['POST', '/api/auth/dev', h('auth', 'devAuth')],
  ['POST', '/api/auth/preview-reviewer', h('auth', 'previewReviewerAuth')],
  ['POST', '/api/auth/logout', h('auth', 'logout')],
  ['POST', '/api/auth/logout-all', h('auth', 'logoutAll')],
  ['POST', '/api/auth/confirm-age', h('auth', 'confirmAge')],
  ['GET', '/api/me', h('auth', 'me')],
  ['POST', '/api/me/switch-mode', h('auth', 'switchAccountMode')],
  ['GET', '/api/me/bookings', h('bookings', 'myBookings')],
  ['POST', '/api/me/bookings/:id/cancel', h('bookings', 'cancelMyBooking')],
  ['GET', '/api/me/announcements', h('bookings', 'myAnnouncements')],
  ['GET', '/api/me/saved-events', h('saved-events', 'getMySavedEvents')],
  ['GET', '/api/me/saved-event-ids', h('saved-events', 'getMySavedEventIds')],
  ['POST', '/api/me/saved-events', h('saved-events', 'saveEventHandler')],
  ['DELETE', '/api/me/saved-events/:id', h('saved-events', 'unsaveEventHandler')],
  ['POST', '/api/events/:id/save', h('saved-events', 'saveEventHandler')],
  ['DELETE', '/api/events/:id/save', h('saved-events', 'unsaveEventHandler')],
  ['POST', '/api/events/:id/toggle-save', h('saved-events', 'toggleSaveEventHandler')],
  ['GET', '/api/me/profile', h('profile', 'getProfile')],
  ['PATCH', '/api/me/profile', h('profile', 'updateProfile')],
  ['GET', '/api/me/recommendations', h('profile', 'getRecommendationsApi')],
  ['GET', '/api/me/connections', h('profile', 'getConnectionsApi')],
  ['POST', '/api/me/connections/request', h('profile', 'requestConnectionApi')],
  ['POST', '/api/me/connections/:id/accept', h('profile', 'acceptConnectionApi')],
  ['POST', '/api/me/connections/:id/decline', h('profile', 'declineConnectionApi')],
  ['GET', '/api/me/notification-preferences', h('auth', 'getMyNotificationPreferences')],
  ['PATCH', '/api/me/notification-preferences', h('auth', 'updateMyNotificationPreferences')],
  ['GET', '/api/me/reports', h('safety', 'listMyReports')],
  ['POST', '/api/reports', h('safety', 'submitReport')],
  ['GET', '/api/me/blocks', h('safety', 'listBlocks')],
  ['POST', '/api/me/blocks', h('safety', 'blockUser')],
  ['DELETE', '/api/me/blocks/:id', h('safety', 'unblockUser')],
  ['GET', '/api/bookings/:id', h('bookings', 'getBooking')],
  ['POST', '/api/bookings/:id/cancel', h('bookings', 'cancelMyBooking')],
  ['POST', '/api/membership/checkout', h('membership', 'membershipCheckout')],
  ['POST', '/api/events/:id/book', h('organiser', 'bookTicket')],
  ['POST', '/api/checkout/upi/intent', h('upi-checkout', 'createUpiIntentApi')],
  ['GET', '/api/checkout/upi/status/:id', h('upi-checkout', 'getUpiStatusApi')],
  ['POST', '/api/checkout/upi/claim', h('upi-checkout', 'claimUpiBookingApi')],
  ['POST', '/api/checkout/upi/report-payment', h('upi-checkout', 'reportPaymentApi')],
  ['GET', '/api/checkout/upi/booking-status/:id', h('upi-checkout', 'bookingStatusApi')],

  // Organisations, members, venues (session + can(); outsiders get 404)
  ['GET', '/api/me/orgs', h('orgs', 'myOrgs')],
  ['GET', '/api/orgs/:id', h('orgs', 'getOrg')],
  ['GET', '/api/orgs/:id/members', h('orgs', 'listMembers')],
  ['POST', '/api/orgs/:id/members', h('orgs', 'addMember')],
  ['PATCH', '/api/orgs/:id/members/:member', h('orgs', 'updateMember')],
  ['GET', '/api/orgs/:id/venues', h('orgs', 'listVenues')],
  ['POST', '/api/orgs/:id/venues', h('orgs', 'createVenue')],
  ['PATCH', '/api/venues/:id', h('orgs', 'updateVenue')],

  // Business Command Centre & Self-Service Workspaces
  ['GET', '/api/business/overview', h('business', 'getOverviewApi')],
  ['GET', '/api/business/events', h('business', 'listEventsApi')],
  ['POST', '/api/business/events/:id/duplicate', h('business', 'duplicateEventApi')],
  ['POST', '/api/business/events/:id/cancel', h('business', 'cancelEventApi')],
  ['DELETE', '/api/business/events/:id', h('business', 'deleteEventApi')],
  ['GET', '/api/business/media/cleanup-preview', h('business', 'getCleanupPreviewApi')],
  ['POST', '/api/business/media/cleanup-now', h('business', 'runCleanupNowApi')],
  ['GET', '/api/business/venues', h('business', 'listVenuesApi')],
  ['POST', '/api/business/venues', h('business', 'createVenueApi')],
  ['PATCH', '/api/business/venues/:id', h('business', 'updateVenueApi')],
  ['GET', '/api/business/team', h('business', 'listTeamApi')],
  ['GET', '/api/business/suppliers', h('business', 'listSuppliersApi')],
  ['POST', '/api/business/suppliers', h('business', 'createSupplierApi')],
  ['GET', '/api/business/analytics', h('business', 'getAnalyticsApi')],
  ['GET', '/api/business/payment-settings', h('business', 'getPaymentSettingsApi')],
  ['PUT', '/api/business/payment-settings', h('business', 'savePaymentSettingsApi')],
  ['DELETE', '/api/business/payment-settings', h('business', 'deletePaymentSettingsApi')],

  // Venue Owner Dashboard (session + venue access; isolation enforced by can())
  ['GET', '/api/venue/context', h('venue', 'venueContextApi')],
  ['GET', '/api/venue/profile', h('venue', 'venueProfileApi')],
  ['PATCH', '/api/venue/profile', h('venue', 'updateVenueProfileApi')],
  ['GET', '/api/venue/events', h('venue', 'venueEventsApi')],
  ['GET', '/api/venue/analytics', h('venue', 'venueAnalyticsApi')],
  ['GET', '/api/venue/enquiries', h('venue', 'venueEnquiriesApi')],
  ['POST', '/api/venue/enquiries', h('venue', 'createVenueEnquiryApi')],
  ['POST', '/api/venue/enquiries/:id/decide', h('venue', 'decideVenueEnquiryApi')],
  ['GET', '/api/venue/staff', h('venue', 'venueStaffApi')],
  ['POST', '/api/venue/staff', h('venue', 'addVenueStaffApi')],
  ['PATCH', '/api/venue/staff/:memberId', h('venue', 'updateVenueStaffApi')],
  ['GET', '/api/venue/reports', h('venue', 'venueReportsApi')],
  ['POST', '/api/venue/reports', h('venue', 'submitVenueReportApi')],
  ['POST', '/api/venue/onboard', h('venue', 'onboardVenueApi')],
  ['POST', '/api/venue/apply', h('venue', 'applyVenueApi')],
  ['POST', '/api/venue/claim', h('venue', 'submitVenueClaimApi')],
  ['GET', '/api/venue/claims', h('venue', 'listVenueClaimsApi')],
  ['POST', '/api/venue/photos', h('venue', 'uploadVenuePhotoApi')],

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
  ['GET', '/api/organiser/events/:id/overview', h('organiser', 'eventOverview')],
  ['PUT', '/api/organiser/events/:id', h('organiser', 'updateEvent')],
  ['POST', '/api/organiser/events/:id/cancel', h('organiser', 'cancelEvent')],
  ['GET', '/api/organiser/events/:id/inventory', h('organiser', 'eventInventory')],
  ['GET', '/api/organiser/events/:id/bookings', h('organiser', 'eventBookings')],
  ['GET', '/api/organiser/events/:id/guests', h('organiser', 'eventGuests')],
  ['POST', '/api/organiser/bookings/:id/approve', h('organiser', 'approveBooking')],
  ['POST', '/api/organiser/bookings/:id/decline', h('organiser', 'declineBooking')],
  ['POST', '/api/organiser/bookings/:id/cancel', h('organiser', 'cancelBooking')],
  ['GET', '/api/organiser/events/:id/staff', h('organiser', 'eventStaff')],
  ['POST', '/api/organiser/events/:id/staff', h('organiser', 'assignStaff')],
  ['DELETE', '/api/organiser/events/:id/staff/:staffId', h('organiser', 'revokeStaff')],
  ['POST', '/api/organiser/events/:id/staff/invite', h('organiser', 'inviteStaff')],
  ['GET', '/api/staff/invite/:token', h('organiser', 'getStaffInviteHandler')],
  ['POST', '/api/staff/accept-invite', h('organiser', 'acceptStaffInviteHandler')],
  ['GET', '/api/organiser/events/:id/announcements', h('organiser', 'eventAnnouncements')],
  ['POST', '/api/organiser/events/:id/announcements', h('organiser', 'postAnnouncement')],
  ['POST', '/api/organiser/events/:id/check-in', h('organiser', 'checkInTicketHandler')],
  ['GET', '/api/organiser/events/:id/scans', h('organiser', 'eventScans')],
  ['GET', '/api/organiser/events/:id/attendance', h('organiser', 'eventAttendance')],
  ['POST', '/api/organiser/tickets/:id/reissue', h('organiser', 'reissueTicketHandler')],
  ['POST', '/api/organiser/tickets/:id/revoke', h('organiser', 'revokeTicketHandler')],
  ['GET', '/api/me/bookings/:id/ticket', h('organiser', 'guestTicket')],
  ['GET', '/api/organiser/finance', h('organiser', 'organiserFinance')],
  ['GET', '/api/organiser/events/:id/finance', h('organiser', 'eventFinance')],
  ['POST', '/api/organiser/finance/submit-payment', h('organiser', 'submitOrganiserFeePayment')],
  ['GET', '/api/organiser/finance/statement', h('organiser', 'downloadOrganiserStatement')],
  ['GET', '/api/organiser/payment-settings', h('organiser', 'getPaymentSettingsHandler')],
  ['PUT', '/api/organiser/payment-settings', h('organiser', 'savePaymentSettingsHandler')],
  ['DELETE', '/api/organiser/payment-settings', h('organiser', 'deletePaymentSettingsHandler')],
  ['GET', '/api/organiser/events/:id/payments', h('organiser', 'listDirectUpiPayments')],
  ['POST', '/api/organiser/events/:id/payments/:bookingId/confirm', h('organiser', 'confirmPayment')],
  ['POST', '/api/organiser/events/:id/payments/:bookingId/reject', h('organiser', 'rejectPayment')],

  // Event Promotional Campaigns (Opt-in WhatsApp Marketing)
  ['POST', '/api/campaigns/preview', h('campaigns', 'previewCampaignHandler')],
  ['POST', '/api/campaigns', h('campaigns', 'createCampaignHandler')],
  ['GET', '/api/campaigns', h('campaigns', 'listCampaignsHandler')],
  ['GET', '/api/campaigns/:id', h('campaigns', 'getCampaignHandler')],
  ['POST', '/api/campaigns/:id/approve', h('campaigns', 'approveCampaignHandler')],
  ['POST', '/api/campaigns/:id/cancel', h('campaigns', 'cancelCampaignHandler')],
  ['POST', '/api/campaigns/:id/dispatch', h('campaigns', 'dispatchCampaignHandler')],
  ['GET', '/api/campaigns/:id/logs', h('campaigns', 'getCampaignLogsHandler')],
  ['POST', '/api/notifications/unsubscribe', h('campaigns', 'unsubscribeHandler')],

  // Webhooks
  ['GET', '/api/webhooks/whatsapp', h('whatsapp-webhook', 'verifyWebhook')],
  ['POST', '/api/webhooks/whatsapp', h('whatsapp-webhook', 'handleWebhook')],
  ['POST', '/api/telegram/webhook', h('telegram', 'telegramWebhook')],
  ['POST', '/api/webhooks/superprofile', h('superprofile', 'superprofileWebhook')],
  ['POST', '/api/membership/superprofile/webhook', h('superprofile', 'superprofileWebhook')],
  ['POST', '/api/payments/webhook/phonepe', h('upi-checkout', 'phonepeWebhook')],

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
  ['GET', '/api/admin/finance/overview', h('admin', 'adminFinanceOverview')],
  ['GET', '/api/admin/finance/queue', h('admin', 'adminFinanceQueue')],
  ['POST', '/api/admin/finance/confirm-payment', h('admin', 'adminConfirmPayment')],
  ['POST', '/api/admin/finance/reject-payment', h('admin', 'adminRejectPayment')],
  ['POST', '/api/admin/finance/investigate-payment', h('admin', 'adminInvestigatePayment')],
  ['POST', '/api/admin/finance/rules', h('admin', 'adminSetFeeRule')],
  ['POST', '/api/admin/finance/extend-deadline', h('admin', 'adminExtendDeadline')],
  ['GET', '/api/admin/finance/export', h('admin', 'adminFinanceExport')],
  ['GET', '/api/admin/bookings', h('admin', 'listBookings')],
  ['GET', '/api/admin/orders', h('admin', 'listOrders')],
  ['POST', '/api/admin/orders/:id/link', h('admin', 'linkOrder')],
  ['POST', '/api/admin/payments/:id/refund', h('admin', 'refundPayment')],
  ['GET', '/api/admin/payments', h('admin', 'listPayments')],
  ['GET', '/api/admin/payments/:id/audit', h('admin', 'paymentAudit')],
  ['GET', '/api/admin/onboarding', h('admin', 'listOnboarding')],
  ['GET', '/api/admin/memberships', h('admin', 'listMemberships')],
  ['POST', '/api/admin/entitlements/:id/revoke', h('admin', 'revokeEntitlement')],
  ['GET', '/api/admin/leads', h('admin', 'listLeads')],
  ['PATCH', '/api/admin/leads/:id', h('admin', 'updateLead')],
  ['PATCH', '/api/admin/reports/:id', h('admin', 'updateReport')],
  ['GET', '/api/admin/notifications', h('admin', 'listNotifications')],
  ['POST', '/api/admin/notifications/:id/retry', h('admin', 'retryNotification')],
  ['GET', '/api/admin/notifications/health', h('admin', 'notificationHealth')],
  ['GET', '/api/admin/notifications/stats', h('admin', 'notificationStats')],
  ['GET', '/api/admin/notifications/messages', h('admin', 'notificationMessages')],
  ['GET', '/api/admin/notifications/suppressions', h('admin', 'notificationSuppressions')],
  ['PATCH', '/api/admin/cities/:slug', h('admin', 'updateCityStatus')],
  ['GET', '/api/admin/media', h('admin', 'listMedia')],
  ['POST', '/api/admin/media', h('admin', 'createMedia')],
  ['PATCH', '/api/admin/media/:id', h('admin', 'updateMedia')],
  ['GET', '/api/admin/tiers', h('admin', 'listTiers')],
  ['PATCH', '/api/admin/tiers/:id', h('admin', 'updateTier')],
  ['GET', '/api/admin/admins', h('admin', 'listAdmins')],
  ['POST', '/api/admin/admins', h('admin', 'upsertAdmin')],
  ['GET', '/api/admin/audit', h('admin', 'listAudit')],
  ['GET', '/api/admin/organisers', h('admin', 'listOrganisers')],
  ['POST', '/api/admin/organisers', h('admin', 'setOrganiser')],
  ['GET', '/api/admin/orgs', h('admin', 'listOrgs')],
  ['POST', '/api/admin/orgs', h('admin', 'createOrg')],
  ['PATCH', '/api/admin/orgs/:id', h('admin', 'updateOrg')],
  ['GET', '/api/admin/venues', h('admin', 'listAdminVenues')],
  ['GET', '/api/admin/venue-claims', h('admin', 'listAdminVenueClaims')],
  ['POST', '/api/admin/venue-claims/:id/resolve', h('admin', 'resolveAdminVenueClaim')]
];

const COMPILED = ROUTES.map(([method, pattern, load]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\/:([a-zA-Z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
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
  return !pathname.startsWith('/api/') && !pathname.startsWith('/auth/telegram/state');
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
          ? { ok: false, error: err.code, message: err.message, ...(err.extra || {}) }
          : { ok: false, error: status === 503 ? 'not_configured' : 'internal', message: status === 503 ? 'Service not configured yet' : 'Something went wrong' };
        sendJson(res, status, safe);
      }
    }
  });
}
