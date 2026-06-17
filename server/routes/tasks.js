// Phase 4A — Tasks: legacy follow-up tasks PLUS a Kanban board + per-task time
// tracking, layered ADDITIVELY on the existing tasks table.
//
// TWO STATUSES, KEPT IN SYNC (see HOUSE_RULES):
//   - `status` (pending|done|cancelled) is the legacy lifecycle the Today queue
//     and existing endpoints read. DO NOT widen it.
//   - `board_status` (To Do|Doing|Review|Done|Drop) is the Kanban lane.
//   The PATCH keeps them in sync: board_status Done → status='done'+completed_at;
//   Drop → status='cancelled'; To Do/Doing/Review → status='pending'.
//
// Times: scheduled_*_at are UTC ISO instants. time_tracked is total seconds;
// time_entries is a JSON array of {id,start,end,duration,date} (date = IST day).
import { Router } from 'express';
import db from '../db.js';
import { nowUtc, todayIst } from '../lib/istTime.js';
import { isAdmin } from '../lib/permissions.js';
import { detectConflicts, conflictMessage } from '../lib/schedule.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_STATUSES = ['To Do', 'Doing', 'Review', 'Done', 'Drop'];
const PRIORITIES = ['Daily', 'High', 'Medium', 'Low'];
const router = Router();

// Map a board_status lane to the legacy lifecycle status it implies.
function legacyStatusFor(board) {
  if (board === 'Done') return 'done';
  if (board === 'Drop') return 'cancelled';
  return 'pending'; // To Do / Doing / Review
}

function safeJsonArray(s) {
  if (Array.isArray(s)) return s;
  if (s == null) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// A simple, unique-enough id for subtask / time-entry rows.
function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Load a task with access enforcement. Non-admins are limited to their own.
function loadTask(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
  if (!isAdmin(req.user.role) && task.assigned_to !== req.user.id) {
    res.status(403).json({ error: 'Not your task' }); return null;
  }
  return task;
}

// ---------- LIST ----------
// Keeps the existing shape additively; adds project_id / assignee / priority /
// board_status filters. `status=all` returns every lifecycle state (default is
// pending only, as before).
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (!isAdmin(req.user.role)) {
    where.push('t.assigned_to = ?');
    params.push(req.user.id);
  } else if (req.query.assigned_to || req.query.assignee) {
    where.push('t.assigned_to = ?');
    params.push(Number(req.query.assigned_to || req.query.assignee));
  }
  where.push(req.query.status === 'all' ? '1=1' : "t.status = 'pending'");
  if (req.query.lead_id) {
    where.push('t.lead_id = ?');
    params.push(Number(req.query.lead_id));
  }
  if (req.query.project_id) {
    where.push('t.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  if (req.query.priority && PRIORITIES.includes(req.query.priority)) {
    where.push('t.priority = ?');
    params.push(req.query.priority);
  }
  if (req.query.board_status && BOARD_STATUSES.includes(req.query.board_status)) {
    where.push('t.board_status = ?');
    params.push(req.query.board_status);
  }
  const rows = db.prepare(
    `SELECT t.*, u.full_name AS assigned_to_name, l.name AS lead_name, l.phone AS lead_phone,
            p.name AS project_name
     FROM tasks t
     JOIN users u ON u.id = t.assigned_to
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.due_date, t.id LIMIT 500`
  ).all(...params);
  res.json(rows);
});

// ---------- GET one ----------
router.get('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  const row = db.prepare(
    `SELECT t.*, u.full_name AS assigned_to_name, l.name AS lead_name, l.phone AS lead_phone,
            p.name AS project_name
     FROM tasks t
     JOIN users u ON u.id = t.assigned_to
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?`
  ).get(task.id);
  return res.json(row);
});

// ---------- CREATE ----------
router.post('/', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title required' });
  const dueDate = DATE_RE.test(req.body.due_date || '') ? req.body.due_date : todayIst();

  let assignedTo = req.user.id;
  if (isAdmin(req.user.role) && req.body.assigned_to) {
    assignedTo = Number(req.body.assigned_to);
  }
  let leadId = null;
  if (req.body.lead_id) {
    const lead = db.prepare('SELECT id, assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL')
      .get(Number(req.body.lead_id));
    if (!lead) return res.status(400).json({ error: 'Invalid lead' });
    if (!isAdmin(req.user.role) && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Not your lead' });
    }
    leadId = lead.id;
  }
  let projectId = null;
  if (req.body.project_id) {
    const project = db.prepare('SELECT id, assigned_head_id FROM projects WHERE id = ?').get(Number(req.body.project_id));
    if (!project) return res.status(400).json({ error: 'Invalid project' });
    // Non-admins may only attach tasks to a project they head — otherwise an
    // agent could link tasks into any project and skew its metrics (audit L-2).
    if (!isAdmin(req.user.role) && project.assigned_head_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your project' });
    }
    projectId = project.id;
  }
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'Medium';

  const info = db.prepare(
    `INSERT INTO tasks (title, details, lead_id, project_id, priority, assigned_to, due_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, req.body.details || null, leadId, projectId, priority, assignedTo, dueDate, req.user.id, nowUtc());
  res.json({ id: info.lastInsertRowid });
});

// Has the tasks table the updated_by/updated_at columns? (Stamped only if so.)
const TASK_COLS = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));

// ---------- PATCH ----------
// Accepts legacy fields (title/details/due_date/status) PLUS board_status /
// priority / project_id / subtasks / scheduled_*_at, and keeps the two statuses
// in sync. read-modify-write of subtasks happens here.
router.patch('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  const body = req.body || {};

  // Resolve the new board_status (and the legacy status it implies). An explicit
  // legacy `status` still works (back-compat: the sync.integration flow PATCHes
  // {status:'done'}), and it maps back onto a board lane.
  let boardStatus = task.board_status;
  let status = task.status;
  if (body.board_status !== undefined && BOARD_STATUSES.includes(body.board_status)) {
    boardStatus = body.board_status;
    status = legacyStatusFor(boardStatus);
  } else if (body.status !== undefined && ['pending', 'done', 'cancelled'].includes(body.status)) {
    status = body.status;
    boardStatus = status === 'done' ? 'Done' : status === 'cancelled' ? 'Drop'
      : (task.board_status === 'Done' || task.board_status === 'Drop' ? 'To Do' : task.board_status);
  }

  const priority = body.priority !== undefined && PRIORITIES.includes(body.priority)
    ? body.priority : task.priority;

  // project_id: null/'' detaches; a number must reference a real project.
  let projectId = task.project_id;
  if (body.project_id !== undefined) {
    if (body.project_id === null || body.project_id === '') {
      projectId = null;
    } else {
      const project = db.prepare('SELECT id, assigned_head_id FROM projects WHERE id = ?').get(Number(body.project_id));
      if (!project) return res.status(400).json({ error: 'Invalid project' });
      if (!isAdmin(req.user.role) && project.assigned_head_id !== req.user.id) {
        return res.status(403).json({ error: 'Not your project' });
      }
      projectId = project.id;
    }
  }

  // Scheduled window: when BOTH are provided, validate start < end.
  let schedStart = task.scheduled_start_at;
  let schedEnd = task.scheduled_end_at;
  const windowTouched = body.scheduled_start_at !== undefined || body.scheduled_end_at !== undefined;
  if (body.scheduled_start_at !== undefined) schedStart = body.scheduled_start_at || null;
  if (body.scheduled_end_at !== undefined) schedEnd = body.scheduled_end_at || null;
  if (schedStart && schedEnd && !(new Date(schedStart) < new Date(schedEnd))) {
    return res.status(400).json({ error: 'scheduled_start_at must be before scheduled_end_at' });
  }
  // Conflict check: only when the window is being set/changed to a full window,
  // and the task isn't being parked in Done/Drop. Scoped to the task's assignee
  // (its calendar owner); excludes the task itself.
  if (windowTouched && schedStart && schedEnd && boardStatus !== 'Done' && boardStatus !== 'Drop'
      && (schedStart !== task.scheduled_start_at || schedEnd !== task.scheduled_end_at)) {
    const conflicts = detectConflicts(db, {
      ownerId: task.assigned_to, startAt: schedStart, endAt: schedEnd, excludeTaskId: task.id,
    });
    if (conflicts.length) return res.status(409).json({ error: conflictMessage(conflicts), conflicts });
  }

  // Subtasks: full-array replace, or an action {subtask_action:add|toggle|delete}.
  let subtasks = safeJsonArray(task.subtasks);
  if (Array.isArray(body.subtasks)) {
    subtasks = body.subtasks.map((s) => ({
      id: s.id || genId(),
      title: String(s.title || '').trim(),
      completed: !!s.completed,
    })).filter((s) => s.title);
  } else if (body.subtask_action) {
    const act = body.subtask_action;
    if (act === 'add') {
      const t = String(body.subtask_title || '').trim();
      if (!t) return res.status(400).json({ error: 'Subtask title required' });
      subtasks.push({ id: genId(), title: t, completed: false });
    } else if (act === 'toggle') {
      subtasks = subtasks.map((s) => (s.id === body.subtask_id ? { ...s, completed: !s.completed } : s));
    } else if (act === 'delete') {
      subtasks = subtasks.filter((s) => s.id !== body.subtask_id);
    }
  }

  const cols = [
    'title = ?', 'details = ?', 'due_date = ?', 'status = ?', 'board_status = ?',
    'priority = ?', 'project_id = ?', 'subtasks = ?',
    'scheduled_start_at = ?', 'scheduled_end_at = ?',
    "completed_at = CASE WHEN ? = 'done' AND status != 'done' THEN ? ELSE completed_at END",
  ];
  const vals = [
    body.title !== undefined ? String(body.title).trim() || task.title : task.title,
    body.details !== undefined ? body.details : task.details,
    DATE_RE.test(body.due_date || '') ? body.due_date : task.due_date,
    status, boardStatus, priority, projectId, JSON.stringify(subtasks),
    schedStart, schedEnd, status, nowUtc(),
  ];
  if (TASK_COLS.has('updated_by')) { cols.push('updated_by = ?'); vals.push(req.user.id); }
  if (TASK_COLS.has('updated_at')) { cols.push('updated_at = ?'); vals.push(nowUtc()); }
  vals.push(task.id);

  db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// ---------- DELETE ----------
router.delete('/:id', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  return res.json({ ok: true });
});

// ===================== TIME TRACKING =====================

// Start: records intent + moves a To Do task into Doing. The single active
// timer is enforced client-side; the server just stamps a start instant.
router.post('/:id/timer/start', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  const started = nowUtc();
  const board = task.board_status === 'To Do' ? 'Doing' : task.board_status;
  const status = legacyStatusFor(board);
  db.prepare('UPDATE tasks SET board_status = ?, status = ? WHERE id = ?').run(board, status, task.id);
  return res.json({ ok: true, started, board_status: board });
});

// Stop: compute duration from {start_iso} to now, append a time_entry and bump
// time_tracked. Non-positive durations are ignored (clock skew / instant stop).
router.post('/:id/timer/stop', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  const startIso = req.body?.start_iso;
  const start = startIso ? Date.parse(startIso) : NaN;
  if (Number.isNaN(start)) return res.status(400).json({ error: 'start_iso required' });
  const end = Date.now();
  const duration = Math.floor((end - start) / 1000);
  if (duration <= 0) return res.json({ ok: true, duration: 0, time_tracked: task.time_tracked });

  const entries = safeJsonArray(task.time_entries);
  entries.push({
    id: genId(),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    duration,
    date: todayIst(),
  });
  const total = (task.time_tracked || 0) + duration;
  db.prepare('UPDATE tasks SET time_entries = ?, time_tracked = ? WHERE id = ?')
    .run(JSON.stringify(entries), total, task.id);
  return res.json({ ok: true, duration, time_tracked: total });
});

// Manual entry: append a synthetic time_entry of {minutes} and bump the total.
router.post('/:id/time', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return undefined;
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive number' });
  }
  const duration = Math.round(minutes * 60);
  const entries = safeJsonArray(task.time_entries);
  const now = nowUtc();
  entries.push({ id: genId(), start: now, end: now, duration, date: todayIst(), manual: true });
  const total = (task.time_tracked || 0) + duration;
  db.prepare('UPDATE tasks SET time_entries = ?, time_tracked = ? WHERE id = ?')
    .run(JSON.stringify(entries), total, task.id);
  return res.json({ ok: true, duration, time_tracked: total });
});

export default router;
