// lib/handlers/safety.js - HTTP endpoints for safety reports and user blocking.
import { readJson, sendJson, HttpError } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import {
  submitSafetyReport,
  listUserReports,
  blockUser as blockUserSvc,
  unblockUser as unblockUserSvc,
  listBlockedUsers,
  REPORT_CATEGORIES
} from '../services/safety.js';

const SafetyReportInput = z.object({
  category: z.enum(REPORT_CATEGORIES),
  body: z.string().trim().min(10, 'Please provide at least 10 characters').max(3000, 'Must be under 3000 characters'),
  eventId: z.string().uuid().optional().nullable().transform((v) => v || null),
  reportedUserId: z.string().uuid().optional().nullable().transform((v) => v || null)
}).strict();

const BlockInput = z.object({
  blockedUserId: z.string().uuid('Invalid user ID')
}).strict();

function uuid(v) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || '')) {
    throw new HttpError(400, 'invalid_id', 'Invalid user ID');
  }
  return v;
}

export async function submitReport(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`report:${user.id}`, 5, 3600);

  const body = parse(SafetyReportInput, await readJson(ctx.req));
  const report = await submitSafetyReport({
    userId: user.id,
    category: body.category,
    body: body.body,
    eventId: body.eventId,
    reportedUserId: body.reportedUserId
  });

  sendJson(ctx.res, 201, {
    ok: true,
    reportId: report.id,
    status: report.status,
    message: 'Thank you. Your report has been submitted to moderators and will be reviewed confidentially.'
  });
}

export async function listMyReports(ctx) {
  const user = await requireUser(ctx.req);
  const reports = await listUserReports(user.id);
  sendJson(ctx.res, 200, { ok: true, reports });
}

export async function listBlocks(ctx) {
  const user = await requireUser(ctx.req);
  const blocks = await listBlockedUsers(user.id);
  sendJson(ctx.res, 200, { ok: true, blocks });
}

export async function blockUser(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`block:${user.id}`, 20, 3600);

  const body = parse(BlockInput, await readJson(ctx.req));
  await blockUserSvc({
    blockerUserId: user.id,
    blockedUserId: body.blockedUserId
  });

  sendJson(ctx.res, 200, { ok: true, message: 'User blocked' });
}

export async function unblockUser(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);

  const targetUserId = uuid(ctx.params.id);
  await unblockUserSvc({
    blockerUserId: user.id,
    blockedUserId: targetUserId
  });

  sendJson(ctx.res, 200, { ok: true, message: 'User unblocked' });
}
