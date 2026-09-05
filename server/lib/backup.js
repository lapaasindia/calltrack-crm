// Daily safe backup of the business database. WAL means a naive file copy can
// tear; SQLite's online backup API (better-sqlite3 `db.backup()`) copies pages
// in small steps on a worker thread, so the server keeps serving while the
// snapshot is taken (audit SCALE-4: `VACUUM INTO` blocked the event loop
// ~2.4 ms per MB — 5 s for a 2 GB database, twice a day once cloud backup
// ran it again).
//
// The copy is written to `crm-<date>.sqlite.tmp`, verified (quick_check) and
// only then renamed into place, so a crash or SIGTERM mid-copy can never leave
// a torn file under the real name — and the cloud backup, which picks the
// newest `crm-*.sqlite`, can never ship one off-site (SCALE-8/14).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import db, { DATA_DIR, getSetting, setSetting } from '../db.js';
import { todayIst, nowUtc } from './istTime.js';
import { runJob, isShuttingDown } from './jobs.js';
import { log } from './logger.js';

export const BACKUP_DIR = process.env.CRM_BACKUP_DIR || path.join(DATA_DIR, '..', 'backups');
const KEEP = 30;
// quick_check is synchronous; bound its cost on very large snapshots.
const QUICK_CHECK_MAX_BYTES = 256 * 1024 * 1024;
const blog = log.child({ mod: 'backup' });

// Open the snapshot on its own and prove it is a consistent SQLite database
// before it may carry the real backup name. Also switches the copy to a
// self-contained rollback journal so the backup is exactly one file.
export function verifyBackupFile(file) {
  const bytes = fs.statSync(file).size;
  const copy = new Database(file, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    if (bytes <= QUICK_CHECK_MAX_BYTES) {
      const r = copy.pragma('quick_check', { simple: true });
      if (r !== 'ok') throw new Error(`backup failed quick_check: ${r}`);
    } else {
      copy.pragma('page_count', { simple: true }); // header sanity only
    }
    return { bytes, user_version: copy.pragma('user_version', { simple: true }) };
  } finally {
    copy.close();
  }
}

async function doBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const date = todayIst();
  const file = path.join(BACKUP_DIR, `crm-${date}.sqlite`);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  const t0 = Date.now();
  let info;
  try {
    await db.backup(tmp);
    info = verifyBackupFile(tmp);
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const ms = Date.now() - t0;
  setSetting('last_backup', { date, at: nowUtc(), file, bytes: info.bytes, ms });
  blog.info({ file, bytes: info.bytes, ms }, 'backup written');

  // Retention: keep the newest KEEP dated backups; sweep any stale .tmp too.
  const entries = fs.readdirSync(BACKUP_DIR);
  const backups = entries
    .filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(KEEP)) {
    fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
  }
  for (const stale of entries.filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.sqlite\.tmp$/.test(f) && f !== path.basename(tmp))) {
    fs.rmSync(path.join(BACKUP_DIR, stale), { force: true });
  }
  return file;
}

// Take today's snapshot. ASYNC (resolves with the file path). Concurrent
// callers (scheduler tick + "Backup now") share one in-flight run, and the run
// is a tracked job so graceful shutdown waits for it.
let inFlight = null;
export function runBackup() {
  if (inFlight) return inFlight;
  inFlight = runJob('backup', doBackup).finally(() => { inFlight = null; });
  return inFlight;
}

// Check every 30 minutes whether today's backup exists yet; run it if not.
export function startBackupScheduler() {
  const tick = () => {
    if (isShuttingDown()) return;
    try {
      const last = getSetting('last_backup', null);
      if (!last || last.date !== todayIst()) {
        runBackup().catch((err) => blog.error({ err }, 'backup failed'));
      }
    } catch (err) {
      blog.error({ err }, 'backup tick failed');
    }
  };
  setTimeout(tick, 30 * 1000).unref(); // first check shortly after boot
  setInterval(tick, 30 * 60 * 1000).unref();
}
