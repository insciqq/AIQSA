-- The first turn of each continued chat stored before this release takes the kind the previous migration added
-- (`lib/contracts/chatContinuation.ts`), read from the durable continuation records alone. A turn is recognized only
-- where a completed continuation names its chat, and only exactly as that continuation wrote it: the chat's root user
-- turn with the prompt's exact text, no kind and no scheduled task, whose answer is the summary written with it (its
-- one text block under the summary's heading, no model and no run). A root turn the user wrote by editing the prompt,
-- even to the same words, is answered by a run of its own, so it stays the user's.
--
-- Not recognized, so their first turn stays an ordinary one: a continued chat whose source chat was deleted (its
-- record went with the source), and a branch copy made of a continued chat before this release (a copy keeps no link to
-- a turn that had no run). Nothing else changes: no other column or row, no active leaf, run or accepted request.
UPDATE "Message" AS prompt
SET "systemTurnKind" = 'conversation_summary'
FROM "ChatContinuation" AS continuation
WHERE continuation."status" = 'complete'
  AND continuation."newChatId" = prompt."chatId"
  AND prompt."role" = 'user'
  AND prompt."parentMessageId" IS NULL
  AND prompt."systemTurnKind" IS NULL
  AND prompt."scheduledTaskPrompt" = false
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
  );
