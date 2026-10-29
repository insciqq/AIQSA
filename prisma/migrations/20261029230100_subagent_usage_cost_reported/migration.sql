-- A sub-agent's model calls report their provider charge as an answer's do
-- (OpenRouter), so a `subagent` row may keep that cost settled too. It names
-- the enum value `20261029230000_subagent_contracts` added, which PostgreSQL
-- allows only after that migration's transaction committed. Existing rows and
-- previous-release writers are `chat_answer` or not reported, so the wider
-- check holds at once.
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_cost_reported_answer_check",
  ADD CONSTRAINT "UsageEvent_cost_reported_answer_check" CHECK (NOT "costReported" OR "purpose" IN ('chat_answer', 'subagent'));
