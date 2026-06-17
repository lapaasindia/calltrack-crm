// Phase 5B — Role-aware dashboards + weekly report.
//
// Read-only aggregation over existing tables (NO new migration). Money is
// INTEGER paise everywhere; all IST day math goes through istTime.js. Scoping:
//   super_admin | admin | manager  -> company-wide (managers == admin for now)
//   agent | caller | employee | read_only -> only the user's own
//     leads (assigned_to), deals (created_by), calls (user_id), payments
//     (recorded_by).
//
// The weekly printable report (GET /api/dashboard/weekly.html) mirrors the
// invoice print pattern: a self-contained HTML document + window.print(), no
// PDF library.
import { Router } from 'express';
import db, { getSetting } from '../db.js';
import {
  todayIst, addDays, istRangeBounds, istDayBounds,
} from '../lib/istTime.js';
import { isAdmin } from '../lib/permissions.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// from/to are inclusive IST 'YYYY-MM-DD' business dates; default = last 30 IST
// days ending today. Returns the dates + the UTC half-open bounds for *_at cols.
function dateRange(req) {
  const today = todayIst();
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : addDays(today, -29);
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : today;
  return { from, to, ...istRangeBounds(from, to) };
}

// Build the role-aware scope clauses. For an admin tier user every clause is a
// no-op ('1'); for everyone else each is column-scoped to their own id. The
// placeholder count must match exactly when the clause binds `?`.
function scopeFor(user) {
  const admin = isAdmin(user.role);
  return {
    admin,
    // calls.user_id  /  deals.created_by  /  payments.recorded_by  /  leads.assigned_to
    callsClause: admin ? '1' : 'c.user_id = ?',
    dealsClause: admin ? '1' : 'd.created_by = ?',
    paymentsClause: admin ? '1' : 'p.recorded_by = ?',
    leadsClause: admin ? '1' : 'l.assigned_to = ?',
    uid: user.id,
  };
}

// One scalar query helper that conditionally appends the scope binding.
function scalar(sql, params) {
  return db.prepare(sql).get(...params);
}

function buildKpis(scope, range) {
  const { from, to, startUtc, endUtc } = range;
  const { admin, uid } = scope;

  // Total leads (live) the user can see, created on/before the range end.
  const totalLeads = scalar(
    `SELECT COUNT(*) AS n FROM leads l
       WHERE l.deleted_at IS NULL AND l.created_at < ? AND (${scope.leadsClause})`,
    admin ? [endUtc] : [endUtc, uid]
  ).n;

  // Pipeline value (paise): open deals' deal_value_paise (status='active', i.e.
  // not completed/cancelled) for leads still open, PLUS a fallback to the open
  // leads' budget when they have no deal yet. We sum active deals first, then
  // add budget only for open leads that have NO active deal (avoid double count).
  const activeDealValue = scalar(
    `SELECT COALESCE(SUM(d.deal_value_paise), 0) AS v
       FROM deals d JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
      WHERE d.status = 'active' AND (${scope.dealsClause})`,
    admin ? [] : [uid]
  ).v;

  // Open leads (not won/lost) with NO active deal → fall back to their budget.
  // leads.budget_paise may not exist on every install; guard via column check.
  const hasBudget = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('leads') WHERE name = 'budget_paise'").get().n > 0;
  let fallbackBudget = 0;
  if (hasBudget) {
    fallbackBudget = scalar(
      `SELECT COALESCE(SUM(l.budget_paise), 0) AS v
         FROM leads l
        WHERE l.deleted_at IS NULL AND l.stage NOT IN ('won','lost')
          AND (${scope.leadsClause})
          AND NOT EXISTS (
            SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.status = 'active'
          )`,
      admin ? [] : [uid]
    ).v;
  }
  const pipelineValuePaise = activeDealValue + fallbackBudget;

  // Revenue (paise) = real cash actually collected in the range (payments).
  const revenuePaise = scalar(
    `SELECT COALESCE(SUM(p.amount_paise), 0) AS v FROM payments p
      WHERE p.received_date >= ? AND p.received_date <= ? AND (${scope.paymentsClause})`,
    admin ? [from, to] : [from, to, uid]
  ).v;

  // Active projects = projects not Completed. Projects aren't per-caller owned
  // the way leads are; for non-admins scope to projects they head or created.
  const projClause = admin ? '1' : '(p.assigned_head_id = ? OR p.created_by = ?)';
  const activeProjects = scalar(
    `SELECT COUNT(*) AS n FROM projects p WHERE p.status != 'Completed' AND (${projClause})`,
    admin ? [] : [uid, uid]
  ).n;

  // Calls + connects in the range (skip auto-logged noise the way reports do,
  // and WhatsApp mirror rows which are messaging activity, not phone dials).
  const calls = scalar(
    `SELECT COUNT(*) AS dials, COALESCE(SUM(c.disposition = 'connected'), 0) AS connects
       FROM calls c
      WHERE c.called_at >= ? AND c.called_at < ?
        AND (c.auto_logged = 0 OR c.disposition = 'connected')
        AND c.source != 'whatsapp'
        AND (${scope.callsClause})`,
    admin ? [startUtc, endUtc] : [startUtc, endUtc, uid]
  );

  return {
    totalLeads,
    pipelineValuePaise,
    revenuePaise,
    activeProjects,
    callsInRange: calls.dials,
    connectsInRange: calls.connects,
  };
}

// Per-IST-day trend for the bar chart: revenue (paise), leads created, deals won.
function buildTrend(scope, range) {
  const { from, to, startUtc, endUtc } = range;
  const { admin, uid } = scope;

  const leads = db.prepare(
    `SELECT date(l.created_at, '+330 minutes') AS day, COUNT(*) AS n
       FROM leads l
      WHERE l.deleted_at IS NULL AND l.created_at >= ? AND l.created_at < ?
        AND (${scope.leadsClause})
      GROUP BY day`
  ).all(...(admin ? [startUtc, endUtc] : [startUtc, endUtc, uid]));

  const deals = db.prepare(
    `SELECT d.won_date AS day, COUNT(*) AS n
       FROM deals d
      WHERE d.won_date >= ? AND d.won_date <= ? AND d.status != 'cancelled'
        AND (${scope.dealsClause})
      GROUP BY d.won_date`
  ).all(...(admin ? [from, to] : [from, to, uid]));

  const revenue = db.prepare(
    `SELECT p.received_date AS day, COALESCE(SUM(p.amount_paise), 0) AS v
       FROM payments p
      WHERE p.received_date >= ? AND p.received_date <= ? AND (${scope.paymentsClause})
      GROUP BY p.received_date`
  ).all(...(admin ? [from, to] : [from, to, uid]));

  const byDay = new Map();
  let d = from;
  while (d <= to) { byDay.set(d, { day: d, leads: 0, deals: 0, revenuePaise: 0 }); d = addDays(d, 1); }
  for (const r of leads) byDay.get(r.day) && (byDay.get(r.day).leads = r.n);
  for (const r of deals) byDay.get(r.day) && (byDay.get(r.day).deals = r.n);
  for (const r of revenue) byDay.get(r.day) && (byDay.get(r.day).revenuePaise = r.v);
  return [...byDay.values()];
}

// Top performers (admin/manager only): per-user revenue (payments.recorded_by),
// leads (assigned_to, created in range), deals won, calls. Ranked by revenue.
function buildTopPerformers(range) {
  const { from, to, startUtc, endUtc } = range;
  const rows = db.prepare(
    `SELECT u.id, u.full_name,
        COALESCE(p.revenue_paise, 0) AS revenuePaise,
        COALESCE(d.deals, 0) AS deals,
        COALESCE(l.leads, 0) AS leads,
        COALESCE(c.calls, 0) AS calls,
        COALESCE(c.connects, 0) AS connects
       FROM users u
       LEFT JOIN (
         SELECT recorded_by, SUM(amount_paise) AS revenue_paise
           FROM payments WHERE received_date >= ? AND received_date <= ?
          GROUP BY recorded_by
       ) p ON p.recorded_by = u.id
       LEFT JOIN (
         SELECT created_by, COUNT(*) AS deals
           FROM deals WHERE won_date >= ? AND won_date <= ? AND status != 'cancelled'
          GROUP BY created_by
       ) d ON d.created_by = u.id
       LEFT JOIN (
         SELECT assigned_to, COUNT(*) AS leads
           FROM leads WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL
          GROUP BY assigned_to
       ) l ON l.assigned_to = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS calls, SUM(disposition = 'connected') AS connects
           FROM calls WHERE called_at >= ? AND called_at < ?
             AND (auto_logged = 0 OR disposition = 'connected')
             AND source != 'whatsapp'
          GROUP BY user_id
       ) c ON c.user_id = u.id
      WHERE u.is_active = 1
      ORDER BY revenuePaise DESC, deals DESC, calls DESC`
  ).all(from, to, from, to, startUtc, endUtc, startUtc, endUtc);
  // Only surface people who actually did something in the range.
  return rows.filter((r) => r.revenuePaise || r.deals || r.leads || r.calls);
}

// Upcoming follow-ups in the next 7 IST days (pending). Admin → team-wide;
// others → only their own. Returns lead + due instant for quick drill-in.
function buildUpcomingFollowups(scope) {
  const { admin, uid } = scope;
  const today = todayIst();
  const { startUtc } = istDayBounds(today);
  const { endUtc } = istDayBounds(addDays(today, 7));
  const rows = db.prepare(
    `SELECT f.id, f.lead_id, f.due_at, f.reason, l.name AS lead_name, l.phone,
            l.assigned_to, u.full_name AS owner_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
       LEFT JOIN users u ON u.id = f.assigned_to
      WHERE f.status = 'pending'
        AND f.due_at >= ? AND f.due_at < ?
        AND (${admin ? '1' : 'f.assigned_to = ?'})
      ORDER BY f.due_at ASC
      LIMIT 50`
  ).all(...(admin ? [startUtc, endUtc] : [startUtc, endUtc, uid]));
  return rows;
}

// Intelligence: recent analyzed calls (recordings.ai_json). Count, avg overall
// rating, sentiment mix, and the latest few summaries/coaching for the panel.
function buildIntelligence(scope, range) {
  const { startUtc, endUtc } = range;
  const { admin, uid } = scope;
  // Recordings link to a call; scope by that call's user_id for non-admins.
  const where = admin
    ? "r.ai_status = 'done' AND r.created_at >= ? AND r.created_at < ?"
    : "r.ai_status = 'done' AND r.created_at >= ? AND r.created_at < ? AND c.user_id = ?";
  const params = admin ? [startUtc, endUtc] : [startUtc, endUtc, uid];
  const recs = db.prepare(
    `SELECT r.id, r.ai_json, r.summary, r.created_at, c.user_id, l.id AS lead_id, l.name AS lead_name
       FROM recordings r
       LEFT JOIN calls c ON c.id = r.call_id
       LEFT JOIN leads l ON l.id = c.lead_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT 200`
  ).all(...params);

  let ratingSum = 0; let ratingN = 0;
  const sentiment = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  const recent = [];
  for (const r of recs) {
    let ai = null;
    try { ai = r.ai_json ? JSON.parse(r.ai_json) : null; } catch { ai = null; }
    if (!ai) continue;
    const overall = ai.rating && typeof ai.rating === 'object'
      ? (ai.rating.overall ?? ai.rating.conversion) : null;
    if (typeof overall === 'number' && Number.isFinite(overall)) { ratingSum += overall; ratingN += 1; }
    const s = String(ai.sentiment || '').toLowerCase();
    if (s in sentiment) sentiment[s] += 1;
    if (recent.length < 8) {
      recent.push({
        id: r.id,
        lead_id: r.lead_id,
        lead_name: r.lead_name,
        created_at: r.created_at,
        intent: ai.intent || null,
        sentiment: ai.sentiment || null,
        overall: typeof overall === 'number' ? overall : null,
        summary: r.summary || ai.summary || null,
        coaching: ai.coaching || (Array.isArray(ai.improvements) ? ai.improvements[0] : null) || null,
      });
    }
  }
  return {
    analyzedCount: ratingN ? ratingN : recs.length,
    totalRecordings: recs.length,
    avgRating: ratingN ? Math.round((ratingSum / ratingN) * 10) / 10 : null,
    sentiment,
    recent,
  };
}

// GET /api/dashboard?from=&to= → role-aware metrics for req.user.
router.get('/', (req, res) => {
  const range = dateRange(req);
  const scope = scopeFor(req.user);

  const payload = {
    range: { from: range.from, to: range.to },
    scope: scope.admin ? 'team' : 'self',
    role: req.user.role,
    kpis: buildKpis(scope, range),
    trend: buildTrend(scope, range),
    upcomingFollowups: buildUpcomingFollowups(scope),
    intelligence: buildIntelligence(scope, range),
  };
  // Top performers only for admin tier; callers get an empty array.
  payload.topPerformers = scope.admin ? buildTopPerformers(range) : [];

  res.json(payload);
});

// ---------- Weekly printable report (last 7 IST days) ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
const rupees = (paise) => inr.format(Math.round((paise || 0) / 100));

function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  });
}

// GET /api/dashboard/weekly.html → print-ready HTML for the last 7 IST days.
// Per-user calls/connects/deals/revenue + the top performer. Admin tier sees
// the whole team; everyone else sees a single row (themselves).
router.get('/weekly.html', (req, res) => {
  const today = todayIst();
  const from = addDays(today, -6);
  const to = today;
  const range = { from, to, ...istRangeBounds(from, to) };
  const admin = isAdmin(req.user.role);

  let rows;
  if (admin) {
    rows = buildTopPerformers(range);
  } else {
    // Single self row built from the scoped KPIs.
    const scope = scopeFor(req.user);
    const kpis = buildKpis(scope, range);
    rows = [{
      id: req.user.id,
      full_name: req.user.full_name,
      revenuePaise: kpis.revenuePaise,
      deals: db.prepare(
        `SELECT COUNT(*) AS n FROM deals WHERE created_by = ? AND won_date >= ? AND won_date <= ? AND status != 'cancelled'`
      ).get(req.user.id, from, to).n,
      // Leads created WITHIN the period (same window as buildTopPerformers), not
      // all live leads — keeps the column meaning identical across roles.
      leads: db.prepare(
        `SELECT COUNT(*) AS n FROM leads
           WHERE assigned_to = ? AND created_at >= ? AND created_at < ? AND deleted_at IS NULL`
      ).get(req.user.id, range.startUtc, range.endUtc).n,
      calls: kpis.callsInRange,
      connects: kpis.connectsInRange,
    }];
  }

  const companyName = getSetting('company_legal_name', '') || getSetting('company_name', 'CallTrack CRM');
  const totals = rows.reduce((a, r) => ({
    revenuePaise: a.revenuePaise + (r.revenuePaise || 0),
    deals: a.deals + (r.deals || 0),
    leads: a.leads + (r.leads || 0),
    calls: a.calls + (r.calls || 0),
    connects: a.connects + (r.connects || 0),
  }), { revenuePaise: 0, deals: 0, leads: 0, calls: 0, connects: 0 });

  const topPerformer = rows.length ? rows[0] : null;

  const bodyRows = rows.length
    ? rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(r.full_name)}</td>
        <td class="num">${r.calls || 0}</td>
        <td class="num">${r.connects || 0}</td>
        <td class="num">${r.deals || 0}</td>
        <td class="num">${rupees(r.revenuePaise || 0)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:#6b7280">No activity in this period.</td></tr>';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Weekly report ${escapeHtml(from)} – ${escapeHtml(to)}</title>
  <style>
    :root { --ink: #1f2937; --soft: #6b7280; --line: #e5e7eb; --brand: #4f46e5; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      color: var(--ink); margin: 0; background: #f3f4f6; }
    .sheet { max-width: 800px; margin: 24px auto; background: #fff; padding: 40px;
      border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .top { border-bottom: 2px solid var(--brand); padding-bottom: 16px; margin-bottom: 22px; }
    .company-name { font-size: 22px; font-weight: 800; }
    h1 { margin: 6px 0 2px; font-size: 24px; }
    .muted { color: var(--soft); font-size: 13px; }
    .cards { display: flex; gap: 14px; flex-wrap: wrap; margin: 18px 0 26px; }
    .stat { flex: 1 1 120px; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
    .stat .v { font-size: 22px; font-weight: 800; }
    .stat .l { font-size: 12px; color: var(--soft); text-transform: uppercase; letter-spacing: .04em; }
    .winner { background: #eef2ff; border-color: #c7d2fe; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    thead th { background: #f9fafb; text-align: left; font-size: 12px; text-transform: uppercase;
      letter-spacing: .04em; color: var(--soft); padding: 10px 12px; border-bottom: 1px solid var(--line); }
    tbody td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
    tfoot td { padding: 10px 12px; font-size: 14px; font-weight: 800; border-top: 2px solid var(--ink); }
    .num { text-align: right; white-space: nowrap; }
    .bar { position: sticky; bottom: 0; text-align: center; padding: 14px; }
    .btn { background: var(--brand); color: #fff; border: 0; padding: 11px 22px; border-radius: 8px;
      font-size: 15px; font-weight: 600; cursor: pointer; }
    @media print {
      body { background: #fff; }
      .sheet { box-shadow: none; margin: 0; max-width: none; border-radius: 0; padding: 0; }
      .no-print { display: none !important; }
      @page { margin: 16mm; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div class="company-name">${escapeHtml(companyName)}</div>
      <h1>Weekly Performance Report</h1>
      <div class="muted">${fmtDate(from)} – ${fmtDate(to)}${admin ? '' : ` · ${escapeHtml(req.user.full_name)}`}</div>
    </div>

    <div class="cards">
      <div class="stat"><div class="v">${totals.calls}</div><div class="l">Calls</div></div>
      <div class="stat"><div class="v">${totals.connects}</div><div class="l">Connects</div></div>
      <div class="stat"><div class="v">${totals.deals}</div><div class="l">Deals won</div></div>
      <div class="stat"><div class="v">${rupees(totals.revenuePaise)}</div><div class="l">Revenue</div></div>
      ${topPerformer && admin ? `<div class="stat winner"><div class="v">🏆 ${escapeHtml(topPerformer.full_name)}</div><div class="l">Top performer</div></div>` : ''}
    </div>

    <table>
      <thead>
        <tr><th>#</th><th>${admin ? 'Team member' : 'Member'}</th><th class="num">Calls</th>
        <th class="num">Connects</th><th class="num">Deals</th><th class="num">Revenue</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr><td colspan="2">Total</td><td class="num">${totals.calls}</td>
        <td class="num">${totals.connects}</td><td class="num">${totals.deals}</td>
        <td class="num">${rupees(totals.revenuePaise)}</td></tr>
      </tfoot>
    </table>
  </div>

  <div class="bar no-print">
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`);
});

export default router;
