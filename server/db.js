import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');
export const DB_PATH = path.join(DATA_DIR, 'crm.sqlite');

// Single source of truth: the root package.json version (also re-exported by
// app.js for /api/health). Read once at load; recorded against every migration
// this build applies (schema_migrations.app_version).
export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { return '0.0.0'; }
})();

fs.mkdirSync(DATA_DIR, { recursive: true });

// CRM_SQLITE_NATIVE_BINDING (set by the desktop app, DESK-4) points at the
// prebuilt better_sqlite3.node shipped next to the Electron binary, so the
// repo's node_modules binary is never rebuilt for a different runtime.
const db = new Database(DB_PATH, process.env.CRM_SQLITE_NATIVE_BINDING
  ? { nativeBinding: process.env.CRM_SQLITE_NATIVE_BINDING } : {});
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

const dbLog = log.child({ mod: 'db' });

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// ── Migrations ───────────────────────────────────────────────────────────────
// Numbered .sql files applied in order, tracked via PRAGMA user_version (the
// number is the file's numeric prefix). Sorted NUMERICALLY so 100_ sorts after
// 099_ (a plain lexicographic sort only works while prefixes stay 3 digits).
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
export const LATEST_MIGRATION = files.length ? parseInt(files[files.length - 1], 10) : 0;

let version = db.pragma('user_version', { simple: true });

// Refuse to run an OLDER build against a NEWER database (audit SCALE-14): the
// newer schema may have renamed/added columns this code doesn't know, and the
// first query touching one would 500 with an opaque "Server error". A clear
// boot-time refusal beats silent data corruption after a downgrade.
if (version > LATEST_MIGRATION) {
  db.close();
  throw new Error(
    `[db] Refusing to start: ${DB_PATH} is at schema version ${version}, but this build `
    + `(CallTrack CRM v${APP_VERSION}) only knows migrations up to ${LATEST_MIGRATION}. `
    + 'The database was created by a newer release — upgrade the app (or restore the '
    + 'matching version) instead of running an older build against it.'
  );
}

const appliedNow = [];
for (const file of files) {
  const num = parseInt(file, 10);
  if (num <= version) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // A migration whose FIRST line is the directive `-- migrate:no-transaction`
  // runs WITHOUT the wrapping db.transaction(). Some rebuilds (e.g. swapping a
  // table to widen a CHECK) need to toggle `PRAGMA foreign_keys` — which is a
  // silent no-op inside a transaction — so such files manage their own atomicity.
  const noTxn = /^\s*--\s*migrate:no-transaction\b/.test(sql);
  const t0 = Date.now();
  try {
    if (noTxn) {
      db.exec(sql);
      db.pragma(`user_version = ${num}`);
    } else {
      db.transaction(() => {
        db.exec(sql);
        db.pragma(`user_version = ${num}`);
      })();
    }
  } catch (err) {
    // A no-transaction file that failed inside its own BEGIN…COMMIT leaves the
    // transaction open; roll it back so the error is the only thing that
    // escapes, and name the migration in the message the operator sees.
    try { if (db.inTransaction) db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    err.message = `[db] migration ${file} failed: ${err.message}`;
    throw err;
  }
  version = num;
  appliedNow.push(num);
  dbLog.info({ migration: file, ms: Date.now() - t0 }, 'migration applied');
}

// Record which build applied which migration (table created by 017). Versions
// applied before the table existed are backfilled as 'unrecorded' so the
// history is complete from the first boot on this build.
if (tableExists('schema_migrations')) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, app_version, applied_at) VALUES (?, ?, ?)'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const file of files) {
      const num = parseInt(file, 10);
      if (num > version) continue;
      ins.run(num, appliedNow.includes(num) ? APP_VERSION : 'unrecorded', now);
    }
  })();
}

// ── Integrity + planner statistics ───────────────────────────────────────────
// Boot-time health that /api/ops/health reports (audit SCALE-14/17).
export const dbHealth = {
  quick_check: null,
  quick_check_at: null,
  quick_check_ms: null,
  analyzed_at: null,
  migrations_applied: appliedNow,
  latest_migration: LATEST_MIGRATION,
  user_version: version,
};

// PRAGMA quick_check: fast page-level check (no index/content cross-check).
// 'ok' or the first problem found. Loud on failure, never fatal: a report may
// still work and the operator needs the server up to take a backup.
export function runQuickCheck() {
  const t0 = Date.now();
  let result;
  try {
    result = db.pragma('quick_check', { simple: true });
  } catch (err) {
    result = `error: ${err.message}`;
  }
  dbHealth.quick_check = result;
  dbHealth.quick_check_at = new Date().toISOString();
  dbHealth.quick_check_ms = Date.now() - t0;
  if (result !== 'ok') {
    const banner = [
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      `!!  DATABASE INTEGRITY PROBLEM in ${DB_PATH}`,
      `!!  PRAGMA quick_check: ${result}`,
      '!!  Take a backup NOW (Settings → Backup now) and contact support before',
      '!!  continuing to use this database.',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
    ].join('\n');
    console.error(banner);
    dbLog.error({ quick_check: result }, 'database integrity problem');
  }
  return result;
}
runQuickCheck();

// The planner had never been given statistics: with no sqlite_stat1 it chose
// the wrong index for /collections (12 s → 29 ms with ANALYZE alone; SCALE-1).
// Run ANALYZE when stats are missing or a migration (new index) just applied;
// PRAGMA optimize keeps them fresh afterwards.
function stat1Empty() {
  if (!tableExists('sqlite_stat1')) return true;
  return db.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get().n === 0;
}
export function analyze() {
  const t0 = Date.now();
  db.exec('ANALYZE');
  dbHealth.analyzed_at = new Date().toISOString();
  dbLog.info({ ms: Date.now() - t0 }, 'ANALYZE');
}
if (appliedNow.length || stat1Empty()) analyze();

// ── Housekeeping timers (unref'd: never keep a test process alive) ──────────
// PASSIVE WAL checkpoint every 5 minutes: SQLite's auto-checkpoint only completes
// when no reader overlaps, and this process is always reading, so the -wal file
// grew to 300× the DB in production (SCALE-16). PRAGMA optimize daily.
const CHECKPOINT_MS = 5 * 60 * 1000;
const OPTIMIZE_MS = 24 * 60 * 60 * 1000;
const timers = [
  setInterval(() => {
    try { if (db.open) db.pragma('wal_checkpoint(PASSIVE)'); } catch (err) { dbLog.warn({ err }, 'wal_checkpoint failed'); }
  }, CHECKPOINT_MS),
  setInterval(() => {
    try { if (db.open) db.pragma('optimize'); } catch (err) { dbLog.warn({ err }, 'optimize failed'); }
  }, OPTIMIZE_MS),
];
for (const t of timers) t.unref();

// Graceful shutdown (SCALE-8): truncate the WAL, refresh stats, close. Safe to
// call twice. After this every db call throws — only call it from stop().
let closed = false;
export function shutdownDb() {
  for (const t of timers) clearInterval(t);
  if (closed || !db.open) return;
  closed = true;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (err) { dbLog.warn({ err }, 'shutdown checkpoint failed'); }
  try { db.pragma('optimize'); } catch { /* best effort */ }
  try { db.close(); } catch (err) { dbLog.warn({ err }, 'db.close failed'); }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export default db;
