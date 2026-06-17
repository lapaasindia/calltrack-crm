// Phase 1B — off-site encrypted Google Drive backup orchestrator.
//
// Outbound only (Mac → Drive): this NEVER exposes the LAN app to the internet.
// It layers on the existing local backup (server/lib/backup.js) — the local
// VACUUM snapshot is untouched; we just encrypt + upload a copy.
//
// Flow of runCloudBackup():
//   1. runBackup() to ensure today's VACUUM snapshot exists locally.
//   2. Build the upload SET from data/ (include/exclude rules below).
//   3. For each file not already in the cloud_backup_files ledger (keyed by
//      source_path + plaintext sha256): AES-256-GCM encrypt to a temp file with
//      the user passphrase, upload the ciphertext to the dated Drive folder,
//      record a ledger row. Recordings are content-addressed → upload once.
//   4. Retention: keep the newest 30 daily DB snapshots in Drive; delete older.
//   5. Write last_cloud_backup. On failure: notify owner + audit. Offline =
//      skip quietly (caught, retried next tick).
//
// The Drive client is INJECTABLE (the `drive` arg) so unit tests run the whole
// pipeline with a fake uploader and never touch the network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db, { DATA_DIR, getSetting, setSetting } from '../db.js';
import { todayIst, nowUtc } from './istTime.js';
import { runBackup, BACKUP_DIR } from './backup.js';
import { encryptFile } from './cryptoBackup.js';
import { sendNotification } from './notify.js';
import { logAudit } from './audit.js';
import * as drive from './googleDrive.js';
import { openSecret } from './secretBox.js';

export const DRIVE_FOLDER_NAME = 'CallTrack Backups';
const DB_SNAPSHOT_KEEP = 30;

// ── File selection ───────────────────────────────────────────────────────────
// We back up "everything under data/" with a sensible exclude list, PLUS the
// latest VACUUM DB snapshot from BACKUP_DIR (which lives outside data/ by
// default). We deliberately DO NOT upload the live crm.sqlite/-wal/-shm — a
// naive copy of a WAL db can tear; the VACUUM snapshot is the consistent one.
const EXCLUDE_DIRS = new Set(['apk', 'tmp']); // build artifacts / scratch
const EXCLUDE_BASENAMES = new Set(['secret.key', 'sessions.sqlite']);

function isExcludedFile(relPath) {
  const base = path.basename(relPath);
  if (EXCLUDE_BASENAMES.has(base)) return true;
  // Live DB + any WAL/SHM sidecars, session store sidecars, logs.
  if (base === 'crm.sqlite') return true;
  if (/-wal$|-shm$|-journal$/.test(base)) return true;
  if (/^sessions\.sqlite/.test(base)) return true;
  if (/\.log$/.test(base)) return true;
  // Any segment of the path that is an excluded dir.
  const segs = relPath.split(path.sep);
  return segs.some((s) => EXCLUDE_DIRS.has(s));
}

function walk(dirAbs, baseAbs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return; // dir may not exist (e.g. no recordings yet) — fine.
  }
  for (const ent of entries) {
    const abs = path.join(dirAbs, ent.name);
    const rel = path.relative(baseAbs, abs);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(abs, baseAbs, out);
    } else if (ent.isFile()) {
      if (!isExcludedFile(rel)) out.push({ abs, rel });
    }
  }
}

// Returns the upload candidate set: [{ abs, source_path }]. source_path is a
// stable, forward-slash relative key (e.g. 'recordings/2026/06/abc.m4a' or
// 'backups/crm-2026-06-16.sqlite') used as the ledger key + Drive name stem.
export function buildUploadSet({ dataDir = DATA_DIR, backupDir = BACKUP_DIR } = {}) {
  const set = [];

  // 1. Latest DB snapshot from BACKUP_DIR (newest crm-YYYY-MM-DD.sqlite).
  try {
    const snaps = fs.readdirSync(backupDir)
      .filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .sort();
    if (snaps.length) {
      const latest = snaps[snaps.length - 1];
      set.push({ abs: path.join(backupDir, latest), source_path: `backups/${latest}` });
    }
  } catch { /* no backups dir yet */ }

  // 2. Everything under data/ minus the exclude list (recordings, invoices,
  //    exports, etc.).
  const dataFiles = [];
  walk(dataDir, dataDir, dataFiles);
  for (const f of dataFiles) {
    set.push({ abs: f.abs, source_path: f.rel.split(path.sep).join('/') });
  }
  return set;
}

function sha256File(abs) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(abs));
  return hash.digest('hex');
}

// Drive object name for an encrypted file: flatten the source path so it's a
// single legible filename in the Drive folder, suffixed .enc. Ledger keys on
// (source_path, sha256), so collisions are impossible to confuse.
function driveNameFor(source_path) {
  return `${source_path.replace(/[/\\]/g, '__')}.enc`;
}

const ledgerGet = () => db.prepare(
  'SELECT id, drive_file_id FROM cloud_backup_files WHERE source_path = ? AND sha256 = ?'
);
const ledgerInsert = () => db.prepare(
  `INSERT OR IGNORE INTO cloud_backup_files (source_path, sha256, drive_file_id, bytes, uploaded_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

// Resolve which owner gets failure notifications (super_admin/admin, lowest id).
function ownerUserId() {
  const row = db.prepare(
    "SELECT id FROM users WHERE role IN ('super_admin','admin') AND is_active = 1 ORDER BY id LIMIT 1"
  ).get();
  return row?.id ?? null;
}

// Is Drive connected (client id/secret + refresh token present + sync enabled)?
export function driveConnected() {
  const cfg = getSetting('cloud_backup', null);
  return !!(cfg && cfg.sync_enabled && cfg.client_id && cfg.refresh_token_enc && cfg.client_secret_enc);
}

export function hasPassphrase() {
  const p = getSetting('cloud_backup_passphrase', null);
  return !!(p && p.salt && p.verifier);
}

// Acquire a fresh access token from the stored (encrypted) refresh token.
async function getAccessToken(cfg, driveClient) {
  const refreshToken = openSecret(cfg.refresh_token_enc);
  const clientSecret = openSecret(cfg.client_secret_enc);
  const tok = await driveClient.refreshAccessToken({
    clientId: cfg.client_id, clientSecret, refreshToken,
  });
  if (!tok.access_token) throw new Error('No access token returned by Google');
  return tok.access_token;
}

// Core. Returns a result object also persisted to last_cloud_backup.
// Options let tests inject a fake drive client + an explicit passphrase and
// skip the owner-notification side effects.
export async function runCloudBackup({
  drive: driveClient = drive,
  passphrase,
  dataDir = DATA_DIR,
  backupDir = BACKUP_DIR,
  notify = true,
} = {}) {
  const cfg = getSetting('cloud_backup', null);
  if (!cfg || !cfg.sync_enabled) {
    return { ok: false, skipped: true, reason: 'not_connected' };
  }
  const pass = passphrase ?? (cfg.__passphrase /* never persisted; tests only */);
  if (!pass) {
    return { ok: false, skipped: true, reason: 'no_passphrase' };
  }

  // Ensure today's local VACUUM snapshot exists before we pick the upload set.
  try { runBackup(); } catch { /* if VACUUM fails we still try existing files */ }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctbkp-'));
  const get = ledgerGet();
  const insert = ledgerInsert();
  let uploaded = 0;
  let totalBytes = 0;
  let skipped = 0;
  let folderId = null;

  try {
    const accessToken = await getAccessToken(cfg, driveClient);
    folderId = await driveClient.ensureFolder(accessToken, DRIVE_FOLDER_NAME);

    const set = buildUploadSet({ dataDir, backupDir });
    for (const item of set) {
      const sha = sha256File(item.abs);
      const existing = get.get(item.source_path, sha);
      if (existing && existing.drive_file_id) { skipped++; continue; } // already uploaded

      const tmpEnc = path.join(tmpRoot, driveNameFor(item.source_path));
      fs.mkdirSync(path.dirname(tmpEnc), { recursive: true });
      const { bytes } = encryptFile(item.abs, tmpEnc, pass);

      const driveFile = await driveClient.uploadFile(accessToken, {
        folderId,
        name: driveNameFor(item.source_path),
        srcAbs: tmpEnc,
      });
      insert.run(item.source_path, sha, driveFile.id, bytes, nowUtc(), nowUtc());
      fs.rmSync(tmpEnc, { force: true });
      uploaded++;
      totalBytes += bytes;
    }

    // Retention: keep newest DB_SNAPSHOT_KEEP daily DB snapshots in Drive.
    await applyRetention(driveClient, accessToken, folderId);

    const result = {
      ok: true, date: todayIst(), at: nowUtc(),
      files: uploaded, skipped, bytes: totalBytes, error: null,
    };
    setSetting('last_cloud_backup', result);
    return result;
  } catch (err) {
    const offline = isNetworkError(err);
    const result = {
      ok: false, date: todayIst(), at: nowUtc(),
      files: uploaded, skipped, bytes: totalBytes,
      error: err.message, offline,
    };
    setSetting('last_cloud_backup', result);
    if (!offline && notify) {
      const owner = ownerUserId();
      if (owner) {
        sendNotification(owner, 'Cloud backup failed',
          `Off-site Google Drive backup failed: ${err.message}`, 'error');
      }
      logAudit({ action: 'CLOUD_BACKUP_FAILED', entity_type: 'backup', details: { error: err.message } });
    }
    return result;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Delete the oldest encrypted DB snapshots in Drive beyond the keep window.
// DB snapshots are the files whose ledger source_path starts with 'backups/'.
async function applyRetention(driveClient, accessToken, folderId) {
  if (typeof driveClient.listFiles !== 'function' || typeof driveClient.deleteFile !== 'function') return;
  const files = await driveClient.listFiles(accessToken, { folderId, namePrefix: 'backups__crm-' });
  // Names look like 'backups__crm-2026-06-16.sqlite.enc'; sort by name = by date.
  const sorted = files
    .filter((f) => /backups__crm-\d{4}-\d{2}-\d{2}\.sqlite\.enc$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toDelete = sorted.slice(0, Math.max(0, sorted.length - DB_SNAPSHOT_KEEP));
  for (const f of toDelete) {
    await driveClient.deleteFile(accessToken, f.id);
    db.prepare('DELETE FROM cloud_backup_files WHERE drive_file_id = ?').run(f.id);
  }
}

// Only treat genuine connectivity failures as "offline" (which suppresses the
// owner notification + CLOUD_BACKUP_FAILED audit). A blanket `cause.code != null`
// would silently swallow any future wrapped error exactly when the operator
// most needs to hear the off-site backup stopped working.
const NET_ERROR_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isNetworkError(err) {
  const m = String(err?.message || '').toLowerCase();
  if (/(fetch failed|enotfound|econnrefused|etimedout|network|getaddrinfo|socket hang up|und_err)/.test(m)) {
    return true;
  }
  const code = err?.code || err?.cause?.code;
  return code != null && NET_ERROR_CODES.has(code);
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// Piggyback the existing daily cadence: shortly after boot, then every 30 min,
// if Drive is connected + a passphrase is set + today's cloud backup isn't done,
// run it. The passphrase lives only in memory for the running process (set via
// the /run-now route or by the operator); if it isn't in memory we skip — we
// never persist the passphrase. To enable unattended daily runs, the operator
// can set CRM_BACKUP_PASSPHRASE in the environment.
let inMemoryPassphrase = null;
export function setInMemoryPassphrase(p) { inMemoryPassphrase = p || null; }
export function getInMemoryPassphrase() {
  return inMemoryPassphrase || process.env.CRM_BACKUP_PASSPHRASE || null;
}

export function startCloudBackupScheduler() {
  const tick = async () => {
    try {
      if (!driveConnected() || !hasPassphrase()) return;
      const pass = getInMemoryPassphrase();
      if (!pass) return; // can't decrypt without it; wait for operator/env.
      const last = getSetting('last_cloud_backup', null);
      if (last && last.ok && last.date === todayIst()) return; // already done today
      await runCloudBackup({ passphrase: pass });
    } catch (err) {
      console.error('[cloud-backup] tick failed:', err.message);
    }
  };
  // First check a minute after boot (after the local backup scheduler's tick),
  // then every 30 minutes — same cadence as the local backup.
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}
