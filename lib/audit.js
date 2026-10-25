// lib/audit.js - Append-only audit trail for admin and system writes.
import { db } from './db.js';

export async function audit(actor, action, target = null, details = {}, client = db) {
  await client.query(
    'INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)',
    [String(actor), action, target ? String(target) : null, JSON.stringify(details)]
  );
}
