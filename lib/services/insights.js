// lib/services/insights.js - Admin insights computed from our own Postgres tables only.
// Every metric is either { available: true, value } (zero is a real zero) or
// { available: false, value: null, reason } when we have no data source for it. Nothing is estimated.
// Demographic / interest buckets smaller than SUPPRESS_BELOW are hidden to protect individuals.
import { db } from '../db.js';
import { livePayments, configStatus } from '../config.js';
import { superprofileConfigured } from './superprofile.js';

export const SUPPRESS_BELOW = 5;
export const WINDOWS = [7, 30, 90, 365];

const ok = (value, extra = {}) => ({ available: true, value, ...extra });
const na = (reason) => ({ available: false, value: null, reason });
const int = (v) => Number(v || 0);

/** Record an integration failure. Never pass payloads; tokens are scrubbed defensively. */
export async function recordIntegrationError(source, kind, detail = '') {
  const clean = String(detail || '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>').replace(/[^\s@]+@[^\s@]+/g, '<email>').slice(0, 300);
  try {
    await db.query('INSERT INTO integration_errors (source, kind, detail) VALUES ($1, $2, $3)', [source, kind, clean]);
  } catch { /* never let error logging break the caller */ }
}

function suppress(rows) {
  return rows.map((r) => (int(r.n) < SUPPRESS_BELOW
    ? { label: r.label, count: null, suppressed: true }
    : { label: r.label, count: int(r.n), suppressed: false }));
}

function rate(num, den, reason) {
  return den > 0 ? ok(Math.round((num / den) * 1000) / 10, { unit: '%', numerator: num, denominator: den }) : na(reason);
}

async function traffic(since) {
  const first = await db.one(`SELECT min(at) AS first FROM analytics_events WHERE name = 'page_view'`);
  if (!first?.first) {
    const reason = 'No page views recorded yet. First-party page-view tracking (JS-enabled browsers, no cookies) starts with the first visit after this deploy.';
    return { trackingSince: null, visitors: na(reason), pageViews: na(reason), daily: na(reason), topPaths: na(reason), topReferrers: na(reason) };
  }
  const t = await db.one(
    `SELECT count(DISTINCT visitor_uuid)::int AS visitors, count(*)::int AS views
       FROM analytics_events WHERE name = 'page_view' AND at >= $1`, [since]);
  const { rows: daily } = await db.query(
    `SELECT to_char(date_trunc('day', at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
            count(DISTINCT visitor_uuid)::int AS visitors, count(*)::int AS views
       FROM analytics_events WHERE name = 'page_view' AND at >= $1 GROUP BY 1 ORDER BY 1`, [since]);
  const { rows: paths } = await db.query(
    `SELECT path AS label, count(*)::int AS n FROM analytics_events
      WHERE name = 'page_view' AND at >= $1 AND path IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [since]);
  const { rows: refs } = await db.query(
    `SELECT COALESCE(utm_source, referrer_host) AS label, count(DISTINCT visitor_uuid)::int AS n FROM analytics_events
      WHERE name = 'page_view' AND at >= $1 AND COALESCE(utm_source, referrer_host) IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [since]);
  const partial = new Date(first.first) > new Date(since);
  const note = partial ? `Tracking started ${new Date(first.first).toISOString()}; earlier days in this window have no data.` : undefined;
  return {
    trackingSince: new Date(first.first).toISOString(),
    visitors: ok(t.visitors, { note: 'Distinct browsers (first-party id in localStorage). Excludes visitors without JavaScript or storage.' }),
    pageViews: ok(t.views, note ? { note } : {}),
    daily: ok(daily),
    topPaths: ok(paths.map((p) => ({ label: p.label, count: p.n }))),
    topReferrers: ok(refs.map((p) => ({ label: p.label, count: p.n })))
  };
}

async function registrations(since) {
  const r = await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= $1)::int AS new_in_window,
            count(*) FILTER (WHERE age_confirmed_21)::int AS age_confirmed,
            count(*) FILTER (WHERE bot_started)::int AS bot_started,
            count(*) FILTER (WHERE alerts_opt_in)::int AS alerts_opt_in,
            count(*) FILTER (WHERE status <> 'active')::int AS restricted
       FROM users`, [since]);
  const { rows: daily } = await db.query(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM users WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [since]);
  return {
    totalUsers: ok(r.total), newUsers: ok(r.new_in_window), ageConfirmed: ok(r.age_confirmed),
    botStarted: ok(r.bot_started), alertSubscribers: ok(r.alerts_opt_in), restricted: ok(r.restricted),
    daily: ok(daily.map((d) => ({ day: d.day, count: d.n })))
  };
}

async function demographics() {
  const resp = await db.one(
    `SELECT count(*)::int AS users,
            count(*) FILTER (WHERE gender IS NOT NULL)::int AS gender,
            count(*) FILTER (WHERE age_band IS NOT NULL)::int AS age_band,
            count(*) FILTER (WHERE city IS NOT NULL)::int AS city,
            count(*) FILTER (WHERE cardinality(interests) > 0)::int AS interests
       FROM users`);
  const dist = async (col, label) => {
    if (!resp[label]) return na(`No users have shared ${label.replace('_', ' ')} yet (optional, on the member page).`);
    const { rows } = await db.query(`SELECT ${col}::text AS label, count(*)::int AS n FROM users WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
    return ok(suppress(rows), { respondents: resp[label], of: resp.users });
  };
  let interests;
  if (!resp.interests) interests = na('No users have shared interests yet (optional, on the member page).');
  else {
    const { rows } = await db.query(`SELECT i AS label, count(*)::int AS n FROM users, unnest(interests) AS i GROUP BY 1 ORDER BY 2 DESC`);
    interests = ok(suppress(rows), { respondents: resp.interests, of: resp.users });
  }
  return {
    note: `Voluntary self-reported data. Buckets with fewer than ${SUPPRESS_BELOW} people are hidden.`,
    gender: await dist('gender', 'gender'),
    ageBand: await dist('age_band', 'age_band'),
    city: await dist('lower(city)', 'city'),
    interests
  };
}

async function bookings(since) {
  const { rows: byStatus } = await db.query(
    `SELECT b.status::text AS label, count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.created_at >= $1 AND NOT e.is_demo GROUP BY 1 ORDER BY 1`, [since]);
  const { rows: byCategory } = await db.query(
    `SELECT e.category::text AS label, count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.created_at >= $1 AND b.status IN ('confirmed','checked_in') AND NOT e.is_demo GROUP BY 1 ORDER BY 2 DESC`, [since]);
  const { rows: upcoming } = await db.query(
    `SELECT e.id, e.title, e.start_at, e.capacity, e.category,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed','checked_in')) AS confirmed,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'pending_payment' AND b.hold_expires_at > now()) AS holds
       FROM events e WHERE e.status = 'published' AND e.start_at > now() AND NOT e.is_demo AND e.source = 'internal'
      ORDER BY e.start_at LIMIT 25`);
  const ev = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'published' AND start_at > now() AND NOT is_demo AND source = 'internal')::int AS internal_upcoming,
            count(*) FILTER (WHERE status = 'published' AND start_at > now() AND source = 'external')::int AS external_upcoming,
            count(*) FILTER (WHERE status = 'published' AND start_at > now() AND is_demo)::int AS sample_upcoming
       FROM events`);
  return {
    byStatus: ok(byStatus.map((r) => ({ label: r.label, count: r.n }))),
    confirmedByCategory: ok(byCategory.map((r) => ({ label: r.label, count: r.n }))),
    upcomingFill: ok(upcoming),
    upcomingInternalEvents: ok(ev.internal_upcoming),
    upcomingExternalListings: ok(ev.external_upcoming),
    upcomingSampleEvents: ok(ev.sample_upcoming)
  };
}

async function revenue(since) {
  const r = await db.one(
    `SELECT COALESCE(sum(amount) FILTER (WHERE currency = 'INR' AND NOT is_test AND status IN ('paid','refunded')), 0)::bigint AS live_gross,
            COALESCE(sum(amount) FILTER (WHERE currency = 'INR' AND NOT is_test AND status = 'refunded'), 0)::bigint AS live_refunded,
            COALESCE(sum(amount) FILTER (WHERE currency = 'INR' AND is_test AND status IN ('paid','refunded')), 0)::bigint AS test_gross,
            COALESCE(sum(amount) FILTER (WHERE currency = 'XTR' AND status IN ('paid','refunded')), 0)::bigint AS stars,
            count(*) FILTER (WHERE status = 'paid' AND purpose = 'ticket')::int AS paid_tickets
       FROM payments WHERE COALESCE(paid_at, created_at) >= $1`, [since]);
  const live = livePayments();
  const sp = await db.one(
    `SELECT count(*)::int AS events, count(amount_paise)::int AS with_amount, COALESCE(sum(amount_paise), 0)::bigint AS paise
       FROM superprofile_events WHERE event_type = 'purchase' AND COALESCE(occurred_at, received_at) >= $1`, [since]);
  let superprofile;
  if (!superprofileConfigured() && !sp.events) superprofile = na('SuperProfile is not connected (SUPERPROFILE_WEBHOOK_SECRET not set, no events received).');
  else if (sp.events && !sp.with_amount) superprofile = na('SuperProfile events were received but carried no amount field.');
  else superprofile = ok(int(sp.paise), { unit: 'paise', note: 'As reported by SuperProfile via automation; not reconciled with payouts.', purchases: sp.events });
  return {
    liveTicketGross: ok(int(r.live_gross), { unit: 'paise', note: live ? undefined : 'Live payments are disabled (ENABLE_LIVE_PAYMENTS=false).' }),
    liveTicketRefunded: ok(int(r.live_refunded), { unit: 'paise' }),
    sandboxTicketGross: ok(int(r.test_gross), { unit: 'paise', note: 'Test-mode payments — not real money.' }),
    paidTickets: ok(r.paid_tickets),
    starsReceived: ok(int(r.stars), { unit: 'stars' }),
    superprofile
  };
}

async function conversions(since, trafficSection) {
  const f = await db.one(
    `SELECT count(DISTINCT visitor_uuid) FILTER (WHERE name = 'page_view')::int AS visitors,
            count(DISTINCT visitor_uuid) FILTER (WHERE name = 'event_view')::int AS event_viewers,
            count(DISTINCT visitor_uuid) FILTER (WHERE name = 'book_click')::int AS book_clickers,
            count(DISTINCT visitor_uuid) FILTER (WHERE name = 'checkout_start')::int AS checkout_starters,
            count(DISTINCT visitor_uuid) FILTER (WHERE name = 'membership_click')::int AS membership_clickers
       FROM analytics_events WHERE at >= $1`, [since]);
  const b = await db.one(
    `SELECT count(*) FILTER (WHERE b.status IN ('confirmed','checked_in'))::int AS confirmed, count(*)::int AS started
       FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.created_at >= $1 AND NOT e.is_demo`, [since]);
  const u = await db.one(`SELECT count(*)::int AS n FROM users WHERE created_at >= $1`, [since]);
  const noTraffic = 'No page-view data in this window.';
  return {
    funnel: trafficSection.trackingSince ? ok([
      { step: 'Visitors', count: f.visitors },
      { step: 'Viewed an event', count: f.event_viewers },
      { step: 'Clicked Book', count: f.book_clickers },
      { step: 'Reached checkout', count: f.checkout_starters },
      { step: 'Confirmed bookings', count: b.confirmed }
    ], { note: 'Steps 1–4 count distinct browsers; step 5 counts bookings.' }) : na(noTraffic),
    visitorToSignup: rate(u.n, f.visitors, noTraffic),
    eventViewToBookClick: rate(f.book_clickers, f.event_viewers, 'No event views in this window.'),
    bookingStartToConfirmed: rate(b.confirmed, b.started, 'No bookings started in this window.'),
    membershipClicks: trafficSection.trackingSince ? ok(f.membership_clickers) : na(noTraffic)
  };
}

async function membership(since) {
  const s = await db.one(
    `SELECT count(DISTINCT user_id) FILTER (WHERE status IN ('active','grace','cancelled') AND expires_at > now())::int AS active,
            count(*) FILTER (WHERE created_at >= $1)::int AS new_in_window,
            count(*) FILTER (WHERE status IN ('active','cancelled') AND expires_at BETWEEN now() AND now() + interval '7 days')::int AS expiring_7d,
            count(*) FILTER (WHERE revoked_at >= $1)::int AS revoked_in_window,
            count(*) FILTER (WHERE status = 'expired' AND revoked_at IS NULL)::int AS expired_pending_removal
       FROM entitlements`, [since]);
  const renewals = await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'membership.renewed' AND at >= $1`, [since]);
  const stars = {
    active: ok(s.active), newInWindow: ok(s.new_in_window), renewalsInWindow: ok(renewals.n), expiring7d: ok(s.expiring_7d),
    revokedInWindow: ok(s.revoked_in_window), expiredAwaitingRemoval: ok(s.expired_pending_removal)
  };
  const anySp = await db.one('SELECT count(*)::int AS n FROM superprofile_events');
  let superprofile;
  if (!superprofileConfigured() && !anySp.n) {
    const reason = 'SuperProfile is not connected (SUPERPROFILE_WEBHOOK_SECRET not set, no events received).';
    superprofile = { active: na(reason), newInWindow: na(reason), renewalsInWindow: na(reason), expiredInWindow: na(reason), abandonedInWindow: na(reason), unmappedProducts: na(reason) };
  } else {
    const m = await db.one(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE started_at >= $1)::int AS new_in_window,
              count(*) FILTER (WHERE expired_at >= $1)::int AS expired_in_window
         FROM superprofile_memberships`, [since]);
    const e = await db.one(
      `SELECT count(*) FILTER (WHERE event_type = 'purchase')::int AS purchases,
              count(*) FILTER (WHERE event_type = 'purchase_abandoned')::int AS abandoned,
              count(*) FILTER (WHERE event_type = 'purchase' AND email_hash IS NULL)::int AS no_email,
              (SELECT count(DISTINCT product_ref)::int FROM superprofile_events WHERE tier_id IS NULL AND product_ref IS NOT NULL) AS unmapped
         FROM superprofile_events WHERE COALESCE(occurred_at, received_at) >= $1`, [since]);
    const note = anySp.n ? undefined : 'Connected, but no SuperProfile events have been received yet.';
    superprofile = {
      active: ok(m.active, note ? { note } : (e.no_email ? { note: `${e.no_email} purchase event(s) had no email and cannot be tracked per member.` } : {})),
      newInWindow: ok(m.new_in_window),
      renewalsInWindow: ok(Math.max(0, e.purchases - m.new_in_window)),
      expiredInWindow: ok(m.expired_in_window),
      abandonedInWindow: ok(e.abandoned),
      unmappedProducts: ok(e.unmapped, { note: 'Products not linked to a tier (set the product reference on the tier).' })
    };
  }
  return { stars, superprofile, note: 'Stars and SuperProfile members are counted separately; one person could appear in both.' };
}

async function feeds() {
  const { rows } = await db.query(
    `SELECT f.id, f.name, f.url, f.active, f.last_status, f.last_error, f.last_fetched_at, f.last_success_at, f.last_item_count, f.consecutive_failures,
            (SELECT count(*)::int FROM event_candidates c WHERE c.feed_id = f.id AND c.status = 'pending') AS pending,
            (SELECT count(*)::int FROM event_candidates c WHERE c.feed_id = f.id AND c.status = 'approved') AS approved
       FROM event_feeds f ORDER BY f.name`);
  const q = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'duplicate')::int AS duplicate,
            count(*) FILTER (WHERE status = 'pending' AND origin = 'submission')::int AS pending_submissions,
            count(*) FILTER (WHERE status = 'pending' AND start_at IS NULL)::int AS pending_without_date
       FROM event_candidates`);
  return {
    feeds: ok(rows.map((f) => ({
      ...f,
      health: !f.active ? 'paused' : !f.last_fetched_at ? 'never_fetched' : f.consecutive_failures > 0 ? 'failing' : 'healthy'
    }))),
    queue: ok(q)
  };
}

async function failures(since) {
  const { rows: pay } = await db.query(
    `SELECT COALESCE(failure_reason, 'unknown') AS label, count(*)::int AS n FROM payments
      WHERE status = 'failed' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [since]);
  const { rows: notif } = await db.query(
    `SELECT kind AS label, count(*)::int AS n, max(last_error) AS sample_error FROM notifications
      WHERE status = 'failed' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`, [since]);
  const stuck = await db.one(
    `SELECT count(*)::int AS n FROM notifications WHERE status = 'pending' AND next_attempt_at < now() - interval '15 minutes'`);
  const { rows: integ } = await db.query(
    `SELECT source, kind, count(*)::int AS n, max(at) AS last_at,
            (array_agg(detail ORDER BY at DESC))[1] AS last_detail
       FROM integration_errors WHERE at >= $1 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, [since]);
  const wh = await db.one(
    `SELECT count(*)::int AS n FROM webhook_events WHERE processed_at IS NULL AND received_at < now() - interval '10 minutes'`);
  const refundsDue = await db.one(
    `SELECT count(*)::int AS n FROM bookings WHERE cancel_reason = 'paid_but_unavailable_refund_due' AND status <> 'refunded'`);
  return {
    failedPayments: ok(pay.map((r) => ({ label: r.label, count: r.n }))),
    failedNotifications: ok(notif.map((r) => ({ label: r.label, count: r.n, sampleError: r.sample_error }))),
    overdueNotifications: ok(stuck.n),
    integrationErrors: ok(integ),
    unprocessedWebhooks: ok(wh.n),
    refundsDue: ok(refundsDue.n)
  };
}

export async function getInsights(days) {
  const windowDays = WINDOWS.includes(days) ? days : 30;
  const since = new Date(Date.now() - windowDays * 864e5).toISOString();
  const t = await traffic(since);
  const [reg, demo, book, rev, conv, mem, fd, fail] = await Promise.all([
    registrations(since), demographics(), bookings(since), revenue(since), conversions(since, t), membership(since), feeds(), failures(since)
  ]);
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    since,
    traffic: t,
    registrations: reg,
    demographics: demo,
    bookings: book,
    revenue: rev,
    conversions: conv,
    membership: mem,
    discovery: fd,
    failures: fail,
    config: configStatus()
  };
}
