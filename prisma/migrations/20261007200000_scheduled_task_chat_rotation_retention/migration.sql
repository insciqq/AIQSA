-- Scheduled task chat rotation and history retention. Nullable or defaulted
-- columns and one new table only, so previous-release writers keep working:
-- existing tasks keep their history forever (null retention, never deleted)
-- and their current chat (a null period adopts the month of its next run),
-- and existing chats get no task origin.

-- The retention choice and its deleted-chat count, the chat epoch that fences
-- links and baselines across a rotation, and the month the current chat takes.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "historyRetentionDays" INTEGER,
  ADD COLUMN "historyDeletedChats" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chatEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chatPeriod" VARCHAR(7),
  ADD CONSTRAINT "ScheduledTask_history_check" CHECK (
    ("historyRetentionDays" IS NULL OR "historyRetentionDays" IN (30, 90, 365))
    AND "historyDeletedChats" >= 0 AND "chatEpoch" >= 0
    AND ("chatPeriod" IS NULL OR "chatPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  );

-- The epoch a run's admission linked the occurrence under.
ALTER TABLE "ScheduledTaskOccurrence"
  ADD COLUMN "chatEpoch" INTEGER,
  ADD CONSTRAINT "ScheduledTaskOccurrence_chat_epoch_check" CHECK ("chatEpoch" IS NULL OR "chatEpoch" >= 0);

-- A chat's task origin and the owner's rename or restore that keeps it from
-- retention. Task deletion clears only the origin, never the owner. The index
-- on the origin is built CONCURRENTLY by the next migration.
ALTER TABLE "Chat"
  ADD COLUMN "scheduledTaskId" TEXT,
  ADD COLUMN "ownerKeptAt" TIMESTAMP(3);
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_scheduledTaskId_fkey"
  FOREIGN KEY ("userId", "scheduledTaskId") REFERENCES "ScheduledTask"("userId", "id")
  ON DELETE SET NULL ("scheduledTaskId") ON UPDATE RESTRICT;

-- A Workspace seed a task's rotation captured; task deletion leaves an
-- ordinary continuation seed.
ALTER TABLE "ChatContinuationWorkspaceSeed" ADD COLUMN "scheduledTaskId" TEXT;
ALTER TABLE "ChatContinuationWorkspaceSeed" ADD CONSTRAINT "ChatContinuationWorkspaceSeed_scheduledTaskId_fkey"
  FOREIGN KEY ("scheduledTaskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
CREATE INDEX "ChatContinuationWorkspaceSeed_scheduledTaskId_status_idx"
  ON "ChatContinuationWorkspaceSeed"("scheduledTaskId", "status");

-- The frozen copy of a task's previous shown result that its new chat's runs
-- see: owner-consistent, and gone with the task, its source chat or answer.
CREATE TABLE "ScheduledTaskCarryover" (
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatEpoch" INTEGER NOT NULL,
  "taskGeneration" INTEGER NOT NULL,
  "sourceChatId" TEXT NOT NULL,
  "sourceAssistantMessageId" TEXT NOT NULL,
  "answerText" TEXT NOT NULL,
  "reliedServerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledTaskCarryover_pkey" PRIMARY KEY ("taskId"),
  CONSTRAINT "ScheduledTaskCarryover_check" CHECK (
    "chatEpoch" > 0 AND "taskGeneration" > 0
    AND char_length("answerText") BETWEEN 1 AND 100000
    AND cardinality("reliedServerIds") <= 256 AND array_position("reliedServerIds", NULL) IS NULL
  )
);
CREATE UNIQUE INDEX "ScheduledTaskCarryover_userId_taskId_key" ON "ScheduledTaskCarryover"("userId", "taskId");
CREATE INDEX "ScheduledTaskCarryover_source_answer_idx"
  ON "ScheduledTaskCarryover"("sourceChatId", "sourceAssistantMessageId");
ALTER TABLE "ScheduledTaskCarryover" ADD CONSTRAINT "ScheduledTaskCarryover_userId_taskId_fkey"
  FOREIGN KEY ("userId", "taskId") REFERENCES "ScheduledTask"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskCarryover" ADD CONSTRAINT "ScheduledTaskCarryover_userId_sourceChatId_fkey"
  FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskCarryover" ADD CONSTRAINT "ScheduledTaskCarryover_source_answer_fkey"
  FOREIGN KEY ("sourceChatId", "sourceAssistantMessageId") REFERENCES "Message"("chatId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
