import { Router } from 'express';
import db from '../db.js';
import { nowUtc, todayIst } from '../lib/istTime.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const router = Router();

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.user.role === 'caller') {
    where.push('t.assigned_to = ?');
    params.push(req.user.id);
  } else if (req.query.assigned_to) {
    where.push('t.assigned_to = ?');
    params.push(Number(req.query.assigned_to));
  }
  where.push(req.query.status === 'all' ? '1=1' : "t.status = 'pending'");
  if (req.query.lead_id) {
    where.push('t.lead_id = ?');
    params.push(Number(req.query.lead_id));
  }
  const rows = db.prepare(
    `SELECT t.*, u.full_name AS assigned_to_name, l.name AS lead_name, l.phone AS lead_phone
     FROM tasks t
     JOIN users u ON u.id = t.assigned_to
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.due_date, t.id LIMIT 300`
  ).all(...params);
  res.json(rows);
});

router.post('/', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title required' });
  const dueDate = DATE_RE.test(req.body.due_date || '') ? req.body.due_date : todayIst();

  let assignedTo = req.user.id;
  if (req.user.role === 'admin' && req.body.assigned_to) {
    assignedTo = Number(req.body.assigned_to);
  }
  let leadId = null;
  if (req.body.lead_id) {
    const lead = db.prepare('SELECT id, assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL')
      .get(Number(req.body.lead_id));
    if (!lead) return res.status(400).json({ error: 'Invalid lead' });
    if (req.user.role !== 'admin' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Not your lead' });
    }
    leadId = lead.id;
  }

  const info = db.prepare(
    `INSERT INTO tasks (title, details, lead_id, assigned_to, due_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, req.body.details || null, leadId, assignedTo, dueDate, req.user.id, nowUtc());
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role !== 'admin' && task.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Not your task' });
  }
  const status = ['pending', 'done', 'cancelled'].includes(req.body.status)
    ? req.body.status : task.status;
  db.prepare(
    `UPDATE tasks SET title = ?, details = ?, due_date = ?, status = ?,
       completed_at = CASE WHEN ? = 'done' AND status != 'done' THEN ? ELSE completed_at END
     WHERE id = ?`
  ).run(
    req.body.title !== undefined ? String(req.body.title).trim() || task.title : task.title,
    req.body.details !== undefined ? req.body.details : task.details,
    DATE_RE.test(req.body.due_date || '') ? req.body.due_date : task.due_date,
    status, status, nowUtc(), task.id
  );
  res.json({ ok: true });
});

export default router;
