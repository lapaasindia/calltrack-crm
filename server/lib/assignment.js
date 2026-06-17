// Lead auto-assignment — decides the owner of a lead an admin-tier user creates
// without naming one. Three strategies, in priority order:
//   1. RULE        — an exact lead_routing_rules.subject match on the lead's
//                    subject (then, as a fallback, its source) with a still-active
//                    assignee.
//   2. ROUND_ROBIN — rotate through active agent/caller users; the cursor is the
//                    id of the LAST user handed a lead, persisted in settings
//                    ('rr_cursor') so rotation survives restarts.
//   3. FALLBACK     — the oldest active admin-tier user (so a lead is never
//                    left orphaned when there are no agents/callers).
//
// getAutoAssignedOwner is DB-only (no clock/network) and never throws: when it
// genuinely cannot find anyone it returns { userId: null, method:'FALLBACK' }.

import { getSetting, setSetting } from '../db.js';
import { isAdmin } from './permissions.js';

const RR_ROLES = ['agent', 'caller'];

// Normalize a free-text subject/source for matching: trimmed, case-folded.
function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Find a routing rule whose subject matches `value` (case-insensitive), whose
// assignee is set and still active. Returns the assignee id, or null.
function ruleMatch(db, value) {
  const v = norm(value);
  if (!v) return null;
  const rule = db.prepare(
    `SELECT r.assigned_to AS uid
       FROM lead_routing_rules r
       JOIN users u ON u.id = r.assigned_to
      WHERE lower(trim(r.subject)) = ? AND u.is_active = 1`
  ).get(v);
  return rule ? rule.uid : null;
}

export function getAutoAssignedOwner(db, lead = {}) {
  // 1) Rule match — subject first, then source as a softer fallback.
  const bySubject = ruleMatch(db, lead.subject);
  if (bySubject) {
    return { userId: bySubject, method: 'RULE', reason: `Subject rule → "${String(lead.subject).trim()}"` };
  }
  const bySource = ruleMatch(db, lead.source);
  if (bySource) {
    return { userId: bySource, method: 'RULE', reason: `Source rule → "${String(lead.source).trim()}"` };
  }

  // 2) Round-robin among active agents/callers, ordered by id (stable). Pick the
  //    first user whose id is strictly greater than the cursor; wrap to the
  //    smallest id when the cursor is at/after the end.
  const pool = db.prepare(
    `SELECT id FROM users
      WHERE is_active = 1 AND role IN (${RR_ROLES.map(() => '?').join(',')})
      ORDER BY id`
  ).all(...RR_ROLES).map((r) => r.id);
  if (pool.length) {
    const cursor = Number(getSetting('rr_cursor', 0)) || 0;
    const next = pool.find((id) => id > cursor) ?? pool[0];
    setSetting('rr_cursor', next);
    return { userId: next, method: 'ROUND_ROBIN', reason: 'Round-robin (agents/callers)' };
  }

  // 3) Fallback — the oldest active admin-tier user. We can't express the
  //    isAdmin() tier purely in SQL (legacy 'admin' + the named tiers), so load
  //    active users oldest-first and take the first admin-tier one.
  const actives = db.prepare(
    'SELECT id, role FROM users WHERE is_active = 1 ORDER BY created_at, id'
  ).all();
  const owner = actives.find((u) => isAdmin(u.role));
  return {
    userId: owner ? owner.id : null,
    method: 'FALLBACK',
    reason: owner ? 'Fallback to oldest active admin' : 'No eligible assignee',
  };
}
