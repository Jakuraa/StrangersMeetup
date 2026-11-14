import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  recordConsent,
  getConsents,
  hasConsent,
  addSuppression,
  isSuppressed,
  removeSuppression
} from '../lib/services/communication-consent.js';

test.beforeEach(async () => {
  await resetDb();
});

test('communication consent lifecycle: default states and explicit opt-in', async () => {
  const user = (await db.query(`INSERT INTO users (telegram_user_id, alias) VALUES (777001, 'ConsentUser') RETURNING id`)).rows[0];

  // Default: transactional is allowed, promotional is false
  assert.equal(await hasConsent({ userId: user.id, channel: 'whatsapp', purpose: 'transactional' }), true);
  assert.equal(await hasConsent({ userId: user.id, channel: 'whatsapp', purpose: 'promotional' }), false);

  // Explicit opt-in for promotional
  await recordConsent({
    userId: user.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_in',
    source: 'signin_form'
  });

  assert.equal(await hasConsent({ userId: user.id, channel: 'whatsapp', purpose: 'promotional' }), true);

  // Opt-out again
  await recordConsent({
    userId: user.id,
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_out',
    source: 'profile_settings'
  });

  assert.equal(await hasConsent({ userId: user.id, channel: 'whatsapp', purpose: 'promotional' }), false);

  // Audit log should record consent events
  const auditLogs = (await db.query(`SELECT action, target, details FROM audit_log WHERE target = $1 ORDER BY at ASC`, [`user:${user.id}`])).rows;
  assert.ok(auditLogs.some((l) => l.action === 'consent_opted_in' && l.details.purpose === 'promotional'));
  assert.ok(auditLogs.some((l) => l.action === 'consent_opted_out' && l.details.purpose === 'promotional'));
});

test('suppression list: suppresses destination and removes suppression', async () => {
  const phone = '+919876543210';

  assert.equal(await isSuppressed({ channel: 'whatsapp', destination: phone }), false);

  await addSuppression({ channel: 'whatsapp', destination: phone, reason: 'user_opt_out' });
  assert.equal(await isSuppressed({ channel: 'whatsapp', destination: phone }), true);

  await removeSuppression({ channel: 'whatsapp', destination: phone });
  assert.equal(await isSuppressed({ channel: 'whatsapp', destination: phone }), false);
});
