// lib/handlers/campaigns.js - HTTP API handlers for opt-in promotional campaigns, audience preview, approval, and delivery logs.
import { HttpError, readJson, sendJson, hashIp } from '../http.js';
import { requireUser, requireCsrf, getSessionUser } from '../session.js';
import { parse, z, uuid } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { db } from '../db.js';
import { manageableEvent } from '../services/ticketing.js';
import {
  previewCampaignAudience,
  createCampaign,
  getCampaign,
  listCampaigns,
  approveCampaign,
  cancelCampaign,
  dispatchCampaign,
  getCampaignLogs
} from '../services/promotional-campaign.js';
import { handleOptOutKeyword } from '../services/notification-dispatcher.js';
import { normalizePhoneNumber } from '../services/phone.js';
import { recordConsent } from '../services/communication-consent.js';

async function isSuperAdminUser(user, client = db) {
  if (!user?.telegram_user_id) return false;
  const { rows } = await client.query(
    'SELECT 1 FROM admin_users WHERE telegram_user_id = $1 AND active AND role = $2',
    [user.telegram_user_id, 'super_admin']
  );
  return rows.length > 0;
}

const CampaignPreviewBody = z.object({
  eventId: uuid,
  targetCity: z.string().trim().max(100).nullable().optional(),
  targetCategory: z.string().trim().max(100).nullable().optional()
});

const CreateCampaignBody = z.object({
  eventId: uuid,
  title: z.string().trim().min(3).max(160).optional(),
  targetCity: z.string().trim().max(100).nullable().optional(),
  targetCategory: z.string().trim().max(100).nullable().optional()
});

const UnsubscribeBody = z.object({
  phone: z.string().trim().min(8).max(20).optional(),
  channel: z.enum(['whatsapp', 'telegram', 'email', 'sms']).default('whatsapp'),
  reason: z.string().trim().max(100).default('user_unsubscribed')
});

/**
 * POST /api/campaigns/preview — Previews audience count, cost, and sample WhatsApp template.
 */
export async function previewCampaignHandler({ req, res }) {
  const user = await requireUser(req);
  const body = parse(CampaignPreviewBody, await readJson(req));

  // Authorize user for this event (organiser or admin)
  await manageableEvent(user, body.eventId);

  const preview = await previewCampaignAudience({
    eventId: body.eventId,
    targetCity: body.targetCity,
    targetCategory: body.targetCategory
  });

  return sendJson(res, 200, preview);
}

/**
 * POST /api/campaigns — Creates a new campaign draft.
 */
export async function createCampaignHandler({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`campaign_create:${user.id}`, 20, 300);

  const body = parse(CreateCampaignBody, await readJson(req));
  const event = await manageableEvent(user, body.eventId);

  const campaign = await createCampaign({
    eventId: body.eventId,
    createdByUserId: user.id,
    organiserOrgId: event.organiser_org_id || null,
    title: body.title,
    targetCity: body.targetCity,
    targetCategory: body.targetCategory
  });

  return sendJson(res, 201, { ok: true, campaign });
}

/**
 * GET /api/campaigns — Lists promotional campaigns.
 */
export async function listCampaignsHandler({ req, res, query }) {
  const user = await requireUser(req);
  const eventId = query.get('eventId');
  const isSuperAdmin = await isSuperAdminUser(user);

  if (eventId) {
    await manageableEvent(user, eventId);
  }

  const campaigns = await listCampaigns({
    eventId,
    userId: user.id,
    isSuperAdmin
  });

  return sendJson(res, 200, { ok: true, campaigns });
}

/**
 * GET /api/campaigns/:id — Gets a campaign's detail.
 */
export async function getCampaignHandler({ req, res, params }) {
  const user = await requireUser(req);
  const campaign = await getCampaign({ campaignId: params.id });
  const isSuperAdmin = await isSuperAdminUser(user);

  if (!isSuperAdmin) {
    await manageableEvent(user, campaign.event_id);
  }

  return sendJson(res, 200, { ok: true, campaign });
}

/**
 * POST /api/campaigns/:id/approve — Approves a campaign.
 */
export async function approveCampaignHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const campaign = await getCampaign({ campaignId: params.id });
  const isSuperAdmin = await isSuperAdminUser(user);

  if (!isSuperAdmin) {
    await manageableEvent(user, campaign.event_id);
  }

  const updated = await approveCampaign({
    campaignId: params.id,
    approvedByUserId: user.id
  });

  return sendJson(res, 200, { ok: true, campaign: updated });
}

/**
 * POST /api/campaigns/:id/cancel — Cancels a campaign.
 */
export async function cancelCampaignHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const campaign = await getCampaign({ campaignId: params.id });
  const isSuperAdmin = await isSuperAdminUser(user);

  if (!isSuperAdmin) {
    await manageableEvent(user, campaign.event_id);
  }

  const updated = await cancelCampaign({
    campaignId: params.id,
    userId: user.id
  });

  return sendJson(res, 200, { ok: true, campaign: updated });
}

/**
 * POST /api/campaigns/:id/dispatch — Dispatches or simulates campaign sending.
 */
export async function dispatchCampaignHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`campaign_dispatch:${user.id}`, 10, 300);

  const campaign = await getCampaign({ campaignId: params.id });
  const isSuperAdmin = await isSuperAdminUser(user);

  if (!isSuperAdmin) {
    await manageableEvent(user, campaign.event_id);
  }

  const result = await dispatchCampaign({
    campaignId: params.id,
    triggeredByUserId: user.id
  });

  return sendJson(res, 200, result);
}

/**
 * GET /api/campaigns/:id/logs — Retrieves delivery logs for a campaign.
 */
export async function getCampaignLogsHandler({ req, res, params }) {
  const user = await requireUser(req);
  const campaign = await getCampaign({ campaignId: params.id });
  const isSuperAdmin = await isSuperAdminUser(user);

  if (!isSuperAdmin) {
    await manageableEvent(user, campaign.event_id);
  }

  const logs = await getCampaignLogs({ campaignId: params.id });
  return sendJson(res, 200, { ok: true, logs });
}

/**
 * POST /api/notifications/unsubscribe — One-click unsubscribe endpoint.
 */
export async function unsubscribeHandler({ req, res, ip }) {
  await rateLimit(`unsub_ip:${hashIp(ip)}`, 20, 300);
  const sessionUser = await getSessionUser(req);
  const body = parse(UnsubscribeBody, await readJson(req).catch(() => ({})));

  let phone = body.phone;
  if (!phone && sessionUser && sessionUser.phone) {
    phone = sessionUser.phone;
  }

  if (phone) {
    const normalized = normalizePhoneNumber(phone);
    await handleOptOutKeyword({
      destination: normalized,
      channel: body.channel || 'whatsapp',
      reason: body.reason || 'user_unsubscribed'
    });
  }

  if (sessionUser) {
    await recordConsent({
      userId: sessionUser.id,
      channel: body.channel || 'whatsapp',
      purpose: 'promotional',
      status: 'opted_out',
      source: 'opt_out_link',
      ip
    });
  }

  return sendJson(res, 200, {
    ok: true,
    message: 'You have been unsubscribed from promotional marketing messages. Essential transactional notices remain active.'
  });
}
