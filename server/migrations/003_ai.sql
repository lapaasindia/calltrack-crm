-- Local AI layer: transcription + field/follow-up extraction. Runs fully on
-- the office Mac (whisper.cpp + Ollama). recordings already has transcript,
-- summary, ai_json, ai_status (from migration 002) — this adds the suggestion
-- store so AI output is reviewed and accepted, never silently written to leads.

-- One row per AI-proposed change to a lead. The caller accepts or dismisses.
CREATE TABLE ai_suggestions (
  id            INTEGER PRIMARY KEY,
  recording_id  INTEGER NOT NULL REFERENCES recordings(id),
  lead_id       INTEGER REFERENCES leads(id),
  kind          TEXT NOT NULL CHECK (kind IN ('field','follow_up','task')),
  field         TEXT,            -- for kind='field': city|email|notes|interest
  value         TEXT,            -- proposed value (text, or ISO/date for follow_up/task)
  label         TEXT NOT NULL,   -- human-readable description of the suggestion
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','dismissed')),
  acted_by      INTEGER REFERENCES users(id),
  acted_at      TEXT,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_ai_suggestions_status ON ai_suggestions(status, created_at);
CREATE INDEX idx_ai_suggestions_lead ON ai_suggestions(lead_id, status);

-- AI settings (engine on/off, language). Stored in the existing settings table
-- via getSetting/setSetting; no schema needed here.
