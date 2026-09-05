// Nightly maintenance (audit SCALE-6/10/25 + SCALE-14 integrity):
//   1. recomputeLeadScores  — the stored lead score has a recency component
//                             that only changed when an event fired, so a lead
//                             that was Hot after yesterday's call stayed Hot
//                             forever. One aggregate pass over calls + 5k-row
//                             UPDATE transactions, yielding to the event loop
//                             between chunks. Also gives imported/manual leads
//                             (score NULL) their initial score.
//   2. sweepStaleFollowups  — cancels pending follow-ups on LOST or deleted
//                             leads and follow-ups/tasks assigned to
//                             deactivated users, recording why in
//                             cancel_reason. Merely OLD follow-ups are never
//                             touched: "overdue never silently disappears" is
//                             a product promise.
//   3. pruneOldRows         — notifications older than 180 days, audit rows
//                             older than 365 days, deleted in 5k-row chunks.
//   4. runQuickCheck        — re-run the integrity check so a bit-rotted page
//                             is noticed within a day, not on restore day.
//
// Runs once per IST day after 02:00, or shortly after boot when the last run
// is older than 24 h (or never happened). Tracked in settings.last_maintenance.
import db, { getSetting, setSetting, runQuickCheck } from '../db.js';
import { nowUtc, todayIst } from './istTime.js';
import { calculateLeadScoreFromSignals } from './scoring.js';
import { runJob, isShuttingDown } from './jobs.js';
import { log } from './logger.js';

const mlog = log.child({ mod: 'maintenance' });
const CHUNK = 5000;
const NOTIFICATION_KEEP_DAYS = 180;
const AUDIT_KEEP_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export async function recomputeLeadScores(dbh = db, { chunk = CHUNK, now = nowUtc() } = {}) {
  // One aggregate pass over calls → per-lead engagement signals, with exactly
  // calculateLeadScore's semantics: engagement counts phone calls only
  // (WhatsApp mirror rows skipped); recency uses the latest CONNECTED row of
  // any source (QA-11: failed dials never warm a lead).
  const signals = new Map();
  const agg = dbh.prepare(
    `SELECT lead_id,
            SUM(source != 'whatsapp' AND disposition = 'connected') AS connected,
            SUM(source != 'whatsapp' AND disposition != 'connected') AS attempts,
            MAX(CASE WHEN disposition = 'connected' THEN called_at END) AS last_connected_at
       FROM calls GROUP BY lead_id`
  );
  for (const r of agg.iterate()) signals.set(r.lead_id, r);

  const page = dbh.prepare(
    `SELECT id, source, stage, extra_json, score, score_factors
       FROM leads WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?`
  );
  const update = dbh.prepare('UPDATE leads SET score = ?, score_factors = ? WHERE id = ?');
  const applyChunk = dbh.transaction((leads) => {
    let n = 0;
    for (const l of leads) {
      const s = signals.get(l.id) || null;
      const { score, factors } = calculateLeadScoreFromSignals(l, s, now);
      // Only write when the score actually moved (or was never computed): the
      // days_since_last_call factor ticks daily for every lead and rewriting
      // 50k rows a night for that alone would be pointless WAL churn.
      if (l.score !== score || l.score_factors == null) {
        update.run(score, JSON.stringify(factors), l.id);
        n += 1;
      }
    }
    return n;
  });

  let lastId = 0;
  let scanned = 0;
  let updated = 0;
  for (;;) {
    const leads = page.all(lastId, chunk);
    if (!leads.length) break;
    updated += applyChunk(leads);
    scanned += leads.length;
    lastId = leads[leads.length - 1].id;
    if (leads.length < chunk || isShuttingDown()) break;
    await yieldToLoop();
  }
  return { scanned, updated };
}

export function sweepStaleFollowups(dbh = db) {
  return dbh.transaction(() => {
    const fuLost = dbh.prepare(
      `UPDATE follow_ups SET status = 'cancelled', cancel_reason = 'lead_lost'
        WHERE status = 'pending'
          AND lead_id IN (SELECT id FROM leads WHERE stage = 'lost')`
    ).run().changes;
    const fuDeleted = dbh.prepare(
      `UPDATE follow_ups SET status = 'cancelled', cancel_reason = 'lead_deleted'
        WHERE status = 'pending'
          AND lead_id IN (SELECT id FROM leads WHERE deleted_at IS NOT NULL)`
    ).run().changes;
    const fuInactive = dbh.prepare(
      `UPDATE follow_ups SET status = 'cancelled', cancel_reason = 'assignee_deactivated'
        WHERE status = 'pending'
          AND assigned_to IN (SELECT id FROM users WHERE is_active = 0)`
    ).run().changes;
    const tasksInactive = dbh.prepare(
      `UPDATE tasks SET status = 'cancelled', board_status = 'Drop', cancel_reason = 'assignee_deactivated'
        WHERE status = 'pending'
          AND assigned_to IN (SELECT id FROM users WHERE is_active = 0)`
    ).run().changes;
    return {
      followups_lead_lost: fuLost,
      followups_lead_deleted: fuDeleted,
      followups_assignee_deactivated: fuInactive,
      tasks_assignee_deactivated: tasksInactive,
    };
  })();
}

function deleteInChunks(dbh, table, cutoff, chunk = CHUNK) {
  const stmt = dbh.prepare(
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE created_at < ? ORDER BY id LIMIT ?)`
  );
  let total = 0;
  for (;;) {
    const n = stmt.run(cutoff, chunk).changes;
    total += n;
    if (n < chunk) break;
  }
  return total;
}

export function pruneOldRows(dbh = db, { now = Date.now() } = {}) {
  const notifCutoff = new Date(now - NOTIFICATION_KEEP_DAYS * DAY_MS).toISOString();
  const auditCutoff = new Date(now - AUDIT_KEEP_DAYS * DAY_MS).toISOString();
  return {
    notifications: deleteInChunks(dbh, 'notifications', notifCutoff),
    audit_logs: deleteInChunks(dbh, 'audit_logs', auditCutoff),
  };
}

export async function runNightlyMaintenance({ reason = 'scheduled' } = {}) {
  return runJob('maintenance', async () => {
    const t0 = Date.now();
    const out = { reason };
    out.scores = await recomputeLeadScores();
    out.sweep = sweepStaleFollowups();
    out.pruned = pruneOldRows();
    out.quick_check = runQuickCheck();
    const result = { at: nowUtc(), date: todayIst(), ms: Date.now() - t0, ...out };
    setSetting('last_maintenance', result);
    mlog.info(result, 'nightly maintenance done');
    return result;
  });
}

// Should a tick run maintenance now? Exported for tests.
export function maintenanceDue(last, now = new Date()) {
  if (!last || !last.at) return true;
  const age = now.getTime() - Date.parse(last.at);
  if (!Number.isFinite(age) || age > DAY_MS) return true;
  const istHour = new Date(now.getTime() + 330 * 60 * 1000).getUTCHours();
  return istHour >= 2 && last.date !== todayIst(now);
}

export function startMaintenanceJob() {
  const tick = () => {
    if (isShuttingDown()) return;
    try {
      if (!maintenanceDue(getSetting('last_maintenance', null))) return;
      runNightlyMaintenance().catch((err) => mlog.error({ err }, 'nightly maintenance failed'));
    } catch (err) {
      mlog.error({ err }, 'maintenance tick failed');
    }
  };
  setTimeout(tick, 2 * 60 * 1000).unref(); // shortly after boot (once the backup tick is done)
  setInterval(tick, 15 * 60 * 1000).unref();
}
