import { Router } from 'express';
import { invalidateOnWrite } from '../lib/cache.js';
import db from '../db.js';
import { requireAdmin, loadLead, canAccessLead } from '../middleware/auth.js';
import { isReadOnly, canSeeAllLeads } from '../lib/permissions.js';
import { nowUtc, todayIst } from '../lib/istTime.js';
import { changeStage } from '../lib/leadStage.js';
import { recalcLeadScore } from '../lib/scoring.js';
// One money bound for every paise route (deals, invoices, products, catalog):
// ₹100 crore (1e11 paise) — far above any real deal/payment and well under
// Number.MAX_SAFE_INTEGER, past which JS integer math silently loses precision
// and poisons SUM() rollups (audit M-6).
import { MAX_PAISE } from './catalog.js';

const router = Router();
// Every deal / payment / installment write drops the dashboard cache
// (SCALE-12) — pipeline, revenue, leaderboard and top performers all read
// these tables.
router.use(invalidateOnWrite);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other'];
// Convert rupees → integer paise. Returns NaN for non-finite/out-of-range
// input so the existing `Number.isFinite(value) && value > 0` guards reject it.
const toPaise = (rupees) => {
  const paise = Math.round(Number(rupees) * 100);
  if (!Number.isSafeInteger(paise) || paise < 0 || paise > MAX_PAISE) return NaN;
  return paise;
};

function loadDealChecked(req, res) {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) { res.status(404).json({ error: 'Deal not found' }); return null; }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(deal.lead_id);
  if (!canAccessLead(req.user, lead)) { res.status(403).json({ error: 'Not your lead' }); return null; }
  return { deal, lead };
}

function paidFor(dealId) {
  return db.prepare(
    'SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM payments WHERE deal_id = ?'
  ).get(dealId).paid;
}

// Recompute one installment's status from its linked payments.
function refreshInstallmentStatus(installmentId) {
  const inst = db.prepare('SELECT * FROM installments WHERE id = ?').get(installmentId);
  if (!inst || inst.status === 'waived') return;
  const paid = db.prepare(
    'SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM payments WHERE installment_id = ?'
  ).get(installmentId).paid;
  const status = paid <= 0 ? 'pending' : paid >= inst.amount_paise ? 'paid' : 'partial';
  db.prepare('UPDATE installments SET status = ? WHERE id = ?').run(status, installmentId);
}

function refreshDealStatus(dealId) {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal || deal.status === 'cancelled') return;
  const status = paidFor(dealId) >= deal.deal_value_paise ? 'completed' : 'active';
  db.prepare('UPDATE deals SET status = ? WHERE id = ?').run(status, dealId);
}

// Win a deal on a lead: creates deal (+ optional EMI schedule), marks lead won.
router.post('/leads/:id/deals', loadLead, (req, res) => {
  const lead = req.lead;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1')
    .get(Number(req.body.product_id));
  if (!product) return res.status(400).json({ error: 'Pick a valid product' });

  const value = toPaise(req.body.deal_value_rupees);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Valid deal value required' });

  const installments = Array.isArray(req.body.installments) ? req.body.installments : [];
  const parsed = installments.map((i, idx) => ({
    seq: idx + 1,
    amount: toPaise(i.amount_rupees),
    due_date: i.due_date,
  }));
  for (const i of parsed) {
    if (!Number.isFinite(i.amount) || i.amount <= 0) {
      return res.status(400).json({ error: `Installment ${i.seq}: valid amount required` });
    }
    if (!DATE_RE.test(i.due_date || '')) {
      return res.status(400).json({ error: `Installment ${i.seq}: valid due date required` });
    }
  }
  if (parsed.length) {
    const sum = parsed.reduce((s, i) => s + i.amount, 0);
    if (sum !== value) {
      return res.status(400).json({
        error: `Installments must add up to the deal value (schedule: ₹${(sum / 100).toLocaleString('en-IN')}, deal: ₹${(value / 100).toLocaleString('en-IN')})`,
      });
    }
  }

  const now = nowUtc();
  const dealId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, won_at, won_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(lead.id, product.id, req.user.id, value, now, todayIst(), req.body.notes || null, now);
    const id = info.lastInsertRowid;
    const insertInst = db.prepare(
      'INSERT INTO installments (deal_id, seq, amount_paise, due_date, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const i of parsed) insertInst.run(id, i.seq, i.amount, i.due_date, now);
    if (lead.stage !== 'won') {
      changeStage(lead.id, lead.stage, 'won', req.user.id);
      // Reflect the 'won' stage boost immediately (mirrors calls.js / leads.js
      // PATCH, which rescore on every stage change) instead of waiting for the
      // next call to be logged.
      recalcLeadScore(db, lead.id);
    }
    // Seed the closer's learning journal with this win. The client can still
    // prompt for a richer reflection via POST /api/coaching/learnings; this is
    // the automatic 'deal_closed' marker so closes always show up in coaching.
    db.prepare(
      `INSERT INTO daily_learnings (user_id, entry_date, source, deal_id, learning, win, created_at)
       VALUES (?, ?, 'deal_closed', ?, ?, ?, ?)`
    ).run(
      req.user.id, todayIst(), id,
      `Closed a deal with ${lead.name} (${product.name}).`,
      `Won ₹${(value / 100).toLocaleString('en-IN')} — ${product.name}`,
      now
    );
    return id;
  })();

  res.json({ ok: true, deal_id: dealId });
});

// Record a payment (optionally against a specific installment).
router.post('/deals/:id/payments', (req, res) => {
  const ctx = loadDealChecked(req, res);
  if (!ctx) return;
  const { deal } = ctx;
  if (deal.status === 'cancelled') return res.status(400).json({ error: 'Deal is cancelled' });

  const amount = toPaise(req.body.amount_rupees);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
  const pending = deal.deal_value_paise - paidFor(deal.id);
  if (amount > pending) {
    return res.status(400).json({
      error: `Amount exceeds pending balance (₹${(pending / 100).toLocaleString('en-IN')})`,
    });
  }
  const method = METHODS.includes(req.body.method) ? req.body.method : 'other';
  const receivedDate = DATE_RE.test(req.body.received_date || '') ? req.body.received_date : todayIst();

  let installmentId = null;
  if (req.body.installment_id) {
    const inst = db.prepare('SELECT * FROM installments WHERE id = ? AND deal_id = ?')
      .get(Number(req.body.installment_id), deal.id);
    if (!inst) return res.status(400).json({ error: 'Invalid installment' });
    installmentId = inst.id;
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO payments (deal_id, installment_id, amount_paise, method, reference, received_date, recorded_by, recorded_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(deal.id, installmentId, amount, method, req.body.reference || null,
      receivedDate, req.user.id, nowUtc(), req.body.notes || null);
    if (installmentId) refreshInstallmentStatus(installmentId);
    refreshDealStatus(deal.id);
  })();

  res.json({ ok: true });
});

// Fix-a-mistake delete: admin only; client shows balance impact confirmation.
router.delete('/payments/:id', requireAdmin, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
    if (payment.installment_id) refreshInstallmentStatus(payment.installment_id);
    refreshDealStatus(payment.deal_id);
  })();
  res.json({ ok: true });
});

router.post('/deals/:id/cancel', requireAdmin, (req, res) => {
  const ctx = loadDealChecked(req, res);
  if (!ctx) return;
  db.prepare("UPDATE deals SET status = 'cancelled' WHERE id = ?").run(ctx.deal.id);
  res.json({ ok: true });
});

// Replace the remaining schedule of a deal (admin or assigned caller).
router.put('/deals/:id/installments', (req, res) => {
  const ctx = loadDealChecked(req, res);
  if (!ctx) return;
  const { deal } = ctx;
  const rows = Array.isArray(req.body.installments) ? req.body.installments : [];
  const parsed = rows.map((i, idx) => ({ seq: idx + 1, amount: toPaise(i.amount_rupees), due_date: i.due_date }));
  for (const i of parsed) {
    if (!Number.isFinite(i.amount) || i.amount <= 0 || !DATE_RE.test(i.due_date || '')) {
      return res.status(400).json({ error: `Installment ${i.seq}: valid amount and date required` });
    }
  }
  const sum = parsed.reduce((s, i) => s + i.amount, 0);
  if (sum !== deal.deal_value_paise) {
    return res.status(400).json({ error: 'Installments must add up to the deal value' });
  }
  const hasLinkedPayments = db.prepare(
    'SELECT COUNT(*) AS n FROM payments WHERE deal_id = ? AND installment_id IS NOT NULL'
  ).get(deal.id).n;
  if (hasLinkedPayments) {
    return res.status(400).json({ error: 'Schedule has payments linked to it — adjust individual installments instead' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM installments WHERE deal_id = ?').run(deal.id);
    const insert = db.prepare(
      'INSERT INTO installments (deal_id, seq, amount_paise, due_date, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const i of parsed) insert.run(deal.id, i.seq, i.amount, i.due_date, nowUtc());
  })();
  res.json({ ok: true });
});

// Collections overview: deals with balances + next open installment.
//
// Default = deals with an OPEN balance (pending > 0); ?all=1 includes settled
// ones. ?limit (default 500, max 5000) + ?offset page the list; `summary` and
// `total` are always computed over the whole scope with one aggregate query,
// so the tiles don't change meaning when the list is paged.
//
// Pre-aggregated payments/installments joins replace the correlated
// subqueries that rescanned every pending installment per deal (12–14 s at 8k
// deals, blocking every other user; SCALE-1) → ~25 ms.
//
// "overdue" = money is still OWED on past-due installments after subtracting
// the payments linked to them AND the deal's unlinked payments (which the
// Today queue applies FIFO to the earliest open installments — the past-due
// ones). README: pending is deal value − payments, never derived from EMI
// status. overdue_paise = MAX(past-due owed − unlinked, 0).
// The `inst` subquery binds ONE parameter: today's IST date.
const COLLECTIONS_JOINS = `
  FROM deals d
  JOIN products pr ON pr.id = d.product_id
  JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
  LEFT JOIN users u ON u.id = l.assigned_to
  LEFT JOIN (SELECT deal_id, SUM(amount_paise) AS paid_paise,
                    SUM(CASE WHEN installment_id IS NULL THEN amount_paise ELSE 0 END) AS unlinked_paise
               FROM payments GROUP BY deal_id) pay
    ON pay.deal_id = d.id
  LEFT JOIN (SELECT i.deal_id, MIN(i.due_date) AS next_due_date,
                    SUM(CASE WHEN i.due_date < ? THEN i.amount_paise - COALESCE(ip.paid_paise, 0) ELSE 0 END) AS past_due_owed_paise
               FROM installments i
               LEFT JOIN (SELECT installment_id, SUM(amount_paise) AS paid_paise FROM payments
                           WHERE installment_id IS NOT NULL GROUP BY installment_id) ip
                 ON ip.installment_id = i.id
              WHERE i.status IN ('pending','partial') GROUP BY i.deal_id) inst
    ON inst.deal_id = d.id`;
const OVERDUE_PAISE_SQL = 'MAX(COALESCE(inst.past_due_owed_paise, 0) - COALESCE(pay.unlinked_paise, 0), 0)';

router.get('/collections', (req, res) => {
  const today = todayIst();
  // Scope non-admin roles to their own deals (audit H-7 — was `role==='caller'`,
  // which leaked all deals/balances/phones to agent/employee/read_only).
  let callerScope = '';
  const scopeParams = [];
  if (!canSeeAllLeads(req.user.role)) {
    if (isReadOnly(req.user.role)) {
      callerScope = 'AND 1 = 0';
    } else {
      callerScope = 'AND l.assigned_to = ?';
      scopeParams.push(req.user.id);
    }
  }
  const includeSettled = req.query.all === '1' || req.query.all === 'true';
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const openOnly = includeSettled ? '' : 'AND (d.deal_value_paise - COALESCE(pay.paid_paise, 0)) > 0';

  const deals = db.prepare(
    `SELECT d.id, d.deal_value_paise, d.status, d.won_date, pr.name AS product_name,
            l.id AS lead_id, l.name, l.phone, l.assigned_to, u.full_name AS assigned_to_name,
            COALESCE(pay.paid_paise, 0) AS paid_paise,
            inst.next_due_date,
            MIN(${OVERDUE_PAISE_SQL}, MAX(d.deal_value_paise - COALESCE(pay.paid_paise, 0), 0)) AS overdue_paise
     ${COLLECTIONS_JOINS}
     WHERE d.status != 'cancelled' ${callerScope} ${openOnly}
     ORDER BY d.won_date DESC, d.id DESC
     LIMIT ? OFFSET ?`
  ).all(today, ...scopeParams, limit, offset);

  for (const d of deals) {
    d.pending_paise = d.deal_value_paise - d.paid_paise;
    d.overdue = d.overdue_paise > 0;
  }

  // Whole-scope aggregates (settled deals included, as before) in one pass.
  const agg = db.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(d.deal_value_paise), 0) AS total_value_paise,
            COALESCE(SUM(COALESCE(pay.paid_paise, 0)), 0) AS collected_paise,
            COALESCE(SUM(MAX(d.deal_value_paise - COALESCE(pay.paid_paise, 0), 0)), 0) AS pending_paise,
            COALESCE(SUM(${OVERDUE_PAISE_SQL} > 0), 0) AS overdue_count,
            COALESCE(SUM(MIN(${OVERDUE_PAISE_SQL}, MAX(d.deal_value_paise - COALESCE(pay.paid_paise, 0), 0))), 0) AS overdue_paise,
            COALESCE(SUM(d.deal_value_paise - COALESCE(pay.paid_paise, 0) > 0), 0) AS open_count
     ${COLLECTIONS_JOINS}
     WHERE d.status != 'cancelled' ${callerScope}`
  ).get(today, ...scopeParams);

  const summary = {
    total_value_paise: agg.total_value_paise,
    collected_paise: agg.collected_paise,
    pending_paise: agg.pending_paise,
    overdue_count: agg.overdue_count,
    overdue_paise: agg.overdue_paise,
    open_count: agg.open_count,
    deal_count: agg.n,
  };

  res.json({
    deals,
    summary,
    today,
    total: includeSettled ? agg.n : agg.open_count,
    limit,
    offset,
    all: includeSettled,
  });
});

export default router;
