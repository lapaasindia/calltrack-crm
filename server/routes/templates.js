import { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';

const CATEGORIES = ['intro', 'follow_up', 'payment_reminder', 'support', 'custom'];
const router = Router();

// Callers need templates for WhatsApp buttons.
router.get('/', (req, res) => {
  const includeInactive = req.query.all === '1' && req.user.role === 'admin';
  const rows = db.prepare(
    `SELECT * FROM message_templates ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY sort_order, name`
  ).all();
  res.json(rows);
});

router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const body = String(req.body.body || '').trim();
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'custom';
  if (!name || !body) return res.status(400).json({ error: 'Name and message body required' });
  const info = db.prepare(
    'INSERT INTO message_templates (name, category, body, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, category, body, parseInt(req.body.sort_order, 10) || 0, nowUtc());
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const tpl = db.prepare('SELECT * FROM message_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  db.prepare(
    `UPDATE message_templates SET name = ?, category = ?, body = ?, is_active = ?, sort_order = ? WHERE id = ?`
  ).run(
    req.body.name !== undefined ? String(req.body.name).trim() : tpl.name,
    CATEGORIES.includes(req.body.category) ? req.body.category : tpl.category,
    req.body.body !== undefined ? String(req.body.body) : tpl.body,
    req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : tpl.is_active,
    req.body.sort_order !== undefined ? parseInt(req.body.sort_order, 10) || 0 : tpl.sort_order,
    tpl.id
  );
  res.json({ ok: true });
});

router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM message_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
