-- 018 — Wave 2: playable recordings, phone history, FTS5 lead search and the
-- calls_daily rollup (audit MOB-22 / SCALE-12 / SCALE-18b / roadmap "Next").
--
-- Additive only. Every CREATE is IF NOT EXISTS, every backfill is either
-- guarded by NOT EXISTS or a full rebuild, so re-running any statement is a
-- no-op (server/test/migrations.test.js proves it). The single ADD COLUMN runs
-- inside the runner's transaction together with the user_version bump.
-- Timing on a 100 MB / 50k-lead / 200k-call database: ~1 s (the FTS rebuild
-- and the rollup backfill dominate).
--
-- Conventions kept from the rest of the schema: instants are UTC ISO strings
-- (strftime('%Y-%m-%dT%H:%M:%fZ') matches nowUtc()), business days are IST
-- (`date(x, '+330 minutes')` — the same expression as SQL_IST_DATE), and
-- phones are the canonical 10-digit form from lib/phone.js.

-- ── MOB-22: a browser-playable sibling of a recording ───────────────────────
-- .amr / .3gp / .ogg / .opus uploads are transcoded to <sha>.m4a next to the
-- original (lib/transcode.js); the original stays for the AI pipeline. NULL
-- until the transcode succeeds, so a half-written file is never served.
ALTER TABLE recordings ADD COLUMN playable_path TEXT;

-- ── SCALE-18b: every number a lead has ever had ─────────────────────────────
-- kind: 'primary' (the current leads.phone), 'alt' (normalised alt_phone),
-- 'previous' (a primary that was edited away — valid_to says when).
-- Soft-deleting a lead closes its open rows (valid_to = deleted_at).
CREATE TABLE IF NOT EXISTS lead_phones (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  phone      TEXT NOT NULL CHECK (length(phone) = 10),
  kind       TEXT NOT NULL CHECK (kind IN ('primary','alt','previous')),
  valid_from TEXT NOT NULL,
  valid_to   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_lead_phones_phone ON lead_phones(phone, valid_to);
CREATE INDEX IF NOT EXISTS idx_lead_phones_lead ON lead_phones(lead_id, kind);

-- Backfill: one 'primary' row per lead (open unless the lead is deleted) and
-- one 'alt' row where alt_phone reduces to a real mobile number (last 10
-- digits after the usual separators — the same rule lib/leadMatch.js used).
INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
  SELECT l.id, l.phone, 'primary', l.created_at, l.deleted_at
    FROM leads l
   WHERE NOT EXISTS (SELECT 1 FROM lead_phones lp WHERE lp.lead_id = l.id AND lp.kind = 'primary');
INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
  SELECT l.id,
         substr(replace(replace(replace(replace(replace(l.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10),
         'alt', l.created_at, l.deleted_at
    FROM leads l
   WHERE l.alt_phone IS NOT NULL AND l.alt_phone <> ''
     AND substr(replace(replace(replace(replace(replace(l.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10)
         GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
     AND substr(replace(replace(replace(replace(replace(l.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10) <> l.phone
     AND NOT EXISTS (SELECT 1 FROM lead_phones lp WHERE lp.lead_id = l.id AND lp.kind = 'alt');

-- Keep it in sync from every write path (manual, import, review, WhatsApp,
-- seed) without touching each route.
CREATE TRIGGER IF NOT EXISTS trg_lead_phones_ai AFTER INSERT ON leads BEGIN
  INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
    VALUES (NEW.id, NEW.phone, 'primary', NEW.created_at, NEW.deleted_at);
  INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
    SELECT NEW.id,
           substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10),
           'alt', NEW.created_at, NEW.deleted_at
     WHERE NEW.alt_phone IS NOT NULL AND NEW.alt_phone <> ''
       AND substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10)
           GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
       AND substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10) <> NEW.phone;
END;

-- Phone edited: the old primary becomes 'previous' (closed now), the new one
-- opens. Calls synced later from the old number still attach to this lead
-- (routes/sync.js findLead) and review candidates still surface it.
CREATE TRIGGER IF NOT EXISTS trg_lead_phones_au_phone AFTER UPDATE OF phone ON leads
WHEN NEW.phone IS NOT OLD.phone BEGIN
  UPDATE lead_phones
     SET kind = 'previous', valid_to = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE lead_id = NEW.id AND kind = 'primary' AND valid_to IS NULL;
  INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
    VALUES (NEW.id, NEW.phone, 'primary', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
END;

CREATE TRIGGER IF NOT EXISTS trg_lead_phones_au_alt AFTER UPDATE OF alt_phone ON leads
WHEN NEW.alt_phone IS NOT OLD.alt_phone BEGIN
  UPDATE lead_phones SET valid_to = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE lead_id = NEW.id AND kind = 'alt' AND valid_to IS NULL;
  INSERT INTO lead_phones (lead_id, phone, kind, valid_from, valid_to)
    SELECT NEW.id,
           substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10),
           'alt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
     WHERE NEW.alt_phone IS NOT NULL AND NEW.alt_phone <> ''
       AND substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10)
           GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
       AND substr(replace(replace(replace(replace(replace(NEW.alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10, 10) <> NEW.phone;
END;

CREATE TRIGGER IF NOT EXISTS trg_lead_phones_au_deleted AFTER UPDATE OF deleted_at ON leads
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  UPDATE lead_phones SET valid_to = NEW.deleted_at WHERE lead_id = NEW.id AND valid_to IS NULL;
END;

-- ── FTS5 lead search (roadmap "Next") ───────────────────────────────────────
-- External-content table over leads (no duplicated text): the rowid is the
-- lead id, so GET /api/leads?q= joins it back to leads and keeps applying
-- scoping + deleted_at exactly as before. unicode61 with the mark categories
-- (Mn/Mc) added so Devanagari matras are token characters and "राहुल" is one
-- token (the default splits Hindi names on every vowel sign).
CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
  name, city, email, notes, phone,
  content='leads', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'"
);
CREATE TRIGGER IF NOT EXISTS trg_leads_fts_ai AFTER INSERT ON leads BEGIN
  INSERT INTO leads_fts (rowid, name, city, email, notes, phone)
    VALUES (NEW.id, NEW.name, NEW.city, NEW.email, NEW.notes, NEW.phone);
END;
CREATE TRIGGER IF NOT EXISTS trg_leads_fts_ad AFTER DELETE ON leads BEGIN
  INSERT INTO leads_fts (leads_fts, rowid, name, city, email, notes, phone)
    VALUES ('delete', OLD.id, OLD.name, OLD.city, OLD.email, OLD.notes, OLD.phone);
END;
CREATE TRIGGER IF NOT EXISTS trg_leads_fts_au AFTER UPDATE OF name, city, email, notes, phone ON leads BEGIN
  INSERT INTO leads_fts (leads_fts, rowid, name, city, email, notes, phone)
    VALUES ('delete', OLD.id, OLD.name, OLD.city, OLD.email, OLD.notes, OLD.phone);
  INSERT INTO leads_fts (rowid, name, city, email, notes, phone)
    VALUES (NEW.id, NEW.name, NEW.city, NEW.email, NEW.notes, NEW.phone);
END;
-- Index everything that already exists (idempotent: a rebuild is a rebuild).
INSERT INTO leads_fts (leads_fts) VALUES ('rebuild');

-- ── SCALE-12: calls_daily rollup ────────────────────────────────────────────
-- One row per (user, IST day) with the calling KPIs the dashboard, reports
-- and leaderboard used to compute by scanning calls: dials, connects and the
-- distinct leads dialled that day. The filter is the reporting rule from
-- reports.js — manual calls plus auto-logged calls that connected, never the
-- WhatsApp mirror rows. Maintained by the triggers below, which RECOMPUTE the
-- affected (user, day) bucket from calls (a user's calls in one day, via
-- idx_calls_user_time) instead of adding/subtracting counters — so
-- COUNT(DISTINCT lead_id) stays exact and the row can never drift from the
-- source of truth.
CREATE TABLE IF NOT EXISTS calls_daily (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  day          TEXT NOT NULL,
  dials        INTEGER NOT NULL DEFAULT 0,
  connects     INTEGER NOT NULL DEFAULT 0,
  unique_leads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_calls_daily_day ON calls_daily(day, user_id);

CREATE TRIGGER IF NOT EXISTS trg_calls_daily_ai AFTER INSERT ON calls BEGIN
  DELETE FROM calls_daily
   WHERE user_id = NEW.user_id AND day = date(NEW.called_at, '+330 minutes');
  INSERT INTO calls_daily (user_id, day, dials, connects, unique_leads)
    SELECT user_id, date(called_at, '+330 minutes'), COUNT(*),
           SUM(disposition = 'connected'), COUNT(DISTINCT lead_id)
      FROM calls
     WHERE user_id = NEW.user_id
       AND called_at >= strftime('%Y-%m-%dT%H:%M:%fZ', date(NEW.called_at, '+330 minutes'), '-330 minutes')
       AND called_at <  strftime('%Y-%m-%dT%H:%M:%fZ', date(NEW.called_at, '+330 minutes'), '+1 day', '-330 minutes')
       AND date(called_at, '+330 minutes') = date(NEW.called_at, '+330 minutes')
       AND (auto_logged = 0 OR disposition = 'connected')
       AND source != 'whatsapp'
     GROUP BY user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_calls_daily_au
AFTER UPDATE OF user_id, called_at, disposition, auto_logged, source, lead_id ON calls BEGIN
  DELETE FROM calls_daily
   WHERE user_id = OLD.user_id AND day = date(OLD.called_at, '+330 minutes');
  INSERT INTO calls_daily (user_id, day, dials, connects, unique_leads)
    SELECT user_id, date(called_at, '+330 minutes'), COUNT(*),
           SUM(disposition = 'connected'), COUNT(DISTINCT lead_id)
      FROM calls
     WHERE user_id = OLD.user_id
       AND called_at >= strftime('%Y-%m-%dT%H:%M:%fZ', date(OLD.called_at, '+330 minutes'), '-330 minutes')
       AND called_at <  strftime('%Y-%m-%dT%H:%M:%fZ', date(OLD.called_at, '+330 minutes'), '+1 day', '-330 minutes')
       AND date(called_at, '+330 minutes') = date(OLD.called_at, '+330 minutes')
       AND (auto_logged = 0 OR disposition = 'connected')
       AND source != 'whatsapp'
     GROUP BY user_id;
  DELETE FROM calls_daily
   WHERE user_id = NEW.user_id AND day = date(NEW.called_at, '+330 minutes');
  INSERT INTO calls_daily (user_id, day, dials, connects, unique_leads)
    SELECT user_id, date(called_at, '+330 minutes'), COUNT(*),
           SUM(disposition = 'connected'), COUNT(DISTINCT lead_id)
      FROM calls
     WHERE user_id = NEW.user_id
       AND called_at >= strftime('%Y-%m-%dT%H:%M:%fZ', date(NEW.called_at, '+330 minutes'), '-330 minutes')
       AND called_at <  strftime('%Y-%m-%dT%H:%M:%fZ', date(NEW.called_at, '+330 minutes'), '+1 day', '-330 minutes')
       AND date(called_at, '+330 minutes') = date(NEW.called_at, '+330 minutes')
       AND (auto_logged = 0 OR disposition = 'connected')
       AND source != 'whatsapp'
     GROUP BY user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_calls_daily_ad AFTER DELETE ON calls BEGIN
  DELETE FROM calls_daily
   WHERE user_id = OLD.user_id AND day = date(OLD.called_at, '+330 minutes');
  INSERT INTO calls_daily (user_id, day, dials, connects, unique_leads)
    SELECT user_id, date(called_at, '+330 minutes'), COUNT(*),
           SUM(disposition = 'connected'), COUNT(DISTINCT lead_id)
      FROM calls
     WHERE user_id = OLD.user_id
       AND called_at >= strftime('%Y-%m-%dT%H:%M:%fZ', date(OLD.called_at, '+330 minutes'), '-330 minutes')
       AND called_at <  strftime('%Y-%m-%dT%H:%M:%fZ', date(OLD.called_at, '+330 minutes'), '+1 day', '-330 minutes')
       AND date(called_at, '+330 minutes') = date(OLD.called_at, '+330 minutes')
       AND (auto_logged = 0 OR disposition = 'connected')
       AND source != 'whatsapp'
     GROUP BY user_id;
END;

-- Backfill as a full rebuild (idempotent). One GROUP BY over calls.
DELETE FROM calls_daily;
INSERT INTO calls_daily (user_id, day, dials, connects, unique_leads)
  SELECT user_id, date(called_at, '+330 minutes') AS day, COUNT(*),
         SUM(disposition = 'connected'), COUNT(DISTINCT lead_id)
    FROM calls
   WHERE (auto_logged = 0 OR disposition = 'connected')
     AND source != 'whatsapp'
     AND date(called_at, '+330 minutes') IS NOT NULL
   GROUP BY user_id, day;
