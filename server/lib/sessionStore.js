// Minimal express-session Store backed by its own SQLite file, so session
// churn stays out of business-data backups and logins survive restarts.
import Database from 'better-sqlite3';
import path from 'node:path';
import { Store } from 'express-session';
import { DATA_DIR } from '../db.js';

export class SqliteSessionStore extends Store {
  constructor() {
    super();
    this.db = new Database(path.join(DATA_DIR, 'sessions.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires_ms INTEGER NOT NULL)'
    );
    // Sweep expired sessions hourly.
    setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires_ms < ?').run(Date.now());
      } catch { /* sweep is best-effort */ }
    }, 60 * 60 * 1000).unref();
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
      this.db.prepare('UPDATE sessions SET expires_ms = ? WHERE sid = ?').run(this.#expiry(sess), sid);
      cb?.(null);
    } catch (err) { cb?.(err); }
  }
}
