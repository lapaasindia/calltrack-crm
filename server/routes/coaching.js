// Coaching report card + daily learning journal.
//   GET  /api/coaching/daily       — one agent's report card for a day.
//   GET  /api/coaching/leaderboard — team avg-rating ranking (admin tier).
//   POST /api/coaching/learnings   — log a daily learning check-in.
//   GET  /api/coaching/learnings   — list learnings (own; admin can scope any).
// Access: an agent/caller may only read their OWN data; admin tier (manager+)
// may read anyone's.
import { Router } from 'express';
import db from '../db.js';
import { isAdmin } from '../lib/permissions.js';
import { nowUtc, todayIst, istRangeBounds, addDays } from '../lib/istTime.js';
import { getDailyCoaching, gradeFor } from '../lib/coaching.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Resolve the target user_id, enforcing self-only for non-admins. Returns the
// id, or sends a 403 and returns null.
function resolveTargetUser(req, res, raw) {
  const requested = raw !== undefined && raw !== '' ? Number(raw) : req.user.id;
  if (!Number.isInteger(requested) || requested <= 0) {
    res.status(400).json({ error: 'Invalid user_id' });
    return null;
  }
  if (requested !== req.user.id && !isAdmin(req.user.role)) {
    res.status(403).json({ error: 'You can only view your own coaching' });
    return null;
  }
  return requested;
}

router.get('/daily', (req, res) => {
  const userId = resolveTargetUser(req, res, req.query.user_id);
  if (userId === null) return;
  const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayIst();
  const user = db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const card = getDailyCoaching(db, userId, date);
  res.json({ ...card, user_name: user.full_name });
});

// Team leaderboard: each active agent/caller's avg overall rating over the last
// `days` (default 7) ending at `date`, sorted best-first. Admin tier only.
router.get('/leaderboard', (req, res) => {
  if (!isAdmin(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayIst();
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  // Keep all IST day math in istTime.js rather than duplicating raw UTC
  // arithmetic here.
  const fromDate = addDays(date, -(days - 1));

  const members = db.prepare(
    "SELECT id, full_name, role FROM users WHERE is_active = 1 AND role IN ('agent','caller') ORDER BY id"
  ).all();
  const board = members.map((m) => {
    const card = getDailyCoachingRange(db, m.id, fromDate, date);
    return {
      user_id: m.id,
      user_name: m.full_name,
      avgRating: card.avgRating,
      grade: gradeFor(card.avgRating),
      analyzedCalls: card.analyzedCalls,
      callsTotal: card.callsTotal,
    };
  }).sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1));
  res.json({ from: fromDate, to: date, leaderboard: board });
});

// Lightweight range aggregate for the leaderboard (avg overall rating over a
// span). Reuses the same recordings→calls attribution as getDailyCoaching.
function getDailyCoachingRange(db2, userId, fromDate, toDate) {
  const { startUtc, endUtc } = istRangeBounds(fromDate, toDate);
  const rows = db2.prepare(
    `SELECT r.ai_json FROM recordings r JOIN calls c ON c.id = r.call_id
      WHERE c.user_id = ? AND r.ai_json IS NOT NULL AND c.called_at >= ? AND c.called_at < ?`
  ).all(userId, startUtc, endUtc);
  const vals = [];
  for (const row of rows) {
    let ai = null;
    try { ai = JSON.parse(row.ai_json); } catch { ai = null; }
    const v = Number(ai && ai.rating && ai.rating.overall);
    if (Number.isFinite(v)) vals.push(Math.max(0, Math.min(10, v)));
  }
  const callsTotal = db2.prepare(
    'SELECT COUNT(*) AS n FROM calls WHERE user_id = ? AND called_at >= ? AND called_at < ?'
  ).get(userId, startUtc, endUtc).n;
  const avgRating = vals.length
    ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10
    : null;
  return { avgRating, analyzedCalls: vals.length, callsTotal };
}

// Log a daily learning check-in for the current user.
router.post('/learnings', (req, res) => {
  const learning = String(req.body.learning || '').trim();
  if (!learning) return res.status(400).json({ error: 'A learning is required' });
  const win = req.body.win ? String(req.body.win).trim() : null;
  const challenge = req.body.challenge ? String(req.body.challenge).trim() : null;
  const entryDate = DATE_RE.test(req.body.entry_date || '') ? req.body.entry_date : todayIst();

  const info = db.prepare(
    `INSERT INTO daily_learnings (user_id, entry_date, source, learning, win, challenge, created_at)
     VALUES (?, ?, 'daily_check_in', ?, ?, ?, ?)`
  ).run(req.user.id, entryDate, learning, win, challenge, nowUtc());
  res.json({ id: info.lastInsertRowid });
});

router.get('/learnings', (req, res) => {
  const userId = resolveTargetUser(req, res, req.query.user_id);
  if (userId === null) return;
  const where = ['user_id = ?'];
  const params = [userId];
  if (DATE_RE.test(req.query.from || '')) { where.push('entry_date >= ?'); params.push(req.query.from); }
  if (DATE_RE.test(req.query.to || '')) { where.push('entry_date <= ?'); params.push(req.query.to); }
  const rows = db.prepare(
    `SELECT dl.*, d.lead_id AS deal_lead_id
       FROM daily_learnings dl
       LEFT JOIN deals d ON d.id = dl.deal_id
      WHERE ${where.join(' AND ')}
      ORDER BY entry_date DESC, id DESC
      LIMIT 200`
  ).all(...params);
  res.json(rows);
});

export default router;
