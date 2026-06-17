// Phase 5A — Meeting OS: schedule + run meetings (agenda, live timer, roles,
// decisions, actions-to-tasks). Layered additively on the Phase 4 task system.
//
// Times: start_at/end_at and every *_at column are UTC ISO instants
// (nowUtc()). A meeting action's due_at → a task due_date is the IST calendar
// date of that instant (istDateOf). Tasks spawned from a meeting reuse the
// existing task conventions (board_status 'To Do' / legacy 'pending', priority,
// origin='meeting_action') and carry meeting_id + the meeting's lead/deal/project.
//
// Scoping: admin tier (super_admin|admin|manager) sees/edits all meetings;
// everyone else sees a meeting only when owner_id=self OR self is in
// attendee_ids, and may edit when owner or attendee. We fetch then filter in JS
// (attendee_ids is JSON) — the active set is small, so this stays cheap.
import { Router } from 'express';
import db from '../db.js';
import { nowUtc, istDateOf } from '../lib/istTime.js';
import { isAdmin } from '../lib/permissions.js';

const router = Router();
const STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];
const ITEM_STATUSES = ['Pending', 'In Progress', 'Done'];
const DECISION_STATUSES = ['Pending', 'Accepted', 'Revisit'];
const TIMER_STATUSES = ['Running', 'Paused', 'Stopped'];

function safeIds(s) {
  if (Array.isArray(s)) return s.map(Number).filter(Number.isInteger);
  if (s == null) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []; }
  catch { return []; }
}

// Whether a UTC ISO instant string parses. Empty/undefined is allowed (=> null).
function optInstant(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  const t = Date.parse(v);
  if (Number.isNaN(t)) return { ok: false };
  return { ok: true, value: new Date(t).toISOString() };
}
function reqInstant(v) {
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// Round an instant UP to the next 15-minute boundary (default new-meeting start).
function next15(now = new Date()) {
  const ms = now.getTime();
  const step = 15 * 60 * 1000;
  return new Date(Math.ceil(ms / step) * step).toISOString();
}

function isAttendee(meeting, userId) {
  if (meeting.owner_id === userId) return true;
  return safeIds(meeting.attendee_ids).includes(userId);
}
function canSee(user, meeting) {
  if (isAdmin(user.role)) return true;
  return isAttendee(meeting, user.id);
}
// canEdit == canSee here (admin OR owner OR attendee), per the spec.
const canEdit = canSee;

// Validate a user-id field that must reference a real user (null clears it).
function resolveUser(v) {
  if (v === undefined) return { skip: true };
  if (v === null || v === '') return { value: null };
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(v));
  if (!u) return { error: 'Invalid user' };
  return { value: u.id };
}

function loadMeeting(req, res) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!m) { res.status(404).json({ error: 'Meeting not found' }); return null; }
  if (!canSee(req.user, m)) { res.status(403).json({ error: 'Not your meeting' }); return null; }
  return m;
}

// Hydrate a meeting row with attendees array + names for the detail view.
function hydrate(meeting) {
  const ids = safeIds(meeting.attendee_ids);
  const attendees = ids.length
    ? db.prepare(`SELECT id, full_name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  const owner = meeting.owner_id
    ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(meeting.owner_id) : null;
  const lead = meeting.lead_id
    ? db.prepare('SELECT name FROM leads WHERE id = ?').get(meeting.lead_id) : null;
  const project = meeting.project_id
    ? db.prepare('SELECT name FROM projects WHERE id = ?').get(meeting.project_id) : null;
  return {
    ...meeting,
    attendee_ids: ids,
    attendees,
    owner_name: owner?.full_name || null,
    lead_name: lead?.name || null,
    project_name: project?.name || null,
  };
}

// ===================== MEETINGS CRUD =====================

// LIST — scoped. Optional ?status= / ?owner_id= filters.
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM meetings ORDER BY start_at DESC, id DESC LIMIT 1000').all();
  let visible = rows.filter((m) => canSee(req.user, m));
  if (req.query.status && STATUSES.includes(req.query.status)) {
    visible = visible.filter((m) => m.status === req.query.status);
  }
  if (req.query.owner_id) {
    const oid = Number(req.query.owner_id);
    visible = visible.filter((m) => m.owner_id === oid);
  }
  res.json(visible.map(hydrate));
});

// GET one (with agenda, roles, decisions, actions, timer sessions).
router.get('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return undefined;
  const agenda = db.prepare(
    'SELECT * FROM meeting_agenda WHERE meeting_id = ? ORDER BY order_index, id'
  ).all(meeting.id);
  let roles = db.prepare('SELECT * FROM meeting_roles WHERE meeting_id = ?').get(meeting.id) || null;
  const decisions = db.prepare(
    'SELECT * FROM meeting_decisions WHERE meeting_id = ? ORDER BY id DESC'
  ).all(meeting.id);
  const actions = db.prepare(
    'SELECT * FROM meeting_actions WHERE meeting_id = ? ORDER BY id DESC'
  ).all(meeting.id);
  const timer_sessions = db.prepare(
    'SELECT * FROM meeting_timer_sessions WHERE meeting_id = ? ORDER BY id'
  ).all(meeting.id);
  return res.json({ ...hydrate(meeting), agenda, roles, decisions, actions, timer_sessions });
});

// CREATE. start_at defaults to the next 15-min round; end_at to start+30min.
router.post('/', (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Meeting title required' });

  let startAt = next15();
  if (body.start_at !== undefined && body.start_at !== null && body.start_at !== '') {
    const s = reqInstant(body.start_at);
    if (!s) return res.status(400).json({ error: 'Invalid start_at' });
    startAt = s;
  }
  let endAt = new Date(Date.parse(startAt) + 30 * 60 * 1000).toISOString();
  if (body.end_at !== undefined && body.end_at !== null && body.end_at !== '') {
    const e = reqInstant(body.end_at);
    if (!e) return res.status(400).json({ error: 'Invalid end_at' });
    endAt = e;
  }
  if (!(Date.parse(startAt) < Date.parse(endAt))) {
    return res.status(400).json({ error: 'start_at must be before end_at' });
  }

  // owner defaults to the creator.
  let ownerId = req.user.id;
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  if (!ownerRes.skip && ownerRes.value !== null) ownerId = ownerRes.value;

  // attendees: validate each id is a real user.
  const attendeeIds = [...new Set(safeIds(body.attendee_ids))];
  if (attendeeIds.length) {
    const found = db.prepare(
      `SELECT id FROM users WHERE id IN (${attendeeIds.map(() => '?').join(',')})`
    ).all(...attendeeIds).map((u) => u.id);
    if (found.length !== attendeeIds.length) return res.status(400).json({ error: 'Invalid attendee' });
  }

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
  let projectId = null;
  if (body.project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(body.project_id));
    if (!project) return res.status(400).json({ error: 'Invalid project' });
    projectId = project.id;
  }

  const info = db.prepare(
    `INSERT INTO meetings
       (title, description, start_at, end_at, location, meeting_url, status, notes,
        owner_id, attendee_ids, lead_id, deal_id, project_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title,
    body.description ? String(body.description) : null,
    startAt, endAt,
    body.location ? String(body.location) : null,
    body.meeting_url ? String(body.meeting_url) : null,
    body.notes ? String(body.notes) : null,
    ownerId, JSON.stringify(attendeeIds), leadId, dealId, projectId,
    req.user.id, nowUtc(),
  );
  res.json({ id: info.lastInsertRowid });
});

// UPDATE meeting fields (not the status state-machine — use /start /end).
router.patch('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return undefined;
  if (!canEdit(req.user, meeting)) return res.status(403).json({ error: 'Cannot edit this meeting' });
  const body = req.body || {};

  const title = body.title !== undefined ? String(body.title).trim() || meeting.title : meeting.title;

  let startAt = meeting.start_at;
  if (body.start_at !== undefined) {
    const s = optInstant(body.start_at);
    if (!s.ok || s.value === null) return res.status(400).json({ error: 'Invalid start_at' });
    startAt = s.value;
  }
  let endAt = meeting.end_at;
  if (body.end_at !== undefined) {
    const e = optInstant(body.end_at);
    if (!e.ok || e.value === null) return res.status(400).json({ error: 'Invalid end_at' });
    endAt = e.value;
  }
  if (!(Date.parse(startAt) < Date.parse(endAt))) {
    return res.status(400).json({ error: 'start_at must be before end_at' });
  }

  // status: explicit set only allows Scheduled/Cancelled here (In Progress /
  // Completed go through the state machine), but we accept any valid value to
  // stay flexible (e.g. re-opening). Cancelling is the common manual transition.
  const status = body.status !== undefined && STATUSES.includes(body.status)
    ? body.status : meeting.status;

  let ownerId = meeting.owner_id;
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  if (!ownerRes.skip) ownerId = ownerRes.value;

  let attendeeJson = meeting.attendee_ids;
  if (body.attendee_ids !== undefined) {
    const ids = [...new Set(safeIds(body.attendee_ids))];
    if (ids.length) {
      const found = db.prepare(
        `SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids).map((u) => u.id);
      if (found.length !== ids.length) return res.status(400).json({ error: 'Invalid attendee' });
    }
    attendeeJson = JSON.stringify(ids);
  }

  const resolveLink = (val, table, soft) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    const sql = soft
      ? `SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`
      : `SELECT id FROM ${table} WHERE id = ?`;
    const row = db.prepare(sql).get(Number(val));
    return row ? row.id : false;
  };
  let leadId = meeting.lead_id;
  if (body.lead_id !== undefined) {
    const r = resolveLink(body.lead_id, 'leads', true);
    if (r === false) return res.status(400).json({ error: 'Invalid lead' });
    leadId = r;
  }
  let dealId = meeting.deal_id;
  if (body.deal_id !== undefined) {
    const r = resolveLink(body.deal_id, 'deals', false);
    if (r === false) return res.status(400).json({ error: 'Invalid deal' });
    dealId = r;
  }
  let projectId = meeting.project_id;
  if (body.project_id !== undefined) {
    const r = resolveLink(body.project_id, 'projects', false);
    if (r === false) return res.status(400).json({ error: 'Invalid project' });
    projectId = r;
  }

  db.prepare(
    `UPDATE meetings SET title = ?, description = ?, start_at = ?, end_at = ?,
       location = ?, meeting_url = ?, status = ?, notes = ?, owner_id = ?,
       attendee_ids = ?, lead_id = ?, deal_id = ?, project_id = ? WHERE id = ?`
  ).run(
    title,
    body.description !== undefined ? (body.description ? String(body.description) : null) : meeting.description,
    startAt, endAt,
    body.location !== undefined ? (body.location ? String(body.location) : null) : meeting.location,
    body.meeting_url !== undefined ? (body.meeting_url ? String(body.meeting_url) : null) : meeting.meeting_url,
    status,
    body.notes !== undefined ? (body.notes ? String(body.notes) : null) : meeting.notes,
    ownerId, attendeeJson, leadId, dealId, projectId,
    meeting.id,
  );
  return res.json({ ok: true });
});

// DELETE — cascades agenda / roles / decisions / actions / timer sessions.
router.delete('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return undefined;
  if (!canEdit(req.user, meeting)) return res.status(403).json({ error: 'Cannot delete this meeting' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_timer_sessions WHERE meeting_id = ?').run(meeting.id);
    db.prepare('DELETE FROM meeting_actions WHERE meeting_id = ?').run(meeting.id);
    db.prepare('DELETE FROM meeting_decisions WHERE meeting_id = ?').run(meeting.id);
    db.prepare('DELETE FROM meeting_roles WHERE meeting_id = ?').run(meeting.id);
    db.prepare('DELETE FROM meeting_agenda WHERE meeting_id = ?').run(meeting.id);
    // Tasks spawned from this meeting keep existing (they live in the Today
    // queue); just unlink them.
    db.prepare('UPDATE tasks SET meeting_id = NULL WHERE meeting_id = ?').run(meeting.id);
    db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  });
  tx();
  return res.json({ ok: true });
});

// ===================== STATE MACHINE =====================

router.post('/:id/start', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return undefined;
  if (!canEdit(req.user, meeting)) return res.status(403).json({ error: 'Cannot edit this meeting' });
  if (meeting.status !== 'Scheduled') {
    return res.status(409).json({ error: `Cannot start a meeting that is ${meeting.status}` });
  }
  db.prepare("UPDATE meetings SET status = 'In Progress' WHERE id = ?").run(meeting.id);
  return res.json({ ok: true, status: 'In Progress' });
});

router.post('/:id/end', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return undefined;
  if (!canEdit(req.user, meeting)) return res.status(403).json({ error: 'Cannot edit this meeting' });
  if (meeting.status !== 'In Progress') {
    return res.status(409).json({ error: `Cannot end a meeting that is ${meeting.status}` });
  }
  db.prepare("UPDATE meetings SET status = 'Completed' WHERE id = ?").run(meeting.id);
  return res.json({ ok: true, status: 'Completed' });
});

// ===================== AGENDA =====================

function loadEditable(req, res) {
  const meeting = loadMeeting(req, res);
  if (!meeting) return null;
  if (!canEdit(req.user, meeting)) { res.status(403).json({ error: 'Cannot edit this meeting' }); return null; }
  return meeting;
}

router.post('/:id/agenda', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Agenda item title required' });
  let duration = Number(body.duration);
  if (!Number.isFinite(duration) || duration < 0) duration = 15;
  duration = Math.round(duration);
  // Default order_index = end of the list.
  let orderIndex = Number(body.order_index);
  if (!Number.isInteger(orderIndex)) {
    const max = db.prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS m FROM meeting_agenda WHERE meeting_id = ?'
    ).get(meeting.id).m;
    orderIndex = max + 1;
  }
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  const ownerId = ownerRes.skip ? null : ownerRes.value;
  const info = db.prepare(
    `INSERT INTO meeting_agenda (meeting_id, title, duration, order_index, owner_id, status, time_spent, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'Pending', 0, ?, ?)`
  ).run(meeting.id, title, duration, orderIndex, ownerId, body.notes ? String(body.notes) : null, nowUtc());
  return res.json({ id: info.lastInsertRowid });
});

router.patch('/:id/agenda/:itemId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const item = db.prepare('SELECT * FROM meeting_agenda WHERE id = ? AND meeting_id = ?')
    .get(req.params.itemId, meeting.id);
  if (!item) return res.status(404).json({ error: 'Agenda item not found' });
  const body = req.body || {};

  const title = body.title !== undefined ? String(body.title).trim() || item.title : item.title;
  let duration = item.duration;
  if (body.duration !== undefined) {
    const d = Number(body.duration);
    if (Number.isFinite(d) && d >= 0) duration = Math.round(d);
  }
  let orderIndex = item.order_index;
  if (body.order_index !== undefined && Number.isInteger(Number(body.order_index))) {
    orderIndex = Number(body.order_index);
  }
  const status = body.status !== undefined && ITEM_STATUSES.includes(body.status) ? body.status : item.status;
  let timeSpent = item.time_spent;
  if (body.time_spent !== undefined) {
    const t = Number(body.time_spent);
    if (Number.isFinite(t) && t >= 0) timeSpent = Math.round(t);
  }
  let ownerId = item.owner_id;
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  if (!ownerRes.skip) ownerId = ownerRes.value;

  db.prepare(
    `UPDATE meeting_agenda SET title = ?, duration = ?, order_index = ?, owner_id = ?,
       status = ?, time_spent = ?, notes = ? WHERE id = ?`
  ).run(
    title, duration, orderIndex, ownerId, status, timeSpent,
    body.notes !== undefined ? (body.notes ? String(body.notes) : null) : item.notes,
    item.id,
  );
  return res.json({ ok: true });
});

// Bulk reorder: body.order is an array of agenda item ids in the desired order.
router.post('/:id/agenda/reorder', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : [];
  if (!order.length) return res.status(400).json({ error: 'order array required' });
  const owned = new Set(
    db.prepare('SELECT id FROM meeting_agenda WHERE meeting_id = ?').all(meeting.id).map((r) => r.id)
  );
  const tx = db.transaction(() => {
    order.forEach((itemId, idx) => {
      if (owned.has(itemId)) {
        db.prepare('UPDATE meeting_agenda SET order_index = ? WHERE id = ? AND meeting_id = ?')
          .run(idx, itemId, meeting.id);
      }
    });
  });
  tx();
  return res.json({ ok: true });
});

router.delete('/:id/agenda/:itemId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const item = db.prepare('SELECT id FROM meeting_agenda WHERE id = ? AND meeting_id = ?')
    .get(req.params.itemId, meeting.id);
  if (!item) return res.status(404).json({ error: 'Agenda item not found' });
  // Null out timer sessions that referenced this item (keep the audit of time).
  db.prepare('UPDATE meeting_timer_sessions SET agenda_item_id = NULL WHERE agenda_item_id = ?').run(item.id);
  db.prepare('DELETE FROM meeting_agenda WHERE id = ?').run(item.id);
  return res.json({ ok: true });
});

// ===================== ROLES (one row per meeting, upsert) =====================

router.put('/:id/roles', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const body = req.body || {};
  const fac = resolveUser(body.facilitator_id);
  const scr = resolveUser(body.scribe_id);
  const dec = resolveUser(body.decision_maker_id);
  for (const r of [fac, scr, dec]) if (r.error) return res.status(400).json({ error: r.error });

  const existing = db.prepare('SELECT * FROM meeting_roles WHERE meeting_id = ?').get(meeting.id);
  const valFor = (r, prev) => (r.skip ? prev : r.value);
  if (existing) {
    db.prepare(
      `UPDATE meeting_roles SET facilitator_id = ?, scribe_id = ?, decision_maker_id = ? WHERE meeting_id = ?`
    ).run(
      valFor(fac, existing.facilitator_id),
      valFor(scr, existing.scribe_id),
      valFor(dec, existing.decision_maker_id),
      meeting.id,
    );
  } else {
    db.prepare(
      `INSERT INTO meeting_roles (meeting_id, facilitator_id, scribe_id, decision_maker_id)
       VALUES (?, ?, ?, ?)`
    ).run(meeting.id, valFor(fac, null), valFor(scr, null), valFor(dec, null));
  }
  return res.json({ ok: true });
});

// ===================== DECISIONS =====================

router.post('/:id/decisions', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Decision title required' });
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  const reviewAt = optInstant(body.review_at);
  if (!reviewAt.ok) return res.status(400).json({ error: 'Invalid review_at' });
  const status = DECISION_STATUSES.includes(body.status) ? body.status : 'Pending';
  const info = db.prepare(
    `INSERT INTO meeting_decisions (meeting_id, title, rationale, owner_id, review_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meeting.id, title, body.rationale ? String(body.rationale) : null,
    ownerRes.skip ? null : ownerRes.value, reviewAt.value, status, nowUtc(),
  );
  return res.json({ id: info.lastInsertRowid });
});

router.patch('/:id/decisions/:decId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const dec = db.prepare('SELECT * FROM meeting_decisions WHERE id = ? AND meeting_id = ?')
    .get(req.params.decId, meeting.id);
  if (!dec) return res.status(404).json({ error: 'Decision not found' });
  const body = req.body || {};
  const title = body.title !== undefined ? String(body.title).trim() || dec.title : dec.title;
  const status = body.status !== undefined && DECISION_STATUSES.includes(body.status) ? body.status : dec.status;
  let ownerId = dec.owner_id;
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  if (!ownerRes.skip) ownerId = ownerRes.value;
  let reviewAt = dec.review_at;
  if (body.review_at !== undefined) {
    const r = optInstant(body.review_at);
    if (!r.ok) return res.status(400).json({ error: 'Invalid review_at' });
    reviewAt = r.value;
  }
  db.prepare(
    `UPDATE meeting_decisions SET title = ?, rationale = ?, owner_id = ?, review_at = ?, status = ? WHERE id = ?`
  ).run(
    title,
    body.rationale !== undefined ? (body.rationale ? String(body.rationale) : null) : dec.rationale,
    ownerId, reviewAt, status, dec.id,
  );
  return res.json({ ok: true });
});

router.delete('/:id/decisions/:decId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const dec = db.prepare('SELECT id FROM meeting_decisions WHERE id = ? AND meeting_id = ?')
    .get(req.params.decId, meeting.id);
  if (!dec) return res.status(404).json({ error: 'Decision not found' });
  db.prepare('DELETE FROM meeting_decisions WHERE id = ?').run(dec.id);
  return res.json({ ok: true });
});

// ===================== ACTIONS =====================

router.post('/:id/actions', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Action title required' });
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  const dueAt = optInstant(body.due_at);
  if (!dueAt.ok) return res.status(400).json({ error: 'Invalid due_at' });
  const status = ITEM_STATUSES.includes(body.status) ? body.status : 'Pending';
  const info = db.prepare(
    `INSERT INTO meeting_actions (meeting_id, title, owner_id, due_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(meeting.id, title, ownerRes.skip ? null : ownerRes.value, dueAt.value, status, nowUtc());
  return res.json({ id: info.lastInsertRowid });
});

router.patch('/:id/actions/:actId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const act = db.prepare('SELECT * FROM meeting_actions WHERE id = ? AND meeting_id = ?')
    .get(req.params.actId, meeting.id);
  if (!act) return res.status(404).json({ error: 'Action not found' });
  const body = req.body || {};
  const title = body.title !== undefined ? String(body.title).trim() || act.title : act.title;
  const status = body.status !== undefined && ITEM_STATUSES.includes(body.status) ? body.status : act.status;
  let ownerId = act.owner_id;
  const ownerRes = resolveUser(body.owner_id);
  if (ownerRes.error) return res.status(400).json({ error: ownerRes.error });
  if (!ownerRes.skip) ownerId = ownerRes.value;
  let dueAt = act.due_at;
  if (body.due_at !== undefined) {
    const d = optInstant(body.due_at);
    if (!d.ok) return res.status(400).json({ error: 'Invalid due_at' });
    dueAt = d.value;
  }
  db.prepare(
    `UPDATE meeting_actions SET title = ?, owner_id = ?, due_at = ?, status = ? WHERE id = ?`
  ).run(title, ownerId, dueAt, status, act.id);
  return res.json({ ok: true });
});

router.delete('/:id/actions/:actId', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const act = db.prepare('SELECT id FROM meeting_actions WHERE id = ? AND meeting_id = ?')
    .get(req.params.actId, meeting.id);
  if (!act) return res.status(404).json({ error: 'Action not found' });
  db.prepare('DELETE FROM meeting_actions WHERE id = ?').run(act.id);
  return res.json({ ok: true });
});

// Shared task-creation helper. Reuses the Phase 4A task conventions:
// board_status 'To Do' / legacy status 'pending', priority 'Medium',
// origin='meeting_action', meeting_id set, and the meeting's lead/deal/project
// propagated. due_date = the IST calendar date of dueAt (or meeting end), else
// the meeting end's IST date. assigned_to = ownerId (falls back to meeting owner
// then the caller).
function createTaskFromMeeting(meeting, { title, ownerId, dueAt }, createdBy) {
  const assignedTo = ownerId || meeting.owner_id || createdBy;
  const dueSource = dueAt || meeting.end_at;
  const dueDate = istDateOf(dueSource);
  const info = db.prepare(
    `INSERT INTO tasks
       (title, details, lead_id, project_id, priority, board_status, status, origin,
        meeting_id, assigned_to, due_date, created_by, created_at)
     VALUES (?, NULL, ?, ?, 'Medium', 'To Do', 'pending', 'meeting_action', ?, ?, ?, ?, ?)`
  ).run(
    title, meeting.lead_id, meeting.project_id, meeting.id,
    assignedTo, dueDate, createdBy, nowUtc(),
  );
  return info.lastInsertRowid;
}

// Convert an action item into a task and link it (meeting_actions.task_id).
router.post('/:id/actions/:actId/to-task', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const act = db.prepare('SELECT * FROM meeting_actions WHERE id = ? AND meeting_id = ?')
    .get(req.params.actId, meeting.id);
  if (!act) return res.status(404).json({ error: 'Action not found' });
  if (act.task_id) {
    const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(act.task_id);
    if (existing) return res.json({ ok: true, task_id: act.task_id, already: true });
  }
  const taskId = createTaskFromMeeting(
    meeting, { title: act.title, ownerId: act.owner_id, dueAt: act.due_at }, req.user.id,
  );
  db.prepare('UPDATE meeting_actions SET task_id = ? WHERE id = ?').run(taskId, act.id);
  return res.json({ ok: true, task_id: taskId });
});

// Create a task FROM a decision (a decision review/follow-through item).
router.post('/:id/decisions/:decId/to-task', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const dec = db.prepare('SELECT * FROM meeting_decisions WHERE id = ? AND meeting_id = ?')
    .get(req.params.decId, meeting.id);
  if (!dec) return res.status(404).json({ error: 'Decision not found' });
  if (dec.task_id) {
    const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dec.task_id);
    if (existing) return res.json({ ok: true, task_id: dec.task_id, already: true });
  }
  const taskId = createTaskFromMeeting(
    meeting,
    { title: `Decision: ${dec.title}`, ownerId: dec.owner_id, dueAt: dec.review_at },
    req.user.id,
  );
  db.prepare('UPDATE meeting_decisions SET task_id = ? WHERE id = ?').run(taskId, dec.id);
  return res.json({ ok: true, task_id: taskId });
});

// ===================== TIMER SESSIONS =====================

// Start a timer session (optionally bound to an agenda item).
router.post('/:id/timer/start', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  let agendaItemId = null;
  if (req.body?.agenda_item_id) {
    const item = db.prepare('SELECT id FROM meeting_agenda WHERE id = ? AND meeting_id = ?')
      .get(Number(req.body.agenda_item_id), meeting.id);
    if (!item) return res.status(400).json({ error: 'Invalid agenda item' });
    agendaItemId = item.id;
  }
  const now = nowUtc();
  const info = db.prepare(
    `INSERT INTO meeting_timer_sessions (meeting_id, agenda_item_id, start_time, status, created_at)
     VALUES (?, ?, ?, 'Running', ?)`
  ).run(meeting.id, agendaItemId, now, now);
  return res.json({ id: info.lastInsertRowid, start_time: now });
});

router.post('/:id/timer/:sessionId/pause', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const sess = db.prepare('SELECT * FROM meeting_timer_sessions WHERE id = ? AND meeting_id = ?')
    .get(req.params.sessionId, meeting.id);
  if (!sess) return res.status(404).json({ error: 'Timer session not found' });
  db.prepare("UPDATE meeting_timer_sessions SET status = 'Paused' WHERE id = ?").run(sess.id);
  return res.json({ ok: true, status: 'Paused' });
});

// Stop a timer session: compute elapsed seconds and add them to the linked
// agenda item's time_spent. Elapsed = explicit body.elapsed_seconds when given
// (the client tracks pause/resume), else now - start_time.
//
// Idempotent: re-stopping an already-Stopped session returns the already-computed
// duration WITHOUT re-adding to time_spent, so a double-click / retry / replay
// cannot double-count. (Same guard pattern as the to-task handler.)
router.post('/:id/timer/:sessionId/stop', (req, res) => {
  const meeting = loadEditable(req, res);
  if (!meeting) return undefined;
  const sess = db.prepare('SELECT * FROM meeting_timer_sessions WHERE id = ? AND meeting_id = ?')
    .get(req.params.sessionId, meeting.id);
  if (!sess) return res.status(404).json({ error: 'Timer session not found' });

  if (sess.status === 'Stopped' || sess.end_time != null) {
    const prior = sess.agenda_item_id
      ? db.prepare('SELECT time_spent FROM meeting_agenda WHERE id = ?').get(sess.agenda_item_id) : null;
    return res.json({
      ok: true, duration: sess.duration ?? 0, agenda_time_spent: prior?.time_spent ?? null, already: true,
    });
  }

  const end = nowUtc();
  let elapsed = Number(req.body?.elapsed_seconds);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    // Wall-clock fallback. For a Paused session, start_time would include the
    // paused gap; the client always sends elapsed_seconds, so fall back to 0
    // rather than inflate time_spent with paused wall-clock.
    elapsed = sess.status === 'Paused'
      ? 0
      : Math.max(0, Math.floor((Date.parse(end) - Date.parse(sess.start_time)) / 1000));
  } else {
    elapsed = Math.floor(elapsed);
  }
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE meeting_timer_sessions SET end_time = ?, duration = ?, status = 'Stopped' WHERE id = ?"
    ).run(end, elapsed, sess.id);
    if (sess.agenda_item_id && elapsed > 0) {
      db.prepare('UPDATE meeting_agenda SET time_spent = time_spent + ? WHERE id = ?')
        .run(elapsed, sess.agenda_item_id);
    }
  });
  tx();
  const item = sess.agenda_item_id
    ? db.prepare('SELECT time_spent FROM meeting_agenda WHERE id = ?').get(sess.agenda_item_id) : null;
  return res.json({ ok: true, duration: elapsed, agenda_time_spent: item?.time_spent ?? null });
});

export default router;
