import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from '../db.js';
import { requireAuth, hashToken, revokeUserCredentials } from '../middleware/auth.js';
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
  // Prune expired slots so distinct source IPs can't grow the map forever
  // (audit SEC-13). Cheap: only runs when the map is non-trivial.
  if (pairAttempts.size > 500) {
    for (const [k, s] of pairAttempts) if (s.resetAt < now) pairAttempts.delete(k);
  }
  const slot = pairAttempts.get(ip);
  if (!slot || slot.resetAt < now) {
    pairAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return false;
  }
  slot.count += 1;
  return slot.count > 10;
}
// A successful exchange is not an attack signal (the code was minted by an
// admin and is single-use) — refund its slot so pairing a dozen phones from
// one office IP within five minutes is not throttled; only failures count.
function pairAttemptSucceeded(ip) {
  const slot = pairAttempts.get(ip);
  if (slot && slot.count > 0) slot.count -= 1;
}

// ---- login throttling (audit H-2, redesigned per SEC-3) ----
// Two independent limiters, both keyed on req.ip (the non-spoofable socket
// peer — no trust proxy):
//   * per-IP: a peer gets LOGIN_IP_FREE_FAILS failures per 15-min window for
//     free; every further failure locks that IP for an escalating delay that
//     doubles from 30 s up to 15 min. This throttles brute force from one
//     device without letting it hard-lock the whole office.
//   * per-(IP, username): 5 failures against an EXISTING account from one IP
//     lock that (IP, account) pair for 15 min. A failure for a username that
//     does not exist counts ONLY toward the per-IP key — so an attacker can't
//     lock a victim account (or any account) just by naming it, and can't lock
//     a whole shared IP by hammering bogus names either (SEC-3).
// A successful login clears both keys for that IP.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_FREE_FAILS = 5;          // failures per window before throttling
const LOGIN_IP_LOCK_MIN_MS = 30 * 1000; // first per-IP lock
const LOGIN_IP_LOCK_MAX_MS = 15 * 60 * 1000;
const LOGIN_USER_MAX_FAILS = 5;         // per (IP, username)
const LOGIN_USER_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAP_SOFT_CAP = 5000;

const ipAttempts = new Map();     // ip -> { fails, resetAt, lockUntil, level }
const ipUserAttempts = new Map(); // `${ip}\n${user}` -> { fails, resetAt, lockUntil }

const ipUserKey = (ip, username) => `${ip}\n${String(username).toLowerCase()}`;

function pruneLoginMaps(force = false) {
  const now = Date.now();
  for (const m of [ipAttempts, ipUserAttempts]) {
    if (!force && m.size <= LOGIN_MAP_SOFT_CAP) continue;
    for (const [k, s] of m) if (s.lockUntil < now && s.resetAt < now) m.delete(k);
  }
}
// Periodic sweep so a quiet server doesn't hold stale entries until the next
// burst. unref'd: never keeps the process (or a test runner) alive.
setInterval(() => pruneLoginMaps(true), 5 * 60 * 1000).unref();

// Seconds remaining on the strictest active lock for this (ip, username), else 0.
function loginLockedFor(ip, username) {
  const now = Date.now();
  let lock = 0;
  const ipSlot = ipAttempts.get(ip);
  if (ipSlot && ipSlot.lockUntil > now) lock = Math.max(lock, ipSlot.lockUntil - now);
  const userSlot = ipUserAttempts.get(ipUserKey(ip, username));
  if (userSlot && userSlot.lockUntil > now) lock = Math.max(lock, userSlot.lockUntil - now);
  return Math.ceil(lock / 1000);
}

// Record a failed attempt. `userExists` decides whether the (IP, username)
// limiter is touched. Returns seconds of lock now in force (0 = none).
function recordLoginFailure(ip, username, userExists) {
  const now = Date.now();
  pruneLoginMaps();
  let lockSec = 0;

  const ipSlot = ipAttempts.get(ip) || { fails: 0, resetAt: 0, lockUntil: 0, level: 0 };
  if (ipSlot.resetAt < now) { ipSlot.fails = 0; ipSlot.level = 0; }
  ipSlot.fails += 1;
  ipSlot.resetAt = now + LOGIN_WINDOW_MS; // sliding window
  if (ipSlot.fails > LOGIN_IP_FREE_FAILS) {
    const ms = Math.min(LOGIN_IP_LOCK_MAX_MS, LOGIN_IP_LOCK_MIN_MS * 2 ** ipSlot.level);
    ipSlot.level += 1;
    ipSlot.lockUntil = now + ms;
    lockSec = Math.max(lockSec, Math.ceil(ms / 1000));
  }
  ipAttempts.set(ip, ipSlot);

  if (userExists) {
    const key = ipUserKey(ip, username);
    const slot = ipUserAttempts.get(key) || { fails: 0, resetAt: 0, lockUntil: 0 };
    if (slot.resetAt < now) slot.fails = 0;
    slot.fails += 1;
    slot.resetAt = now + LOGIN_WINDOW_MS;
    if (slot.fails >= LOGIN_USER_MAX_FAILS) {
      slot.lockUntil = now + LOGIN_USER_LOCK_MS;
      lockSec = Math.max(lockSec, Math.ceil(LOGIN_USER_LOCK_MS / 1000));
    }
    ipUserAttempts.set(key, slot);
  }
  return lockSec;
}
function clearLoginFailures(ip, username) {
  ipAttempts.delete(ip);
  ipUserAttempts.delete(ipUserKey(ip, username));
}
// Test/ops hooks: wipe the in-memory limiter state.
export function resetLoginThrottle() {
  ipAttempts.clear();
  ipUserAttempts.clear();
  pairAttempts.clear();
}
export function _resetPairThrottleForTests() {
  pairAttempts.clear();
}

function humanDelay(sec) {
  return sec >= 60 ? `${Math.ceil(sec / 60)} minute(s)` : `${sec} second(s)`;
}
function tooManyAttempts(res, sec) {
  res.set('Retry-After', String(Math.max(1, sec)));
  return res.status(429).json({
    error: `Too many attempts — try again in ${humanDelay(Math.max(1, sec))}`,
    retry_after_seconds: Math.max(1, sec),
  });
}

// Constant-time-ish login (SEC-11): when the username is unknown we still run
// a bcrypt compare against this fixed hash, so an unknown name costs the same
// wall time as a wrong password and usernames can't be enumerated by timing.
const DUMMY_HASH = bcrypt.hashSync('calltrack-dummy-timing-password', 10);

// Exchange a one-time pairing code (from the admin's QR) for a long-lived
// device token. The raw token is returned exactly once; only its hash is kept.
router.post('/pair', (req, res) => {
  if (pairRateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait 5 minutes' });
  const code = String(req.body.code || '').trim().toUpperCase();
  // device_model (MOB-20: the app's Build.MODEL, e.g. "Pixel 8") is the
  // preferred display name when present; device_name is the legacy field.
  const deviceModel = typeof req.body.device_model === 'string'
    ? req.body.device_model.trim().slice(0, 80) : '';
  const deviceName = deviceModel || String(req.body.device_name || 'Android phone').trim().slice(0, 80) || 'Android phone';
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
    // Ignore the "unknown" sentinel (the app returns it when ANDROID_ID is null)
    // and blanks — otherwise two unidentifiable phones would collapse onto one
    // device row and start colliding again.
    // Must be a string of at most 64 chars (ANDROID_ID is 16 hex chars); a
    // non-string used to reach the SQLite binder and 500. Anything else is
    // treated as absent.
    const rawAndroidId = typeof req.body.android_id === 'string' ? req.body.android_id.trim() : '';
    const androidId = (rawAndroidId && rawAndroidId !== 'unknown' && rawAndroidId.length <= 64)
      ? rawAndroidId : null;
    // Reuse this physical phone's existing device row (same user + android_id)
    // instead of accumulating a new one on every re-pair. This keeps device_id
    // STABLE across reinstalls, so the device-scoped call dedupe (migration 015)
    // still suppresses a re-synced history — while two DIFFERENT phones keep
    // distinct device_ids. Only reuse a still-active row (a REVOKED device forks
    // a fresh row so the revocation record survives); ORDER BY id DESC keeps the
    // pick deterministic if a legacy DB holds duplicate rows for this phone.
    const existing = androidId
      ? db.prepare(
        `SELECT id FROM device_tokens
         WHERE user_id = ? AND android_id = ? AND revoked_at IS NULL
         ORDER BY id DESC LIMIT 1`
      ).get(pc.user_id, androidId)
      : null;
    let deviceId;
    if (existing) {
      db.prepare(
        `UPDATE device_tokens
           SET device_name = ?, token_hash = ?, paired_at = ?, expires_at = ?, revoked_at = NULL
         WHERE id = ?`
      ).run(deviceName, hashToken(token), nowUtc(), expiresAt, existing.id);
      deviceId = existing.id;
    } else {
      const info = db.prepare(
        `INSERT INTO device_tokens (user_id, device_name, android_id, token_hash, paired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(pc.user_id, deviceName, androidId, hashToken(token), nowUtc(), expiresAt);
      deviceId = info.lastInsertRowid;
    }
    const user = db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?')
      .get(pc.user_id);
    return { deviceId, user };
  })();

  if (!result) return res.status(401).json({ error: 'Invalid or expired pairing code' });
  pairAttemptSucceeded(req.ip);
  res.json({ token, device_id: result.deviceId, user: result.user });
});

router.post('/login', (req, res) => {
  // Cap the username before it is used or logged, so a flood can't store
  // arbitrarily long attacker strings in audit_logs (audit L-7).
  const username = String(req.body.username || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const lockedFor = loginLockedFor(req.ip, username);
  if (lockedFor) return tooManyAttempts(res, lockedFor);

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Always pay the bcrypt cost (SEC-11): compare against the real hash when the
  // user exists, else against a dummy hash whose result is discarded.
  const passwordOk = user
    ? bcrypt.compareSync(password, user.password_hash)
    : (bcrypt.compareSync(password, DUMMY_HASH), false);
  if (!user || !user.is_active || !passwordOk) {
    const lockSec = recordLoginFailure(req.ip, username, !!user);
    logAudit({
      action: 'LOGIN_FAILED',
      user: user && user.is_active ? user : null,
      entity_type: 'user',
      entity_id: user?.id,
      details: { username },
      ip: req.ip,
    });
    // The failure that crosses a threshold answers 429 (with Retry-After) so
    // clients back off immediately instead of discovering the lock next time.
    if (lockSec) return tooManyAttempts(res, lockSec);
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
  // A password change is the "someone has my password" response: cut off every
  // OTHER credential this account holds — paired-phone tokens and other browser
  // sessions — while keeping the session that made the change (SEC-5).
  const revoked = revokeUserCredentials(req.user.id, { exceptSid: req.session?.id });
  logAudit({
    action: 'PASSWORD_CHANGED', user: req.user, entity_type: 'user', entity_id: req.user.id,
    details: revoked, ip: req.ip,
  });
  res.json({ ok: true, ...revoked });
});

export default router;
