// Daily safe backup of the business database. WAL means a naive file copy can
// tear; VACUUM INTO produces a consistent snapshot while the app runs.
import fs from 'node:fs';
import path from 'node:path';
import db, { DATA_DIR, getSetting, setSetting } from '../db.js';
import { todayIst, nowUtc } from './istTime.js';

export const BACKUP_DIR = process.env.CRM_BACKUP_DIR || path.join(DATA_DIR, '..', 'backups');
const KEEP = 30;

export function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `crm-${todayIst()}.sqlite`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare(`VACUUM INTO ?`).run(file);
  setSetting('last_backup', { date: todayIst(), at: nowUtc(), file });

  // Retention: keep the newest KEEP dated backups.
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(KEEP)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
  }
  return file;
}

// Check every 30 minutes whether today's backup exists yet; run it if not.
export function startBackupScheduler() {
  const tick = () => {
    try {
      const last = getSetting('last_backup', null);
      if (!last || last.date !== todayIst()) runBackup();
    } catch (err) {
      console.error('[backup] failed:', err.message);
    }
  };
  setTimeout(tick, 30 * 1000).unref(); // first check shortly after boot
  setInterval(tick, 30 * 60 * 1000).unref();
}
