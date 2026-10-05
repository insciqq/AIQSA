export const SCHEDULED_TASK_MEMORY_MIGRATION = "20261004190000_scheduled_task_memory";

// A task saved before the Memory switch existed. Explicit columns keep the
// fixture valid when later migrations add columns.
export const scheduledTaskMemoryFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('task-memory-owner', 'Synthetic owner', 'active', now());
INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "timeZone", "modelId", provider,
  "nextRunAt", "updatedAt")
VALUES ('task-memory-existing', 'task-memory-owner', 'Synthetic brief', 'Synthetic scheduled prompt', 'DAILY', 540,
  'Europe/Moscow', 'synthetic-model', 'synthetic-provider', now(), now());
`;

export const scheduledTaskMemoryProofSql = `
DO $$ BEGIN
  -- An existing task keeps running without Memory.
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTask" WHERE id = 'task-memory-existing' AND NOT "memoryEnabled")
    THEN RAISE EXCEPTION 'scheduled_task_memory_existing_enabled'; END IF;
  -- So does a task a previous-release writer saves during the upgrade.
  INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "timeZone", "modelId", provider,
    "nextRunAt", "updatedAt")
  VALUES ('task-memory-previous-writer', 'task-memory-owner', 'Synthetic note', 'Synthetic scheduled prompt', 'DAILY', 600,
    'Europe/Moscow', 'synthetic-model', 'synthetic-provider', now(), now());
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTask" WHERE id = 'task-memory-previous-writer' AND NOT "memoryEnabled")
    THEN RAISE EXCEPTION 'scheduled_task_memory_default_enabled'; END IF;
END $$;
`;
