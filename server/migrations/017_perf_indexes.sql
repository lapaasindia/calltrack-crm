-- 017 — Performance indexes + operability tables (audit SCALE-1/2/3/14/22/23).
--
-- Additive only, and every index/table is IF NOT EXISTS so a partially applied
-- run (or an operator who created one of these by hand) never wedges boot.
-- The three ADD COLUMNs run inside the runner's transaction with the
-- user_version bump, so they're atomic with it. On a 92 MB / 200k-call
-- database this whole file applies in ~1 s.

-- payments.installment_id is an FK with no index: today.js payments_due and
-- refreshInstallmentStatus did a full payments scan per installment (SCALE-2).
CREATE INDEX IF NOT EXISTS idx_payments_installment ON payments(installment_id);

-- /collections' "next open installment per deal" needs (deal_id, status) —
-- without stats the planner picked idx_installments_due and rescanned every
-- pending installment per deal (12 s at 8k deals; SCALE-1).
CREATE INDEX IF NOT EXISTS idx_installments_deal_status ON installments(deal_id, status, due_date);

-- Company-wide calling stats (dashboard/reports/leaderboard) filter on a
-- called_at range with no user_id → were full scans of calls.
CREATE INDEX IF NOT EXISTS idx_calls_called_at ON calls(called_at);

-- Recording ↔ call matching looks up a user's mobile calls by call_log_ts.
CREATE INDEX IF NOT EXISTS idx_calls_user_log_ts_mobile
  ON calls(user_id, call_log_ts) WHERE source = 'mobile';

-- Leads list is ORDER BY updated_at DESC LIMIT/OFFSET over live rows: a temp
-- b-tree over the whole table per page (101 ms at page 500 → 0.5 ms).
CREATE INDEX IF NOT EXISTS idx_leads_updated_live ON leads(updated_at) WHERE deleted_at IS NULL;
-- Source filter + the DISTINCT source dropdown.
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

-- Review queues.
CREATE INDEX IF NOT EXISTS idx_recordings_captured ON recordings(captured_call_id);
CREATE INDEX IF NOT EXISTS idx_recordings_user ON recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_captured_phone_status ON captured_calls(phone, status);
CREATE INDEX IF NOT EXISTS idx_captured_user_ts ON captured_calls(user_id, call_log_ts);

-- WhatsApp unread/thread lookups by lead.
CREATE INDEX IF NOT EXISTS idx_wa_messages_lead ON wa_messages(lead_id);

-- Leaderboard / top performers (created_by, won_date) and the active-deal sums.
CREATE INDEX IF NOT EXISTS idx_deals_creator_won ON deals(created_by, won_date);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);

-- Which build applied which migration, and when (SCALE-14). The runner
-- backfills 001–016 as 'unrecorded' the first time it sees this table.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  app_version TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;

-- Named sequences (SCALE-23): invoice numbers come from here inside the same
-- transaction as the INSERT instead of a MAX() scan over every invoice.
-- Seeded from the highest existing INV-NNNNN so numbering continues unbroken.
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  next INTEGER NOT NULL CHECK (next >= 1)
) STRICT;
INSERT OR IGNORE INTO counters (name, next)
  SELECT 'invoice', COALESCE(MAX(CAST(SUBSTR(invoice_number, 5) AS INTEGER)), 0) + 1
    FROM invoices WHERE invoice_number LIKE 'INV-%';

-- Task timer: the server owns the start instant (SCALE-22) so stop is
-- idempotent and can't be fed a client-chosen start.
ALTER TABLE tasks ADD COLUMN timer_started_at TEXT;

-- Why a follow-up / task was auto-cancelled by the nightly sweep (SCALE-6):
-- 'lead_lost' | 'lead_deleted' | 'assignee_deactivated'. NULL for manual.
ALTER TABLE follow_ups ADD COLUMN cancel_reason TEXT;
ALTER TABLE tasks ADD COLUMN cancel_reason TEXT;

-- Invoices are soft-cancelled, never hard-deleted (QA-4): a GST invoice
-- number must stay in the sequence forever, so DELETE marks the row
-- cancelled + deleted_at and the counter above never hands the number out
-- again. Lists/detail hide deleted rows.
ALTER TABLE invoices ADD COLUMN deleted_at TEXT;
