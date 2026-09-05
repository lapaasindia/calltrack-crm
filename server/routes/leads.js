import { Router } from 'express';
import db from '../db.js';
import { requireAdmin, requireWriter, loadLead } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc } from '../lib/istTime.js';
import { STAGES, changeStage } from '../lib/leadStage.js';
import { recalcLeadScore } from '../lib/scoring.js';
import { isAdmin, isReadOnly, canSeeAllLeads } from '../lib/permissions.js';
import { getAutoAssignedOwner, assignRoundRobin } from '../lib/assignment.js';
import { bump as bumpCache } from '../lib/cache.js';
import { playableInfo } from '../lib/transcode.js';

const router = Router();
// read_only can browse; every write below is refused up front.
router.use(requireWriter);

// Page size: default 50, `?limit=` up to 500 (pickers and the Kanban ask for
// more than a page — CLIENT-7). Echoed back as page_size.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
function pageSizeOf(q) {
  const n = parseInt(q.limit, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, n);
}

// Reassignment moves the lead's OPEN work with it — the pending follow-up and
// pending tasks — so nothing rots in the old owner's queue (SCALE-20).
const moveOpenWork = (newAssignee, leadId) => {
  if (!newAssignee) return;
  db.prepare("UPDATE follow_ups SET assigned_to = ? WHERE lead_id = ? AND status = 'pending'")
    .run(newAssignee, leadId);
  db.prepare("UPDATE tasks SET assigned_to = ? WHERE lead_id = ? AND status = 'pending'")
    .run(newAssignee, leadId);
};

// ── Search (FTS5, migration 018) ────────────────────────────────────────────
// Text queries go through leads_fts (name/city/email/notes/phone) as a
// sanitised prefix query: the text is split on anything that is not a
// letter/digit/mark — the same boundaries the unicode61 tokenizer uses, so
// "rahul@example.com" and "col:on" break into the tokens the index holds and
// no FTS operator (AND/OR/NOT/NEAR, quotes, parentheses, colons) can leak in.
// Each token is double-quoted and suffixed with `*`; tokens are implicitly
// ANDed. "rahul sha" → "rahul"* "sha"* — which also finds "Sharma Rahul",
// unlike LIKE '%rahul sha%'. Returns null when there is nothing to search
// with, or when the query is digits only (a partial phone: users type the
// last 4-5 digits, which needs the substring LIKE path, not a prefix).
export function buildFtsQuery(q) {
  const tokens = String(q || '').split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return null;
  if (tokens.every((t) => /^\p{N}+$/u.test(t))) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
function ftsAvailable() {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leads_fts'").get();
}

// Keyset cursor for the list (SCALE-5): opaque base64url of [updated_at, id]
// of the last row returned. Stable under concurrent inserts/updates where
// OFFSET paging skips or repeats rows.
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.updated_at, row.id])).toString('base64url');
}
function decodeCursor(s) {
  try {
    const v = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && Number.isInteger(v[1])) {
      return { updated_at: v[0], id: v[1] };
    }
  } catch { /* fall through */ }
  return null;
}

// Tolerant JSON parse for stored TEXT(json) columns — a malformed blob must
// never 500 the lead page.
function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const LEAD_COLS = `l.id, l.name, l.phone, l.alt_phone, l.email, l.city, l.source, l.stage,
  l.lost_reason, l.assigned_to, l.notes, l.score, l.ai_intent, l.created_at, l.updated_at,
  u.full_name AS assigned_to_name`;

// List with filters. Non-admin roles are hard-scoped to their own leads at the
// SQL level. IMPORTANT: this used to test `role === 'caller'` literally, which
// let agent/employee/read_only fall through and read EVERY lead (audit H-7).
// Scope by the central permission helpers instead.
router.get('/', (req, res) => {
  const where = ['l.deleted_at IS NULL'];
  const params = [];

  if (!canSeeAllLeads(req.user.role)) {
    if (isReadOnly(req.user.role)) {
      // read_only has no row-level lead access (matches canAccessLead).
      where.push('1 = 0');
    } else {
      // agent / caller / employee: only their own assigned leads.
      where.push('l.assigned_to = ?');
      params.push(req.user.id);
    }
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

  // Search. Three paths, in order:
  //   * a full phone number → exact match on the current phone OR any number
  //     the lead has had (lead_phones: alt / previous), plus name LIKE — the
  //     historical exact-phone semantics, widened to old numbers;
  //   * text → FTS5 prefix query (search_mode 'fts'), falling back to LIKE if
  //     the FTS table is missing or the query has no usable token;
  //   * digits / anything else → the LIKE path (search_mode 'like').
  let searchMode = null;
  let ftsQuery = null;
  let q = '';
  if (req.query.q) {
    q = String(req.query.q).trim();
    const asPhone = normalizePhone(q);
    if (asPhone.ok) {
      searchMode = 'phone';
      where.push('(l.phone = ? OR l.name LIKE ? OR l.id IN (SELECT lead_id FROM lead_phones WHERE phone = ?))');
      params.push(asPhone.phone, `%${q}%`, asPhone.phone);
    } else {
      ftsQuery = buildFtsQuery(q);
      if (ftsQuery && ftsAvailable()) {
        searchMode = 'fts';
        where.push('l.id IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH ?)');
        params.push(ftsQuery);
      } else {
        searchMode = 'like';
        where.push(likeClause());
        params.push(...likeParams(q));
      }
    }
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = pageSizeOf(req.query);
  let cursor = null;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
  }

  const run = () => {
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(' AND ')}`
    ).get(...params).n;
    // Keyset: rows strictly after the cursor in (updated_at DESC, id DESC)
    // order; page/offset otherwise. One extra row tells us whether a next
    // page exists without a second COUNT.
    const pageWhere = cursor
      ? [...where, '(l.updated_at < ? OR (l.updated_at = ? AND l.id < ?))']
      : where;
    const pageParams = cursor ? [...params, cursor.updated_at, cursor.updated_at, cursor.id] : params;
    const offset = cursor ? 0 : (page - 1) * pageSize;
    const rows = db.prepare(
      `SELECT ${LEAD_COLS},
         (SELECT due_at FROM follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending') AS next_follow_up,
         (SELECT MAX(called_at) FROM calls c WHERE c.lead_id = l.id) AS last_call_at
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?`
    ).all(...pageParams, pageSize + 1, offset);
    const hasMore = rows.length > pageSize;
    if (hasMore) rows.length = pageSize;
    return { total, rows, hasMore };
  };

  let result;
  try {
    result = run();
  } catch (err) {
    // An FTS query the sanitiser somehow let through, or an FTS table that
    // is missing/corrupt: degrade to the LIKE path rather than 500.
    if (searchMode !== 'fts') throw err;
    const i = where.findIndex((w) => w.includes('leads_fts'));
    where.splice(i, 1, likeClause());
    const pi = params.indexOf(ftsQuery);
    params.splice(pi, 1, ...likeParams(q));
    searchMode = 'like';
    result = run();
  }

  const { total, rows, hasMore } = result;
  res.json({
    leads: rows,
    total,
    page: cursor ? null : page,
    page_size: pageSize,
    next_cursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    ...(searchMode ? { search_mode: searchMode } : {}),
  });
});

// The pre-018 substring search, kept as the fallback path.
function likeClause() {
  return '(l.name LIKE ? OR l.phone LIKE ? OR l.city LIKE ? OR l.email LIKE ?)';
}
function likeParams(q) {
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, '');
  return [like, digits ? `%${digits}%` : like, like, like];
}

// Distinct sources for the filter dropdown.
router.get('/sources', (req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT source FROM leads WHERE deleted_at IS NULL ORDER BY source"
  ).all();
  res.json(rows.map((r) => r.source));
});

// Live duplicate check for the add-lead form. Callers learn THAT a duplicate
// exists, but details of another caller's lead are not disclosed.
router.get('/check-phone', (req, res) => {
  const norm = normalizePhone(req.query.phone);
  if (!norm.ok) return res.json({ valid: false, reason: norm.reason });
  const existing = db.prepare(
    'SELECT id, name, stage, assigned_to FROM leads WHERE phone = ? AND deleted_at IS NULL'
  ).get(norm.phone);
  if (!existing) return res.json({ valid: true, phone: norm.phone, duplicate: null });
  const mine = canSeeAllLeads(req.user.role) || existing.assigned_to === req.user.id;
  res.json({
    valid: true,
    phone: norm.phone,
    duplicate: mine
      ? { id: existing.id, name: existing.name, stage: existing.stage, mine: true }
      : { mine: false },
  });
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const norm = normalizePhone(req.body.phone);
  if (!norm.ok) return res.status(400).json({ error: `Invalid phone number (${norm.reason})` });

  const existing = db.prepare(
    'SELECT id, name, assigned_to FROM leads WHERE phone = ? AND deleted_at IS NULL'
  ).get(norm.phone);
  if (existing) {
    const mine = canSeeAllLeads(req.user.role) || existing.assigned_to === req.user.id;
    return res.status(409).json({
      error: mine
        ? 'A lead with this phone already exists'
        : 'A lead with this phone already exists (assigned to another team member)',
      existing: mine ? { id: existing.id, name: existing.name } : null,
    });
  }

  // Non-admin (agent/caller/employee) can only create leads assigned to self.
  // Admin-tier creators: an explicit assigned_to is respected; otherwise the
  // lead is auto-routed (subject/source rule → round-robin → fallback).
  let assignedTo = req.user.id;
  let autoAssign = null;
  if (isAdmin(req.user.role)) {
    if (req.body.assigned_to !== undefined) {
      assignedTo = req.body.assigned_to ? Number(req.body.assigned_to) : null;
    } else {
      autoAssign = getAutoAssignedOwner(db, {
        subject: req.body.subject,
        source: req.body.source,
      });
      assignedTo = autoAssign.userId;
    }
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
  // Initial score (source/stage factors) so a fresh lead is never NULL-scored
  // until its first event (SCALE-10).
  recalcLeadScore(db, info.lastInsertRowid);
  bumpCache();
  res.json({
    id: info.lastInsertRowid,
    assigned_to: assignedTo,
    auto_assign: autoAssign ? { method: autoAssign.method, reason: autoAssign.reason } : null,
  });
});

// Lead detail: full timeline (calls + stage events), deals with balances, follow-up.
router.get('/:id', loadLead, (req, res) => {
  const lead = req.lead;
  const assignedName = lead.assigned_to
    ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(lead.assigned_to)?.full_name
    : null;
  const calls = db.prepare(
    `SELECT c.*, u.full_name AS user_name,
       r.id AS recording_id, r.summary AS recording_summary, r.transcript AS recording_transcript,
       r.translation AS recording_translation, r.ai_json AS recording_ai_json,
       r.provider AS recording_provider, r.ai_status AS recording_ai_status,
       r.file_path AS recording_file_path, r.playable_path AS recording_playable_path
     FROM calls c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN recordings r ON r.id = (
       SELECT r2.id FROM recordings r2 WHERE r2.call_id = c.id ORDER BY r2.id LIMIT 1
     )
     WHERE c.lead_id = ? ORDER BY c.called_at DESC`
  ).all(lead.id);
  for (const c of calls) {
    c.recording_ai = c.recording_ai_json ? safeJson(c.recording_ai_json) : null;
    delete c.recording_ai_json;
    // MOB-22: can the browser play what /api/review/audio/:id will serve?
    if (c.recording_id) {
      const p = playableInfo(c.recording_file_path, c.recording_playable_path);
      c.recording_playable = p.playable;
      c.recording_playable_ext = p.playable_ext;
    } else {
      c.recording_playable = null;
      c.recording_playable_ext = null;
    }
    delete c.recording_file_path;
    delete c.recording_playable_path;
  }
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
    extra: lead.extra_json ? safeJson(lead.extra_json) : null,
    score_factors: safeJson(lead.score_factors),
    ai_rating: safeJson(lead.ai_rating),
    calls, events, follow_up: followUp || null, deals,
  });
});

router.patch('/:id', loadLead, (req, res) => {
  const lead = req.lead;

  // Validate everything BEFORE writing anything, so a later failure can't
  // leave a half-applied update (e.g. stage changed but phone rejected).
  const wantsStageChange = req.body.stage !== undefined && req.body.stage !== lead.stage;
  if (wantsStageChange) {
    if (!STAGES.includes(req.body.stage)) return res.status(400).json({ error: 'Invalid stage' });
    if (req.body.stage === 'won') {
      return res.status(400).json({ error: 'Use the Win Deal flow to mark a lead won' });
    }
  }
  // Reassignment is admin-tier (super_admin/admin/manager) — the same tier
  // that may assign on create (SCALE-9 / CLIENT-8).
  if (req.body.assigned_to !== undefined && !isAdmin(req.user.role)) {
    return res.status(403).json({ error: 'Only admin-tier users can reassign leads' });
  }
  let normPhone = null;
  if (req.body.phone !== undefined) {
    const norm = normalizePhone(req.body.phone);
    if (!norm.ok) return res.status(400).json({ error: `Invalid phone number (${norm.reason})` });
    normPhone = norm.phone;
  }

  // Optional note carried with a stage change (e.g. from the Kanban board's
  // required drop-note). Appended to the lead's running notes as a dated line
  // so it shows in the timeline; the stage change itself is recorded in
  // lead_events by changeStage(). Only applied when the stage actually moves.
  const stageNote = wantsStageChange && typeof req.body.note === 'string'
    ? req.body.note.trim() : '';

  try {
    db.transaction(() => {
      if (wantsStageChange) {
        changeStage(lead.id, lead.stage, req.body.stage, req.user.id, req.body.lost_reason || null);
        if (stageNote) {
          const stamp = nowUtc();
          const line = `[${stamp}] ${lead.stage} → ${req.body.stage}: ${stageNote}`;
          const current = db.prepare('SELECT notes FROM leads WHERE id = ?').get(lead.id)?.notes;
          db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?')
            .run(current ? `${current}\n${line}` : line, stamp, lead.id);
        }
        // Stage feeds the rule-based score (interested/follow_up boost it).
        recalcLeadScore(db, lead.id);
      }
      if (req.body.assigned_to !== undefined) {
        const newAssignee = req.body.assigned_to ? Number(req.body.assigned_to) : null;
        db.prepare('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?')
          .run(newAssignee, nowUtc(), lead.id);
        moveOpenWork(newAssignee, lead.id);
      }
      const fields = ['name', 'alt_phone', 'email', 'city', 'source', 'notes'];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          db.prepare(`UPDATE leads SET ${f} = ?, updated_at = ? WHERE id = ?`)
            .run(req.body[f] === '' ? null : req.body[f], nowUtc(), lead.id);
        }
      }
      if (normPhone) {
        const dup = db.prepare(
          'SELECT id FROM leads WHERE phone = ? AND deleted_at IS NULL AND id != ?'
        ).get(normPhone, lead.id);
        if (dup) {
          const err = new Error('Another lead already has this phone');
          err.status = 409;
          throw err;
        }
        // SCALE-18(b): the migration-018 trigger trg_lead_phones_au_phone
        // records the old number in lead_phones as 'previous' (valid_to =
        // now) and the new one as the open 'primary' — sync keeps attaching
        // calls from the old number to this lead.
        db.prepare('UPDATE leads SET phone = ?, phone_raw = ?, updated_at = ? WHERE id = ?')
          .run(normPhone, String(req.body.phone), nowUtc(), lead.id);
      }
    })();
  } catch (err) {
    // The unique phone index can also fire under a concurrent write race.
    if (err.status === 409 || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Another lead already has this phone' });
    }
    throw err;
  }
  bumpCache();
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
    // Unlink WhatsApp chats so the contact can be promoted to a fresh lead
    // later and inbound messages stop mirroring into a deleted lead (SCALE-19).
    // (lead_phones rows are closed by trigger trg_lead_phones_au_deleted.)
    db.prepare('UPDATE wa_contacts SET lead_id = NULL WHERE lead_id = ?').run(lead.id);
  })();
  bumpCache();
  res.json({ ok: true });
});

// Bulk assign (admin): distribute selected leads to a caller, or round-robin.
router.post('/bulk-assign', requireAdmin, (req, res) => {
  const ids = (req.body.lead_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No leads selected' });

  let assignees;
  if (req.body.round_robin) {
    // Shared persistent-cursor round-robin over agents AND callers (SCALE-9/20).
    assignees = assignRoundRobin(db, ids.length);
    if (!assignees.length) return res.status(400).json({ error: 'No active agents/callers to assign to' });
  } else {
    const userId = Number(req.body.assigned_to);
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user) return res.status(400).json({ error: 'Invalid assignee' });
    assignees = ids.map(() => userId);
  }

  const update = db.prepare('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
  db.transaction(() => {
    ids.forEach((id, i) => {
      const to = assignees[i];
      update.run(to, nowUtc(), id);
      moveOpenWork(to, id);
    });
  })();
  bumpCache();
  res.json({ ok: true, assigned: ids.length });
});

export default router;
