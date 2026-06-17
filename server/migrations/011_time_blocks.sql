-- Phase 4B — Time blocks (calendar/scheduling). Additive only: one new STRICT
-- time_blocks table. No changes to tasks (Phase 4A already added the
-- scheduled_start_at / scheduled_end_at columns the calendar overlays).
--
-- block_date is an IST business date ('YYYY-MM-DD'); start_at / end_at are UTC
-- ISO instants (the wall-clock window of the block). created_at is a UTC ISO
-- instant. A block belongs to one owner; same-owner same-day overlaps are the
-- conflicts detected in server/lib/schedule.js.

CREATE TABLE time_blocks (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  block_date     TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  block_type     TEXT NOT NULL DEFAULT 'Deep Work'
                   CHECK (block_type IN ('Deep Work','Meeting Prep','Client Work','Admin','Break','Out of Office')),
  owner_id       INTEGER REFERENCES users(id),
  notes          TEXT,
  linked_task_id INTEGER REFERENCES tasks(id),
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_time_blocks_owner_date ON time_blocks(owner_id, block_date);
