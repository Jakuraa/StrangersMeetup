import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, isValidE164, maskPhone, hashPhone } from '../lib/services/phone.js';

test('normalizePhoneNumber - Indian phone numbers', () => {
  // Plain 10 digits starting with 9, 8, 7, 6
  assert.equal(normalizePhoneNumber('9876543210'), '+919876543210');
  assert.equal(normalizePhoneNumber('8876543210'), '+918876543210');
  assert.equal(normalizePhoneNumber('7876543210'), '+917876543210');
  assert.equal(normalizePhoneNumber('6876543210'), '+916876543210');

  // Formatted with spaces, dashes, brackets
  assert.equal(normalizePhoneNumber('98765 43210'), '+919876543210');
  assert.equal(normalizePhoneNumber('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhoneNumber('+91 (98765) 43210'), '+919876543210');

  // With leading 0
  assert.equal(normalizePhoneNumber('09876543210'), '+919876543210');

  // With 91 prefix without plus
  assert.equal(normalizePhoneNumber('919876543210'), '+919876543210');

  // With 00 international prefix
  assert.equal(normalizePhoneNumber('00919876543210'), '+919876543210');
});

test('normalizePhoneNumber - invalid phone numbers rejected', () => {
  assert.throws(() => normalizePhoneNumber(''), /provide a valid phone/i);
  assert.throws(() => normalizePhoneNumber(null), /provide a valid phone/i);
  assert.throws(() => normalizePhoneNumber('12345'), /must be 10 digits/i);
  assert.throws(() => normalizePhoneNumber('5555555555'), /starting with 6, 7, 8, or 9/i);
  assert.throws(() => normalizePhoneNumber('+911234567890'), /starting with 6, 7, 8, or 9/i);
  assert.throws(() => normalizePhoneNumber('invalid-text'), /must be 10 digits/i);
});

test('isValidE164', () => {
  assert.equal(isValidE164('+919876543210'), true);
  assert.equal(isValidE164('+14155552671'), true);
  assert.equal(isValidE164('+447911123456'), true);
  assert.equal(isValidE164('9876543210'), false);
  assert.equal(isValidE164('+911234567890'), false); // Invalid Indian mobile prefix
  assert.equal(isValidE164(''), false);
  assert.equal(isValidE164(null), false);
});

test('maskPhone', () => {
  assert.equal(maskPhone('+919876543210'), '+91 98****3210');
  assert.equal(maskPhone('+14155552671'), '+141****71');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone('123'), '****');
});

test('hashPhone returns consistent SHA-256 slice', () => {
  const h1 = hashPhone('+919876543210');
  const h2 = hashPhone('+919876543210');
  const h3 = hashPhone('+919876543211');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 32);
});
