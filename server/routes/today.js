import { Router } from 'express';
import db from '../db.js';
import { todayIst, istDayBounds } from '../lib/istTime.js';
import { canSeeAllLeads } from '../lib/permissions.js';
import { loadOpenInstallments } from '../lib/installmentDues.js';

const router = Router();

// Whose queue? Callers get their own; the admin tier (super_admin | admin |
// manager — via canSeeAllLeads, not a literal 'admin'; SCALE-9) can view
// anyone's or everyone's (?user_id=all → null = no user filter).
function resolveUserFilter(req) {
  if (!canSeeAllLeads(req.user.role)) return req.user.id;
  if (req.query.user_id === 'all') return null;
  return Number(req.query.user_id) || req.user.id;
}

// Optional ?limit= per list (default: everything, as before — the mobile
// client and the web page both render the full queue).
function parseLimit(req) {
  const n = parseInt(req.query.limit, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : null;
}

function loadFollowups(userFilter, endUtc, limit) {
  const params = [endUtc];
  let userClause = '';
  if (userFilter) { userClause = 'AND f.assigned_to = ?'; params.push(userFilter); }
  let limitSql = '';
  if (limit) { limitSql = 'LIMIT ?'; params.push(limit); }
  return db.prepare(
    `SELECT f.id AS follow_up_id, f.due_at, f.reason, l.id AS lead_id, l.name, l.phone,
            l.stage, l.city, l.source, u.full_name AS assigned_to_name
     FROM follow_ups f
     JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
     JOIN users u ON u.id = f.assigned_to
     WHERE f.status = 'pending' AND f.due_at < ? ${userClause}
     ORDER BY f.due_at ${limitSql}`
  ).all(...params);
}

function countFollowups(userFilter, endUtc) {
  const params = [endUtc];
  let userClause = '';
  if (userFilter) { userClause = 'AND f.assigned_to = ?'; params.push(userFilter); }
  return db.prepare(
    `SELECT COUNT(*) AS n FROM follow_ups f
     JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
     WHERE f.status = 'pending' AND f.due_at < ? ${userClause}`
  ).get(...params).n;
}

// Installments due today or overdue, with what is ACTUALLY still owed on each
// (amount − payments linked to it − the deal's unlinked payments applied FIFO;
// README "Pending = deal value − payments received"). Fully covered ones are
// omitted. paid_paise is kept as amount − due so the existing client math
// (remaining = amount − paid) stays right; due_paise is the explicit field.
function loadPaymentsDue(userFilter, today, limit) {
  const rows = loadOpenInstallments(db, { dueOnOrBefore: today, assignedTo: userFilter });
  for (const r of rows) {
    r.linked_paid_paise = r.paid_paise;
    r.paid_paise = r.amount_paise - r.due_paise;
    // Internal FIFO bookkeeping — not part of the response (keeps the
    // team-wide payload lean).
    delete r.id;
    delete r.deal_unlinked_paise;
    delete r.unlinked_applied_paise;
  }
  return limit ? rows.slice(0, limit) : rows;
}

function loadTasks(userFilter, today, limit) {
  const params = [today];
  let userClause = '';
  if (userFilter) { userClause = 'AND t.assigned_to = ?'; params.push(userFilter); }
  let limitSql = '';
  if (limit) { limitSql = 'LIMIT ?'; params.push(limit); }
  return db.prepare(
    `SELECT t.id, t.title, t.details, t.due_date, t.source,
            l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
            u.full_name AS assigned_to_name
     FROM tasks t
     JOIN users u ON u.id = t.assigned_to
     LEFT JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
     WHERE t.status = 'pending' AND t.due_date <= ? ${userClause}
     ORDER BY t.due_date ${limitSql}`
  ).all(...params);
}

function countTasks(userFilter, today) {
  const params = [today];
  let userClause = '';
  if (userFilter) { userClause = 'AND t.assigned_to = ?'; params.push(userFilter); }
  return db.prepare(
    `SELECT COUNT(*) AS n FROM tasks t WHERE t.status = 'pending' AND t.due_date <= ? ${userClause}`
  ).get(...params).n;
}

// Badge counts only — what the nav polls every 60 s (SCALE-2/5). Same scoping
// and definitions as GET /api/today, three cheap queries instead of the full
// queue. Shape: { date, followups, payments_due, tasks, total }.
router.get('/counts', (req, res) => {
  const today = todayIst();
  const { endUtc } = istDayBounds(today);
  const userFilter = resolveUserFilter(req);
  const followups = countFollowups(userFilter, endUtc);
  const paymentsDue = loadPaymentsDue(userFilter, today, null).length;
  const tasks = countTasks(userFilter, today);
  res.json({ date: today, followups, payments_due: paymentsDue, tasks, total: followups + paymentsDue + tasks });
});

// The Today queue: pending follow-ups due (or overdue — they never vanish)
// + installments due/overdue + tasks, merged. NEVER filtered by lead stage:
// payment and support follow-ups on won leads must appear.
router.get('/', (req, res) => {
  const today = todayIst();
  const { startUtc, endUtc } = istDayBounds(today);
  const userFilter = resolveUserFilter(req);
  const limit = parseLimit(req);

  const followups = loadFollowups(userFilter, endUtc, limit);
  const paymentsDue = loadPaymentsDue(userFilter, today, limit);
  const tasks = loadTasks(userFilter, today, limit);

  // My stats today vs targets (for callers and for admin's own view).
  // Auto-logged mobile calls only count as dials when they connected —
  // otherwise unanswered personal redials would inflate targets.
  const statsUser = userFilter || req.user.id;
  const stats = db.prepare(
    `SELECT COUNT(*) AS calls,
            SUM(disposition = 'connected') AS connects,
            COUNT(DISTINCT lead_id) AS unique_leads
     FROM calls WHERE user_id = ? AND called_at >= ? AND called_at < ?
       AND (auto_logged = 0 OR disposition = 'connected')
       AND source != 'whatsapp'`
  ).get(statsUser, startUtc, endUtc);
  const dealsToday = db.prepare(
    'SELECT COUNT(*) AS n FROM deals WHERE created_by = ? AND won_date = ?'
  ).get(statsUser, today).n;
  const target = db.prepare(
    `SELECT calls_target, connects_target, deals_target FROM targets
     WHERE user_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
  ).get(statsUser, today);

  const payload = {
    date: today,
    followups,
    payments_due: paymentsDue,
    tasks,
    stats: {
      calls: stats.calls || 0,
      connects: stats.connects || 0,
      unique_leads: stats.unique_leads || 0,
      deals: dealsToday,
      target: target || null,
    },
  };
  if (limit) {
    // True totals so a truncated page can still show "… and N more".
    payload.limit = limit;
    payload.counts = {
      followups: countFollowups(userFilter, endUtc),
      payments_due: loadPaymentsDue(userFilter, today, null).length,
      tasks: countTasks(userFilter, today),
    };
  }
  res.json(payload);
});

export default router;
