// Lead routing rules CRUD (owner tier). A rule maps a subject (and, by reuse in
// assignment.js, a source) to an owner; admin-created leads with no explicit
// assignee are routed by these rules before falling back to round-robin.
import { Router } from 'express';
import db from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

router.use(requireOwner);

// List rules with the assignee's name for the table.
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT r.id, r.subject, r.assigned_to, r.created_at, u.full_name AS assigned_to_name
       FROM lead_routing_rules r
       LEFT JOIN users u ON u.id = r.assigned_to
      ORDER BY lower(r.subject)`
  ).all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const subject = String(req.body.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'Subject required' });
  const assignedTo = req.body.assigned_to ? Number(req.body.assigned_to) : null;
  if (assignedTo) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(assignedTo);
    if (!u) return res.status(400).json({ error: 'Pick an active team member' });
  }
  const existing = db.prepare(
    'SELECT id FROM lead_routing_rules WHERE lower(trim(subject)) = lower(?)'
  ).get(subject);
  if (existing) return res.status(409).json({ error: 'A rule for this subject already exists' });

  const info = db.prepare(
    'INSERT INTO lead_routing_rules (subject, assigned_to, created_at) VALUES (?, ?, ?)'
  ).run(subject, assignedTo, nowUtc());
  logAudit({ action: 'ROUTING_RULE_CREATE', user: req.user, entity_type: 'routing_rule',
    entity_id: info.lastInsertRowid, details: { subject, assigned_to: assignedTo }, ip: req.ip });
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM lead_routing_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  db.prepare('DELETE FROM lead_routing_rules WHERE id = ?').run(rule.id);
  logAudit({ action: 'ROUTING_RULE_DELETE', user: req.user, entity_type: 'routing_rule',
    entity_id: rule.id, details: { subject: rule.subject }, ip: req.ip });
  res.json({ ok: true });
});

export default router;
