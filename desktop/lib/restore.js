// Restore-from-backup validation (DESK-15), factored out of main.js so the
// checks unit-test without Electron or better-sqlite3. main.js feeds it the
// header bytes, file size and free space; the deeper PRAGMA quick_check runs
// in a separate process (see sqlite-check.js) because the main process must
// never load the native module (DESK-4).

// Every SQLite database file starts with the 15 ASCII bytes 'SQLite format 3'
// followed by a NUL (16 bytes in total).
export const SQLITE_MAGIC = 'SQLite format 3';
export const SQLITE_HEADER_LEN = 100;

export function hasSqliteHeader(bytes) {
  if (!bytes || bytes.length < 16) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return bytes[15] === 0;
}

// Bytes 18/19 of the header are the file-format write/read versions:
// 1 = legacy (rollback journal), 2 = WAL. A WAL-mode file copied while the
// server was running may have committed rows still sitting in crm.sqlite-wal.
export function isWalMode(bytes) {
  return !!bytes && bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2;
}

// The sidecar files that belong to a SQLite database in WAL mode.
export function sidecarNames(file) {
  return { wal: `${file}-wal`, shm: `${file}-shm` };
}

// Pure decision: is this file plausibly a CallTrack database we can restore?
//  headerBytes — the first 100 bytes (or fewer if the file is shorter)
//  size        — file size in bytes
//  freeBytes   — free space on the destination volume (null = unknown)
//  walSize     — size of '<file>-wal' if it exists (0 / null = absent)
export function checkRestoreCandidate({ headerBytes, size, freeBytes, walSize } = {}) {
  if (!(size > 0)) {
    return { ok: false, error: 'That file is empty (0 bytes) — pick a different backup.' };
  }
  if (!hasSqliteHeader(headerBytes)) {
    return {
      ok: false,
      error: 'That is not a SQLite database file. CallTrack backups are named like crm-YYYY-MM-DD.sqlite (menu: Server → Open Backups Folder on the old computer).',
    };
  }
  const needed = size + (walSize || 0);
  if (freeBytes != null && Number.isFinite(freeBytes) && needed * 2 > freeBytes) {
    const mb = (n) => `${Math.round(n / 1048576)} MB`;
    return {
      ok: false,
      error: `Not enough free disk space to restore (${mb(needed)} needed twice over for a safe copy, ${mb(freeBytes)} free).`,
    };
  }
  return {
    ok: true,
    wal: isWalMode(headerBytes),
    // A WAL sidecar with content means the file was copied from a LIVE
    // database: the sidecar must travel with it or the last writes are lost.
    liveCopy: !!(walSize > 0),
  };
}

// Interpret the JSON result of sqlite-check.js. Kept pure so the mapping from
// child-process output to a user-facing message is tested.
export function interpretCheck(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'The database check did not produce a result.' };
  }
  if (result.skipped) return { ok: true, skipped: true, reason: result.reason || 'binding unavailable' };
  if (result.error) return { ok: false, error: `The backup could not be opened: ${result.error}` };
  if (result.quick_check !== 'ok') {
    return { ok: false, error: `The backup file is damaged (integrity check: ${String(result.quick_check).slice(0, 120)}).` };
  }
  if (!(result.users >= 1)) {
    return { ok: false, error: 'That database has no CallTrack users in it — it is not a CallTrack backup.' };
  }
  return { ok: true, users: result.users, userVersion: result.user_version };
}
