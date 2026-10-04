-- A user message a scheduled task posted (its prompt) carries that fact
-- itself, so a branch copy keeps it and every answer to it (the scheduled
-- run, a regeneration, an answer in a branch) is recognized without the
-- run's scheduled origin. Only user messages carry it. The check is valid at
-- once (every existing row starts false): validating it after the backfill
-- would fail on the pending events of the deferred Message triggers.
ALTER TABLE "Message"
  ADD COLUMN "scheduledTaskPrompt" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "Message_scheduled_task_prompt_check" CHECK (
    NOT "scheduledTaskPrompt" OR "role" = 'user'
  );

-- Existing prompts: the user message of every run with a scheduled origin.
UPDATE "Message" AS message
SET "scheduledTaskPrompt" = true
FROM "ModelRun" AS run
WHERE run."scheduledTaskId" IS NOT NULL
  AND message."chatId" = run."chatId"
  AND message."id" = run."userMessageId"
  AND message."role" = 'user'
  AND NOT message."scheduledTaskPrompt";
