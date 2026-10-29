-- The sub-agent turn of a transcript item or tool call, beside its thread: a
-- thread may run two turns in one answer, and the thread view and an answer's
-- nested steps tell them apart by this plain value (no foreign key, like the
-- thread key). Expand only: every existing row is the main agent's and stays
-- null. Adding a nullable column changes only the catalog; the checks are
-- added NOT VALID so these large live tables are not scanned under this
-- lock, and `20261029230940_validate_subagent_turn_keys` validates them.
ALTER TABLE "RunTranscriptItem" ADD COLUMN "subagentTurnId" TEXT,
  ADD CONSTRAINT "RunTranscriptItem_subagent_turn_check" CHECK ("subagentTurnId" IS NULL OR "subagentThreadId" IS NOT NULL) NOT VALID;

ALTER TABLE "ModelRunToolCall" ADD COLUMN "subagentTurnId" TEXT,
  ADD CONSTRAINT "ModelRunToolCall_subagent_turn_check" CHECK ("subagentTurnId" IS NULL OR "subagentThreadId" IS NOT NULL) NOT VALID;
