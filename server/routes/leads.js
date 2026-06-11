import { Router } from 'express';
import db from '../db.js';
import { requireAdmin, loadLead } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc } from '../lib/istTime.js';
import { STAGES, changeStage } from '../lib/leadStage.js';

const router = Router();

const LEAD_COLS = `l.id, l.name, l.phone, l.alt_phone, l.email, l.city, l.source, l.stage,
  l.lost_reason, l.assigned_to, l.notes, l.created_at, l.updated_at,
  u.full_name AS assigned_to_name`;

// List with filters. Callers are hard-scoped to their own leads at the SQL level.
router.get('/', (req, res) => {
  const where = ['l.deleted_at IS NULL'];
  const params = [];

  if (req.user.role === 'caller') {
    where.push('l.assigned_to = ?');
    params.push(req.user.id);
  } else if (req.query.assigned_to === 'none') {
    where.push('l.assigned_to IS NULL');
  } else if (req.query.assigned_to) {
    where.push('l.assigned_to = ?');
    params.push(Number(req.query.assigned_to));
  }

  if (req.query.stage && STAGES.includes(req.query.stage)) {
    where.push('l.stage = ?');
    params.push(req.query.stage);
  }
  if (req.query.source) {
    where.push('l.source = ?');
    params.push(req.query.source);
  }
  if (req.query.q) {
    const q = String(req.query.q).trim();
    const asPhone = normalizePhone(q);
    if (asPhone.ok) {
      where.push('(l.phone = ? OR l.name LIKE ?)');
      params.push(asPhone.phone, `%${q}%`);
    } else {
      where.push('(l.name LIKE ? OR l.phone LIKE ? OR l.city LIKE ? OR l.email LIKE ?)');
      const like = `%${q}%`;
      params.push(like, q.replace(/\D/g, '') ? `%${q.replace(/\D/g, '')}%` : like, like, like);
    }
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 50;
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(' AND ')}`
  ).get(...params).n;
  const rows = db.prepare(
    `SELECT ${LEAD_COLS},
       (SELECT due_at FROM follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending') AS next_follow_up,
       (SELECT MAX(called_at) FROM calls c WHERE c.lead_id = l.id) AS last_call_at
     FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
     WHERE ${where.join(' AND ')}
     ORDER BY l.updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);

  res.json({ leads: rows, total, page, page_size: pageSize });
});

// Distinct sources for the filter dropdown.
router.get('/sources', (req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT source FROM leads WHERE deleted_at IS NULL ORDER BY source"
  ).all();
  res.json(rows.map((r) => r.source));
});

// Live duplicate check for the add-lead form.
router.get('/check-phone', (req, res) => {
  const norm = normalizePhone(req.query.phone);
  if (!norm.ok) return res.json({ valid: false, reason: norm.reason });
  const existing = db.prepare(
    'SELECT id, name, stage, assigned_to FROM leads WHERE phone = ? AND deleted_at IS NULL'
  ).get(norm.phone);
  res.json({ valid: true, phone: norm.phone, duplicate: existing || null });
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const norm = normalizePhone(req.body.phone);
  if (!norm.ok) return res.status(400).json({ error: `Invalid phone number (${norm.reason})` });

  const existing = db.prepare(
    'SELECT id, name FROM leads WHERE phone = ? AND deleted_at IS NULL'
  ).get(norm.phone);
  if (existing) {
    return res.status(409).json({ error: 'A lead with this phone already exists', existing });
  }

  // Callers can only create leads assigned to themselves.
  let assignedTo = req.user.id;
  if (req.user.role === 'admin' && req.body.assigned_to !== undefined) {
    assignedTo = req.body.assigned_to ? Number(req.body.assigned_to) : null;
  }

  const now = nowUtc();
  const info = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, alt_phone, email, city, source, assigned_to, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, norm.phone, String(req.body.phone), req.body.alt_phone || null,
    req.body.email || null, req.body.city || null,
    String(req.body.source || 'manual').trim() || 'manual',
    assignedTo, req.body.notes || null, now, now
  );
  res.json({ id: info.lastInsertRowid });
});

// Lead detail: full timeline (calls + stage events), deals with balances, follow-up.
router.get('/:id', loadLead, (req, res) => {
  const lead = req.lead;
  const assignedName = lead.assigned_to
    ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(lead.assigned_to)?.full_name
    : null;
  const calls = db.prepare(
    `SELECT c.*, u.full_name AS user_name FROM calls c
     JOIN users u ON u.id = c.user_id WHERE c.lead_id = ? ORDER BY c.called_at DESC`
  ).all(lead.id);
  const events = db.prepare(
    `SELECT e.*, u.full_name AS user_name FROM lead_events e
     JOIN users u ON u.id = e.changed_by WHERE e.lead_id = ? ORDER BY e.changed_at DESC`
  ).all(lead.id);
  const followUp = db.prepare(
    "SELECT * FROM follow_ups WHERE lead_id = ? AND status = 'pending'"
  ).get(lead.id);
  const deals = db.prepare(
    `SELECT d.*, p.name AS product_name,
       COALESCE((SELECT SUM(amount_paise) FROM payments WHERE deal_id = d.id), 0) AS paid_paise
     FROM deals d JOIN products p ON p.id = d.product_id
     WHERE d.lead_id = ? ORDER BY d.created_at DESC`
  ).all(lead.id);
  for (const deal of deals) {
    deal.pending_paise = deal.deal_value_paise - deal.paid_paise;
    deal.installments = db.prepare(
      'SELECT * FROM installments WHERE deal_id = ? ORDER BY seq'
    ).all(deal.id);
    deal.payments = db.prepare(
      `SELECT p.*, u.full_name AS recorded_by_name FROM payments p
       JOIN users u ON u.id = p.recorded_by WHERE p.deal_id = ? ORDER BY p.received_date DESC, p.id DESC`
    ).all(deal.id);
  }
  res.json({
    ...lead, assigned_to_name: assignedName,
    extra: lead.extra_json ? JSON.parse(lead.extra_json) : null,
    calls, events, follow_up: followUp || null, deals,
  });
});

router.patch('/:id', loadLead, (req, res) => {
  const lead = req.lead;

  // Stage change (manual): callers and admins; recorded in lead_events.
  if (req.body.stage !== undefined && req.body.stage !== lead.stage) {
    if (!STAGES.includes(req.body.stage)) return res.status(400).json({ error: 'Invalid stage' });
    if (req.body.stage === 'won') {
      return res.status(400).json({ error: 'Use the Win Deal flow to mark a lead won' });
    }
    changeStage(lead.id, lead.stage, req.body.stage, req.user.id, req.body.lost_reason || null);
  }

  // Assignment is admin-only.
  if (req.body.assigned_to !== undefined) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can reassign leads' });
    const newAssignee = req.body.assigned_to ? Number(req.body.assigned_to) : null;
    db.prepare('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?')
      .run(newAssignee, nowUtc(), lead.id);
    // Pending follow-up moves with the lead so it doesn't rot in the old caller's queue.
    if (newAssignee) {
      db.prepare("UPDATE follow_ups SET assigned_to = ? WHERE lead_id = ? AND status = 'pending'")
        .run(newAssignee, lead.id);
    }
  }

  const fields = ['name', 'alt_phone', 'email', 'city', 'source', 'notes'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      db.prepare(`UPDATE leads SET ${f} = ?, updated_at = ? WHERE id = ?`)
        .run(req.body[f] === '' ? null : req.body[f], nowUtc(), lead.id);
    }
  }
  if (req.body.phone !== undefined) {
    const norm = normalizePhone(req.body.phone);
    if (!norm.ok) return res.status(400).json({ error: `Invalid phone number (${norm.reason})` });
    const dup = db.prepare(
      'SELECT id FROM leads WHERE phone = ? AND deleted_at IS NULL AND id != ?'
    ).get(norm.phone, lead.id);
    if (dup) return res.status(409).json({ error: 'Another lead already has this phone', existing: dup });
    db.prepare('UPDATE leads SET phone = ?, phone_raw = ?, updated_at = ? WHERE id = ?')
      .run(norm.phone, String(req.body.phone), nowUtc(), lead.id);
  }
  res.json({ ok: true });
});

// Soft delete (admin only).
router.delete('/:id', requireAdmin, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead || lead.deleted_at) return res.status(404).json({ error: 'Lead not found' });
  db.transaction(() => {
    db.prepare('UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(nowUtc(), nowUtc(), lead.id);
    db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'")
      .run(lead.id);
  })();
  res.json({ ok: true });
});

// Bulk assign (admin): distribute selected leads to a caller, or round-robin.
router.post('/bulk-assign', requireAdmin, (req, res) => {
  const ids = (req.body.lead_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No leads selected' });

  let assignees;
  if (req.body.round_robin) {
    assignees = db.prepare(
      "SELECT id FROM users WHERE role = 'caller' AND is_active = 1 ORDER BY id"
    ).all().map((u) => u.id);
    if (!assignees.length) return res.status(400).json({ error: 'No active callers to assign to' });
  } else {
    const userId = Number(req.body.assigned_to);
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user) return res.status(400).json({ error: 'Invalid assignee' });
    assignees = [userId];
  }

  const update = db.prepare('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
  const moveFu = db.prepare("UPDATE follow_ups SET assigned_to = ? WHERE lead_id = ? AND status = 'pending'");
  db.transaction(() => {
    ids.forEach((id, i) => {
      const to = assignees[i % assignees.length];
      update.run(to, nowUtc(), id);
      moveFu.run(to, id);
    });
  })();
  res.json({ ok: true, assigned: ids.length });
});

export default router;
