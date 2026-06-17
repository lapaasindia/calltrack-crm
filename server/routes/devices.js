import { Router } from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { isOwner } from '../lib/permissions.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();
router.use(requireAdmin);

// Unambiguous pairing code (no 0/O/1/I), 15-minute validity, single use.
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

// Reachable LAN URLs for this host. The phone connects to whatever address the
// pairing QR contains, so it must be a real LAN IP — NOT 127.0.0.1/localhost
// (which the desktop app's browser shows) nor a .local name (which some Android
// phones can't resolve). We list every non-internal IPv4, putting the host IP
// on the same /24 as the requesting admin first so a phone on the office WiFi
// gets a directly-reachable address.
function lanUrls(req) {
  const port = (req.headers.host || '').split(':')[1] || req.socket.localPort || 3000;
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  const clientNet = String(req.ip || '').replace(/^::ffff:/, '').split('.').slice(0, 3).join('.');
  const net = (ip) => ip.split('.').slice(0, 3).join('.');
  ips.sort((a, b) => Number(net(b) === clientNet) - Number(net(a) === clientNet));
  return ips.map((ip) => `http://${ip}:${port}`);
}

router.post('/pairing-code', (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND is_active = 1')
    .get(Number(req.body.user_id));
  if (!user) return res.status(400).json({ error: 'Pick an active team member' });
  // Only an owner may pair a phone to an owner-tier account. Without this a
  // manager (also isAdmin, so the router lets them in) could mint a pairing
  // code for a super_admin, pair their own phone, and hold an owner-tier bearer
  // token that bypasses every requireOwner gate (audit H-8). Mirrors users.js.
  if (isOwner(user.role) && !isOwner(req.user.role)) {
    return res.status(403).json({ error: 'Only an owner can pair a device to an admin/super_admin account' });
  }
  const code = makeCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO pairing_codes (code, user_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, user.id, req.user.id, expiresAt, nowUtc());
  res.json({ code, expires_at: expiresAt, urls: lanUrls(req) });
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
