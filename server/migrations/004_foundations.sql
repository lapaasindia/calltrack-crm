-- migrate:no-transaction
-- Phase 1 — Foundations. Runs OUTSIDE the migration runner's wrapping
-- transaction (see the directive on line 1 + server/db.js) because widening the
-- users.role CHECK requires a table rebuild that toggles PRAGMA foreign_keys —
-- a no-op inside a transaction. We manage atomicity ourselves below.

-- ── Widen users.role + add users.department ──────────────────────────────────
-- SQLite can't ALTER a CHECK in place, so rebuild the table. foreign_keys must
-- be OFF during the DROP/RENAME so child rows (leads.assigned_to, etc.) aren't
-- cascaded/invalidated while the table is briefly gone.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN
                  ('super_admin','admin','manager','agent','caller','employee','read_only')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  department    TEXT,
  created_at    TEXT NOT NULL
) STRICT;

INSERT INTO users_new (id, username, password_hash, full_name, role, is_active, created_at)
  SELECT id, username, password_hash, full_name, role, is_active, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX idx_users_username ON users(username);

COMMIT;

PRAGMA foreign_keys = ON;

-- ── Audit log (a write path the PRD left without a reader; viewer added too) ──
-- IF NOT EXISTS: this DDL runs AFTER the users COMMIT but BEFORE user_version is
-- bumped to 4. A crash in that window would re-run the whole file on restart, so
-- these additive statements must be idempotent or they'd wedge at version 3.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY,
  action      TEXT NOT NULL,
  user_id     INTEGER,
  user_email  TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ── In-app notifications (polled by the client bell) ─────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT,
  type       TEXT NOT NULL DEFAULT 'info'
             CHECK (type IN ('info','success','warning','error')),
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);
