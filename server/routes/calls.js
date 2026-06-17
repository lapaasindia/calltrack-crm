import { Router } from 'express';
import db from '../db.js';
import { loadLead } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { changeStage } from '../lib/leadStage.js';
import { recalcLeadScore } from '../lib/scoring.js';

const DISPOSITIONS = ['connected', 'not_picked', 'busy', 'switched_off', 'wrong_number'];
export const CALL_TYPES = ['sales', 'follow_up', 'collection', 'support'];
// Outcomes only apply to connected calls, validated per call type.
export const OUTCOMES = {
  sales: ['interested', 'not_interested', 'callback_requested', 'wrong_person'],
  follow_up: ['interested', 'not_interested', 'callback_requested', 'wrong_person'],
  collection: ['payment_promised', 'payment_collected', 'dispute', 'callback_requested'],
  support: ['resolved', 'open', 'escalated'],
};

const router = Router({ mergeParams: true });

// Log a call on a lead. One transaction: insert call → close pending follow-up
// → schedule next follow-up → apply automatic stage transitions.
router.post('/', loadLead, (req, res) => {
  const lead = req.lead;
  const callType = CALL_TYPES.includes(req.body.call_type) ? req.body.call_type : 'sales';
  const disposition = req.body.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: 'Invalid disposition' });
  }

  let outcome = null;
  if (disposition === 'connected' && req.body.outcome) {
    if (!OUTCOMES[callType].includes(req.body.outcome)) {
      return res.status(400).json({ error: `Invalid outcome for ${callType} call` });
    }
    outcome = req.body.outcome;
  }

  let nextFollowUp = null;
  if (req.body.next_follow_up_at) {
    const t = Date.parse(req.body.next_follow_up_at);
    if (Number.isNaN(t)) return res.status(400).json({ error: 'Invalid follow-up date' });
    nextFollowUp = new Date(t).toISOString();
  }

  const duration = req.body.duration_seconds != null
    ? Math.max(0, parseInt(req.body.duration_seconds, 10) || 0) : null;
  const now = nowUtc();

  const result = db.transaction(() => {
    const callInfo = db.prepare(
      `INSERT INTO calls (lead_id, user_id, call_type, disposition, outcome, notes, duration_seconds, called_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(lead.id, req.user.id, callType, disposition, outcome, req.body.notes || null, duration, now);
    const callId = callInfo.lastInsertRowid;

    // This call fulfills any pending follow-up on the lead.
    db.prepare(
      `UPDATE follow_ups SET status = 'done', completed_by_call_id = ?, completed_at = ?
       WHERE lead_id = ? AND status = 'pending'`
    ).run(callId, now, lead.id);

    if (nextFollowUp) {
      db.prepare(
        `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, created_by_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        lead.id,
        lead.assigned_to || req.user.id,
        nextFollowUp,
        req.body.follow_up_reason || (outcome === 'callback_requested' ? 'Callback requested' : 'Follow-up'),
        callId, now
      );
    }

    // Automatic stage transitions (sales pipeline only — won/lost leads keep
    // their stage except an explicit not_interested marks lost).
    let stage = lead.stage;
    const move = (to, reason = null) => { changeStage(lead.id, stage, to, req.user.id, reason); stage = to; };

    if (disposition === 'connected' && stage === 'new') move('contacted');
    if (outcome === 'interested' && ['new', 'contacted', 'follow_up'].includes(stage)) move('interested');
    if (outcome === 'not_interested' && !['won', 'lost'].includes(stage)) move('lost', 'Not interested');
    if (nextFollowUp && ['new', 'contacted'].includes(stage)) move('follow_up');

    // Recompute the rule-based lead score now that engagement/stage changed.
    recalcLeadScore(db, lead.id);

    return { callId, stage };
  })();

  res.json({ ok: true, call_id: result.callId, stage: result.stage });
});

export default router;
