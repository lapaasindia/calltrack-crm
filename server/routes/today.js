import { Router } from 'express';
import db from '../db.js';
import { todayIst, istDayBounds } from '../lib/istTime.js';

const router = Router();

// The Today queue: pending follow-ups due (or overdue — they never vanish)
// + installments due/overdue, merged. NEVER filtered by lead stage: payment
// and support follow-ups on won leads must appear.
router.get('/', (req, res) => {
  const today = todayIst();
  const { startUtc, endUtc } = istDayBounds(today);

  // Whose queue? Callers get their own; admin can view anyone's or everyone's.
  let userFilter = req.user.id;
  if (req.user.role === 'admin') {
    userFilter = req.query.user_id === 'all' ? null : Number(req.query.user_id) || req.user.id;
  }

  const fuParams = [endUtc];
  let fuUserClause = '';
  if (userFilter) { fuUserClause = 'AND f.assigned_to = ?'; fuParams.push(userFilter); }
  const followups = db.prepare(
    `SELECT f.id AS follow_up_id, f.due_at, f.reason, l.id AS lead_id, l.name, l.phone,
            l.stage, l.city, l.source, u.full_name AS assigned_to_name
     FROM follow_ups f
     JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
     JOIN users u ON u.id = f.assigned_to
     WHERE f.status = 'pending' AND f.due_at < ? ${fuUserClause}
     ORDER BY f.due_at`
  ).all(...fuParams);

  const instParams = [today];
  let instUserClause = '';
  if (userFilter) { instUserClause = 'AND l.assigned_to = ?'; instParams.push(userFilter); }
  const paymentsDue = db.prepare(
    `SELECT i.id AS installment_id, i.due_date, i.seq, i.amount_paise, i.status AS installment_status,
            COALESCE((SELECT SUM(amount_paise) FROM payments p WHERE p.installment_id = i.id), 0) AS paid_paise,
            d.id AS deal_id, d.deal_value_paise, pr.name AS product_name,
            l.id AS lead_id, l.name, l.phone, l.stage, u.full_name AS assigned_to_name
     FROM installments i
     JOIN deals d ON d.id = i.deal_id AND d.status = 'active'
     JOIN products pr ON pr.id = d.product_id
     JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
     LEFT JOIN users u ON u.id = l.assigned_to
     WHERE i.status IN ('pending','partial') AND i.due_date <= ? ${instUserClause}
     ORDER BY i.due_date`
  ).all(...instParams);

  // Tasks due today or overdue.
  const taskParams = [today];
  let taskUserClause = '';
  if (userFilter) { taskUserClause = 'AND t.assigned_to = ?'; taskParams.push(userFilter); }
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.details, t.due_date, t.source,
            l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
            u.full_name AS assigned_to_name
     FROM tasks t
     JOIN users u ON u.id = t.assigned_to
     LEFT JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
     WHERE t.status = 'pending' AND t.due_date <= ? ${taskUserClause}
     ORDER BY t.due_date`
  ).all(...taskParams);

  // My stats today vs targets (for callers and for admin's own view).
  // Auto-logged mobile calls only count as dials when they connected —
  // otherwise unanswered personal redials would inflate targets.
  const statsUser = userFilter || req.user.id;
  const stats = db.prepare(
    `SELECT COUNT(*) AS calls,
            SUM(disposition = 'connected') AS connects,
            COUNT(DISTINCT lead_id) AS unique_leads
     FROM calls WHERE user_id = ? AND called_at >= ? AND called_at < ?
       AND (auto_logged = 0 OR disposition = 'connected')`
  ).get(statsUser, startUtc, endUtc);
  const dealsToday = db.prepare(
    'SELECT COUNT(*) AS n FROM deals WHERE created_by = ? AND won_date = ?'
  ).get(statsUser, today).n;
  const target = db.prepare(
    `SELECT calls_target, connects_target, deals_target FROM targets
     WHERE user_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
  ).get(statsUser, today);

  res.json({
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
  });
});

export default router;
