import { Router } from 'express';
import db from '../db.js';
import { loadLead } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router({ mergeParams: true });

// Schedule (or reschedule) a follow-up without logging a call.
// One pending follow-up per lead: any existing pending one is replaced.
router.put('/', loadLead, (req, res) => {
  const t = Date.parse(req.body.due_at || '');
  if (Number.isNaN(t)) return res.status(400).json({ error: 'Valid due date required' });
  const dueAt = new Date(t).toISOString();
  const lead = req.lead;

  db.transaction(() => {
    db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'")
      .run(lead.id);
    db.prepare(
      `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(lead.id, lead.assigned_to || req.user.id, dueAt, req.body.reason || 'Follow-up', nowUtc());
  })();
  res.json({ ok: true });
});

router.delete('/', loadLead, (req, res) => {
  db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'")
    .run(req.lead.id);
  res.json({ ok: true });
});

export default router;
