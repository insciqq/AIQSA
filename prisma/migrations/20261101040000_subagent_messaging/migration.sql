-- Agents of a chat write to each other through `RunFollowup` (operator decisions
-- 2026-10-31, `lib/server/runs/subagentBackground/store.ts`). A sub-agent's
-- message or question to the main agent is one of its run's own follow-ups. A
-- message to a sub-agent, foreground or background, names that turn and sits on
-- the run hosting it, above the 96 ordinals of the run's own follow-ups: it never
-- moves the revision an answer closes at, and an unread one never holds a run's
-- completion.
ALTER TYPE "RunFollowupOrigin" ADD VALUE 'subagent_message';
ALTER TYPE "RunFollowupOrigin" ADD VALUE 'subagent_question';

-- A turn waiting for an answer owes its question the way an ended one owes its
-- callback, and `callbackRunId` claims it the same way.
--
-- Widen only: every existing row satisfies the narrower old checks, and the
-- previous release's writers never reach the new values, ordinals or claims. The
-- checks are replaced NOT VALID, so these live tables are not scanned under this
-- lock; `20261101040100_validate_subagent_messaging` validates them.
ALTER TABLE "RunFollowup" DROP CONSTRAINT "RunFollowup_bounds",
  ADD CONSTRAINT "RunFollowup_bounds" CHECK (
    ("ordinal" BETWEEN 1 AND 96 OR ("ordinal" > 96 AND "subagentTurnId" IS NOT NULL)) AND
    length(btrim("text")) > 0 AND length("text") <= 16000
  ) NOT VALID;

ALTER TABLE "RunFollowup" DROP CONSTRAINT "RunFollowup_subagent_turn_check",
  ADD CONSTRAINT "RunFollowup_subagent_turn_check" CHECK (
    ("origin" <> 'subagent_callback' OR "subagentTurnId" IS NOT NULL) AND
    ("origin" <> 'user' OR "subagentTurnId" IS NULL)
  ) NOT VALID;

ALTER TABLE "SubagentTurn" DROP CONSTRAINT "SubagentTurn_state_check",
  ADD CONSTRAINT "SubagentTurn_state_check" CHECK (
    ("state" IN ('running', 'waiting')) = ("endedAt" IS NULL)
    AND ("state" = 'done') = ("outcome" IS NOT NULL)
    AND ("outcome" IS DISTINCT FROM 'blocked' OR "reasonCode" IS NOT NULL)
    AND ("state" <> 'failed' OR "reasonCode" IS NOT NULL)
    AND ("callbackRunId" IS NULL OR ("mode" = 'background' AND ("endedAt" IS NOT NULL OR "state" = 'waiting')))
    AND ("result" IS NULL OR jsonb_typeof("result") = 'object')
    AND ("endedAt" IS NULL OR "endedAt" >= "startedAt")
  ) NOT VALID;

-- Only the run's own follow-ups can hold its completion: a mailbox message its
-- turn never read stays for the thread's next turn.
CREATE OR REPLACE FUNCTION aiqsa_run_followup_completion_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."followupRevision" > 0 AND
    (NEW."status" = 'complete' OR NEW."answerCompletedAt" IS NOT NULL) AND
    (NEW."followupClosedAt" IS NULL OR EXISTS (
      SELECT 1 FROM "RunFollowup" WHERE "modelRunId" = NEW."id" AND "deliveredAt" IS NULL AND "ordinal" <= 96
    )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'run_followup_completion_conflict';
  END IF;
  RETURN NEW;
END;
$$;
