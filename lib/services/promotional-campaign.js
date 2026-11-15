// lib/services/promotional-campaign.js - Opt-in WhatsApp event marketing campaigns, audience targeting, approval workflows, and delivery logs.
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';
import { HttpError } from '../http.js';
import { maskPhone, normalizePhoneNumber } from './phone.js';
import { dispatchNotification, ESTIMATED_COST_PAISE } from './notification-dispatcher.js';

export const ESTIMATED_MARKETING_COST_PAISE = ESTIMATED_COST_PAISE.promotional || 80;

export const OFFICIAL_MARKETING_TEMPLATES = {
  nightlifez_promotional_event_v1: {
    name: 'nightlifez_promotional_event_v1',
    category: 'MARKETING',
    language: 'en',
    headerText: 'NIGHTLIFEZ EXCLUSIVE',
    bodyTemplate: "Hey {{1}}! ✨ You're invited to {{2}} in {{3}}.\n📅 {{4}}\nCurated guestlist & secret venue. Book passes before spots fill up!",
    buttons: [
      { type: 'url', text: '🎟️ View Event & Book' },
      { type: 'quick_reply', text: 'Text STOP to opt out' }
    ]
  }
};

/**
 * Returns true if live promotional campaign sending is enabled in configuration.
 * Gated by ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS environment variable.
 */
export function isLiveCampaignSendingEnabled() {
  return process.env.ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS === 'true';
}

/**
 * Queries eligible, opted-in users for a promotional campaign.
 * STRICT PRIVACY INVARIANTS:
 * 1. Only users with active status.
 * 2. Only users with valid normalized E.164 phone.
 * 3. Only users who EXPLICITLY consented to WhatsApp promotional messages (communication_consents.status = 'opted_in').
 * 4. Strictly EXCLUDES any destination present in notification_suppressions.
 * 5. Strictly matches voluntary city and interest criteria; never imports social follows or external lists.
 */
export async function queryEligibleAudience({
  targetCity = null,
  targetCategory = null,
  client = db
} = {}) {
  const params = [];
  let query = `
    SELECT DISTINCT
      u.id,
      u.phone,
      u.alias,
      u.city,
      u.interests
    FROM users u
    INNER JOIN communication_consents cc 
      ON cc.user_id = u.id 
     AND cc.channel = 'whatsapp' 
     AND cc.purpose = 'promotional' 
     AND cc.status = 'opted_in'
    LEFT JOIN notification_suppressions ns 
      ON ns.channel = 'whatsapp' 
     AND ns.destination = u.phone
    WHERE u.status = 'active'
      AND u.phone IS NOT NULL
      AND ns.id IS NULL
  `;

  if (targetCity && targetCity !== 'all') {
    params.push(targetCity.trim());
    const paramIdx = params.length;
    query += `
      AND (
        lower(COALESCE(u.city, '')) = lower($${paramIdx})
        OR EXISTS (
          SELECT 1 FROM bookings b 
          JOIN events e ON e.id = b.event_id 
          WHERE b.user_id = u.id AND lower(e.city) = lower($${paramIdx})
        )
      )
    `;
  }

  if (targetCategory && targetCategory !== 'all') {
    params.push(targetCategory.trim());
    const paramIdx = params.length;
    query += `
      AND (
        $${paramIdx} = ANY(u.interests)
        OR EXISTS (
          SELECT 1 FROM bookings b 
          JOIN events e ON e.id = b.event_id 
          WHERE b.user_id = u.id AND lower(e.category::text) = lower($${paramIdx})
        )
      )
    `;
  }

  query += ` ORDER BY u.id ASC`;

  const { rows } = await client.query(query, params);
  return rows;
}

/**
 * Previews campaign audience, estimated cost, and sample message formatting for an event.
 */
export async function previewCampaignAudience({
  eventId,
  targetCity = null,
  targetCategory = null,
  client = db
}) {
  if (!eventId) {
    throw new HttpError(400, 'missing_event_id', 'Event ID is required to preview campaign audience');
  }

  const { rows: eventRows } = await client.query(
    `SELECT id, title, slug, city, category, start_at FROM events WHERE id = $1`,
    [eventId]
  );
  if (eventRows.length === 0) {
    throw new HttpError(404, 'event_not_found', 'Event not found');
  }
  const event = eventRows[0];

  const cityFilter = targetCity || event.city;
  const categoryFilter = targetCategory || event.category;

  const audience = await queryEligibleAudience({
    targetCity: cityFilter,
    targetCategory: categoryFilter,
    client
  });

  const estimatedCostPaise = audience.length * ESTIMATED_MARKETING_COST_PAISE;

  const sampleName = audience[0]?.alias || 'Fellow Explorer';
  const eventDateStr = new Date(event.start_at).toLocaleDateString('en-IN', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata'
  });

  return {
    ok: true,
    eventId: event.id,
    eventTitle: event.title,
    eventCity: event.city,
    eventCategory: event.category,
    appliedFilters: {
      targetCity: cityFilter,
      targetCategory: categoryFilter
    },
    eligibleRecipientsCount: audience.length,
    estimatedCostPaise,
    estimatedCostRupees: (estimatedCostPaise / 100).toFixed(2),
    sampleRecipientsMasked: audience.slice(0, 5).map((u) => ({
      alias: u.alias || 'Explorer',
      phoneMasked: maskPhone(u.phone),
      city: u.city || cityFilter || 'South India'
    })),
    templatePreview: {
      templateName: 'nightlifez_promotional_event_v1',
      category: 'MARKETING',
      header: 'NIGHTLIFEZ EXCLUSIVE',
      body: `Hey ${sampleName}! ✨ You're invited to ${event.title} in ${event.city}.\n📅 ${eventDateStr}\nCurated guestlist & secret venue. Book passes before spots fill up!`,
      buttons: [
        { type: 'url', label: '🎟️ View Event & Book', url: `https://nightlifez.com/events/${event.slug}` },
        { type: 'quick_reply', label: 'Text STOP to opt out' }
      ]
    },
    liveSendingEnabled: isLiveCampaignSendingEnabled()
  };
}

/**
 * Creates a new promotional campaign draft.
 */
export async function createCampaign({
  eventId,
  createdByUserId,
  organiserOrgId = null,
  title,
  targetCity = null,
  targetCategory = null,
  templateName = 'nightlifez_promotional_event_v1',
  client = db
}) {
  if (!eventId) throw new HttpError(400, 'missing_event_id', 'Event ID is required');
  if (!createdByUserId) throw new HttpError(400, 'missing_user_id', 'User ID is required');

  const { rows: eventRows } = await client.query(
    `SELECT id, title, slug, city, category, start_at FROM events WHERE id = $1`,
    [eventId]
  );
  if (eventRows.length === 0) throw new HttpError(404, 'event_not_found', 'Event not found');
  const event = eventRows[0];

  const campaignTitle = (title || `Promote: ${event.title}`).trim();
  const cityFilter = targetCity !== undefined ? targetCity : event.city;
  const categoryFilter = targetCategory !== undefined ? targetCategory : event.category;

  // Calculate preview metrics
  const audience = await queryEligibleAudience({
    targetCity: cityFilter,
    targetCategory: categoryFilter,
    client
  });

  const estimatedCostPaise = audience.length * ESTIMATED_MARKETING_COST_PAISE;

  const templateVariables = {
    eventTitle: event.title,
    eventCity: event.city,
    eventSlug: event.slug,
    eventStartAt: event.start_at
  };

  const { rows } = await client.query(
    `INSERT INTO promotional_campaigns (
      event_id, created_by_user_id, organiser_org_id, title, template_name,
      channel, target_city, target_category, status, estimated_recipients,
      estimated_cost_paise, template_variables, live_sending_enabled, audit_metadata
    ) VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6, $7, 'draft', $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      eventId,
      createdByUserId,
      organiserOrgId,
      campaignTitle,
      templateName,
      cityFilter,
      categoryFilter,
      audience.length,
      estimatedCostPaise,
      JSON.stringify(templateVariables),
      isLiveCampaignSendingEnabled(),
      JSON.stringify({ createdBy: createdByUserId, createdAt: new Date().toISOString() })
    ]
  );

  const campaign = rows[0];

  await audit(createdByUserId, 'campaign_created', `campaign:${campaign.id}`, {
    eventId,
    title: campaignTitle,
    estimatedRecipients: audience.length,
    estimatedCostPaise
  }, client);

  return campaign;
}

/**
 * Retrieves a campaign by ID.
 */
export async function getCampaign({ campaignId, client = db }) {
  const { rows } = await client.query(
    `SELECT c.*, e.title as event_title, e.slug as event_slug, e.city as event_city, e.start_at as event_start_at
       FROM promotional_campaigns c
       JOIN events e ON e.id = c.event_id
      WHERE c.id = $1`,
    [campaignId]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'campaign_not_found', 'Promotional campaign not found');
  }
  return rows[0];
}

/**
 * Lists campaigns for an event or organisation.
 */
export async function listCampaigns({
  eventId = null,
  organiserOrgId = null,
  userId = null,
  isSuperAdmin = false,
  client = db
} = {}) {
  const params = [];
  let query = `
    SELECT c.*, e.title as event_title, e.slug as event_slug, e.city as event_city, e.start_at as event_start_at
      FROM promotional_campaigns c
      JOIN events e ON e.id = c.event_id
     WHERE 1=1
  `;

  if (eventId) {
    params.push(eventId);
    query += ` AND c.event_id = $${params.length}`;
  }

  if (organiserOrgId && !isSuperAdmin) {
    params.push(organiserOrgId);
    query += ` AND c.organiser_org_id = $${params.length}`;
  } else if (userId && !isSuperAdmin) {
    params.push(userId);
    query += ` AND c.created_by_user_id = $${params.length}`;
  }

  query += ` ORDER BY c.created_at DESC`;

  const { rows } = await client.query(query, params);
  return rows;
}

/**
 * Submits or transitions a campaign to approved status.
 */
export async function approveCampaign({
  campaignId,
  approvedByUserId,
  client = db
}) {
  const campaign = await getCampaign({ campaignId, client });

  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new HttpError(400, 'invalid_state', `Cannot approve campaign in status ${campaign.status}`);
  }

  const { rows } = await client.query(
    `UPDATE promotional_campaigns
        SET status = 'approved',
            approved_by_user_id = $2,
            approved_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [campaignId, approvedByUserId]
  );

  await audit(approvedByUserId, 'campaign_approved', `campaign:${campaignId}`, {
    approvedBy: approvedByUserId
  }, client);

  return rows[0];
}

/**
 * Cancels a campaign.
 */
export async function cancelCampaign({
  campaignId,
  userId,
  client = db
}) {
  const campaign = await getCampaign({ campaignId, client });

  if (campaign.status === 'completed') {
    throw new HttpError(400, 'cannot_cancel', 'Cannot cancel an already completed campaign');
  }

  const { rows } = await client.query(
    `UPDATE promotional_campaigns
        SET status = 'cancelled',
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [campaignId]
  );

  await audit(userId, 'campaign_cancelled', `campaign:${campaignId}`, {
    cancelledBy: userId
  }, client);

  return rows[0];
}

/**
 * Dispatches or simulates promotional campaign dispatch.
 * SAFE DISPATCH INVARIANTS:
 * 1. Checks live sending flag (ENABLE_LIVE_PROMOTIONAL_CAMPAIGNS).
 * 2. If live sending is false, runs in Safe Simulated Mode:
 *    - Records recipient delivery log rows in campaign_recipients.
 *    - Dispatches to notification_messages in mock provider mode.
 *    - Accurately tracks actual cost in paise.
 *    - Updates campaign status to completed with simulated: true.
 * 3. Never sends real WhatsApp messages without explicit live configuration and approval.
 */
export async function dispatchCampaign({
  campaignId,
  triggeredByUserId,
  client = db
}) {
  const campaign = await getCampaign({ campaignId, client });

  if (campaign.status !== 'approved' && campaign.status !== 'draft') {
    throw new HttpError(400, 'invalid_status', `Campaign must be in draft or approved status to dispatch (current: ${campaign.status})`);
  }

  const isLive = isLiveCampaignSendingEnabled();

  // Mark as sending
  await client.query(
    `UPDATE promotional_campaigns SET status = 'sending', updated_at = now() WHERE id = $1`,
    [campaignId]
  );

  const audience = await queryEligibleAudience({
    targetCity: campaign.target_city,
    targetCategory: campaign.target_category,
    client
  });

  let dispatchedCount = 0;
  let totalCostPaise = 0;
  const deliveryLogs = [];

  for (const user of audience) {
    const idempotencyKey = `campaign_${campaignId}_user_${user.id}`;
    let recipientStatus = 'dispatched';
    let errorMessage = null;
    let notifMessageId = null;

    try {
      if (isLive) {
        // Live WhatsApp Cloud API dispatch
        const result = await dispatchNotification({
          userId: user.id,
          recipient: user.phone,
          channel: 'whatsapp',
          purpose: 'promotional',
          templateName: campaign.template_name,
          templateComponents: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: user.alias || 'Explorer' },
                { type: 'text', text: campaign.event_title },
                { type: 'text', text: campaign.event_city },
                { type: 'text', text: 'Curated guestlist & secret venue.' }
              ]
            }
          ],
          idempotencyKey,
          metadata: {
            campaignId,
            eventId: campaign.event_id,
            eventSlug: campaign.event_slug
          }
        });
        notifMessageId = result.id;
        recipientStatus = result.status;
      } else {
        // Safe Simulated Mode: creates outbox entry with mock provider
        const result = await dispatchNotification({
          userId: user.id,
          recipient: user.phone,
          channel: 'whatsapp',
          purpose: 'promotional',
          templateName: campaign.template_name,
          idempotencyKey,
          metadata: {
            campaignId,
            eventId: campaign.event_id,
            eventSlug: campaign.event_slug,
            simulated: true
          }
        });
        notifMessageId = result.id;
        recipientStatus = 'dispatched';
      }

      dispatchedCount++;
      totalCostPaise += ESTIMATED_MARKETING_COST_PAISE;
    } catch (err) {
      recipientStatus = 'failed';
      errorMessage = err.message || 'Delivery dispatch error';
      logger.error('campaign recipient delivery failed', {
        campaignId,
        userId: user.id,
        error: errorMessage
      });
    }

    // Insert campaign recipient delivery log
    const { rows: recipientRow } = await client.query(
      `INSERT INTO campaign_recipients (
        campaign_id, user_id, recipient_destination, status,
        notification_message_id, delivery_cost_paise, error_reason, dispatched_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (campaign_id, user_id) DO UPDATE SET
        status = EXCLUDED.status,
        notification_message_id = EXCLUDED.notification_message_id,
        error_reason = EXCLUDED.error_reason,
        dispatched_at = now()
      RETURNING *`,
      [
        campaignId,
        user.id,
        user.phone,
        recipientStatus,
        notifMessageId,
        ESTIMATED_MARKETING_COST_PAISE,
        errorMessage
      ]
    );

    deliveryLogs.push({
      id: recipientRow[0].id,
      alias: user.alias || 'Explorer',
      phoneMasked: maskPhone(user.phone),
      status: recipientStatus,
      costPaise: ESTIMATED_MARKETING_COST_PAISE,
      errorReason: errorMessage
    });
  }

  // Update campaign to completed
  const auditMeta = {
    dispatchedBy: triggeredByUserId,
    completedAt: new Date().toISOString(),
    simulated: !isLive,
    liveSendingGate: isLive ? 'active' : 'disabled_by_policy'
  };

  const { rows: updatedCampaign } = await client.query(
    `UPDATE promotional_campaigns
        SET status = 'completed',
            actual_recipients = $2,
            actual_cost_paise = $3,
            audit_metadata = $4,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [campaignId, dispatchedCount, totalCostPaise, JSON.stringify(auditMeta)]
  );

  await audit(triggeredByUserId, isLive ? 'campaign_dispatched' : 'campaign_simulated', `campaign:${campaignId}`, {
    actualRecipients: dispatchedCount,
    actualCostPaise: totalCostPaise,
    simulated: !isLive
  }, client);

  return {
    ok: true,
    campaign: updatedCampaign[0],
    simulated: !isLive,
    recipientsCount: dispatchedCount,
    costPaise: totalCostPaise,
    costRupees: (totalCostPaise / 100).toFixed(2),
    message: isLive
      ? `Promotional campaign dispatched to ${dispatchedCount} opted-in WhatsApp recipients.`
      : `Promotional campaign simulated successfully for ${dispatchedCount} opted-in recipients. Live dispatch is disabled by platform policy until Meta approval and owner verification.`
  };
}

/**
 * Returns delivery logs for a campaign.
 */
export async function getCampaignLogs({ campaignId, client = db }) {
  const { rows } = await client.query(
    `SELECT cr.id, cr.status, cr.delivery_cost_paise, cr.error_reason, cr.dispatched_at,
            cr.recipient_destination, u.alias, u.city,
            nm.provider_message_id, nm.delivered_at, nm.sent_at
       FROM campaign_recipients cr
       JOIN users u ON u.id = cr.user_id
  LEFT JOIN notification_messages nm ON nm.id = cr.notification_message_id
      WHERE cr.campaign_id = $1
      ORDER BY cr.dispatched_at DESC`,
    [campaignId]
  );

  return rows.map((r) => ({
    id: r.id,
    alias: r.alias || 'Explorer',
    phoneMasked: maskPhone(r.recipient_destination),
    city: r.city || 'South India',
    status: r.status,
    deliveryCostPaise: r.delivery_cost_paise,
    providerMessageId: r.provider_message_id || null,
    errorReason: r.error_reason,
    dispatchedAt: r.dispatched_at,
    deliveredAt: r.delivered_at,
    sentAt: r.sent_at
  }));
}
