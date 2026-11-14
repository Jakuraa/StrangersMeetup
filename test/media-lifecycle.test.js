import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  scanMediaCleanupCandidates,
  executeMediaCleanup,
  MEDIA_CLEANUP_LOCK_ID
} from '../lib/services/media-lifecycle.js';

test.beforeEach(async () => {
  await resetDb();
});

test('Media Lifecycle - scans abandoned drafts and identifies cleanup candidates', async () => {
  // Create user
  const user = (await db.query(
    `INSERT INTO users (telegram_user_id, alias) VALUES (888001, 'HostA') RETURNING id`
  )).rows[0];

  // 1. Create an active draft updated 20 days ago (abandoned)
  const oldDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const draftAbandoned = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version, updated_at)
     VALUES ($1, 'active', '{"title":"Old Draft"}'::jsonb, 1, $2) RETURNING id`,
    [user.id, oldDate]
  )).rows[0];

  // Insert image for abandoned draft
  const img1 = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('deadbeef', 'hex'), 4, false) RETURNING id`,
    [user.id, draftAbandoned.id]
  )).rows[0];

  // 2. Create a recent draft updated 2 days ago (not abandoned)
  const recentDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const draftRecent = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version, updated_at)
     VALUES ($1, 'active', '{"title":"Recent Draft"}'::jsonb, 1, $2) RETURNING id`,
    [user.id, recentDate]
  )).rows[0];

  const img2 = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('cafebabe', 'hex'), 4, false) RETURNING id`,
    [user.id, draftRecent.id]
  )).rows[0];

  // Scan candidates
  const report = await scanMediaCleanupCandidates({ graceDays: 30, draftGraceDays: 14 });
  assert.equal(report.totalScanned, 1);
  assert.equal(report.eligibleCount, 1);
  assert.equal(report.candidates[0].id, img1.id);
  assert.equal(report.candidates[0].category, 'abandoned_draft');
  assert.equal(report.candidates[0].canDelete, true);
});

test('Media Lifecycle - dry-run mode returns candidate details without deleting data', async () => {
  const user = (await db.query(
    `INSERT INTO users (telegram_user_id, alias) VALUES (888002, 'HostB') RETURNING id`
  )).rows[0];

  const oldDate = new Date(Date.now() - 25 * 86_400_000).toISOString();
  const draft = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version, updated_at)
     VALUES ($1, 'active', '{"title":"Abandoned"}'::jsonb, 1, $2) RETURNING id`,
    [user.id, oldDate]
  )).rows[0];

  const img = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('feedface', 'hex'), 4, false) RETURNING id`,
    [user.id, draft.id]
  )).rows[0];

  // Execute dry-run
  const dryRunRes = await executeMediaCleanup({ dryRun: true, draftGraceDays: 14 });
  assert.equal(dryRunRes.ok, true);
  assert.equal(dryRunRes.dryRun, true);
  assert.equal(dryRunRes.summary.eligibleDeletions, 1);

  // Verify image still exists in DB
  const count = (await db.query(`SELECT count(*)::int AS n FROM event_images WHERE id = $1`, [img.id])).rows[0].n;
  assert.equal(count, 1, 'Dry-run must not delete any database rows');
});

test('Media Lifecycle - strictly protects events with retainMedia, legal hold, or pending bookings', async () => {
  const user = (await db.query(
    `INSERT INTO users (telegram_user_id, alias) VALUES (888003, 'HostC') RETURNING id`
  )).rows[0];

  const concludedStart = new Date(Date.now() - 41 * 86_400_000).toISOString();
  const concludedEnd = new Date(Date.now() - 40 * 86_400_000).toISOString();

  // Event 1: retainMedia = true
  const draft1 = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version) VALUES ($1, 'published', '{}', 1) RETURNING id`,
    [user.id]
  )).rows[0];
  const img1 = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('1111', 'hex'), 2, true) RETURNING id`,
    [user.id, draft1.id]
  )).rows[0];
  await db.query(
    `INSERT INTO events (slug, title, category, city, start_at, end_at, status, draft_id, features, capacity)
     VALUES ('event-retain', 'Retained Media Event', 'nightlife', 'Bengaluru', $1, $2, 'published', $3, '{"retainMedia": true}'::jsonb, 50)`,
    [concludedStart, concludedEnd, draft1.id]
  );

  // Event 2: legalHold = true
  const draft2 = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version) VALUES ($1, 'published', '{}', 1) RETURNING id`,
    [user.id]
  )).rows[0];
  const img2 = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('2222', 'hex'), 2, true) RETURNING id`,
    [user.id, draft2.id]
  )).rows[0];
  await db.query(
    `INSERT INTO events (slug, title, category, city, start_at, end_at, status, draft_id, features, capacity)
     VALUES ('event-legal-hold', 'Legal Hold Event', 'nightlife', 'Bengaluru', $1, $2, 'published', $3, '{"legalHold": true}'::jsonb, 50)`,
    [concludedStart, concludedEnd, draft2.id]
  );

  const report = await scanMediaCleanupCandidates({ graceDays: 30, draftGraceDays: 14 });
  const cand1 = report.candidates.find((c) => c.id === img1.id);
  const cand2 = report.candidates.find((c) => c.id === img2.id);

  assert.ok(cand1, 'Candidate 1 should be scanned');
  assert.equal(cand1.canDelete, false);
  assert.match(cand1.blockedReasons.join('; '), /retain\/archive media/);

  assert.ok(cand2, 'Candidate 2 should be scanned');
  assert.equal(cand2.canDelete, false);
  assert.match(cand2.blockedReasons.join('; '), /legal hold/);
});

test('Media Lifecycle - execution deletes eligible rows and writes immutable audit log', async () => {
  const user = (await db.query(
    `INSERT INTO users (telegram_user_id, alias) VALUES (888004, 'HostD') RETURNING id`
  )).rows[0];

  const oldDate = new Date(Date.now() - 25 * 86_400_000).toISOString();
  const draft = (await db.query(
    `INSERT INTO event_drafts (organiser_user_id, status, data, version, updated_at)
     VALUES ($1, 'active', '{"title":"Clean Me"}'::jsonb, 1, $2) RETURNING id`,
    [user.id, oldDate]
  )).rows[0];

  const img = (await db.query(
    `INSERT INTO event_images (owner_user_id, draft_id, content_type, bytes, byte_size, is_public)
     VALUES ($1, $2, 'image/jpeg', decode('abcdef01', 'hex'), 4, false) RETURNING id`,
    [user.id, draft.id]
  )).rows[0];

  // Execute real deletion
  const execRes = await executeMediaCleanup({ dryRun: false, draftGraceDays: 14, actor: 'worker:cleanup_test' });
  assert.equal(execRes.ok, true);
  assert.equal(execRes.deletedCount, 1);
  assert.equal(execRes.deletedBytes, 4);

  // Verify deleted from event_images
  const count = (await db.query(`SELECT count(*)::int AS n FROM event_images WHERE id = $1`, [img.id])).rows[0].n;
  assert.equal(count, 0, 'Eligible image must be deleted');

  // Verify written to audit_log
  const auditRow = (await db.query(
    `SELECT * FROM audit_log WHERE action = 'media.cleanup' AND target = $1`,
    [img.id]
  )).rows[0];
  assert.ok(auditRow, 'Expected audit_log entry for media deletion');
  assert.equal(auditRow.actor, 'worker:cleanup_test');
  assert.equal(auditRow.details.category, 'abandoned_draft');
});
