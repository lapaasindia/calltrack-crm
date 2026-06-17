-- Phase 2A — Lead scoring + AI call intelligence (hybrid).
-- Additive only: nullable typed columns (allowed on STRICT tables), plus two
-- recordings columns for the hybrid cloud-transcription path. No existing
-- column or constraint is touched, so every prior migration stays frozen.

-- Rule-based score (0-100) + the AI-derived intelligence fields. score and
-- score_factors are computed by server/lib/scoring.js after every call/stage
-- change; ai_* are derived from the linked recording's reviewed analysis.
ALTER TABLE leads ADD COLUMN score INTEGER;            -- 0..100 rule-based engagement score
ALTER TABLE leads ADD COLUMN score_factors TEXT;       -- JSON breakdown of how `score` was reached
ALTER TABLE leads ADD COLUMN ai_score INTEGER;         -- 0..100 derived from the call analysis
ALTER TABLE leads ADD COLUMN ai_intent TEXT;           -- Hot|Warm|Cold|Informational|Follow-up Required
ALTER TABLE leads ADD COLUMN ai_sentiment TEXT;        -- positive|neutral|negative|mixed
ALTER TABLE leads ADD COLUMN ai_rating TEXT;           -- JSON {clarity,engagement,conversion,overall}
ALTER TABLE leads ADD COLUMN ai_status_reason TEXT;    -- one-line why behind the AI intent
ALTER TABLE leads ADD COLUMN ai_analyzed_at TEXT;      -- UTC ISO of the most recent analysis

-- Hybrid transcription: which engine produced the transcript, and (for Sarvam)
-- the English translation alongside the original-language transcript.
ALTER TABLE recordings ADD COLUMN provider TEXT DEFAULT 'local';  -- local|sarvam
ALTER TABLE recordings ADD COLUMN translation TEXT;              -- English translation when cloud-transcribed
