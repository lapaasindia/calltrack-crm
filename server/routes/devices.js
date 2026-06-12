import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();
router.use(requireAdmin);

// Unambiguous pairing code (no 0/O/1/I), 15-minute validity, single use.
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

router.post('/pairing-code', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
    .get(Number(req.body.user_id));
  if (!user) return res.status(400).json({ error: 'Pick an active team member' });
  const code = makeCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO pairing_codes (code, user_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, user.id, req.user.id, expiresAt, nowUtc());
  res.json({ code, expires_at: expiresAt });
});

router.get('/', (req, res) => {
  const devices = db.prepare(
    `SELECT d.id, d.device_name, d.paired_at, d.last_seen_at, d.revoked_at,
            u.full_name AS user_name, u.id AS user_id
     FROM device_tokens d JOIN users u ON u.id = d.user_id
     ORDER BY d.revoked_at IS NOT NULL, d.last_seen_at DESC`
  ).all();
  res.json(devices);
});

router.post('/:id/revoke', (req, res) => {
  const device = db.prepare('SELECT id FROM device_tokens WHERE id = ? AND revoked_at IS NULL')
    .get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ?').run(nowUtc(), device.id);
  res.json({ ok: true });
});

export default router;
