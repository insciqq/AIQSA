-- Validates the widened follow-up bounds `20261030020000_subagent_background_runs`
-- replaced NOT VALID. VALIDATE CONSTRAINT scans under a lock that lets reads
-- and writes go on, and every existing row is within the narrower old bounds.
ALTER TABLE "ModelRun" VALIDATE CONSTRAINT "ModelRun_followup_bounds";
ALTER TABLE "RunFollowup" VALIDATE CONSTRAINT "RunFollowup_bounds";
