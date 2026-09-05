// Money owed on installments, per the README "Tracking definitions":
//
//   Pending = deal value − payments received (never derived from EMI statuses)
//
// So an installment's due amount is its amount MINUS the payments linked to
// it, and payments recorded against the deal WITHOUT picking an installment
// are applied FIFO (lowest seq first) to the deal's open installments. The
// installment `status` column stays what refreshInstallmentStatus wrote (it
// only sees linked payments) — the UI shows `due_paise` instead (SCALE-11).
//
// Used by today.js (queue + counts) and reports.js (summary overdue tiles).
// One query with two pre-aggregated joins — no correlated per-row scan
// (SCALE-2: 3.8 s → ~14 ms company-wide at 25k installments).

// LEFT JOIN fragments; the outer query must alias installments as `i` and
// deals as `d`.
export const LINKED_PAID_JOIN = `
  LEFT JOIN (
    SELECT installment_id, SUM(amount_paise) AS paid_paise
      FROM payments WHERE installment_id IS NOT NULL GROUP BY installment_id
  ) ip ON ip.installment_id = i.id`;
export const UNLINKED_PAID_JOIN = `
  LEFT JOIN (
    SELECT deal_id, SUM(amount_paise) AS unlinked_paise
      FROM payments WHERE installment_id IS NULL GROUP BY deal_id
  ) up ON up.deal_id = d.id`;
// Select-list columns the joins provide.
export const PAID_COLUMNS = 'COALESCE(ip.paid_paise, 0) AS paid_paise, COALESCE(up.unlinked_paise, 0) AS deal_unlinked_paise';

// Given open-installment rows carrying {deal_id, seq, amount_paise, paid_paise,
// deal_unlinked_paise}, set `due_paise` (and `unlinked_applied_paise`) on each
// by applying the deal's unlinked money FIFO by seq. Mutates + returns rows.
export function applyInstallmentDues(rows) {
  const byDeal = new Map();
  for (const r of rows) {
    if (!byDeal.has(r.deal_id)) byDeal.set(r.deal_id, []);
    byDeal.get(r.deal_id).push(r);
  }
  for (const list of byDeal.values()) {
    list.sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
    let unlinked = Math.max(0, Number(list[0].deal_unlinked_paise) || 0);
    for (const r of list) {
      let due = Math.max(0, (Number(r.amount_paise) || 0) - (Number(r.paid_paise) || 0));
      const applied = Math.min(due, unlinked);
      due -= applied;
      unlinked -= applied;
      r.unlinked_applied_paise = applied;
      r.due_paise = due;
    }
  }
  return rows;
}

// Load open installments (pending/partial, on active deals of live leads) that
// are due on/before `dueOnOrBefore` (inclusive) or strictly before `dueBefore`,
// optionally scoped to a lead owner, with due_paise computed. Rows whose due
// is fully covered are dropped — a deal paid off through unlinked payments
// must not keep showing "₹50,000 due" (SCALE-11).
export function loadOpenInstallments(db, { dueOnOrBefore, dueBefore, assignedTo = null } = {}) {
  const where = ["i.status IN ('pending','partial')"];
  const params = [];
  if (dueOnOrBefore) { where.push('i.due_date <= ?'); params.push(dueOnOrBefore); }
  if (dueBefore) { where.push('i.due_date < ?'); params.push(dueBefore); }
  if (assignedTo) { where.push('l.assigned_to = ?'); params.push(assignedTo); }
  const rows = db.prepare(
    `SELECT i.id AS installment_id, i.id, i.deal_id, i.due_date, i.seq, i.amount_paise,
            i.status AS installment_status, ${PAID_COLUMNS},
            d.deal_value_paise, pr.name AS product_name,
            l.id AS lead_id, l.name, l.phone, l.stage, l.assigned_to, u.full_name AS assigned_to_name
       FROM installments i
       JOIN deals d ON d.id = i.deal_id AND d.status = 'active'
       JOIN products pr ON pr.id = d.product_id
       JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
       LEFT JOIN users u ON u.id = l.assigned_to
       ${LINKED_PAID_JOIN}
       ${UNLINKED_PAID_JOIN}
      WHERE ${where.join(' AND ')}
      ORDER BY i.due_date, i.deal_id, i.seq`
  ).all(...params);
  applyInstallmentDues(rows);
  return rows.filter((r) => r.due_paise > 0);
}
