-- A main-agent answer's follow-up revision and ordinals now carry the
-- callbacks of background sub-agents beside the user's own follow-ups, each
-- within its own bound (32 of the user's, 64 callbacks), so callbacks never
-- use up the user's follow-ups (`lib/server/runs/subagentBackground/store.ts`).
-- Widen only: every existing row stays within the old bound of 32, and the
-- previous release's writers never exceed it. The checks are replaced NOT
-- VALID, so these live tables are not scanned under this lock;
-- `20261030020100_validate_subagent_followup_bounds` validates them.
ALTER TABLE "ModelRun" DROP CONSTRAINT "ModelRun_followup_bounds",
  ADD CONSTRAINT "ModelRun_followup_bounds" CHECK (
    "followupRevision" BETWEEN 0 AND 96 AND "followupBudgetTokens" >= 0 AND
    "followupKnowledgeRevision" BETWEEN 0 AND "followupRevision" AND "followupKnowledgeOffset" BETWEEN 0 AND 8 AND
    ("followupMode" IS NULL OR "followupMode" IN ('chat', 'workspace', 'agent'))
  ) NOT VALID;

ALTER TABLE "RunFollowup" DROP CONSTRAINT "RunFollowup_bounds",
  ADD CONSTRAINT "RunFollowup_bounds" CHECK (
    "ordinal" BETWEEN 1 AND 96 AND length(btrim("text")) > 0 AND length("text") <= 16000
  ) NOT VALID;
