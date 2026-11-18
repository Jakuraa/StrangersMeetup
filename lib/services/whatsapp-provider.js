// lib/services/whatsapp-provider.js - Official Meta WhatsApp Cloud API provider with pluggable adapter.
import crypto from 'node:crypto';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { safeEqual, HttpError } from '../http.js';
import { maskPhone } from './phone.js';

/**
 * Returns configuration state of WhatsApp Business Cloud API.
 */
export function getWhatsAppConfig() {
  const enabled = process.env.WHATSAPP_ENABLED === 'true';
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID', '');
  const businessAccountId = env('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
  const accessToken = env('WHATSAPP_ACCESS_TOKEN', '') || env('nightlifezapiadmin', '');
  const apiVersion = env('WHATSAPP_API_VERSION', 'v21.0');
  const otpTemplateName = env('WHATSAPP_OTP_TEMPLATE_NAME', 'nightlifez_auth_otp');
  const otpTemplateLanguage = env('WHATSAPP_OTP_TEMPLATE_LANGUAGE', 'en');
  const otpButtonType = env('WHATSAPP_OTP_BUTTON_TYPE', 'copy_code');
  const webhookSecret = env('WHATSAPP_WEBHOOK_SECRET', '');
  const webhookVerifyToken = env('WHATSAPP_WEBHOOK_VERIFY_TOKEN', '');

  const isConfigured = Boolean(phoneNumberId && accessToken);
  const isLive = enabled && isConfigured;

  return {
    enabled,
    isConfigured,
    isLive,
    phoneNumberId,
    businessAccountId,
    accessToken,
    apiVersion,
    otpTemplateName,
    otpTemplateLanguage,
    otpButtonType,
    webhookSecret,
    webhookVerifyToken
  };
}

/**
 * Builds standard Cloud API JSON payload for authentication OTP templates.
 * Supports copy_code, one_tap, zero_tap (fallback copy_code button), and none (body-only).
 */
export function buildOtpTemplatePayload({
  to,
  otp,
  templateName = 'nightlifez_auth_otp',
  language = 'en',
  buttonType = 'copy_code'
}) {
  const recipientDigits = String(to).replace(/^\+/, '');
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(otp) }
      ]
    }
  ];

  // If button is enabled ('copy_code', 'one_tap', 'zero_tap'), include button parameter at index 0.
  // In Meta Cloud API, button sub_type is 'url' for dynamic OTP variables.
  if (buttonType && buttonType !== 'none' && buttonType !== false) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [
        { type: 'text', text: String(otp) }
      ]
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientDigits,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components
    }
  };
}

/**
 * Base Provider Interface.
 */
export class WhatsAppProviderInterface {
  async sendOtpTemplate({ to, otp, language }) {
    throw new Error('sendOtpTemplate not implemented');
  }

  async sendTemplate({ to, templateName, language, components }) {
    throw new Error('sendTemplate not implemented');
  }

  verifyWebhookSignature({ rawBody, signatureHeader }) {
    throw new Error('verifyWebhookSignature not implemented');
  }
}

/**
 * Meta WhatsApp Business Platform Cloud API implementation.
 */
export class MetaCloudWhatsAppProvider extends WhatsAppProviderInterface {
  constructor(config = getWhatsAppConfig()) {
    super();
    this.config = config;
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  }

  async sendOtpTemplate({ to, otp, language, templateName, buttonType }) {
    const lang = language || this.config.otpTemplateLanguage || 'en';
    const tName = templateName || this.config.otpTemplateName || 'nightlifez_auth_otp';
    const bType = buttonType !== undefined ? buttonType : (this.config.otpButtonType || 'copy_code');

    const payload = buildOtpTemplatePayload({
      to,
      otp,
      templateName: tName,
      language: lang,
      buttonType: bType
    });

    logger.info('dispatching whatsapp otp via meta cloud api', {
      recipient: maskPhone(to),
      template: tName,
      lang,
      buttonType: bType
    });

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = data?.error?.message || `Meta Cloud API responded with status ${response.status}`;
      logger.error('meta whatsapp cloud api delivery error', {
        status: response.status,
        error: errorMsg,
        recipient: maskPhone(to)
      });
      throw new HttpError(502, 'whatsapp_delivery_failed', 'Failed to deliver WhatsApp message. Please try again or use Telegram.');
    }

    const messageId = data?.messages?.[0]?.id || `wamid.${crypto.randomBytes(12).toString('hex')}`;
    return {
      ok: true,
      messageId,
      templateName: tName,
      language: lang,
      buttonType: bType,
      provider: 'meta_cloud_api',
      status: 'sent',
      estimatedCostPaise: 15 // Meta authentication conversation pricing (~0.15 INR)
    };
  }

  async sendTemplate({ to, templateName, language = 'en', components = [] }) {
    const recipientDigits = to.replace(/^\+/, '');
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientDigits,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components
      }
    };

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new HttpError(502, 'whatsapp_delivery_failed', data?.error?.message || 'Meta Cloud API error');
    }

    return {
      ok: true,
      messageId: data?.messages?.[0]?.id,
      provider: 'meta_cloud_api',
      status: 'sent'
    };
  }

  verifyWebhookSignature({ rawBody, signatureHeader }) {
    if (!this.config.webhookSecret) return false;
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

    const signature = signatureHeader.slice(7);
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');

    return safeEqual(signature, expected);
  }
}

/**
 * Safe Development & Test Adapter.
 * Does NOT send real messages. Captures dispatches in memory for testing.
 */
export class StubWhatsAppProvider extends WhatsAppProviderInterface {
  constructor() {
    super();
    this.sentMessages = [];
  }

  async sendOtpTemplate({ to, otp, language, templateName, buttonType }) {
    const cfg = getWhatsAppConfig();
    const lang = language || cfg.otpTemplateLanguage || 'en';
    const tName = templateName || cfg.otpTemplateName || 'nightlifez_auth_otp';
    const bType = buttonType !== undefined ? buttonType : (cfg.otpButtonType || 'copy_code');

    const payload = buildOtpTemplatePayload({
      to,
      otp,
      templateName: tName,
      language: lang,
      buttonType: bType
    });

    const messageId = `wamid.mock_${crypto.randomBytes(10).toString('hex')}`;
    const record = {
      to,
      otp,
      language: lang,
      templateName: tName,
      buttonType: bType,
      payload,
      messageId,
      provider: 'mock',
      sentAt: new Date().toISOString()
    };
    this.sentMessages.push(record);

    logger.info('stub whatsapp otp dispatched (safe dev/test mode)', {
      recipient: maskPhone(to),
      messageId,
      template: tName,
      buttonType: bType
    });

    return {
      ok: true,
      messageId,
      templateName: tName,
      language: lang,
      buttonType: bType,
      provider: 'mock',
      status: 'sent',
      estimatedCostPaise: 15
    };
  }

  async sendTemplate({ to, templateName, language = 'en', components = [] }) {
    const messageId = `wamid.mock_${crypto.randomBytes(10).toString('hex')}`;
    this.sentMessages.push({
      to,
      templateName,
      language,
      components,
      messageId,
      provider: 'mock',
      sentAt: new Date().toISOString()
    });
    return {
      ok: true,
      messageId,
      provider: 'mock',
      status: 'sent',
      estimatedCostPaise: 12
    };
  }

  verifyWebhookSignature({ rawBody, signatureHeader }) {
    const secret = env('WHATSAPP_WEBHOOK_SECRET', 'test_whatsapp_webhook_secret');
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const signature = signatureHeader.slice(7);
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(signature, expected);
  }

  getSentMessages() {
    return [...this.sentMessages];
  }

  clearSentMessages() {
    this.sentMessages = [];
  }
}

// Global active provider
let activeProvider = null;
let defaultStub = null;

export function getWhatsAppProvider() {
  if (activeProvider) return activeProvider;
  const cfg = getWhatsAppConfig();
  if (cfg.isLive && process.env.NODE_ENV !== 'test') {
    return new MetaCloudWhatsAppProvider(cfg);
  }
  if (!defaultStub) {
    defaultStub = new StubWhatsAppProvider();
  }
  return defaultStub;
}

export function setWhatsAppProvider(provider) {
  activeProvider = provider;
}

export function resetWhatsAppProvider() {
  activeProvider = null;
  if (defaultStub) {
    defaultStub.clearSentMessages();
  }
}
