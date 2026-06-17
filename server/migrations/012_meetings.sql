-- Phase 5A — Meeting OS. Additive only: new STRICT meeting tables + one
-- ADD COLUMN on tasks (meeting_id). No rebuilds; migrations 001-011 untouched.
--
-- Instants (start_at/end_at/*_at/review_at/due_at) are UTC ISO strings; there
-- are NO IST business dates in this schema — meeting windows are wall-clock
-- instants, and task due dates derived from due_at are computed in JS via the
-- istTime helpers. attendee_ids is a JSON array of user ids.

CREATE TABLE meetings (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  location      TEXT,
  meeting_url   TEXT,
  status        TEXT NOT NULL DEFAULT 'Scheduled'
                  CHECK (status IN ('Scheduled','In Progress','Completed','Cancelled')),
  notes         TEXT,
  owner_id      INTEGER REFERENCES users(id),
  attendee_ids  TEXT NOT NULL DEFAULT '[]',
  lead_id       INTEGER REFERENCES leads(id),
  deal_id       INTEGER REFERENCES deals(id),
  project_id    INTEGER REFERENCES projects(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_meetings_owner ON meetings(owner_id);
CREATE INDEX idx_meetings_start ON meetings(start_at);

CREATE TABLE meeting_agenda (
  id          INTEGER PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id),
  title       TEXT NOT NULL,
  duration    INTEGER NOT NULL DEFAULT 15,
  order_index INTEGER NOT NULL DEFAULT 0,
  owner_id    INTEGER REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'Pending'
                CHECK (status IN ('Pending','In Progress','Done')),
  time_spent  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_meeting_agenda_meeting ON meeting_agenda(meeting_id, order_index);

CREATE TABLE meeting_roles (
  id                INTEGER PRIMARY KEY,
  meeting_id        INTEGER NOT NULL UNIQUE REFERENCES meetings(id),
  facilitator_id    INTEGER REFERENCES users(id),
  scribe_id         INTEGER REFERENCES users(id),
  decision_maker_id INTEGER REFERENCES users(id)
) STRICT;

CREATE TABLE meeting_decisions (
  id          INTEGER PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id),
  task_id     INTEGER REFERENCES tasks(id),
  title       TEXT NOT NULL,
  rationale   TEXT,
  owner_id    INTEGER REFERENCES users(id),
  review_at   TEXT,
  status      TEXT NOT NULL DEFAULT 'Pending'
                CHECK (status IN ('Pending','Accepted','Revisit')),
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_meeting_decisions_meeting ON meeting_decisions(meeting_id);

CREATE TABLE meeting_actions (
  id          INTEGER PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id),
  task_id     INTEGER REFERENCES tasks(id),
  title       TEXT NOT NULL,
  owner_id    INTEGER REFERENCES users(id),
  due_at      TEXT,
  status      TEXT NOT NULL DEFAULT 'Pending'
                CHECK (status IN ('Pending','In Progress','Done')),
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_meeting_actions_meeting ON meeting_actions(meeting_id);

CREATE TABLE meeting_timer_sessions (
  id             INTEGER PRIMARY KEY,
  meeting_id     INTEGER NOT NULL REFERENCES meetings(id),
  agenda_item_id INTEGER REFERENCES meeting_agenda(id),
  start_time     TEXT NOT NULL,
  end_time       TEXT,
  duration       INTEGER,
  status         TEXT NOT NULL DEFAULT 'Running'
                   CHECK (status IN ('Running','Paused','Stopped')),
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX idx_meeting_timer_meeting ON meeting_timer_sessions(meeting_id);

-- Link tasks created from a meeting action/decision back to their meeting.
-- (tasks.origin already exists — meeting-spawned tasks use origin='meeting_action'.)
ALTER TABLE tasks ADD COLUMN meeting_id INTEGER REFERENCES meetings(id);
