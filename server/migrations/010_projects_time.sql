-- Phase 4A — Projects + Task Kanban + per-task time tracking. Additive only:
-- one new STRICT projects table + ADD COLUMN extensions to the existing tasks
-- table (NO rebuild — the legacy status CHECK is preserved and the Today queue
-- + sync.integration flow stay green).
--
-- Money is INTEGER paise (budget_paise). progress is a clamped 0..100 integer.
-- start_date / end_date are IST business dates ('YYYY-MM-DD'); created_at is a
-- UTC ISO instant.

CREATE TABLE projects (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  lead_id          INTEGER REFERENCES leads(id),
  deal_id          INTEGER REFERENCES deals(id),
  service_type     TEXT,
  budget_paise     INTEGER NOT NULL DEFAULT 0 CHECK (budget_paise >= 0),
  assigned_head_id INTEGER REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'Working'
                     CHECK (status IN ('Approval','Assigned','Working','Review','Completed','Pending Client')),
  progress         INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  start_date       TEXT,
  end_date         TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_projects_head ON projects(assigned_head_id);
CREATE INDEX idx_projects_status ON projects(status);

-- Extend tasks via ADD COLUMN (no rebuild). A column-only CHECK with a
-- satisfying literal default is allowed by SQLite ALTER ADD COLUMN; an FK in
-- ADD COLUMN is allowed when the column is nullable (NULL default).
--
-- board_status is the Kanban lane; the legacy `status` column (pending/done/
-- cancelled) stays the lifecycle the Today queue + existing endpoints read, and
-- the task PATCH keeps the two in sync. Backfill below maps existing rows.
ALTER TABLE tasks ADD COLUMN board_status TEXT NOT NULL DEFAULT 'To Do'
  CHECK (board_status IN ('To Do','Doing','Review','Done','Drop'));
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium'
  CHECK (priority IN ('Daily','High','Medium','Low'));
ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN subtasks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN time_entries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN time_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN scheduled_start_at TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_end_at TEXT;

-- Backfill board_status from the existing lifecycle status so already-completed
-- / cancelled tasks land in the right lane on day one.
UPDATE tasks SET board_status = 'Done' WHERE status = 'done';
UPDATE tasks SET board_status = 'Drop' WHERE status = 'cancelled';
UPDATE tasks SET board_status = 'To Do' WHERE status NOT IN ('done','cancelled');

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_board ON tasks(board_status);
