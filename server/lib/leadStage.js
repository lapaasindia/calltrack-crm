import db from '../db.js';
import { nowUtc } from './istTime.js';

export const STAGES = ['new', 'contacted', 'interested', 'follow_up', 'won', 'lost'];

// The only way lead stage may change: records the transition in lead_events
// so funnel/source reports reflect real history, not snapshots.
// Call inside a transaction when combined with other writes.
export function changeStage(leadId, fromStage, toStage, userId, lostReason = null) {
  if (fromStage === toStage) return;
  db.prepare('UPDATE leads SET stage = ?, lost_reason = ?, updated_at = ? WHERE id = ?')
    .run(toStage, toStage === 'lost' ? lostReason : null, nowUtc(), leadId);
  db.prepare(
    'INSERT INTO lead_events (lead_id, from_stage, to_stage, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)'
  ).run(leadId, fromStage, toStage, userId, nowUtc());
}
