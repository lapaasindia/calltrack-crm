import crypto from 'node:crypto';
import db from '../db.js';
import { isAdmin, isOwner, isReadOnly, canSeeAllLeads } from '../lib/permissions.js';

export const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

// Attaches req.user from the session, or from a paired device's bearer token
// (mobile app). 401 if neither is valid.
export function requireAuth(req, res, next) {
  // Paired-device auth normally comes from the Authorization header. Media URLs
  // loaded by an <audio>/<img> tag can't set headers, so we also accept the
  // token as a ?token= query param (LAN-only; lets the mobile app stream
  // recordings). Session auth is unaffected.
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    || (typeof req.query.token === 'string' ? req.query.token : undefined);
  if (bearer) {
    const device = db.prepare(
      'SELECT * FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL'
    ).get(hashToken(bearer));
    if (!device) return res.status(401).json({ error: 'Device not paired or revoked' });
    const user = db
      .prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?')
      .get(device.user_id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account inactive' });
    db.prepare('UPDATE device_tokens SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), device.id);
    req.user = user;
    req.device = device;
    return next();
  }

  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db
    .prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Account inactive' });
  }
  req.user = user;
  next();
}

// Sync endpoints only make sense for a paired device, never a browser session.
export function requireDevice(req, res, next) {
  if (!req.device) return res.status(403).json({ error: 'Paired device required' });
  next();
}

// Team-management tier: super_admin | admin | manager (and legacy 'admin').
export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Owner tier: super_admin | admin (and legacy 'admin'). Settings / catalog /
// grade-delete actions that managers must NOT perform.
export function requireOwner(req, res, next) {
  if (!isOwner(req.user?.role)) return res.status(403).json({ error: 'Owner only' });
  next();
}

// Authorization rule used everywhere lead access is checked:
// super_admin/admin/manager see all leads; agent/caller/employee only leads
// assigned to them; read_only may read but the route handlers gate writes.
export function canAccessLead(user, lead) {
  if (!lead || lead.deleted_at) return false;
  if (canSeeAllLeads(user.role)) return true;
  if (isReadOnly(user.role)) return false; // read_only is never "assigned"; no row access
  return lead.assigned_to === user.id;
}

// Loads the lead and enforces access. 404 for missing, 403 for foreign leads.
export function loadLead(req, res, next) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead || lead.deleted_at) return res.status(404).json({ error: 'Lead not found' });
  if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'Not your lead' });
  req.lead = lead;
  next();
}
