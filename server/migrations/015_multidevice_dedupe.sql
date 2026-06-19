-- Multi-device sync fix.
--
-- The two "reinstall-proof" dedupe indexes were keyed on user_id only, so when
-- TWO phones are paired to the same user, the second device's calls collided
-- with the first's and were silently dropped by ON CONFLICT DO NOTHING — leads
-- captured on one phone never appeared from the other.
--
-- Add device_id to both keys so each device is deduped only against its OWN
-- prior syncs. Reinstall-dedupe is preserved by /pair reusing the device_tokens
-- row per (user, android_id) — see server/routes/auth.js — so a reinstalled
-- phone keeps its device_id and still won't duplicate its history.
--
-- Rekeying is safe: rows unique under the old (broader) key stay unique under
-- the new (more specific) key, so no CREATE UNIQUE INDEX can fail on existing
-- data.

DROP INDEX IF EXISTS idx_captured_dedupe;
CREATE UNIQUE INDEX idx_captured_dedupe
  ON captured_calls(device_id, user_id, call_log_ts, phone);

DROP INDEX IF EXISTS idx_calls_mobile_dedupe;
CREATE UNIQUE INDEX idx_calls_mobile_dedupe
  ON calls(device_id, user_id, call_log_ts, lead_id) WHERE source = 'mobile';
