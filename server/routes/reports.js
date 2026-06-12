import { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  todayIst, istDayBounds, istRangeBounds, istWeekRange, istMonthRange, addDays, SQL_IST_DATE,
} from '../lib/istTime.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateRange(req) {
  const today = todayIst();
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : addDays(today, -29);
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : today;
  return { from, to, ...istRangeBounds(from, to) };
}

function sendMaybeCsv(req, res, rows, filename) {
  if (req.query.format !== 'csv') return res.json(rows);
  const list = Array.isArray(rows) ? rows : rows.rows || [];
  if (!list.length) return res.status(200).type('text/csv').send('');
  const cols = Object.keys(list[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = ['﻿' + cols.join(','), ...list.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.type('text/csv')
    .set('Content-Disposition', `attachment; filename="${filename}.csv"`)
    .send(csv);
}

// Leaderboard is visible to the whole team (it's a motivation board).
// period: today | week | month
router.get('/leaderboard', (req, res) => {
  const today = todayIst();
  let from = today;
  let to = today;
  if (req.query.period === 'week') [from, to] = istWeekRange(today);
  else if (req.query.period === 'month') [from, to] = istMonthRange(today);
  const { startUtc, endUtc } = istRangeBounds(from, to);

  const rows = db.prepare(
    `SELECT u.id, u.full_name,
       COALESCE(c.dials, 0) AS dials,
       COALESCE(c.connects, 0) AS connects,
       COALESCE(c.unique_leads, 0) AS unique_leads,
       COALESCE(d.deals, 0) AS deals,
       COALESCE(d.deal_value_paise, 0) AS deal_value_paise,
       COALESCE(p.collected_paise, 0) AS collected_paise,
       t.calls_target, t.connects_target, t.deals_target
     FROM users u
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS dials, SUM(disposition = 'connected') AS connects,
              COUNT(DISTINCT lead_id) AS unique_leads
       FROM calls WHERE called_at >= ? AND called_at < ?
         AND (auto_logged = 0 OR disposition = 'connected')
       GROUP BY user_id
     ) c ON c.user_id = u.id
     LEFT JOIN (
       SELECT created_by, COUNT(*) AS deals, SUM(deal_value_paise) AS deal_value_paise
       FROM deals WHERE won_date >= ? AND won_date <= ? AND status != 'cancelled' GROUP BY created_by
     ) d ON d.created_by = u.id
     LEFT JOIN (
       SELECT recorded_by, SUM(amount_paise) AS collected_paise
       FROM payments WHERE received_date >= ? AND received_date <= ? GROUP BY recorded_by
     ) p ON p.recorded_by = u.id
     LEFT JOIN targets t ON t.id = (
       SELECT id FROM targets WHERE user_id = u.id AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1
     )
     WHERE u.is_active = 1 AND u.role = 'caller'
     ORDER BY dials DESC, connects DESC`
  ).all(startUtc, endUtc, from, to, from, to, to);

  // Targets are daily — scale to the period length for week/month views.
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  for (const r of rows) {
    r.connect_rate = r.dials ? Math.round((r.connects / r.dials) * 100) : 0;
    r.period_days = days;
    if (r.calls_target != null) {
      r.calls_target_period = r.calls_target * days;
      r.connects_target_period = r.connects_target * days;
      r.deals_target_period = r.deals_target * days;
    }
  }
  res.json({ period: { from, to }, rows });
});

router.use(requireAdmin);

// Per-agent per-IST-day activity.
router.get('/agent-daily', (req, res) => {
  const { from, to, startUtc, endUtc } = dateRange(req);
  const rows = db.prepare(
    `SELECT ${SQL_IST_DATE('c.called_at')} AS day, u.full_name AS agent,
       COUNT(*) AS dials,
       SUM(c.disposition = 'connected') AS connects,
       COUNT(DISTINCT c.lead_id) AS unique_leads,
       ROUND(100.0 * SUM(c.disposition = 'connected') / COUNT(*)) AS connect_rate_pct
     FROM calls c JOIN users u ON u.id = c.user_id
     WHERE c.called_at >= ? AND c.called_at < ?
       AND (c.auto_logged = 0 OR c.disposition = 'connected')
     GROUP BY day, u.id ORDER BY day DESC, dials DESC`
  ).all(startUtc, endUtc);

  // Conversions per agent per day (won_date is already an IST date).
  const deals = db.prepare(
    `SELECT won_date AS day, u.full_name AS agent, COUNT(*) AS deals, SUM(deal_value_paise) AS deal_value_paise
     FROM deals d JOIN users u ON u.id = d.created_by
     WHERE won_date >= ? AND won_date <= ? AND status != 'cancelled'
     GROUP BY won_date, u.id`
  ).all(from, to);
  const dealMap = new Map(deals.map((d) => [`${d.day}|${d.agent}`, d]));
  for (const r of rows) {
    const d = dealMap.get(`${r.day}|${r.agent}`);
    r.deals = d?.deals || 0;
    r.deal_value_rupees = d ? Math.round(d.deal_value_paise / 100) : 0;
    dealMap.delete(`${r.day}|${r.agent}`);
  }
  // Days where an agent won a deal but made no logged calls still appear.
  for (const d of dealMap.values()) {
    rows.push({
      day: d.day, agent: d.agent, dials: 0, connects: 0, unique_leads: 0,
      connect_rate_pct: 0, deals: d.deals, deal_value_rupees: Math.round(d.deal_value_paise / 100),
    });
  }
  rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.dials - a.dials));
  sendMaybeCsv(req, res, rows, `agent-daily-${from}-to-${to}`);
});

// Funnel: stage transitions within the period (from lead_events, not snapshots).
router.get('/funnel', (req, res) => {
  const { from, to, startUtc, endUtc } = dateRange(req);
  const entered = db.prepare(
    `SELECT to_stage AS stage, COUNT(DISTINCT lead_id) AS leads
     FROM lead_events WHERE changed_at >= ? AND changed_at < ?
     GROUP BY to_stage`
  ).all(startUtc, endUtc);
  const created = db.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL`
  ).get(startUtc, endUtc).n;
  const map = Object.fromEntries(entered.map((e) => [e.stage, e.leads]));
  const rows = [
    { stage: 'new (created)', leads: created },
    { stage: 'contacted', leads: map.contacted || 0 },
    { stage: 'interested', leads: map.interested || 0 },
    { stage: 'follow_up', leads: map.follow_up || 0 },
    { stage: 'won', leads: map.won || 0 },
    { stage: 'lost', leads: map.lost || 0 },
  ];
  sendMaybeCsv(req, res, { period: { from, to }, rows }, `funnel-${from}-to-${to}`);
});

// Revenue by product: deals won and money actually collected in the period.
router.get('/revenue-by-product', (req, res) => {
  const { from, to } = dateRange(req);
  const rows = db.prepare(
    `SELECT pr.name AS product,
       COUNT(DISTINCT d.id) AS deals,
       COALESCE(SUM(d.deal_value_paise), 0) / 100 AS deal_value_rupees,
       COALESCE((
         SELECT SUM(p.amount_paise) FROM payments p
         JOIN deals d2 ON d2.id = p.deal_id
         WHERE d2.product_id = pr.id AND p.received_date >= ? AND p.received_date <= ?
       ), 0) / 100 AS collected_rupees
     FROM products pr
     LEFT JOIN deals d ON d.product_id = pr.id AND d.won_date >= ? AND d.won_date <= ? AND d.status != 'cancelled'
     GROUP BY pr.id HAVING deals > 0 OR collected_rupees > 0
     ORDER BY collected_rupees DESC`
  ).all(from, to, from, to);
  sendMaybeCsv(req, res, rows, `revenue-by-product-${from}-to-${to}`);
});

// Source performance: leads created in period and how far they got (to date).
router.get('/sources', (req, res) => {
  const { startUtc, endUtc, from, to } = dateRange(req);
  const rows = db.prepare(
    `SELECT l.source,
       COUNT(*) AS leads,
       SUM(EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.to_stage = 'contacted')
           OR l.stage NOT IN ('new')) AS contacted,
       SUM(EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.to_stage = 'interested')) AS interested,
       SUM(l.stage = 'won') AS won,
       SUM(l.stage = 'lost') AS lost
     FROM leads l
     WHERE l.created_at >= ? AND l.created_at < ? AND l.deleted_at IS NULL
     GROUP BY l.source ORDER BY leads DESC`
  ).all(startUtc, endUtc);
  for (const r of rows) {
    r.win_rate_pct = r.leads ? Math.round((r.won / r.leads) * 100) : 0;
  }
  sendMaybeCsv(req, res, rows, `sources-${from}-to-${to}`);
});

// Daily team trend for the dashboard chart.
router.get('/daily-trend', (req, res) => {
  const { from, to, startUtc, endUtc } = dateRange(req);
  const calls = db.prepare(
    `SELECT ${SQL_IST_DATE('called_at')} AS day, COUNT(*) AS dials,
            SUM(disposition = 'connected') AS connects
     FROM calls WHERE called_at >= ? AND called_at < ?
       AND (auto_logged = 0 OR disposition = 'connected')
     GROUP BY day ORDER BY day`
  ).all(startUtc, endUtc);
  const deals = db.prepare(
    `SELECT won_date AS day, COUNT(*) AS deals FROM deals
     WHERE won_date >= ? AND won_date <= ? AND status != 'cancelled' GROUP BY won_date`
  ).all(from, to);
  const collected = db.prepare(
    `SELECT received_date AS day, SUM(amount_paise) / 100 AS collected_rupees FROM payments
     WHERE received_date >= ? AND received_date <= ? GROUP BY received_date`
  ).all(from, to);
  const byDay = new Map();
  let d = from;
  while (d <= to) { byDay.set(d, { day: d, dials: 0, connects: 0, deals: 0, collected_rupees: 0 }); d = addDays(d, 1); }
  for (const r of calls) byDay.get(r.day) && Object.assign(byDay.get(r.day), { dials: r.dials, connects: r.connects });
  for (const r of deals) byDay.get(r.day) && (byDay.get(r.day).deals = r.deals);
  for (const r of collected) byDay.get(r.day) && (byDay.get(r.day).collected_rupees = r.collected_rupees);
  res.json([...byDay.values()]);
});

// Admin dashboard summary tiles.
router.get('/summary', (req, res) => {
  const today = todayIst();
  const { startUtc, endUtc } = istDayBounds(today);
  const [mFrom, mTo] = istMonthRange(today);
  const monthBounds = istRangeBounds(mFrom, mTo);

  const callsToday = db.prepare(
    `SELECT COUNT(*) AS dials, COALESCE(SUM(disposition='connected'),0) AS connects
     FROM calls WHERE called_at >= ? AND called_at < ?
       AND (auto_logged = 0 OR disposition = 'connected')`
  ).get(startUtc, endUtc);
  const dealsToday = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(deal_value_paise),0) AS value FROM deals WHERE won_date = ? AND status != 'cancelled'"
  ).get(today);
  const collectedMonth = db.prepare(
    'SELECT COALESCE(SUM(amount_paise),0) AS v FROM payments WHERE received_date >= ? AND received_date <= ?'
  ).get(mFrom, mTo).v;
  const leadsMonth = db.prepare(
    'SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL'
  ).get(monthBounds.startUtc, monthBounds.endUtc).n;
  const pendingFollowups = db.prepare(
    `SELECT COUNT(*) AS n FROM follow_ups f JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
     WHERE f.status = 'pending' AND f.due_at < ?`
  ).get(istDayBounds(today).endUtc).n;
  const overdueInstallments = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(i.amount_paise),0) AS amount FROM installments i
     JOIN deals d ON d.id = i.deal_id AND d.status = 'active'
     JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
     WHERE i.status IN ('pending','partial') AND i.due_date < ?`
  ).get(today);

  res.json({
    today,
    calls_today: callsToday.dials,
    connects_today: callsToday.connects,
    deals_today: dealsToday.n,
    deal_value_today_paise: dealsToday.value,
    collected_month_paise: collectedMonth,
    leads_month: leadsMonth,
    followups_due: pendingFollowups,
    overdue_installments: overdueInstallments.n,
    overdue_amount_paise: overdueInstallments.amount,
    last_backup: db.prepare("SELECT value FROM settings WHERE key = 'last_backup'").get()?.value
      ? JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'last_backup'").get().value)
      : null,
  });
});

export default router;
