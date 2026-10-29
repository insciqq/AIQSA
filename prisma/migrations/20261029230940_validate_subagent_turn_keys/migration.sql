-- Validates the turn-key checks `20261029230930_subagent_turn_keys` added NOT
-- VALID. VALIDATE CONSTRAINT scans under a lock that lets reads and writes go
-- on, and every existing row has neither key, so both checks hold.
ALTER TABLE "RunTranscriptItem" VALIDATE CONSTRAINT "RunTranscriptItem_subagent_turn_check";
ALTER TABLE "ModelRunToolCall" VALIDATE CONSTRAINT "ModelRunToolCall_subagent_turn_check";
