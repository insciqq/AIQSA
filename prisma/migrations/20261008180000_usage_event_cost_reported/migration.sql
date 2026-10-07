-- Run answer rows whose cost is the charge the provider reported for their
-- calls (OpenRouter): the run's rewrites and recovery keep that cost instead of
-- pricing the row from token prices again. Expand only: existing rows and
-- previous-release writers stay false.
ALTER TABLE "UsageEvent"
  ADD COLUMN "costReported" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "UsageEvent_cost_reported_answer_check" CHECK (NOT "costReported" OR "purpose" = 'chat_answer');
