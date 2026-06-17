import crypto from 'node:crypto';
import db from '../db.js';
import { isAdmin, isOwner, isReadOnly, canSeeAllLeads } from '../lib/permissions.js';
import { verifyMediaTicket } from '../lib/mediaTicket.js';

export const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const USER_FIELDS = 'id, username, full_name, role, is_active, must_change_password';

// Audio-streaming GET routes that may be authenticated by a short-lived media
// ticket (audit M-2/L-1) instead of a session/bearer. Path is relative to the
// `/api` mount where requireAuth runs (so e.g. `/review/audio/123`). Kept narrow
// so a leaked ticket can never authenticate anything but the audio bytes.
const AUDIO_TICKET_PATH = /^\/review\/audio\/\d+\/?$/;

// Attaches req.user from the session, or from a paired device's bearer token
// (mobile app). 401 if neither is valid.
export function requireAuth(req, res, next) {
  // Media tickets (audit M-2/L-1): a signed, ~10-min, single-recording grant the
  // mobile app puts in the <audio> URL so the long-lived device token never sits
  // in WebView history. Honoured ONLY on the audio GET route and never weakens
  // auth elsewhere; the route still enforces the ticket's recordingId matches.
  if (req.method === 'GET' && typeof req.query.ticket === 'string'
      && AUDIO_TICKET_PATH.test(req.path)) {
    const claims = verifyMediaTicket(req.query.ticket);
    if (!claims) return res.status(401).json({ error: 'Media link expired — reopen the recording' });
    const user = db
      .prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`)
      .get(claims.userId);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account inactive' });
    req.user = user;
    req.mediaTicket = claims; // { userId, recordingId, exp } — route scopes to recordingId
    return next();
  }
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
    // Token expiry (audit M-1): legacy tokens have NULL expires_at and stay
    // valid; tokens minted after the hardening migration carry an expiry.
    if (device.expires_at && device.expires_at < new Date().toISOString()) {
      return res.status(401).json({ error: 'Device token expired — re-pair this phone' });
    }
    const user = db
      .prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`)
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
    .prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`)
    .get(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Account inactive' });
  }
  req.user = user;
  next();
}

// Blocks an account flagged must_change_password from doing anything except
// changing its password (and reading /me / logging out). Mounted globally after
// requireAuth so a still-default admin can't be used until rotated (audit H-1).
export function requirePasswordChanged(req, res, next) {
  if (!req.user?.must_change_password) return next();
  const p = req.path;
  const allowed = (req.method === 'POST' && (p === '/auth/change-password' || p === '/auth/logout'))
    || (req.method === 'GET' && p === '/auth/me');
  if (allowed) return next();
  return res.status(403).json({ error: 'You must change your password before continuing', must_change_password: true });
}

// (requirePasswordChanged is defined above, next to requireAuth.)

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
