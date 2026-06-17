import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from '../db.js';
import { requireAuth, hashToken } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

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
    const info = db.prepare(
      `INSERT INTO device_tokens (user_id, device_name, android_id, token_hash, paired_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(pc.user_id, deviceName, req.body.android_id || null, hashToken(token), nowUtc());
    const user = db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?')
      .get(pc.user_id);
    return { deviceId: info.lastInsertRowid, user };
  })();

  if (!result) return res.status(401).json({ error: 'Invalid or expired pairing code' });
  res.json({ token, device_id: result.deviceId, user: result.user });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
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

  // Regenerate to prevent session fixation, then store the user id.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    logAudit({ action: 'LOGIN_SUCCESS', user, entity_type: 'user', entity_id: user.id, ip: req.ip });
    res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role });
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
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current_password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(new_password), 10), req.user.id);
  res.json({ ok: true });
});

export default router;
