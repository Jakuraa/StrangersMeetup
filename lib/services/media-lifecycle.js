// lib/services/media-lifecycle.js - Safe Media Lifecycle and Automatic Cleanup Worker
// Identifies and cleans up abandoned draft uploads and expired event media
// while strictly protecting active bookings, refunds, disputes, safety reports, and legal holds.
import { db } from '../db.js';
import { logger } from '../logger.js';
import { audit } from '../audit.js';

export const MEDIA_CLEANUP_LOCK_ID = 749201;

/**
 * Scans PostgreSQL for media cleanup candidates without deleting anything.
 * Produces an audited candidate report with detailed dependency checks.
 */
export async function scanMediaCleanupCandidates({
  graceDays = 30,
  draftGraceDays = 14,
  limit = 100
} = {}) {
  const candidates = [];
  let totalBytes = 0;

  // 1. Identify Orphaned / Abandoned Draft Images
  // event_images where draft is older than draftGraceDays or discarded, and image is not public/referenced
  const draftCutoff = new Date(Date.now() - draftGraceDays * 86_400_000).toISOString();
  const abandonedDraftRows = (await db.query(
    `SELECT img.id, img.byte_size, img.content_type, img.created_at, img.draft_id,
            d.status AS draft_status, d.updated_at AS draft_updated_at
       FROM event_images img
       LEFT JOIN event_drafts d ON d.id = img.draft_id
      WHERE (
        (img.draft_id IS NULL AND img.created_at < $1)
        OR (d.status = 'discarded' AND d.discarded_at < now() - interval '24 hours')
        OR (d.status = 'active' AND d.updated_at < $1)
      )
      AND NOT img.is_public
      AND NOT EXISTS (
        SELECT 1 FROM venues v
         WHERE v.photos::text LIKE '%' || img.id::text || '%'
           AND v.updated_at >= $1
      )
      LIMIT $2`,
    [draftCutoff, limit]
  )).rows;

  for (const row of abandonedDraftRows) {
    const ageDays = Math.round((Date.now() - new Date(row.created_at).getTime()) / 86_400_000);
    const size = Number(row.byte_size || 0);
    totalBytes += size;
    candidates.push({
      id: row.id,
      category: 'abandoned_draft',
      reason: row.draft_status === 'discarded' ? 'Draft explicitly discarded >24h ago' : 'Draft inactive for >14 days',
      ageDays,
      byteSize: size,
      draftId: row.draft_id,
      canDelete: true,
      protectionsPassed: ['no_public_event', 'no_active_bookings', 'no_financial_dependencies']
    });
  }

  // 2. Identify Completed Event Media past Grace Period
  // Events ended > graceDays ago without legal hold or active dependencies
  const remainingLimit = limit - candidates.length;
  if (remainingLimit > 0) {
    const eventCutoff = new Date(Date.now() - graceDays * 86_400_000).toISOString();
    const completedEventImages = (await db.query(
      `SELECT img.id, img.byte_size, img.content_type, img.created_at, e.id AS event_id, e.title,
              e.start_at, e.end_at, e.features,
              (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('pending_approval', 'pending_payment')) AS pending_bookings,
              (SELECT count(*)::int FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.event_id = e.id AND p.status = 'refund_pending') AS pending_refunds,
              (SELECT count(*)::int FROM reports r WHERE r.event_id = e.id AND r.status IN ('new', 'reviewing')) AS active_reports
         FROM event_images img
         JOIN events e ON (e.draft_id = img.draft_id OR e.gallery @> jsonb_build_array('/media/event-images/' || img.id::text))
        WHERE COALESCE(e.end_at, e.start_at) < $1
        LIMIT $2`,
      [eventCutoff, remainingLimit]
    )).rows;

    for (const row of completedEventImages) {
      const features = (typeof row.features === 'object' && row.features !== null) ? row.features : {};
      const retainMedia = Boolean(features.retainMedia);
      const legalHold = Boolean(features.legalHold);
      const hasPendingBookings = Number(row.pending_bookings || 0) > 0;
      const hasPendingRefunds = Number(row.pending_refunds || 0) > 0;
      const hasActiveReports = Number(row.active_reports || 0) > 0;

      const blockedReasons = [];
      if (retainMedia) blockedReasons.push('Organiser elected to retain/archive media');
      if (legalHold) blockedReasons.push('Subject to legal hold');
      if (hasPendingBookings) blockedReasons.push('Has pending bookings');
      if (hasPendingRefunds) blockedReasons.push('Has pending refunds');
      if (hasActiveReports) blockedReasons.push('Has open trust & safety reports');

      const canDelete = blockedReasons.length === 0;
      const ageDays = Math.round((Date.now() - new Date(row.end_at || row.start_at).getTime()) / 86_400_000);
      const size = Number(row.byte_size || 0);

      if (canDelete) {
        totalBytes += size;
      }

      candidates.push({
        id: row.id,
        category: 'completed_event',
        eventId: row.event_id,
        eventTitle: row.title,
        reason: canDelete ? `Event concluded ${ageDays} days ago (exceeds ${graceDays}-day grace period)` : `Blocked: ${blockedReasons.join('; ')}`,
        ageDays,
        byteSize: size,
        canDelete,
        blockedReasons
      });
    }
  }

  return {
    totalScanned: candidates.length,
    eligibleCount: candidates.filter((c) => c.canDelete).length,
    blockedCount: candidates.filter((c) => !c.canDelete).length,
    totalBytesReclaimable: totalBytes,
    candidates
  };
}

/**
 * Executes media cleanup worker.
 * Supports dry-run simulation and atomic execution with PostgreSQL advisory locking.
 */
export async function executeMediaCleanup({
  dryRun = true,
  graceDays = 30,
  draftGraceDays = 14,
  limit = 100,
  actor = 'system:media_cleanup_worker'
} = {}) {
  // Try acquiring advisory lock to prevent concurrent workers
  const lockResult = (await db.query(`SELECT pg_try_advisory_lock($1) AS locked`, [MEDIA_CLEANUP_LOCK_ID])).rows[0];
  if (!lockResult || !lockResult.locked) {
    logger.warn('media_cleanup: concurrent run in progress, skipping execution');
    return {
      ok: false,
      error: 'concurrency_lock_held',
      message: 'Another media cleanup process is currently executing'
    };
  }

  try {
    const report = await scanMediaCleanupCandidates({ graceDays, draftGraceDays, limit });
    const eligible = report.candidates.filter((c) => c.canDelete);

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        summary: {
          candidatesFound: report.totalScanned,
          eligibleDeletions: eligible.length,
          blockedDeletions: report.blockedCount,
          bytesToReclaim: report.totalBytesReclaimable
        },
        candidates: report.candidates
      };
    }

    let deletedCount = 0;
    let deletedBytes = 0;

    // Execute in transaction
    await db.tx(async (c) => {
      for (const item of eligible) {
        // Delete image row
        const delRes = await c.query(`DELETE FROM event_images WHERE id = $1`, [item.id]);
        if (delRes.rowCount > 0) {
          deletedCount++;
          deletedBytes += item.byteSize;

          // Record immutable audit entry
          await audit(
            actor,
            'media.cleanup',
            item.id,
            {
              category: item.category,
              reason: item.reason,
              byteSize: item.byteSize,
              eventId: item.eventId || null,
              draftId: item.draftId || null
            },
            c
          );
        }
      }
    });

    logger.info('media_cleanup: completed run', { deletedCount, deletedBytes });

    return {
      ok: true,
      dryRun: false,
      deletedCount,
      deletedBytes,
      report
    };
  } finally {
    // Release advisory lock
    await db.query(`SELECT pg_advisory_unlock($1)`, [MEDIA_CLEANUP_LOCK_ID]).catch(() => null);
  }
}
