export const SCHEDULED_TASK_CHAT_ROTATION_MIGRATION = "20261007200000_scheduled_task_chat_rotation_retention";

// A same-chat task, its chat and an occurrence saved before chat rotation and
// history retention existed. Explicit columns keep the fixture valid when
// later migrations add columns.
export const scheduledTaskChatRotationFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('task-rotation-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('task-rotation-chat', 'task-rotation-owner', 'Synthetic brief', now());
INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "timeZone", "modelId", provider,
  "chatMode", "chatId", "nextRunAt", "updatedAt")
VALUES ('task-rotation-existing', 'task-rotation-owner', 'Synthetic brief', 'Synthetic scheduled prompt', 'DAILY', 540,
  'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'SAME', 'task-rotation-chat', now(), now());
INSERT INTO "ScheduledTaskOccurrence" (id, "taskId", "userId", trigger, "scheduledFor")
VALUES ('task-rotation-occurrence', 'task-rotation-existing', 'task-rotation-owner', 'schedule', now());
`;

export const scheduledTaskChatRotationProofSql = `
DO $$ BEGIN
  -- An existing task keeps every chat forever and its current chat under the first epoch;
  -- the chat adopts the month of its next run instead of rotating at once.
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTask" WHERE id = 'task-rotation-existing' AND "historyRetentionDays" IS NULL
    AND "historyDeletedChats" = 0 AND "chatEpoch" = 0 AND "chatPeriod" IS NULL AND "chatId" = 'task-rotation-chat')
    THEN RAISE EXCEPTION 'scheduled_task_rotation_existing_task_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTaskOccurrence" WHERE id = 'task-rotation-occurrence' AND "chatEpoch" IS NULL)
    THEN RAISE EXCEPTION 'scheduled_task_rotation_existing_occurrence_changed'; END IF;
  -- Existing chats get no task origin, so no retention ever selects them.
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'task-rotation-chat' AND "scheduledTaskId" IS NULL AND "ownerKeptAt" IS NULL)
    THEN RAISE EXCEPTION 'scheduled_task_rotation_existing_chat_changed'; END IF;
  -- So does a task a previous-release writer saves during the upgrade.
  INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "timeZone", "modelId", provider,
    "nextRunAt", "updatedAt")
  VALUES ('task-rotation-previous-writer', 'task-rotation-owner', 'Synthetic note', 'Synthetic scheduled prompt', 'DAILY', 600,
    'Europe/Moscow', 'synthetic-model', 'synthetic-provider', now(), now());
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTask" WHERE id = 'task-rotation-previous-writer' AND "historyRetentionDays" IS NULL
    AND "chatEpoch" = 0) THEN RAISE EXCEPTION 'scheduled_task_rotation_previous_writer_retention'; END IF;
  -- Only the offered retention choices are stored.
  BEGIN
    UPDATE "ScheduledTask" SET "historyRetentionDays" = 60 WHERE id = 'task-rotation-existing';
    RAISE EXCEPTION 'scheduled_task_rotation_retention_unchecked';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Deleting a task leaves the chats it created as ordinary chats of their owner.
  UPDATE "Chat" SET "scheduledTaskId" = 'task-rotation-existing' WHERE id = 'task-rotation-chat';
  DELETE FROM "ScheduledTask" WHERE id = 'task-rotation-existing';
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'task-rotation-chat' AND "scheduledTaskId" IS NULL
    AND "userId" = 'task-rotation-owner') THEN RAISE EXCEPTION 'scheduled_task_rotation_origin_not_cleared'; END IF;
END $$;
`;
