// Phase 4B — scheduling conflict detection. Pure/DB-only: given an owner and a
// candidate [startAt, endAt) UTC window, find everything already scheduled for
// that same owner that overlaps it.
//
// Two kinds of scheduled things collide:
//   - time_blocks owned by the user (one block = one owner_id), and
//   - tasks ASSIGNED to the user that carry a full scheduled window
//     (scheduled_start_at AND scheduled_end_at) and aren't Done/Drop.
//
// Overlap is half-open: [s1,e1) overlaps [s2,e2)  ⇔  s1 < e2 AND s2 < e1.
// Touching edges (one ends exactly when the next begins) do NOT conflict.
//
// "Same IST day only": we only compare against rows on the candidate's IST
// block date. An all-day item (block_type 'Out of Office', or a window that
// spans the whole IST day) is treated as covering the entire day, so anything
// on that day conflicts with it.
import { istDateOf, istDayBounds } from './istTime.js';

// True when half-open [aStart,aEnd) and [bStart,bEnd) overlap. Inputs are UTC
// ISO strings (or anything Date.parse understands).
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const a0 = Date.parse(aStart);
  const a1 = Date.parse(aEnd);
  const b0 = Date.parse(bStart);
  const b1 = Date.parse(bEnd);
  if ([a0, a1, b0, b1].some(Number.isNaN)) return false;
  return a0 < b1 && b0 < a1;
}

// Does a stored row count as "all-day" (covers the whole IST day)? Either an
// explicit Out-of-Office block, or a window that already spans >= the full day.
function coversWholeDay(startAt, endAt, dayStartUtc, dayEndUtc) {
  return Date.parse(startAt) <= Date.parse(dayStartUtc)
    && Date.parse(endAt) >= Date.parse(dayEndUtc);
}

// detectConflicts(db, opts) → array of conflict descriptors:
//   { kind: 'time_block'|'task', id, title, start_at, end_at }
// opts: { ownerId, startAt, endAt, excludeBlockId?, excludeTaskId? }
//
// Same owner, same IST day, overlapping half-open intervals. The candidate's
// own row (when editing) is excluded via excludeBlockId / excludeTaskId.
export function detectConflicts(db, {
  ownerId, startAt, endAt, excludeBlockId = null, excludeTaskId = null,
} = {}) {
  const conflicts = [];
  if (ownerId == null || !startAt || !endAt) return conflicts;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end) || !(start < end)) return conflicts;

  const day = istDateOf(startAt);
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = istDayBounds(day);
  const candidateAllDay = coversWholeDay(startAt, endAt, dayStartUtc, dayEndUtc);

  // ---- time_blocks (same owner, window overlapping the candidate's IST day) ----
  // Bound by window-overlap against [dayStartUtc, dayEndUtc) rather than by
  // block_date equality, so a block spanning IST midnight (filed under its start
  // day only) is still seen by a candidate on the following day. The exact hit
  // is still decided per-row below by intervalsOverlap()/coversWholeDay().
  const blocks = db.prepare(
    `SELECT id, title, start_at, end_at, block_type
       FROM time_blocks
      WHERE owner_id = ? AND start_at < ? AND end_at > ?`
  ).all(ownerId, dayEndUtc, dayStartUtc);
  for (const b of blocks) {
    if (excludeBlockId != null && b.id === excludeBlockId) continue;
    const blockAllDay = b.block_type === 'Out of Office'
      || coversWholeDay(b.start_at, b.end_at, dayStartUtc, dayEndUtc);
    const hit = candidateAllDay || blockAllDay
      ? true
      : intervalsOverlap(startAt, endAt, b.start_at, b.end_at);
    if (hit) {
      conflicts.push({
        kind: 'time_block', id: b.id, title: b.title,
        start_at: b.start_at, end_at: b.end_at,
      });
    }
  }

  // ---- scheduled tasks (assigned to owner, active, full window) ----
  // Pre-filter to any task whose [start,end) window INTERSECTS the candidate's
  // IST day [dayStartUtc, dayEndUtc), not just tasks that START inside it. A
  // task spanning IST midnight (e.g. 23:30→00:30) must be considered for a
  // candidate on either adjacent day, so we bound by window-overlap. The exact
  // hit is still decided per-row by intervalsOverlap() against the candidate.
  const tasks = db.prepare(
    `SELECT id, title, scheduled_start_at AS start_at, scheduled_end_at AS end_at
       FROM tasks
      WHERE assigned_to = ?
        AND scheduled_start_at IS NOT NULL
        AND scheduled_end_at IS NOT NULL
        AND board_status NOT IN ('Done','Drop')
        AND scheduled_start_at < ? AND scheduled_end_at > ?`
  ).all(ownerId, dayEndUtc, dayStartUtc);
  for (const t of tasks) {
    if (excludeTaskId != null && t.id === excludeTaskId) continue;
    const taskAllDay = coversWholeDay(t.start_at, t.end_at, dayStartUtc, dayEndUtc);
    const hit = candidateAllDay || taskAllDay
      ? true
      : intervalsOverlap(startAt, endAt, t.start_at, t.end_at);
    if (hit) {
      conflicts.push({
        kind: 'task', id: t.id, title: t.title,
        start_at: t.start_at, end_at: t.end_at,
      });
    }
  }

  return conflicts;
}

// Build a one-line, human-readable 409 message from a conflict list.
export function conflictMessage(conflicts) {
  if (!conflicts || conflicts.length === 0) return 'Scheduling conflict';
  const first = conflicts[0];
  const what = first.kind === 'task' ? 'task' : 'time block';
  const more = conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : '';
  return `Conflicts with ${what} "${first.title}"${more} on the same day`;
}
