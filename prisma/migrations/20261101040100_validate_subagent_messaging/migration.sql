-- Validates the checks `20261101040000_subagent_messaging` replaced NOT VALID.
-- VALIDATE CONSTRAINT scans under a lock that lets reads and writes go on, and
-- every existing row is within the narrower old checks.
ALTER TABLE "RunFollowup" VALIDATE CONSTRAINT "RunFollowup_bounds";
ALTER TABLE "RunFollowup" VALIDATE CONSTRAINT "RunFollowup_subagent_turn_check";
ALTER TABLE "SubagentTurn" VALIDATE CONSTRAINT "SubagentTurn_state_check";
