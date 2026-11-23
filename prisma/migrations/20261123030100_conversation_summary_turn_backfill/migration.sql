-- The first turn of each continued chat stored before this release takes the kind the previous migration added
-- (`lib/contracts/chatContinuation.ts`), recognized by the pair the continuation wrote, exactly as it wrote it, so that
-- no continuation record is needed: deleting the source chat deletes its record, and a branch copy never had one. The
-- pair is a root user turn with the prompt's exact text, no kind, no scheduled task and no model, whose answer is the
-- summary written with it: its one text block under the summary's heading, with no model, no run and no run it was
-- copied from. A branch copy of a continued chat copies that pair as it is, so its first turn is recognized too.
--
-- A branch copy made while a regenerated summary was the active answer copied that answer, which names the run it came
-- from (`branchSourceModelRunId`): its first turn is recognized when that run answered a prompt recognized above. A root
-- turn the user wrote by editing the prompt, even to the same words, names the model of the run that answered it, and
-- that answer is the run's own, so it stays the user's, in its chat and in a copy of it.
--
-- Past-chat search indexes such a turn's answer without the turn's text, so each chat whose turn changed here is marked
-- for the indexer as an interactive change marks it (`lib/server/chatSearch/index/dirty.ts`): only a state row it already
-- has moves forward and loses its backoff; no row is created. Nothing else changes: no other column or row, no active
-- leaf, run or accepted request.
WITH "generated" AS (
  SELECT prompt."id"
  FROM "Message" AS prompt
  WHERE prompt."role" = 'user'
    AND prompt."parentMessageId" IS NULL
    AND prompt."systemTurnKind" IS NULL
    AND prompt."scheduledTaskPrompt" = false
    AND prompt."provider" IS NULL
    AND prompt."modelId" IS NULL
    AND prompt."content" = '{"blocks":[{"type":"text","text":"Continue from the conversation summary below."}]}'::jsonb
    AND EXISTS (
      SELECT 1
      FROM "Message" AS summary
      WHERE summary."chatId" = prompt."chatId"
        AND summary."parentMessageId" = prompt."id"
        AND summary."role" = 'assistant'
        AND summary."status" = 'complete'
        AND summary."provider" IS NULL
        AND summary."modelId" IS NULL
        AND summary."branchSourceModelRunId" IS NULL
        -- Path reads, which yield null rather than fail on a content of another shape.
        AND summary."content" #>> '{blocks,0,type}' = 'text'
        AND summary."content" #> '{blocks,1}' IS NULL
        AND starts_with(summary."content" #>> '{blocks,0,text}', E'Conversation summary\n\n')
        AND NOT EXISTS (SELECT 1 FROM "ModelRun" AS run WHERE run."assistantMessageId" = summary."id")
    )
), "copied" AS (
  SELECT copy."id"
  FROM "Message" AS copy
  WHERE copy."role" = 'user'
    AND copy."parentMessageId" IS NULL
    AND copy."systemTurnKind" IS NULL
    AND copy."scheduledTaskPrompt" = false
    AND copy."provider" IS NULL
    AND copy."modelId" IS NULL
    AND copy."content" = '{"blocks":[{"type":"text","text":"Continue from the conversation summary below."}]}'::jsonb
    AND EXISTS (
      SELECT 1
      FROM "Message" AS answer
      JOIN "ModelRun" AS run ON run."id" = answer."branchSourceModelRunId"
      JOIN "generated" ON "generated"."id" = run."userMessageId"
      WHERE answer."chatId" = copy."chatId"
        AND answer."parentMessageId" = copy."id"
        AND answer."role" = 'assistant'
    )
), "backfilled" AS (
  UPDATE "Message" AS prompt
  SET "systemTurnKind" = 'conversation_summary'
  WHERE prompt."id" IN (SELECT "id" FROM "generated" UNION SELECT "id" FROM "copied")
  RETURNING prompt."chatId"
)
UPDATE "ChatSearchState" AS state
SET "dirtyAt" = GREATEST(clock_timestamp()::timestamp(3), state."dirtyAt" + interval '1 millisecond'),
  "nextAttemptAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE state."chatId" IN (SELECT "chatId" FROM "backfilled");
