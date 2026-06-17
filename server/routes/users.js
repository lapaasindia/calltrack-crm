import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc, todayIst } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';
import { ROLES, isOwner } from '../lib/permissions.js';
import { passwordPolicyError } from './auth.js';

const router = Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.department, u.created_at,
            t.calls_target, t.connects_target, t.deals_target
     FROM users u
     LEFT JOIN targets t ON t.id = (
       SELECT id FROM targets WHERE user_id = u.id AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1
     )
     ORDER BY u.role, u.full_name`
  ).all(todayIst());
  res.json(users);
});

router.post('/', (req, res) => {
  const username = String(req.body.username || '').trim();
  const full_name = String(req.body.full_name || '').trim();
  const password = String(req.body.password || '');
  // Any of the known roles; unknown → 'caller' (the safe least-privilege default
  // that still has its own leads).
  const role = ROLES.includes(req.body.role) ? req.body.role : 'caller';
  const department = req.body.department ? String(req.body.department).trim().slice(0, 80) : null;
  if (!username || !full_name) return res.status(400).json({ error: 'Username and full name required' });
  const pwError = passwordPolicyError(password, username);
  if (pwError) return res.status(400).json({ error: pwError });
  // Only an owner (super_admin/admin) may mint an owner-tier account. Without
  // this a manager (also isAdmin) could create a super_admin and log into it,
  // escalating past every requireOwner gate.
  if (isOwner(role) && !isOwner(req.user.role)) {
    return res.status(403).json({ error: 'Only an owner can grant admin/super_admin' });
  }

  try {
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, department, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, bcrypt.hashSync(password, 10), full_name, role, department, nowUtc());
    logAudit({
      action: 'EMPLOYEE_CREATED', user: req.user, entity_type: 'user',
      entity_id: info.lastInsertRowid, details: { username, full_name, role, department }, ip: req.ip,
    });
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    throw err;
  }
});

router.patch('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Editing an owner-tier (super_admin/admin) account at all is owner-only. A
  // manager is isAdmin (so the router lets them in) but must not be able to
  // reset an owner's password, deactivate them, or otherwise mutate the
  // account — that would let them log in as an owner and bypass every
  // requireOwner gate. The role-change branch is separately owner-gated below.
  if (isOwner(user.role) && !isOwner(req.user.role)) {
    return res.status(403).json({ error: 'Only an owner can modify an admin/super_admin account' });
  }

  const changed = [];
  if (req.body.full_name !== undefined) {
    db.prepare('UPDATE users SET full_name = ? WHERE id = ?')
      .run(String(req.body.full_name).trim(), user.id);
    changed.push('full_name');
  }
  if (req.body.role !== undefined) {
    if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Unknown role' });
    if (user.id === req.user.id && req.body.role !== user.role) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    // Promoting anyone INTO the owner tier (or editing an existing owner) is
    // owner-only — stops a manager from minting/keeping a super_admin to escape
    // the requireOwner gates.
    if ((isOwner(req.body.role) || isOwner(user.role)) && !isOwner(req.user.role)) {
      return res.status(403).json({ error: 'Only an owner can grant or change admin/super_admin' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, user.id);
    changed.push('role');
  }
  if (req.body.department !== undefined) {
    const dept = req.body.department ? String(req.body.department).trim().slice(0, 80) : null;
    db.prepare('UPDATE users SET department = ? WHERE id = ?').run(dept, user.id);
    changed.push('department');
  }
  if (req.body.is_active !== undefined) {
    const active = req.body.is_active ? 1 : 0;
    if (!active && user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate yourself' });
    }
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active, user.id);
    changed.push('is_active');
  }
  if (req.body.new_password !== undefined) {
    const pw = String(req.body.new_password);
    const pwError = passwordPolicyError(pw, user.username);
    if (pwError) return res.status(400).json({ error: pwError });
    // An admin-set password is temporary — force the user to pick their own on
    // next login (audit H-1, defense in depth for reset accounts).
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(bcrypt.hashSync(pw, 10), user.id);
    changed.push('password');
  }
  if (changed.length) {
    logAudit({
      action: 'EMPLOYEE_UPDATED', user: req.user, entity_type: 'user',
      entity_id: user.id, details: { fields: changed }, ip: req.ip,
    });
  }
  res.json({ ok: true });
});

// Deactivate-as-delete: the schema has FK children (calls/leads/targets) so a
// hard DELETE would orphan them — we soft-delete by deactivating + logging.
router.delete('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
  logAudit({
    action: 'EMPLOYEE_DELETED', user: req.user, entity_type: 'user',
    entity_id: user.id, details: { username: user.username }, ip: req.ip,
  });
  res.json({ ok: true });
});

// Set targets effective from a given IST date (defaults to today).
router.put('/:id/targets', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const calls = Math.max(0, parseInt(req.body.calls_target, 10) || 0);
  const connects = Math.max(0, parseInt(req.body.connects_target, 10) || 0);
  const deals = Math.max(0, parseInt(req.body.deals_target, 10) || 0);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.body.effective_from || '')
    ? req.body.effective_from : todayIst();
  db.prepare(
    `INSERT INTO targets (user_id, calls_target, connects_target, deals_target, effective_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, effective_from) DO UPDATE SET
       calls_target = excluded.calls_target,
       connects_target = excluded.connects_target,
       deals_target = excluded.deals_target`
  ).run(user.id, calls, connects, deals, from, nowUtc());
  res.json({ ok: true });
});

export default router;
