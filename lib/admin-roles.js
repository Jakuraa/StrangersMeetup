// lib/admin-roles.js - Which admin roles may use each admin API area (enforced in handlers/admin.js),
// and which console tabs each role is shown. A tab is shown only if its loading API allows the role.
export const R = {
  ANY: ['super_admin', 'event_manager', 'moderator', 'finance', 'support'],
  EVENTS_WRITE: ['super_admin', 'event_manager'],
  CHECKIN: ['super_admin', 'event_manager', 'support'],
  BOOKINGS: ['super_admin', 'event_manager', 'finance', 'support'],
  REFUND: ['super_admin', 'finance'],
  ORDERS: ['super_admin', 'finance', 'support'],
  ORDERS_LINK: ['super_admin', 'finance'],
  MEMBERSHIPS: ['super_admin', 'finance', 'support', 'moderator'],
  REVOKE: ['super_admin', 'moderator'],
  LEADS: ['super_admin', 'event_manager', 'support'],
  MEDIA: ['super_admin', 'moderator'],
  SUPER: ['super_admin'],
  INSIGHTS: ['super_admin', 'finance', 'event_manager'],
  DISCOVERY: ['super_admin', 'event_manager', 'moderator'],
  DISCOVERY_WRITE: ['super_admin', 'event_manager', 'moderator'],
  FINANCE_VIEW: ['super_admin', 'finance']
};

// [tab, label, roles allowed to load it]
export const ADMIN_TABS = [
  ['overview', 'Overview', R.ANY],
  ['insights', 'Insights', R.INSIGHTS],
  ['discovery', 'Discovery', R.DISCOVERY],
  ['events', 'Events', R.ANY],
  ['bookings', 'Bookings & payments', R.BOOKINGS],
  ['orders', 'Orders (SuperProfile)', R.ORDERS],
  ['memberships', 'Memberships', R.MEMBERSHIPS],
  ['leads', 'Leads & reports', R.LEADS],
  ['media', 'Media', R.MEDIA],
  ['tiers', 'Membership tiers', R.ANY],
  ['integrations', 'Integrations', [...new Set([...R.SUPER, ...R.FINANCE_VIEW])]],
  ['admins', 'Admins & audit', R.SUPER]
];

export const tabsFor = (role) => ADMIN_TABS.filter(([, , roles]) => roles.includes(role));
