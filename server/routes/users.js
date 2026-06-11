import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc, todayIst } from '../lib/istTime.js';

const router = Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.created_at,
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
  const role = req.body.role === 'admin' ? 'admin' : 'caller';
  if (!username || !full_name) return res.status(400).json({ error: 'Username and full name required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, bcrypt.hashSync(password, 10), full_name, role, nowUtc());
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

  if (req.body.full_name !== undefined) {
    db.prepare('UPDATE users SET full_name = ? WHERE id = ?')
      .run(String(req.body.full_name).trim(), user.id);
  }
  if (req.body.is_active !== undefined) {
    const active = req.body.is_active ? 1 : 0;
    if (!active && user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate yourself' });
    }
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active, user.id);
  }
  if (req.body.new_password !== undefined) {
    const pw = String(req.body.new_password);
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(pw, 10), user.id);
  }
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
