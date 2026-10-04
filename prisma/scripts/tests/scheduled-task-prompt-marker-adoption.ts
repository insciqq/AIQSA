export const SCHEDULED_TASK_PROMPT_MARKER_MIGRATION = "20261004150000_scheduled_task_prompt_marker";

// A chat with a scheduled run (origin values only, no task row needed) and an
// ordinary chat. Explicit columns keep the fixture valid when later
// migrations add columns.
export const scheduledTaskPromptMarkerFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('prompt-marker-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('prompt-marker-task-chat', 'prompt-marker-owner', 'Synthetic task chat', now()),
       ('prompt-marker-plain-chat', 'prompt-marker-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('prompt-marker-prompt', 'prompt-marker-task-chat', 'user', 'complete', '{"text":"Synthetic task prompt"}', NULL, now()),
       ('prompt-marker-answer', 'prompt-marker-task-chat', 'assistant', 'streaming', '{"text":""}', 'prompt-marker-prompt', now()),
       ('prompt-marker-question', 'prompt-marker-plain-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
       ('prompt-marker-reply', 'prompt-marker-plain-chat', 'assistant', 'streaming', '{"text":""}', 'prompt-marker-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", "scheduledTaskId", "scheduledOccurrenceId", "scheduledTaskGeneration", "updatedAt")
VALUES ('prompt-marker-scheduled-run', 'prompt-marker-task-chat', 'prompt-marker-owner', 'prompt-marker-prompt',
        'prompt-marker-answer', 'fake', 'synthetic-model', 'streaming', '{"toolMode":"auto"}',
        'prompt-marker-task', 'prompt-marker-occurrence', 1, now()),
       ('prompt-marker-plain-run', 'prompt-marker-plain-chat', 'prompt-marker-owner', 'prompt-marker-question',
        'prompt-marker-reply', 'fake', 'synthetic-model', 'streaming', '{"toolMode":"auto"}', NULL, NULL, NULL, now());
`;

export const scheduledTaskPromptMarkerProofSql = `
DO $$ BEGIN
  -- Only the scheduled run's user message is backfilled as a task prompt.
  IF (SELECT array_agg(id ORDER BY id) FROM "Message" WHERE "scheduledTaskPrompt") IS DISTINCT FROM
    ARRAY['prompt-marker-prompt']
    THEN RAISE EXCEPTION 'prompt_marker_backfill_mismatch'; END IF;
  -- Only user messages may carry it.
  BEGIN
    UPDATE "Message" SET "scheduledTaskPrompt" = true WHERE id = 'prompt-marker-answer';
    RAISE EXCEPTION 'prompt_marker_accepts_assistant';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
`;
