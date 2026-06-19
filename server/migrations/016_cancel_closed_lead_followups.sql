-- One-time cleanup: a lead that was already moved to won/lost BEFORE the
-- changeStage() fix can still carry a pending follow-up, which keeps showing in
-- the Today queue / dashboard. Cancel those orphaned follow-ups so closed leads
-- stop appearing. New stage changes are handled in server/lib/leadStage.js.
UPDATE follow_ups
   SET status = 'cancelled'
 WHERE status = 'pending'
   AND lead_id IN (SELECT id FROM leads WHERE stage IN ('won', 'lost'));
