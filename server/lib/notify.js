// In-app notifications. The client bell polls /api/notifications; this is the
// single write path other server code uses to drop a notification on a user.
import db from '../db.js';
import { nowUtc } from './istTime.js';

const TYPES = new Set(['info', 'success', 'warning', 'error']);

const insert = db.prepare(
  `INSERT INTO notifications (user_id, title, body, type, created_at)
   VALUES (?, ?, ?, ?, ?)`
);

// Fire-and-forget like audit: never let a notification failure break the caller.
// Returns the new row id, or null on failure / invalid input.
export function sendNotification(userId, title, body = null, type = 'info') {
  try {
    if (!userId || !title) return null;
    const t = TYPES.has(type) ? type : 'info';
    const info = insert.run(Number(userId), String(title), body != null ? String(body) : null, t, nowUtc());
    return info.lastInsertRowid;
  } catch (err) {
    console.error('[notify] failed to send notification:', title, err.message);
    return null;
  }
}
