-- Phase 2B — Lead routing rules + daily coaching/learning journal.
-- Additive only: two new STRICT tables. No prior migration is touched.

-- Subject/source → owner routing. When an admin-tier user creates a lead with
-- no explicit owner, server/lib/assignment.js matches the lead's subject (then
-- source) against these rules; an unmatched lead falls through to round-robin.
CREATE TABLE lead_routing_rules (
  id          INTEGER PRIMARY KEY,
  subject     TEXT NOT NULL UNIQUE,
  assigned_to INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
) STRICT;

-- Daily learning journal — one row per logged learning. 'manual'/'daily_check_in'
-- come from the Coaching page; 'deal_closed' is inserted when a deal is won.
-- entry_date is an IST calendar date ('YYYY-MM-DD').
CREATE TABLE daily_learnings (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  entry_date TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('manual','deal_closed','daily_check_in')),
  deal_id    INTEGER REFERENCES deals(id),
  learning   TEXT NOT NULL,
  win        TEXT,
  challenge  TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_daily_learnings_user_date ON daily_learnings(user_id, entry_date);
