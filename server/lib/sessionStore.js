// Minimal express-session Store backed by its own SQLite file, so session
// churn stays out of business-data backups and logins survive restarts.
import Database from 'better-sqlite3';
import path from 'node:path';
import { Store } from 'express-session';
import { DATA_DIR } from '../db.js';

// The most recently constructed store. createApp() builds exactly one for the
// running server; routes that need to kill a user's sessions (password change,
// admin reset, deactivation — audit SEC-5) reach it through
// destroySessionsForUser() below without app.js having to thread it around.
let activeStore = null;

// Rolling cookies make express-session call touch() on EVERY authenticated
// request; rewriting expires_ms that moves by milliseconds is pure write churn
// (SCALE-16). Skip the UPDATE unless the stored expiry is more than this far
// from the new one.
const TOUCH_SLACK_MS = 5 * 60 * 1000;

export class SqliteSessionStore extends Store {
  #sweep;

  constructor() {
    super();
    activeStore = this;
    this.db = new Database(path.join(DATA_DIR, 'sessions.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires_ms INTEGER NOT NULL)'
    );
    // The hourly sweep and get() both filter on expires_ms.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_ms)');
    // Sweep expired sessions hourly.
    this.#sweep = setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires_ms < ?').run(Date.now());
      } catch { /* sweep is best-effort */ }
    }, 60 * 60 * 1000);
    this.#sweep.unref();
  }

  #expiry(sess) {
    const maxAge = sess?.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
    return Date.now() + maxAge;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires_ms FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_ms < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.db.prepare(
        'INSERT INTO sessions (sid, sess, expires_ms) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_ms = excluded.expires_ms'
      ).run(sid, JSON.stringify(sess), this.#expiry(sess));
      cb?.(null);
    } catch (err) { cb?.(err); }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb?.(null);
    } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) {
    try {
      const next = this.#expiry(sess);
      const row = this.db.prepare('SELECT expires_ms FROM sessions WHERE sid = ?').get(sid);
      if (row && Math.abs(next - row.expires_ms) < TOUCH_SLACK_MS) return cb?.(null);
      this.db.prepare('UPDATE sessions SET expires_ms = ? WHERE sid = ?').run(next, sid);
      cb?.(null);
    } catch (err) { cb?.(err); }
  }

  // Graceful shutdown: fold the WAL back into sessions.sqlite and close the
  // handle (app.js stop() closes crm.sqlite the same way). Idempotent.
  close() {
    clearInterval(this.#sweep);
    if (this.db.open) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      this.db.close();
    }
    if (activeStore === this) activeStore = null;
  }

  // Destroy every session belonging to `userId` except `exceptSid` (the one
  // performing a self-service password change). Sessions are stored as JSON
  // with a top-level `userId`; a scan + parse is fine for this table's size
  // (one row per logged-in browser). Returns the number of sessions removed.
  destroyByUserId(userId, exceptSid = null) {
    const rows = this.db.prepare('SELECT sid, sess FROM sessions').all();
    const del = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    let n = 0;
    const run = this.db.transaction(() => {
      for (const row of rows) {
        if (exceptSid && row.sid === exceptSid) continue;
        let sess;
        try { sess = JSON.parse(row.sess); } catch { continue; }
        if (Number(sess?.userId) === Number(userId)) { del.run(row.sid); n += 1; }
      }
    });
    run();
    return n;
  }
}

// Module-level entry point used by the auth/users routes. Falls back to a
// fresh store on the same sessions.sqlite if none was constructed yet (e.g. a
// script calling into the routes without createApp()).
export function destroySessionsForUser(userId, exceptSid = null) {
  if (!activeStore) activeStore = new SqliteSessionStore();
  return activeStore.destroyByUserId(userId, exceptSid);
}

// Close the running server's session store (called from app.js stop()). Safe
// when no store was ever constructed.
export function closeSessionStore() {
  if (activeStore) activeStore.close();
}
