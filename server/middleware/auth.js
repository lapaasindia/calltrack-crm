import crypto from 'node:crypto';
import db from '../db.js';
import { isAdmin, isOwner, isReadOnly, canSeeAllLeads } from '../lib/permissions.js';
import { verifyMediaTicket } from '../lib/mediaTicket.js';
import { destroySessionsForUser } from '../lib/sessionStore.js';

export const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const USER_FIELDS = 'id, username, full_name, role, is_active, must_change_password';

// Audio-streaming GET routes that may be authenticated by a short-lived media
// ticket (audit M-2/L-1) instead of a session/bearer. Path is relative to the
// `/api` mount where requireAuth runs (so e.g. `/review/audio/123`). Kept narrow
// so a leaked ticket can never authenticate anything but the audio bytes.
const AUDIO_TICKET_PATH = /^\/review\/audio\/\d+\/?$/;

const LAST_SEEN_THROTTLE_MS = 60 * 1000;
// Legacy tokens (paired before migration 014) have expires_at = NULL. Rather
// than living forever they now expire 90 days after the later of paired_at /
// last_seen_at — i.e. a 90-day inactivity window (audit SEC-15). New pairings
// carry an explicit expires_at which wins.
const LEGACY_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export function deviceExpiryMs(device) {
  if (device.expires_at) {
    const t = Date.parse(device.expires_at);
    if (Number.isFinite(t)) return t;
  }
  const paired = Date.parse(device.paired_at || '') || 0;
  const seen = Date.parse(device.last_seen_at || '') || 0;
  return Math.max(paired, seen) + LEGACY_TOKEN_TTL_MS;
}

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
  // Paired-device auth comes from the Authorization header. The legacy
  // `?token=` query-param form is honoured ONLY on the audio GET route (older
  // APKs stream recordings that way; <audio> tags can't set headers). It used
  // to authenticate every route and method, which made a token that landed in
  // a URL/log/history a full API credential (audit SEC-4). Everywhere else the
  // header is required.
  const headerBearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const queryBearer = (!headerBearer && req.method === 'GET' && typeof req.query.token === 'string'
      && AUDIO_TICKET_PATH.test(req.path)) ? req.query.token : undefined;
  const bearer = headerBearer || queryBearer;
  if (bearer) {
    const device = db.prepare(
      'SELECT * FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL'
    ).get(hashToken(bearer));
    if (!device) return res.status(401).json({ error: 'Device not paired or revoked' });
    const nowMs = Date.now();
    if (nowMs >= deviceExpiryMs(device)) {
      return res.status(401).json({ error: 'Device token expired — re-pair this phone' });
    }
    const user = db
      .prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`)
      .get(device.user_id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account inactive' });
    // last_seen_at is a coarse "is this phone alive" signal; writing it on every
    // poll was a needless write per request. At most once per 60 s per device.
    const lastSeenMs = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
    if (!(lastSeenMs > nowMs - LAST_SEEN_THROTTLE_MS)) {
      db.prepare('UPDATE device_tokens SET last_seen_at = ? WHERE id = ?')
        .run(new Date(nowMs).toISOString(), device.id);
    }
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
  // A paired phone has no change-password UI; gating it would strand every
  // sync call after an admin reset (audit SEC-16). The gate stays for sessions.
  if (req.device) return next();
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

// read_only may read but never write. Mount on a router (or a write route) so
// every non-GET request from a read_only session is refused before the handler
// runs — rather than trusting each handler to remember.
export function requireWriter(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (isReadOnly(req.user?.role)) return res.status(403).json({ error: 'Read-only account' });
  next();
}

// Credential lifecycle (audit SEC-5): after a password change / admin reset /
// deactivation, every OTHER credential the account holds must die — paired
// device bearer tokens and browser sessions. `exceptSid` keeps the session that
// performed a self-service change. Returns counts for the audit log.
export function revokeUserCredentials(userId, { exceptSid = null } = {}) {
  const now = new Date().toISOString();
  const devices = db.prepare(
    'UPDATE device_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
  ).run(now, userId).changes;
  let sessions = 0;
  try { sessions = destroySessionsForUser(userId, exceptSid); } catch { /* best effort */ }
  return { revoked_devices: devices, revoked_sessions: sessions };
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
