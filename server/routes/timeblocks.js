// Phase 4B — Time blocks CRUD (the amber lanes on the calendar).
//
// A time block is a named slice of an owner's day: block_date is an IST
// business date ('YYYY-MM-DD'); start_at / end_at are UTC ISO instants for the
// wall-clock window. Owners see/manage their own; admin tier (super_admin |
// admin | manager) sees/manages everyone's.
//
// Create/Update validate start_at < end_at and run detectConflicts (same owner,
// same IST day, overlapping window) → 409 with a descriptive message.
import { Router } from 'express';
import db from '../db.js';
import { nowUtc, istDateOf } from '../lib/istTime.js';
import { isAdmin } from '../lib/permissions.js';
import { detectConflicts, conflictMessage } from '../lib/schedule.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCK_TYPES = [
  'Deep Work', 'Meeting Prep', 'Client Work', 'Admin', 'Break', 'Out of Office',
];

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

const SELECT = `SELECT tb.*, u.full_name AS owner_name, t.title AS linked_task_title
   FROM time_blocks tb
   LEFT JOIN users u ON u.id = tb.owner_id
   LEFT JOIN tasks t ON t.id = tb.linked_task_id`;

// Load a block + enforce access (own, or admin tier). Returns null after
// sending the proper status.
function loadBlock(req, res) {
  const block = db.prepare(`${SELECT} WHERE tb.id = ?`).get(req.params.id);
  if (!block) { res.status(404).json({ error: 'Time block not found' }); return null; }
  if (!isAdmin(req.user.role) && block.owner_id !== req.user.id) {
    res.status(403).json({ error: 'Not your time block' }); return null;
  }
  return block;
}

// Resolve + validate a linked_task_id (must exist; for non-admins must be your
// own task). Returns { ok, value } — value is the id or null.
function resolveLinkedTask(req, raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const task = db.prepare('SELECT id, assigned_to FROM tasks WHERE id = ?').get(Number(raw));
  if (!task) return { ok: false, error: 'Invalid linked task' };
  if (!isAdmin(req.user.role) && task.assigned_to !== req.user.id) {
    return { ok: false, error: 'Not your linked task' };
  }
  return { ok: true, value: task.id };
}

// ---------- LIST ----------
// Owner sees own; admin tier sees all (optionally ?owner_id=). Range filter via
// ?from=&to= (inclusive IST dates) or a single ?date=.
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (!isAdmin(req.user.role)) {
    where.push('tb.owner_id = ?');
    params.push(req.user.id);
  } else if (req.query.owner_id) {
    where.push('tb.owner_id = ?');
    params.push(Number(req.query.owner_id));
  }
  if (DATE_RE.test(req.query.date || '')) {
    where.push('tb.block_date = ?');
    params.push(req.query.date);
  } else {
    if (DATE_RE.test(req.query.from || '')) {
      where.push('tb.block_date >= ?');
      params.push(req.query.from);
    }
    if (DATE_RE.test(req.query.to || '')) {
      where.push('tb.block_date <= ?');
      params.push(req.query.to);
    }
  }
  const rows = db.prepare(
    `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY tb.start_at, tb.id LIMIT 1000`
  ).all(...params);
  res.json(rows);
});

// ---------- GET one ----------
router.get('/:id', (req, res) => {
  const block = loadBlock(req, res);
  if (!block) return undefined;
  return res.json(block);
});

// Shared body validation/normalization for POST/PUT. Returns { ok, error } or
// { ok, value: {...} }. ownerId defaults to self; only admins may set another.
function parseBody(req) {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return { ok: false, error: 'Title required' };
  if (!isIso(body.start_at) || !isIso(body.end_at)) {
    return { ok: false, error: 'start_at and end_at must be ISO instants' };
  }
  if (!(Date.parse(body.start_at) < Date.parse(body.end_at))) {
    return { ok: false, error: 'start_at must be before end_at' };
  }
  const blockType = BLOCK_TYPES.includes(body.block_type) ? body.block_type : 'Deep Work';

  // block_date: explicit IST date, else derived from the start instant.
  const blockDate = DATE_RE.test(body.block_date || '')
    ? body.block_date : istDateOf(body.start_at);

  // Owner: self by default; admin tier may schedule for another user.
  let ownerId = req.user.id;
  if (isAdmin(req.user.role) && body.owner_id) {
    const owner = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(body.owner_id));
    if (!owner) return { ok: false, error: 'Invalid owner' };
    ownerId = owner.id;
  }

  const linked = resolveLinkedTask(req, body.linked_task_id);
  if (!linked.ok) return { ok: false, error: linked.error };

  return {
    ok: true,
    value: {
      title, blockDate, startAt: body.start_at, endAt: body.end_at,
      blockType, ownerId, notes: body.notes ? String(body.notes) : null,
      linkedTaskId: linked.value,
    },
  };
}

// ---------- CREATE ----------
router.post('/', (req, res) => {
  const parsed = parseBody(req);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;

  const conflicts = detectConflicts(db, {
    ownerId: v.ownerId, startAt: v.startAt, endAt: v.endAt,
  });
  if (conflicts.length) return res.status(409).json({ error: conflictMessage(conflicts), conflicts });

  const info = db.prepare(
    `INSERT INTO time_blocks
       (title, block_date, start_at, end_at, block_type, owner_id, notes, linked_task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(v.title, v.blockDate, v.startAt, v.endAt, v.blockType, v.ownerId, v.notes, v.linkedTaskId, nowUtc());
  return res.json({ id: info.lastInsertRowid });
});

// ---------- UPDATE ----------
router.put('/:id', (req, res) => {
  const block = loadBlock(req, res);
  if (!block) return undefined;
  const parsed = parseBody(req);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  // Non-admins can't reassign ownership away from themselves.
  const ownerId = isAdmin(req.user.role) ? v.ownerId : block.owner_id;

  const conflicts = detectConflicts(db, {
    ownerId, startAt: v.startAt, endAt: v.endAt, excludeBlockId: block.id,
  });
  if (conflicts.length) return res.status(409).json({ error: conflictMessage(conflicts), conflicts });

  db.prepare(
    `UPDATE time_blocks SET title = ?, block_date = ?, start_at = ?, end_at = ?,
       block_type = ?, owner_id = ?, notes = ?, linked_task_id = ?
     WHERE id = ?`
  ).run(v.title, v.blockDate, v.startAt, v.endAt, v.blockType, ownerId, v.notes, v.linkedTaskId, block.id);
  return res.json({ ok: true });
});

// ---------- DELETE ----------
router.delete('/:id', (req, res) => {
  const block = loadBlock(req, res);
  if (!block) return undefined;
  db.prepare('DELETE FROM time_blocks WHERE id = ?').run(block.id);
  return res.json({ ok: true });
});

export default router;
