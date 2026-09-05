// Operability surface (audit SCALE-8/17, SEC-8, DESK-22):
//   * opsHealth()            — the owner-only GET /api/ops/health payload
//   * eventLoopLag()         — perf_hooks.monitorEventLoopDelay sampled since last read
//   * installProcessGuards() — process-level policy: log unhandled rejections /
//                              uncaught exceptions and KEEP SERVING, except for
//                              truly fatal states (DB closed/corrupt, OOM) where
//                              the caller's onFatal runs a graceful exit.
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import db, { DATA_DIR, DB_PATH, dbHealth, getSetting } from '../db.js';
import { activeJobs } from './jobs.js';
import { transcodeStatus } from './transcode.js';
import { cacheStats } from './cache.js';
import { log } from './logger.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const nsToMs = (ns) => Math.round((Number(ns) || 0) / 1e4) / 100;

// {p50, p99, max} in ms. reset:true starts a fresh window (what /ops/health
// does, so each poll reports the lag since the previous poll).
export function eventLoopLag({ reset = false } = {}) {
  const out = {
    p50: nsToMs(loopDelay.percentile(50)),
    p99: nsToMs(loopDelay.percentile(99)),
    max: nsToMs(loopDelay.max),
  };
  if (reset) loopDelay.reset();
  return out;
}

export function freeDiskGb(dir = DATA_DIR) {
  try {
    const s = fs.statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / 1e7) / 100;
  } catch {
    return null;
  }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export function opsHealth({ version } = {}) {
  let ai = { pending: 0, processing: 0 };
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(ai_status = 'pending'), 0) AS pending, COALESCE(SUM(ai_status = 'processing'), 0) AS processing FROM recordings"
    ).get();
    ai = { pending: row.pending, processing: row.processing };
  } catch { /* recordings table missing only on a broken DB; report zeros */ }
  const lag = eventLoopLag({ reset: true });
  const mem = process.memoryUsage();
  return {
    version: version ?? null,
    uptime_s: Math.round(process.uptime()),
    db_quick_check: dbHealth.quick_check,
    db_quick_check_at: dbHealth.quick_check_at,
    db_schema_version: dbHealth.user_version,
    wal_bytes: fileSize(`${DB_PATH}-wal`),
    db_bytes: fileSize(DB_PATH),
    last_backup: getSetting('last_backup', null),
    last_cloud_backup: getSetting('last_cloud_backup', null),
    last_maintenance: getSetting('last_maintenance', null),
    ai_queue: ai,
    transcode: transcodeStatus(),
    cache: cacheStats(),
    event_loop_lag_ms: lag.p99,
    event_loop_lag: lag,
    free_disk_gb: freeDiskGb(),
    memory_rss_mb: Math.round(mem.rss / 1e5) / 10,
    jobs: activeJobs(),
  };
}

// Errors after which the process cannot usefully keep serving.
export function isFatalError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (/^SQLITE_(CORRUPT|NOTADB|IOERR|FULL|CANTOPEN|READONLY)/.test(code)) return true;
  if (/database connection is not open|database is closed|The database connection is not open/i.test(msg)) return true;
  if (code === 'ERR_OUT_OF_MEMORY' || /heap out of memory/i.test(msg)) return true;
  return err?.fatal === true;
}

// The two handlers, built separately so they can be unit-tested without
// emitting real process events (node:test owns those).
export function processGuardHandlers({ logger = log, onFatal } = {}) {
  return {
    onUnhandledRejection(reason) {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      logger.error({ err }, 'unhandledRejection (kept serving)');
      if (isFatalError(err) && onFatal) onFatal(err);
    },
    onUncaughtException(err, origin) {
      if (isFatalError(err)) {
        logger.fatal({ err, origin }, 'uncaughtException — fatal state, shutting down');
        if (onFatal) onFatal(err);
        else process.exit(1);
        return;
      }
      // A bug in one request/timer must not take the whole office down: log
      // with the stack and keep the server up (SEC-8). The offending request
      // already got no response or a 500; the next one is served normally.
      logger.error({ err, origin }, 'uncaughtException (kept serving)');
    },
  };
}

let guardsInstalled = false;
export function installProcessGuards(opts = {}) {
  if (guardsInstalled) return false;
  guardsInstalled = true;
  const h = processGuardHandlers(opts);
  process.on('unhandledRejection', h.onUnhandledRejection);
  process.on('uncaughtException', h.onUncaughtException);
  return true;
}

export function _resetGuardsForTests() {
  guardsInstalled = false;
}
