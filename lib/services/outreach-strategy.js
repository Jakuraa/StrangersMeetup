// lib/services/outreach-strategy.js - Decision engine & governance framework for Personal vs Automated outreach on NIGHTLIFEZ.

/**
 * Valid contact and relationship types.
 */
export const RELATIONSHIP_TYPES = {
  COMMUNITY_OWNER: 'community_owner',
  INFLUENCER: 'influencer',
  EVENT_ORGANISER: 'event_organiser',
  BRAND_PARTNER: 'brand_partner',
  SPONSOR: 'sponsor',
  INBOUND_LEAD: 'inbound_lead',
  REGISTERED_USER: 'registered_user',
  ATTENDEE: 'attendee',
  EXTERNAL_CONTACT: 'external_contact'
};

/**
 * Valid sources of contacts.
 */
export const CONTACT_SOURCES = {
  SIGNUP_OPTIN: 'signup_optin',
  ACCOUNT_SETTINGS: 'account_settings',
  DIRECT_INQUIRY: 'direct_inquiry',
  PARTNER_APPLICATION: 'partner_application',
  INSTAGRAM_FOLLOW: 'instagram_follow',
  PUBLIC_PROFILE: 'public_profile',
  SCRAPED_LIST: 'scraped_list',
  PURCHASE_HISTORY: 'purchase_history',
  AUTH_OTP: 'auth_otp'
};

/**
 * Core decision rule evaluating whether a contact is eligible for Personal Outreach,
 * Automated Outreach, or must be Excluded (No Outreach).
 *
 * DECISION RULES:
 * 1. Partner or influencer relationship -> PERSONAL OUTREACH.
 * 2. Inbound direct inquiry / explicit request -> PERSONAL OUTREACH.
 * 3. Existing NIGHTLIFEZ user with verified explicit marketing consent -> AUTOMATED OUTREACH.
 * 4. Scraped, social-follow, or inferred consent (e.g. ticket purchase, OTP) -> EXCLUDED (NO OUTREACH).
 * 5. No marketing consent -> NO PROMOTIONAL MESSAGE.
 * 6. Unclear consent or eligibility -> FAIL-CLOSED EXCLUDE FROM CAMPAIGN.
 */
export function evaluateOutreachDecision({
  name,
  relationshipType,
  source,
  hasExplicitMarketingConsent = false,
  isRegisteredUser = false,
  requestedInformation = false,
  phone = null
} = {}) {
  // Prohibited sources: Instagram scraping, third-party lists, unsolicited scraping
  const prohibitedSources = [
    CONTACT_SOURCES.INSTAGRAM_FOLLOW,
    CONTACT_SOURCES.PUBLIC_PROFILE,
    CONTACT_SOURCES.SCRAPED_LIST
  ];

  if (prohibitedSources.includes(source)) {
    return {
      decision: 'PROHIBITED',
      channel: 'none',
      eligibleForAutomatedCampaign: false,
      eligibleForPersonalOutreach: false,
      reason: 'Strict anti-scraping policy: Scraped contacts, social followers, and public profiles are strictly prohibited from all outreach.',
      action: 'DROP_CONTACT'
    };
  }

  // Fallback checks against inferred consent violations:
  // "Never infer consent from an Instagram follow, public profile, phone number, previous ticket purchase or authentication OTP request."
  if (
    (source === CONTACT_SOURCES.PURCHASE_HISTORY || source === CONTACT_SOURCES.AUTH_OTP) &&
    !hasExplicitMarketingConsent
  ) {
    return {
      decision: 'NO_PROMOTIONAL_MESSAGE',
      channel: 'none',
      eligibleForAutomatedCampaign: false,
      eligibleForPersonalOutreach: false,
      reason: 'Consent cannot be inferred from previous ticket purchases or authentication OTP requests. Explicit promotional opt-in required.',
      action: 'EXCLUDE'
    };
  }

  // 1. Partner / Influencer / Community Owner / Inbound Business Inquiries:
  // (e.g. Rafiky, community owners, venue owners, brand sponsors, inbound partners)
  const personalOutreachTypes = [
    RELATIONSHIP_TYPES.COMMUNITY_OWNER,
    RELATIONSHIP_TYPES.INFLUENCER,
    RELATIONSHIP_TYPES.EVENT_ORGANISER,
    RELATIONSHIP_TYPES.BRAND_PARTNER,
    RELATIONSHIP_TYPES.SPONSOR,
    RELATIONSHIP_TYPES.INBOUND_LEAD
  ];

  if (personalOutreachTypes.includes(relationshipType) || requestedInformation) {
    return {
      decision: 'PERSONAL_OUTREACH',
      channel: 'manual_direct',
      eligibleForAutomatedCampaign: false, // Never put partners into bulk automated broadcasts!
      eligibleForPersonalOutreach: true,
      reason: 'Partner or influencer relationship (e.g., Rafiky, community owners, sponsors) requires genuine, 1-on-1 personal outreach.',
      action: 'MANUAL_PERSONAL_MESSAGE',
      governance: {
        method: 'Individual 1:1 message (Email, Instagram DM or WhatsApp) written by team member',
        rules: [
          'Must be individually targeted and relevant',
          'Do not scrape follower lists or harvest contact details',
          'Never send unsolicited bulk messages or automated bots',
          'Keep personal partner conversations completely separate from customer campaigns'
        ]
      }
    };
  }

  // 2. Existing NIGHTLIFEZ user with verified marketing consent:
  if (isRegisteredUser && hasExplicitMarketingConsent === true) {
    return {
      decision: 'AUTOMATED_OUTREACH',
      channel: 'whatsapp_campaign',
      eligibleForAutomatedCampaign: true,
      eligibleForPersonalOutreach: false,
      reason: 'Existing NIGHTLIFEZ user with verified marketing consent is eligible for automated campaigns.',
      action: 'INCLUDE_IN_CAMPAIGN',
      governance: {
        template: 'nightlifez_promotional_event_v1',
        requiresMetaApproval: true,
        optOutHandling: 'Mandatory STOP keyword / unsubscribe link support'
      }
    };
  }

  // 3. No marketing consent:
  if (hasExplicitMarketingConsent === false) {
    return {
      decision: 'NO_PROMOTIONAL_MESSAGE',
      channel: 'none',
      eligibleForAutomatedCampaign: false,
      eligibleForPersonalOutreach: false,
      reason: 'User has not granted marketing consent. Promotional messages are strictly forbidden.',
      action: 'EXCLUDE'
    };
  }

  // 4. Unclear consent or ambiguous eligibility: FAIL-CLOSED
  return {
    decision: 'UNCLEAR_ELIGIBILITY_EXCLUDE',
    channel: 'none',
    eligibleForAutomatedCampaign: false,
    eligibleForPersonalOutreach: false,
    reason: 'Unclear consent or eligibility. Fail-closed invariant excludes contact from the campaign.',
    action: 'EXCLUDE'
  };
}

/**
 * Genuine, bespoke personal outreach templates for partners and community leads (e.g. Rafiky).
 * NEVER sent via automated bots. Used by founders/organisers for genuine 1:1 engagement.
 */
export const PERSONAL_OUTREACH_GUIDES = {
  community_owner: {
    recipientType: 'Community Owner / Influencer (e.g. Rafiky)',
    objective: 'Co-hosting, cross-promotion, or curated community meetup collaboration',
    channel: 'Direct Email, Personal WhatsApp, or Direct Instagram Message',
    rules: [
      'Individually targeted and relevant to the creator community',
      'Reference specific context (e.g. their community events, recent gatherings)',
      'No unsolicited bulk blasts, spam, or automated bot scripts',
      'Provide clear, mutual value proposition'
    ],
    sampleTemplate: (partnerName = 'Rafiky', eventTitle = 'our upcoming secret mixer') => `Hey ${partnerName}! Hope you're having a great week. I love what you've built with your community in Chennai. We're hosting ${eventTitle} on NIGHTLIFEZ and would love to explore co-hosting or curating an exclusive table for your crew. Happy to share full details if you're open to collaborating!`
  },
  venue_brand_partner: {
    recipientType: 'Venue Owner / Brand Sponsor',
    objective: 'Venue partnership, exclusive booking privileges, or beverage brand sponsorship',
    channel: 'Direct Business Email or Scheduled In-Person Meeting',
    rules: [
      'Bespoke commercial proposal',
      'Tailored footfall and guest demographic estimates'
    ],
    sampleTemplate: (brandName = 'Partner Venue') => `Hi team ${brandName}, we host curated nightlife and social dining experiences across South India. We'd love to discuss hosting our upcoming private guestlist events at your venue on off-peak nights. Would you have 10 minutes for a quick chat this week?`
  }
};

/**
 * Builds a campaign tracking URL with attribution parameters.
 */
export function buildCampaignTrackingUrl({
  baseUrl = 'https://nightlifez.com',
  eventSlug,
  campaignId,
  channel = 'whatsapp',
  medium = 'campaign',
  refCode = null
}) {
  const url = new URL(`/events/${eventSlug}`, baseUrl);
  url.searchParams.set('utm_source', channel);
  url.searchParams.set('utm_medium', medium);
  if (campaignId) url.searchParams.set('utm_campaign', campaignId);
  if (refCode) url.searchParams.set('ref', refCode);
  return url.toString();
}
