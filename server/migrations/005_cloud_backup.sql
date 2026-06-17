-- Phase 1B — Off-site encrypted Google Drive backup.
-- Incremental upload ledger: each (source file, content sha256) is uploaded to
-- Drive exactly once. Recordings are content-addressed, so they upload once and
-- never again; the daily VACUUM DB snapshot changes daily → one new row/day.
CREATE TABLE cloud_backup_files (
  id           INTEGER PRIMARY KEY,
  source_path  TEXT NOT NULL,            -- path relative to data/ (stable key)
  sha256       TEXT NOT NULL,            -- sha256 of the PLAINTEXT source file
  drive_file_id TEXT,                    -- Google Drive file id once uploaded
  bytes        INTEGER,                  -- ciphertext bytes uploaded
  uploaded_at  TEXT,                     -- UTC ISO when the upload completed
  created_at   TEXT NOT NULL,            -- UTC ISO when the ledger row was made
  UNIQUE(source_path, sha256)
) STRICT;
CREATE INDEX idx_cloud_backup_source ON cloud_backup_files(source_path);
