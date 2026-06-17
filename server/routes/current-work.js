// Phase 4B — Current Work: what is the logged-in user working on RIGHT NOW?
//
// Among the user's ACTIVE scheduled items whose window contains "now", return
// the one that ENDS SOONEST (so the widget nudges toward the next handoff).
// Candidates:
//   - scheduled tasks: assignee = self, board_status not Done/Drop, both
//     scheduled_*_at set, scheduled_start_at <= now < scheduled_end_at.
//   - time blocks: owner = self, today's IST date, start_at <= now < end_at.
//   - meetings (Phase 5A): owner or attendee = self, status != Cancelled,
//     start_at <= now < end_at.
import { Router } from 'express';
import db from '../db.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();

// Returns a flat list of {kind,id,title,start_at,end_at,...} active for `now`.
// Kept small + side-effect free so Phase 5 can extend it cleanly.
function collectCandidates(userId, nowIso) {
  const now = nowIso;
  const out = [];

  // Active scheduled tasks (window contains now).
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.board_status, t.priority, t.project_id, t.time_tracked,
            t.scheduled_start_at AS start_at, t.scheduled_end_at AS end_at,
            p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND t.scheduled_start_at IS NOT NULL
        AND t.scheduled_end_at IS NOT NULL
        AND t.board_status NOT IN ('Done','Drop')
        AND t.scheduled_start_at <= ? AND t.scheduled_end_at > ?`
  ).all(userId, now, now);
  for (const t of tasks) {
    out.push({
      kind: 'task', id: t.id, title: t.title, start_at: t.start_at, end_at: t.end_at,
      board_status: t.board_status, priority: t.priority,
      project_id: t.project_id, project_name: t.project_name,
      time_tracked: t.time_tracked, link: `/work/${t.id}`,
    });
  }

  // Active time blocks (window contains now). We deliberately do NOT bound by
  // the start instant's IST day: an overnight / out-of-office block that began
  // before today's IST midnight but is genuinely active now (start_at <= now <
  // end_at) must still surface. The active-now set is small, so the simple
  // owner + window predicate is cheap.
  const blocks = db.prepare(
    `SELECT tb.id, tb.title, tb.start_at, tb.end_at, tb.block_type, tb.linked_task_id,
            t.title AS linked_task_title
       FROM time_blocks tb
       LEFT JOIN tasks t ON t.id = tb.linked_task_id
      WHERE tb.owner_id = ?
        AND tb.start_at <= ? AND tb.end_at > ?`
  ).all(userId, now, now);
  for (const b of blocks) {
    out.push({
      kind: 'time_block', id: b.id, title: b.title, start_at: b.start_at, end_at: b.end_at,
      block_type: b.block_type, linked_task_id: b.linked_task_id,
      linked_task_title: b.linked_task_title,
      link: b.linked_task_id ? `/work/${b.linked_task_id}` : '/calendar',
    });
  }

  // Active meetings (Phase 5A): window contains now, user is owner or attendee,
  // and the meeting isn't Cancelled. attendee_ids is a JSON array, so we filter
  // membership in JS. The active-now set is small, so this is cheap.
  const meetings = db.prepare(
    `SELECT id, title, start_at, end_at, status, owner_id, attendee_ids, location, meeting_url
       FROM meetings
      WHERE status != 'Cancelled'
        AND start_at <= ? AND end_at > ?`
  ).all(now, now);
  for (const m of meetings) {
    let attendees = [];
    try { const v = JSON.parse(m.attendee_ids); if (Array.isArray(v)) attendees = v; } catch { /* ignore */ }
    if (m.owner_id !== userId && !attendees.includes(userId)) continue;
    out.push({
      kind: 'meeting', id: m.id, title: m.title, start_at: m.start_at, end_at: m.end_at,
      status: m.status, location: m.location, meeting_url: m.meeting_url,
      link: `/meetings/${m.id}`,
    });
  }

  return out;
}

// GET /api/current-work → { now, current, active_count }
// current = the active item ending soonest (or null); active_count = how many
// items are currently active (window contains now).
router.get('/', (req, res) => {
  const now = nowUtc();
  const candidates = collectCandidates(req.user.id, now);
  candidates.sort((a, b) => Date.parse(a.end_at) - Date.parse(b.end_at));
  res.json({
    now,
    current: candidates[0] || null,
    active_count: candidates.length,
  });
});

export default router;
