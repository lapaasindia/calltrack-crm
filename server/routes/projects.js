// Phase 4A — Projects CRUD.
//
// Money is INTEGER paise (budget_paise >= 0). progress is a clamped 0..100
// integer. start_date / end_date are IST business dates ('YYYY-MM-DD').
//
// Access model:
//   - Create requires CREATE_PROJECT (everyone except read_only).
//   - Delete requires DELETE_RECORDS (admin tier: super_admin|admin|manager).
//   - Admins (admin tier) see ALL projects; everyone else only LIST/GET projects
//     where assigned_head_id = self.
import { Router } from 'express';
import db from '../db.js';
import { nowUtc } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';
import { isAdmin, hasPermission } from '../lib/permissions.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['Approval', 'Assigned', 'Working', 'Review', 'Completed', 'Pending Client'];

// Parse + validate an integer-paise value. Returns null when invalid; 0 is OK.
function toPaise(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// Clamp a progress value to an integer 0..100. Returns null when not numeric.
function toProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function optDate(v) {
  return DATE_RE.test(v || '') ? v : null;
}

// A project is accessible if the caller is admin tier OR is its head.
function canAccessProject(user, project) {
  if (!project) return false;
  if (isAdmin(user.role)) return true;
  return project.assigned_head_id === user.id;
}

const SELECT = `SELECT p.*, l.name AS lead_name, l.phone AS lead_phone,
       u.full_name AS head_name,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.board_status = 'Done') AS done_count
   FROM projects p
   LEFT JOIN leads l ON l.id = p.lead_id
   LEFT JOIN users u ON u.id = p.assigned_head_id`;

// ---------- LIST ----------
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (!isAdmin(req.user.role)) {
    where.push('p.assigned_head_id = ?');
    params.push(req.user.id);
  } else if (req.query.head_id) {
    where.push('p.assigned_head_id = ?');
    params.push(Number(req.query.head_id));
  }
  if (req.query.status && STATUSES.includes(req.query.status)) {
    where.push('p.status = ?');
    params.push(req.query.status);
  }
  const rows = db.prepare(
    `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.created_at DESC, p.id DESC LIMIT 500`
  ).all(...params);
  res.json(rows);
});

// ---------- GET one (with its tasks) ----------
router.get('/:id', (req, res) => {
  const project = db.prepare(`${SELECT} WHERE p.id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!canAccessProject(req.user, project)) return res.status(403).json({ error: 'Not your project' });
  const tasks = db.prepare(
    `SELECT t.*, u.full_name AS assigned_to_name
     FROM tasks t JOIN users u ON u.id = t.assigned_to
     WHERE t.project_id = ? ORDER BY t.due_date, t.id`
  ).all(project.id);
  res.json({ ...project, tasks });
});

// ---------- CREATE ----------
router.post('/', (req, res) => {
  if (!hasPermission(req.user.role, 'CREATE_PROJECT')) {
    return res.status(403).json({ error: 'Not allowed to create projects' });
  }
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name required' });

  const budget = toPaise(body.budget_paise ?? 0);
  if (budget === null) return res.status(400).json({ error: 'budget_paise must be a non-negative integer (paise)' });

  let progress = 0;
  if (body.progress !== undefined) {
    progress = toProgress(body.progress);
    if (progress === null) return res.status(400).json({ error: 'progress must be 0..100' });
  }

  const status = STATUSES.includes(body.status) ? body.status : 'Working';

  let leadId = null;
  if (body.lead_id) {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL').get(Number(body.lead_id));
    if (!lead) return res.status(400).json({ error: 'Invalid lead' });
    leadId = lead.id;
  }
  let dealId = null;
  if (body.deal_id) {
    const deal = db.prepare('SELECT id FROM deals WHERE id = ?').get(Number(body.deal_id));
    if (!deal) return res.status(400).json({ error: 'Invalid deal' });
    dealId = deal.id;
  }
  let headId = null;
  if (body.assigned_head_id) {
    const head = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(body.assigned_head_id));
    if (!head) return res.status(400).json({ error: 'Invalid head' });
    headId = head.id;
  }

  const info = db.prepare(
    `INSERT INTO projects
       (name, description, lead_id, deal_id, service_type, budget_paise,
        assigned_head_id, status, progress, start_date, end_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    body.description ? String(body.description) : null,
    leadId, dealId,
    body.service_type ? String(body.service_type).trim() : null,
    budget, headId, status, progress,
    optDate(body.start_date), optDate(body.end_date),
    req.user.id, nowUtc(),
  );
  logAudit({
    action: 'PROJECT_CREATE', user: req.user, entity_type: 'project',
    entity_id: info.lastInsertRowid, details: { name, budget_paise: budget, status }, ip: req.ip,
  });
  res.json({ id: info.lastInsertRowid });
});

// ---------- UPDATE ----------
router.patch('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!canAccessProject(req.user, project)) return res.status(403).json({ error: 'Not your project' });
  const body = req.body || {};

  const name = body.name !== undefined ? String(body.name).trim() : project.name;
  if (!name) return res.status(400).json({ error: 'Project name required' });

  let budget = project.budget_paise;
  if (body.budget_paise !== undefined) {
    budget = toPaise(body.budget_paise);
    if (budget === null) return res.status(400).json({ error: 'budget_paise must be a non-negative integer (paise)' });
  }
  let progress = project.progress;
  if (body.progress !== undefined) {
    progress = toProgress(body.progress);
    if (progress === null) return res.status(400).json({ error: 'progress must be 0..100' });
  }
  const status = body.status !== undefined
    ? (STATUSES.includes(body.status) ? body.status : project.status)
    : project.status;

  let headId = project.assigned_head_id;
  if (body.assigned_head_id !== undefined) {
    if (body.assigned_head_id === null || body.assigned_head_id === '') {
      headId = null;
    } else {
      const head = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(body.assigned_head_id));
      if (!head) return res.status(400).json({ error: 'Invalid head' });
      headId = head.id;
    }
  }

  db.prepare(
    `UPDATE projects SET name = ?, description = ?, service_type = ?, budget_paise = ?,
       assigned_head_id = ?, status = ?, progress = ?, start_date = ?, end_date = ?
     WHERE id = ?`
  ).run(
    name,
    body.description !== undefined ? (body.description ? String(body.description) : null) : project.description,
    body.service_type !== undefined ? (body.service_type ? String(body.service_type).trim() : null) : project.service_type,
    budget, headId, status, progress,
    body.start_date !== undefined ? optDate(body.start_date) : project.start_date,
    body.end_date !== undefined ? optDate(body.end_date) : project.end_date,
    project.id,
  );
  res.json({ ok: true });
});

// ---------- DELETE (admin tier) ----------
router.delete('/:id', (req, res) => {
  if (!hasPermission(req.user.role, 'DELETE_RECORDS')) {
    return res.status(403).json({ error: 'Not allowed to delete projects' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Detach tasks (keep them; they live in the Today queue) before removing.
  db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  logAudit({
    action: 'PROJECT_DELETE', user: req.user, entity_type: 'project',
    entity_id: project.id, details: { name: project.name }, ip: req.ip,
  });
  res.json({ ok: true });
});

export default router;
