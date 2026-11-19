// lib/services/phone.js - E.164 Phone number normalization, validation, and PII masking.
import crypto from 'node:crypto';
import { HttpError } from '../http.js';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;
const INDIA_MOBILE_REGEX = /^\+91[6-9]\d{9}$/;

/**
 * Normalises an input phone number to standard international E.164 format.
 * Defaults to India (+91) if no country prefix is supplied.
 * Throws HttpError(400, 'invalid_phone') if format is invalid.
 *
 * @param {string} input - Raw user input (e.g. "9876543210", "+91 98765-43210", "09876543210")
 * @param {string} [defaultCountryCode='+91']
 * @returns {string} E.164 formatted phone number (e.g. "+919876543210")
 */
export function normalizePhoneNumber(input, defaultCountryCode = '+91') {
  if (!input || typeof input !== 'string') {
    throw new HttpError(400, 'invalid_phone', 'Please provide a valid phone number.');
  }

  // Strip all whitespace, dashes, parentheses, periods
  let cleaned = input.trim().replace(/[\s\-\(\)\.]/g, '');

  // Handle international 00 prefix
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // If leading plus exists
  if (cleaned.startsWith('+')) {
    // Strip redundant leading zero after India country code (+910...)
    if (cleaned.startsWith('+910') && cleaned.length === 14) {
      cleaned = '+91' + cleaned.slice(4);
    }
    if (!E164_REGEX.test(cleaned)) {
      throw new HttpError(400, 'invalid_phone', 'Invalid phone number format. Please include country code (e.g. +91 9876543210).');
    }
    // Specific validation for India numbers (+91)
    if (cleaned.startsWith('+91') && !INDIA_MOBILE_REGEX.test(cleaned)) {
      throw new HttpError(400, 'invalid_phone', 'Indian mobile numbers must be 10 digits starting with 6, 7, 8, or 9.');
    }
    return cleaned;
  }

  // No leading plus: apply default country
  const country = defaultCountryCode.startsWith('+') ? defaultCountryCode : '+' + defaultCountryCode;

  if (country === '+91') {
    // Strip leading 0 if present (e.g. 09876543210)
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.slice(1);
    }
    // If user already typed 91 without plus (e.g. 919876543210)
    if (cleaned.length === 12 && cleaned.startsWith('91')) {
      cleaned = '+' + cleaned;
      if (!INDIA_MOBILE_REGEX.test(cleaned)) {
        throw new HttpError(400, 'invalid_phone', 'Indian mobile numbers must be 10 digits starting with 6, 7, 8, or 9.');
      }
      return cleaned;
    }
    // Standard 10-digit Indian mobile number
    if (/^[6-9]\d{9}$/.test(cleaned)) {
      return '+91' + cleaned;
    }
    throw new HttpError(400, 'invalid_phone', 'Indian mobile numbers must be 10 digits starting with 6, 7, 8, or 9.');
  }

  // Other country fallback
  const candidate = country + cleaned;
  if (!E164_REGEX.test(candidate)) {
    throw new HttpError(400, 'invalid_phone', 'Invalid phone number format. Please check the country code and number.');
  }
  return candidate;
}

/**
 * Validates whether a string is a valid E.164 phone number.
 */
export function isValidE164(phone) {
  if (!phone || typeof phone !== 'string') return false;
  if (!E164_REGEX.test(phone)) return false;
  if (phone.startsWith('+91')) {
    return INDIA_MOBILE_REGEX.test(phone);
  }
  return true;
}

/**
 * Mask a phone number for safe display in UI and admin dashboards without exposing full PII.
 * Example: "+919876543210" -> "+91 98****3210"
 */
export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.trim();
  if (clean.length < 8) return '****';

  // For +91: "+91 98****3210"
  if (clean.startsWith('+91') && clean.length === 13) {
    return `+91 ${clean.slice(3, 5)}****${clean.slice(9)}`;
  }

  // General format: keep country prefix + first 2 national digits, mask middle, show last 2
  const plusIdx = clean.indexOf('+');
  const start = clean.slice(0, 4);
  const end = clean.slice(-2);
  return `${start}****${end}`;
}

/**
 * Hash a phone number with SHA-256 for secure cache/rate-limit keys.
 */
export function hashPhone(phone) {
  return crypto.createHash('sha256').update(String(phone).trim()).digest('hex').slice(0, 32);
}
