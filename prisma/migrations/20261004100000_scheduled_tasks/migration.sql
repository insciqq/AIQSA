-- Scheduled tasks: owner-edited prompts that the runner posts into personal
-- chats, plus their content-free occurrence history. New tables and new
-- nullable run columns only; previous-release writers never touch them.
CREATE TYPE "ScheduledTaskScheduleKind" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'HOURLY');
CREATE TYPE "ScheduledTaskChatMode" AS ENUM ('NEW', 'SAME');
CREATE TYPE "ScheduledTaskStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');
CREATE TYPE "ScheduledTaskOccurrenceState" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

CREATE TABLE "ScheduledTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "prompt" TEXT NOT NULL,
  "scheduleKind" "ScheduledTaskScheduleKind" NOT NULL,
  "timeOfDayMinutes" INTEGER NOT NULL,
  "daysOfWeekMask" INTEGER NOT NULL DEFAULT 0,
  "dayOfMonth" INTEGER,
  "onceLocalDate" VARCHAR(10),
  "everyHours" INTEGER,
  "untilMinutes" INTEGER,
  "timeZone" VARCHAR(64) NOT NULL,
  "modelId" VARCHAR(256) NOT NULL,
  "provider" VARCHAR(256) NOT NULL,
  "searchEnabled" BOOLEAN NOT NULL DEFAULT false,
  "emailNotify" BOOLEAN NOT NULL DEFAULT false,
  "chatMode" "ScheduledTaskChatMode" NOT NULL DEFAULT 'NEW',
  "status" "ScheduledTaskStatus" NOT NULL DEFAULT 'ACTIVE',
  "pauseReason" VARCHAR(64),
  "nextRunAt" TIMESTAMP(3),
  "chatId" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "baselineRunId" TEXT,
  "baselineUserMessageId" TEXT,
  "baselineAssistantMessageId" TEXT,
  "baselineGeneration" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledTask_text_check" CHECK (
    char_length(btrim("title")) > 0 AND char_length("prompt") BETWEEN 1 AND 8000
    AND char_length("modelId") > 0 AND char_length("provider") > 0
    AND "timeZone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
  ),
  -- Exactly the columns of the schedule kind are set; the application owns
  -- calendar validity and the wall-clock interpretation. An hourly window
  -- starts at "timeOfDayMinutes" and ends inclusively after it, or runs
  -- through the end of the day.
  CONSTRAINT "ScheduledTask_schedule_check" CHECK (
    "timeOfDayMinutes" BETWEEN 0 AND 1439 AND CASE "scheduleKind"
      WHEN 'ONCE'::"ScheduledTaskScheduleKind" THEN "onceLocalDate" IS NOT NULL
        AND "onceLocalDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "dayOfMonth" IS NULL AND "daysOfWeekMask" = 0
        AND "everyHours" IS NULL AND "untilMinutes" IS NULL
      WHEN 'WEEKLY'::"ScheduledTaskScheduleKind" THEN "onceLocalDate" IS NULL AND "dayOfMonth" IS NULL
        AND "daysOfWeekMask" BETWEEN 1 AND 127 AND "everyHours" IS NULL AND "untilMinutes" IS NULL
      WHEN 'MONTHLY'::"ScheduledTaskScheduleKind" THEN "onceLocalDate" IS NULL AND "dayOfMonth" IS NOT NULL
        AND "dayOfMonth" BETWEEN 1 AND 31 AND "daysOfWeekMask" = 0 AND "everyHours" IS NULL AND "untilMinutes" IS NULL
      WHEN 'HOURLY'::"ScheduledTaskScheduleKind" THEN "onceLocalDate" IS NULL AND "dayOfMonth" IS NULL
        AND "daysOfWeekMask" BETWEEN 1 AND 127 AND "everyHours" IN (1, 2, 3, 4, 6, 8, 12)
        AND ("untilMinutes" IS NULL OR "untilMinutes" BETWEEN "timeOfDayMinutes" + 1 AND 1439)
      ELSE "onceLocalDate" IS NULL AND "dayOfMonth" IS NULL AND "daysOfWeekMask" = 0
        AND "everyHours" IS NULL AND "untilMinutes" IS NULL
    END
  ),
  -- Only ACTIVE tasks are due, only once tasks complete, only automatic
  -- pauses carry a bounded lowercase reason code, and hourly tasks always
  -- continue in one chat.
  CONSTRAINT "ScheduledTask_state_check" CHECK (
    "revision" > 0 AND "generation" > 0 AND "consecutiveFailures" >= 0
    AND ("status" = 'ACTIVE'::"ScheduledTaskStatus" OR "nextRunAt" IS NULL)
    AND ("status" <> 'COMPLETED'::"ScheduledTaskStatus" OR "scheduleKind" = 'ONCE'::"ScheduledTaskScheduleKind")
    AND ("pauseReason" IS NULL OR (
      "status" = 'PAUSED'::"ScheduledTaskStatus" AND "pauseReason" ~ '^[a-z][a-z0-9_]{0,63}$'
    ))
    AND ("chatMode" = 'SAME'::"ScheduledTaskChatMode" OR "scheduleKind" <> 'HOURLY'::"ScheduledTaskScheduleKind")
  ),
  -- The baseline names one accepted result completely or not at all.
  CONSTRAINT "ScheduledTask_baseline_check" CHECK (
    ("baselineRunId" IS NULL) = ("baselineUserMessageId" IS NULL)
    AND ("baselineRunId" IS NULL) = ("baselineAssistantMessageId" IS NULL)
    AND ("baselineRunId" IS NULL) = ("baselineGeneration" IS NULL)
    AND ("baselineGeneration" IS NULL OR "baselineGeneration" > 0)
  )
);

CREATE TABLE "ScheduledTaskOccurrence" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trigger" VARCHAR(16) NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "state" "ScheduledTaskOccurrenceState" NOT NULL DEFAULT 'PENDING',
  "reasonCode" VARCHAR(64),
  "chatId" TEXT,
  "userMessageId" TEXT,
  "runId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  "taskGeneration" INTEGER,
  "unseenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledTaskOccurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledTaskOccurrence_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
  CONSTRAINT "ScheduledTaskOccurrence_reason_check" CHECK (
    "reasonCode" IS NULL OR "reasonCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  -- Only a settled occurrence finishes or carries an unread result.
  CONSTRAINT "ScheduledTaskOccurrence_finished_check" CHECK (
    ("state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState", 'FAILED'::"ScheduledTaskOccurrenceState",
      'SKIPPED'::"ScheduledTaskOccurrenceState")) = ("finishedAt" IS NOT NULL)
    AND ("unseenAt" IS NULL OR "finishedAt" IS NOT NULL)
    AND ("taskGeneration" IS NULL OR "taskGeneration" > 0)
  )
);

CREATE INDEX "ScheduledTask_status_nextRunAt_idx" ON "ScheduledTask"("status", "nextRunAt");
CREATE INDEX "ScheduledTask_userId_createdAt_idx" ON "ScheduledTask"("userId", "createdAt");
CREATE INDEX "ScheduledTask_chatId_idx" ON "ScheduledTask"("chatId");
CREATE UNIQUE INDEX "ScheduledTask_userId_id_key" ON "ScheduledTask"("userId", "id");
CREATE INDEX "ScheduledTaskOccurrence_taskId_scheduledFor_idx" ON "ScheduledTaskOccurrence"("taskId", "scheduledFor");
CREATE INDEX "ScheduledTaskOccurrence_state_leaseExpiresAt_idx" ON "ScheduledTaskOccurrence"("state", "leaseExpiresAt");
CREATE INDEX "ScheduledTaskOccurrence_chatId_idx" ON "ScheduledTaskOccurrence"("chatId");
CREATE INDEX "ScheduledTaskOccurrence_runId_idx" ON "ScheduledTaskOccurrence"("runId");
CREATE INDEX "ScheduledTaskOccurrence_userMessageId_idx" ON "ScheduledTaskOccurrence"("userMessageId");
CREATE UNIQUE INDEX "ScheduledTaskOccurrence_taskId_trigger_scheduledFor_key"
  ON "ScheduledTaskOccurrence"("taskId", "trigger", "scheduledFor");

-- Tasks and their history leave with the account. A task's chat and run
-- references must belong to the same owner (personal chats only); deleting the
-- chat, message or run clears only that reference column.
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_userId_chatId_fkey"
  FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
  ON DELETE SET NULL ("chatId") ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_userId_taskId_fkey"
  FOREIGN KEY ("userId", "taskId") REFERENCES "ScheduledTask"("userId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_userId_chatId_fkey"
  FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
  ON DELETE SET NULL ("chatId") ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_userMessageId_fkey"
  FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_userId_runId_fkey"
  FOREIGN KEY ("userId", "runId") REFERENCES "ModelRun"("userId", "id")
  ON DELETE SET NULL ("runId") ON UPDATE RESTRICT;

-- A run admitted for a scheduled occurrence keeps its origin as plain values,
-- without foreign keys, so deleting the task or its history leaves it intact.
ALTER TABLE "ModelRun"
  ADD COLUMN "scheduledTaskId" TEXT,
  ADD COLUMN "scheduledOccurrenceId" TEXT,
  ADD COLUMN "scheduledTaskGeneration" INTEGER,
  ADD CONSTRAINT "ModelRun_scheduled_origin_check" CHECK (
    ("scheduledTaskId" IS NULL) = ("scheduledOccurrenceId" IS NULL)
    AND ("scheduledTaskId" IS NULL) = ("scheduledTaskGeneration" IS NULL)
    AND ("scheduledTaskGeneration" IS NULL OR "scheduledTaskGeneration" > 0)
  );
