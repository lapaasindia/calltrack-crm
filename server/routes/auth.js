import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from '../db.js';
import { requireAuth, hashToken } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// Shared password policy (audit H-1/H-2): min 8 chars, not the username, and
// not one of a handful of obvious defaults (notably the bootstrap 'admin123').
const WEAK_PASSWORDS = new Set([
  'admin123', 'password', 'password1', '12345678', '123456789', 'qwerty123',
  'admin1234', 'changeme', 'letmein1', 'calltrack',
]);
export function passwordPolicyError(pw, username) {
  const p = String(pw || '');
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 200) return 'Password is too long';
  if (username && p.toLowerCase() === String(username).toLowerCase()) {
    return 'Password must not be your username';
  }
  if (WEAK_PASSWORDS.has(p.toLowerCase())) return 'That password is too common — pick a stronger one';
  return null;
}

// ---- device pairing (public, rate-limited) ----
const pairAttempts = new Map(); // ip -> { count, resetAt }
function pairRateLimited(ip) {
  const now = Date.now();
  const slot = pairAttempts.get(ip);
  if (!slot || slot.resetAt < now) {
    pairAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return false;
  }
  slot.count += 1;
  return slot.count > 10;
}

// ---- login throttling (audit H-2) ----
// Per-IP AND per-username failure tracking with lockout. req.ip is the
// non-spoofable socket peer (no trust proxy), so it's a sound limiter key.
const loginAttempts = new Map(); // key -> { fails, resetAt, lockUntil }
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function loginKeys(ip, username) {
  return [`ip:${ip}`, `user:${String(username).toLowerCase()}`];
}
// Returns seconds remaining if locked out, else 0.
function loginLockedFor(ip, username) {
  const now = Date.now();
  let lock = 0;
  for (const k of loginKeys(ip, username)) {
    const slot = loginAttempts.get(k);
    if (slot && slot.lockUntil > now) lock = Math.max(lock, Math.ceil((slot.lockUntil - now) / 1000));
  }
  return lock;
}
function recordLoginFailure(ip, username) {
  const now = Date.now();
  if (loginAttempts.size > 5000) {
    for (const [k, s] of loginAttempts) {
      if (s.lockUntil < now && s.resetAt < now) loginAttempts.delete(k);
    }
  }
  for (const k of loginKeys(ip, username)) {
    const slot = loginAttempts.get(k) || { fails: 0, resetAt: now + LOGIN_WINDOW_MS, lockUntil: 0 };
    if (slot.resetAt < now) { slot.fails = 0; slot.resetAt = now + LOGIN_WINDOW_MS; }
    slot.fails += 1;
    if (slot.fails >= LOGIN_MAX_FAILS) slot.lockUntil = now + LOGIN_LOCK_MS;
    loginAttempts.set(k, slot);
  }
}
function clearLoginFailures(ip, username) {
  for (const k of loginKeys(ip, username)) loginAttempts.delete(k);
}

// Exchange a one-time pairing code (from the admin's QR) for a long-lived
// device token. The raw token is returned exactly once; only its hash is kept.
router.post('/pair', (req, res) => {
  if (pairRateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait 5 minutes' });
  const code = String(req.body.code || '').trim().toUpperCase();
  const deviceName = String(req.body.device_name || 'Android phone').slice(0, 80);
  if (!code) return res.status(400).json({ error: 'Pairing code required' });

  const token = crypto.randomBytes(32).toString('hex');
  const result = db.transaction(() => {
    const pc = db.prepare(
      'SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL'
    ).get(code);
    if (!pc || pc.expires_at < nowUtc()) return null;
    db.prepare('UPDATE pairing_codes SET used_at = ? WHERE id = ?').run(nowUtc(), pc.id);
    // Tokens expire (audit M-1) — re-pairing is one QR scan. 90-day TTL.
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(
      `INSERT INTO device_tokens (user_id, device_name, android_id, token_hash, paired_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pc.user_id, deviceName, req.body.android_id || null, hashToken(token), nowUtc(), expiresAt);
    const user = db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?')
      .get(pc.user_id);
    return { deviceId: info.lastInsertRowid, user };
  })();

  if (!result) return res.status(401).json({ error: 'Invalid or expired pairing code' });
  res.json({ token, device_id: result.deviceId, user: result.user });
});

router.post('/login', (req, res) => {
  // Cap the username before it is used or logged, so a flood can't store
  // arbitrarily long attacker strings in audit_logs (audit L-7).
  const username = String(req.body.username || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const lockedFor = loginLockedFor(req.ip, username);
  if (lockedFor) {
    return res.status(429).json({ error: `Too many attempts — try again in ${Math.ceil(lockedFor / 60)} minute(s)` });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(req.ip, username);
    logAudit({
      action: 'LOGIN_FAILED',
      user: user && user.is_active ? user : null,
      entity_type: 'user',
      entity_id: user?.id,
      details: { username },
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearLoginFailures(req.ip, username);

  // Regenerate to prevent session fixation, then store the user id.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    logAudit({ action: 'LOGIN_SUCCESS', user, entity_type: 'user', entity_id: user.id, ip: req.ip });
    res.json({
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      must_change_password: !!user.must_change_password,
    });
  });
});

router.post('/logout', (req, res) => {
  const user = req.session?.userId
    ? db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  if (user) logAudit({ action: 'LOGOUT', user, entity_type: 'user', entity_id: user.id, ip: req.ip });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  const pw = String(new_password || '');
  const policyError = passwordPolicyError(pw, req.user.username);
  if (policyError) return res.status(400).json({ error: policyError });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current_password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  // Clear must_change_password: this lifts the change-password lockout (H-1).
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(pw, 10), req.user.id);
  logAudit({ action: 'PASSWORD_CHANGED', user: req.user, entity_type: 'user', entity_id: req.user.id, ip: req.ip });
  res.json({ ok: true });
});

export default router;
