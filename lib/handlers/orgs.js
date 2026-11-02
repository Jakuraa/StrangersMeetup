// lib/handlers/orgs.js - Organisations, members and venues for the people who belong to them.
// Every route: session → authorize(user, action, scope) (outsiders get 404, low roles 403). Every
// write: CSRF + rate limit + audit row. Lists are paginated (?limit, ?offset).
import { HttpError, readJson, sendJson } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z, uuid } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { audit } from '../audit.js';
import { db } from '../db.js';
import { page, pageInfo } from '../pagination.js';
import { authorize, can } from '../services/permissions.js';

const id = (v) => {
  if (!uuid.safeParse(v).success) throw new HttpError(404, 'not_found', 'Not found');
  return v;
};

async function writer(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`orgs:${user.id}`, 60, 600);
  return user;
}

const orgOut = (o) => ({ id: o.id, kind: o.kind, name: o.name, status: o.status, verified: Boolean(o.verified_at) });

// ---------- my organisations ----------

export async function myOrgs(ctx) {
  const user = await requireUser(ctx.req);
  const p = page(ctx.query);
  const { rows } = await db.query(
    `SELECT o.id, o.kind, o.name, o.status, o.verified_at, m.role
       FROM org_memberships m JOIN organisations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (o.kind = 'personal') DESC, o.name, o.id LIMIT $2 OFFSET $3`, [user.id, p.limit + 1, p.offset]);
  const r = pageInfo(rows, p, 'orgs');
  sendJson(ctx.res, 200, { ok: true, ...r, orgs: r.orgs.map((o) => ({ ...orgOut(o), role: o.role })) });
}

export async function getOrg(ctx) {
  const user = await requireUser(ctx.req);
  const orgId = id(ctx.params.id);
  const a = await authorize(user, 'org.view', { orgId });
  const o = await db.one('SELECT * FROM organisations WHERE id = $1', [orgId]);
  if (!o) throw new HttpError(404, 'not_found', 'Not found');
  sendJson(ctx.res, 200, { ok: true, org: { ...orgOut(o), role: a.role || null } });
}

// ---------- members ----------

export async function listMembers(ctx) {
  const user = await requireUser(ctx.req);
  const orgId = id(ctx.params.id);
  await authorize(user, 'org.view_members', { orgId });
  const p = page(ctx.query);
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.status, m.created_at, u.alias
       FROM org_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 ORDER BY m.created_at, m.user_id LIMIT $2 OFFSET $3`, [orgId, p.limit + 1, p.offset]);
  const r = pageInfo(rows, p, 'members');
  sendJson(ctx.res, 200, { ok: true, ...r, members: r.members.map((m) => ({ userId: m.user_id, alias: m.alias || 'Member', role: m.role, status: m.status, since: m.created_at })) });
}

const AddMemberBody = z.object({
  telegram_user_id: z.coerce.number().int().positive(),
  role: z.enum(['admin', 'manager', 'staff'])
}).strict();

export async function addMember(ctx) {
  const user = await writer(ctx);
  const orgId = id(ctx.params.id);
  const b = parse(AddMemberBody, await readJson(ctx.req));
  await db.tx(async (c) => {
    await authorize(user, b.role === 'admin' ? 'org.manage_admins' : 'org.manage_members', { orgId }, c);
    const org = (await c.query('SELECT kind FROM organisations WHERE id = $1 FOR UPDATE', [orgId])).rows[0];
    if (!org) throw new HttpError(404, 'not_found', 'Not found');
    if (org.kind === 'personal') throw new HttpError(409, 'personal_org', 'A personal organisation has one member. Ask an admin to set up a team organisation.');
    const target = (await c.query('SELECT id FROM users WHERE telegram_user_id = $1', [b.telegram_user_id])).rows[0];
    if (!target) throw new HttpError(404, 'user_not_found', 'That person needs to sign in to the site once first');
    const cur = (await c.query('SELECT role FROM org_memberships WHERE user_id = $1 AND org_id = $2', [target.id, orgId])).rows[0];
    if (cur?.role === 'owner') throw new HttpError(409, 'is_owner', 'That person already owns this organisation.');
    if (cur?.role === 'admin' && !(await can(user, 'org.manage_admins', { orgId }, c))) throw new HttpError(403, 'forbidden', 'Only the owner can change an admin.');
    await c.query(
      `INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`, [target.id, orgId, b.role]);
    await audit(`user:${user.id}`, 'org.member.add', orgId, { userId: target.id, role: b.role }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

const UpdateMemberBody = z.object({
  role: z.enum(['admin', 'manager', 'staff']).optional(),
  status: z.enum(['active', 'revoked']).optional()
}).strict().refine((b) => b.role || b.status, { message: 'Nothing to change' });

export async function updateMember(ctx) {
  const user = await writer(ctx);
  const orgId = id(ctx.params.id);
  const targetId = id(ctx.params.member);
  const b = parse(UpdateMemberBody, await readJson(ctx.req));
  await db.tx(async (c) => {
    await authorize(user, 'org.manage_members', { orgId }, c);
    const cur = (await c.query('SELECT role, status FROM org_memberships WHERE user_id = $1 AND org_id = $2 FOR UPDATE', [targetId, orgId])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Member not found');
    if (cur.role === 'owner') throw new HttpError(409, 'is_owner', 'The owner cannot be changed here.');
    if ((cur.role === 'admin' || b.role === 'admin') && !(await can(user, 'org.manage_admins', { orgId }, c))) {
      throw new HttpError(403, 'forbidden', 'Only the owner can change an admin.');
    }
    await c.query(
      `UPDATE org_memberships SET role = COALESCE($3, role), status = COALESCE($4, status) WHERE user_id = $1 AND org_id = $2`,
      [targetId, orgId, b.role || null, b.status || null]);
    await audit(`user:${user.id}`, 'org.member.update', orgId, { userId: targetId, from: cur, to: b }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- venues (address and coordinates are for members only) ----------

const venueOut = (v, priv) => ({
  id: v.id, orgId: v.org_id, name: v.name, capacity: v.capacity, localityId: v.locality_id, status: v.status,
  ...(priv ? { addressPrivate: v.address_private, lat: v.lat, lng: v.lng } : {})
});

export async function listVenues(ctx) {
  const user = await requireUser(ctx.req);
  const orgId = id(ctx.params.id);
  await authorize(user, 'venue.view', { orgId });
  const priv = await can(user, 'venue.view_private', { orgId });
  const p = page(ctx.query);
  const { rows } = await db.query(
    `SELECT * FROM venues WHERE org_id = $1 ORDER BY status, name, id LIMIT $2 OFFSET $3`, [orgId, p.limit + 1, p.offset]);
  const r = pageInfo(rows, p, 'venues');
  sendJson(ctx.res, 200, { ok: true, ...r, venues: r.venues.map((v) => venueOut(v, priv)) }, { 'Cache-Control': 'private, no-store' });
}

const VenueBody = z.object({
  name: z.string().trim().min(2).max(120),
  capacity: z.number().int().positive().max(100_000).nullable().optional(),
  address_private: z.string().trim().max(500).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional()
}).strict();

export async function createVenue(ctx) {
  const user = await writer(ctx);
  const orgId = id(ctx.params.id);
  const b = parse(VenueBody, await readJson(ctx.req));
  const v = await db.tx(async (c) => {
    await authorize(user, 'venue.manage', { orgId }, c);
    if (!(await c.query('SELECT 1 FROM organisations WHERE id = $1', [orgId])).rowCount) throw new HttpError(404, 'not_found', 'Not found');
    const row = (await c.query(
      `INSERT INTO venues (org_id, name, capacity, address_private, lat, lng) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [orgId, b.name, b.capacity ?? null, b.address_private ?? null, b.lat ?? null, b.lng ?? null])).rows[0];
    await audit(`user:${user.id}`, 'venue.create', row.id, { orgId }, c);
    return row;
  });
  sendJson(ctx.res, 201, { ok: true, venue: venueOut(v, true) });
}

const VenuePatch = VenueBody.partial().extend({ status: z.enum(['active', 'archived']).optional() }).strict();

export async function updateVenue(ctx) {
  const user = await writer(ctx);
  const venueId = id(ctx.params.id);
  const b = parse(VenuePatch, await readJson(ctx.req));
  const v = await db.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM venues WHERE id = $1 FOR UPDATE', [venueId])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    await authorize(user, 'venue.manage', { venue: cur }, c);
    const next = { ...cur, ...b };
    const row = (await c.query(
      `UPDATE venues SET name = $2, capacity = $3, address_private = $4, lat = $5, lng = $6, status = $7 WHERE id = $1 RETURNING *`,
      [venueId, next.name, next.capacity, next.address_private, next.lat, next.lng, next.status])).rows[0];
    await audit(`user:${user.id}`, 'venue.update', venueId, { fields: Object.keys(b) }, c);
    return row;
  });
  sendJson(ctx.res, 200, { ok: true, venue: venueOut(v, true) });
}
