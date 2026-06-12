import { Router } from 'express';
import db, { setSetting } from '../db.js';
import { requireAdmin, canAccessLead } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { changeStage } from '../lib/leadStage.js';
import { aiStatus, runAiQueueOnce } from '../lib/ai.js';

const router = Router();

router.get('/status', (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) n FROM recordings WHERE ai_status = 'pending'").get().n;
  const processing = db.prepare("SELECT COUNT(*) n FROM recordings WHERE ai_status = 'processing'").get().n;
  res.json({ ...aiStatus(), queue: { pending, processing } });
});

router.put('/settings', requireAdmin, (req, res) => {
  if (req.body.enabled !== undefined) setSetting('ai_enabled', !!req.body.enabled);
  if (req.body.language !== undefined) setSetting('ai_language', String(req.body.language));
  if (req.body.enabled) runAiQueueOnce().catch(() => {});
  res.json({ ok: true });
});

// Suggestions for a lead (for the lead detail page) or all pending (review).
router.get('/suggestions', (req, res) => {
  const where = ["s.status = 'pending'"];
  const params = [];
  if (req.query.lead_id) { where.push('s.lead_id = ?'); params.push(Number(req.query.lead_id)); }
  if (req.user.role === 'caller') { where.push('l.assigned_to = ?'); params.push(req.user.id); }
  const rows = db.prepare(
    `SELECT s.*, r.summary FROM ai_suggestions s
     LEFT JOIN leads l ON l.id = s.lead_id
     LEFT JOIN recordings r ON r.id = s.recording_id
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`
  ).all(...params);
  res.json(rows);
});

function loadSuggestion(req, res) {
  const s = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(req.params.id);
  if (!s || s.status !== 'pending') { res.status(404).json({ error: 'Not found' }); return null; }
  const lead = s.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(s.lead_id) : null;
  if (lead && !canAccessLead(req.user, lead)) { res.status(403).json({ error: 'Not your lead' }); return null; }
  return { s, lead };
}

// Accept = apply the change AND mark accepted, atomically.
router.post('/suggestions/:id/accept', (req, res) => {
  const ctx = loadSuggestion(req, res);
  if (!ctx) return;
  const { s, lead } = ctx;
  if (!lead) return res.status(400).json({ error: 'Suggestion has no lead' });

  db.transaction(() => {
    if (s.kind === 'field') {
      if (s.field === 'notes') {
        const merged = lead.notes ? `${lead.notes}\n${s.value}` : s.value;
        db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').run(merged, nowUtc(), lead.id);
      } else if (['city', 'email'].includes(s.field)) {
        db.prepare(`UPDATE leads SET ${s.field} = ?, updated_at = ? WHERE id = ?`).run(s.value, nowUtc(), lead.id);
      }
    } else if (s.kind === 'follow_up') {
      // field = IST date; schedule at 11:00 IST → UTC instant.
      const [y, m, d] = s.field.split('-').map(Number);
      const dueAt = new Date(Date.UTC(y, m - 1, d, 11, 0) - 330 * 60000).toISOString();
      // One pending follow-up per lead: replace any existing.
      db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'").run(lead.id);
      db.prepare(
        `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(lead.id, lead.assigned_to || req.user.id, dueAt, s.value, nowUtc());
      if (!['won', 'lost'].includes(lead.stage)) changeStage(lead.id, lead.stage, 'follow_up', req.user.id);
    } else if (s.kind === 'task') {
      // field = IST due date, value = task title.
      db.prepare(
        `INSERT INTO tasks (title, lead_id, assigned_to, due_date, source, created_by, created_at)
         VALUES (?, ?, ?, ?, 'ai', ?, ?)`
      ).run(s.value, lead.id, lead.assigned_to || req.user.id, s.field, req.user.id, nowUtc());
    }
    db.prepare("UPDATE ai_suggestions SET status = 'accepted', acted_by = ?, acted_at = ? WHERE id = ?")
      .run(req.user.id, nowUtc(), s.id);
  })();
  res.json({ ok: true });
});

router.post('/suggestions/:id/dismiss', (req, res) => {
  const ctx = loadSuggestion(req, res);
  if (!ctx) return;
  db.prepare("UPDATE ai_suggestions SET status = 'dismissed', acted_by = ?, acted_at = ? WHERE id = ?")
    .run(req.user.id, nowUtc(), ctx.s.id);
  res.json({ ok: true });
});

export default router;
