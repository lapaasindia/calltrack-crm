// Append-only audit trail. logAudit is fire-and-forget: an audit write must
// never break the action it records, so any failure is swallowed to the console.
import db from '../db.js';
import { nowUtc } from './istTime.js';

const insert = db.prepare(
  `INSERT INTO audit_logs (action, user_id, user_email, entity_type, entity_id, details, ip, created_at)
   VALUES (@action, @user_id, @user_email, @entity_type, @entity_id, @details, @ip, @created_at)`
);

// user may be a req.user object (id/username/full_name) or null for anonymous
// actions (e.g. a failed login where the username didn't resolve to a user).
export function logAudit({ action, user, entity_type, entity_id, details, ip } = {}) {
  try {
    insert.run({
      action: String(action || 'UNKNOWN'),
      user_id: user?.id ?? null,
      // We have no email column on users (username is the identifier); record
      // the username here so the viewer always shows *who*.
      user_email: user?.username ?? user?.email ?? null,
      entity_type: entity_type ?? null,
      entity_id: entity_id != null ? String(entity_id) : null,
      details: details != null ? JSON.stringify(details) : null,
      ip: ip ?? null,
      created_at: nowUtc(),
    });
  } catch (err) {
    console.error('[audit] failed to write log:', action, err.message);
  }
}
