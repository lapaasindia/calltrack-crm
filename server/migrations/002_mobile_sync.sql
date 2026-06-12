-- Mobile call-capture sync: paired devices, auto-logged calls, captured
-- unknown-number calls (staging — NEVER auto-created as leads), call
-- recordings, and the tasks module.

-- Paired phones. The raw token is shown once at pairing; only its SHA-256
-- is stored. Revoking a device kills its access immediately.
CREATE TABLE device_tokens (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  device_name  TEXT NOT NULL,
  android_id   TEXT,
  token_hash   TEXT NOT NULL UNIQUE,
  paired_at    TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
) STRICT;

-- Short-lived one-time codes an admin generates (rendered as a QR) to pair
-- a phone to a specific caller.
CREATE TABLE pairing_codes (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- Calls from numbers that don't match any lead. Staged for review:
-- one tap turns them into a lead, or they get ignored.
CREATE TABLE captured_calls (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  device_id        INTEGER NOT NULL REFERENCES device_tokens(id),
  phone            TEXT NOT NULL CHECK (length(phone) = 10),
  direction        TEXT NOT NULL CHECK (direction IN ('incoming','outgoing','missed')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  call_log_ts      INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','lead_created','ignored')),
  created_lead_id  INTEGER REFERENCES leads(id),
  created_at       TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_captured_dedupe ON captured_calls(user_id, call_log_ts, phone);
CREATE INDEX idx_captured_status ON captured_calls(status, created_at);

-- Numbers the team never wants to see again (food delivery, family, spam).
CREATE TABLE ignored_numbers (
  phone      TEXT PRIMARY KEY CHECK (length(phone) = 10),
  added_by   INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
) STRICT;

-- Uploaded call recordings. Linked to a call when matching is confident,
-- to a captured_call when the number was unknown, or left for manual review.
CREATE TABLE recordings (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  device_id         INTEGER NOT NULL REFERENCES device_tokens(id),
  call_id           INTEGER REFERENCES calls(id),
  captured_call_id  INTEGER REFERENCES captured_calls(id),
  file_path         TEXT NOT NULL,
  sha256            TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  duration_seconds  INTEGER,
  rec_start_ts      INTEGER,
  match_status      TEXT NOT NULL DEFAULT 'unmatched'
                    CHECK (match_status IN ('matched','ambiguous','unmatched')),
  transcript        TEXT,
  summary           TEXT,
  ai_json           TEXT,
  ai_status         TEXT NOT NULL DEFAULT 'pending'
                    CHECK (ai_status IN ('pending','processing','done','failed','skipped')),
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_recordings_call ON recordings(call_id);
CREATE INDEX idx_recordings_review ON recordings(match_status, created_at);
CREATE INDEX idx_recordings_ai ON recordings(ai_status, created_at);

-- Tasks: standalone to-dos (optionally tied to a lead), merged into the
-- Today queue. due_date is an IST calendar date.
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  details      TEXT,
  lead_id      INTEGER REFERENCES leads(id),
  assigned_to  INTEGER NOT NULL REFERENCES users(id),
  due_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','done','cancelled')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_tasks_queue ON tasks(assigned_to, status, due_date);
CREATE INDEX idx_tasks_lead ON tasks(lead_id);

-- Mobile-synced call metadata on the existing append-only calls table.
ALTER TABLE calls ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE calls ADD COLUMN direction TEXT
  CHECK (direction IN ('incoming','outgoing','missed') OR direction IS NULL);
ALTER TABLE calls ADD COLUMN call_log_ts INTEGER;
ALTER TABLE calls ADD COLUMN device_id INTEGER REFERENCES device_tokens(id);
ALTER TABLE calls ADD COLUMN auto_logged INTEGER NOT NULL DEFAULT 0;

-- Reinstall/re-sync safety: the same call-log entry can never create a
-- second row, no matter how many times a phone re-syncs.
CREATE UNIQUE INDEX idx_calls_mobile_dedupe
  ON calls(user_id, call_log_ts, lead_id) WHERE source = 'mobile';
