CREATE TABLE "ChatContinuation" (
  "id" TEXT NOT NULL,
  "sourceChatId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "snapshotUpdatedAt" TIMESTAMP(3) NOT NULL,
  "actorUserId" TEXT,
  "attemptId" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "errorCode" VARCHAR(64),
  "newChatId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatContinuation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatContinuation_status_check" CHECK (
    "status" IN ('running', 'complete', 'failed') AND
    ("status" = 'complete' OR "newChatId" IS NULL)
  ),
  CONSTRAINT "ChatContinuation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "ChatContinuation_sourceChatId_fkey" FOREIGN KEY ("sourceChatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ChatContinuation_sourceChatId_sourceMessageId_fkey" FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ChatContinuation_newChatId_fkey" FOREIGN KEY ("newChatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ChatContinuation_attemptId_key" ON "ChatContinuation"("attemptId");
CREATE UNIQUE INDEX "ChatContinuation_newChatId_key" ON "ChatContinuation"("newChatId");
CREATE UNIQUE INDEX "ChatContinuation_source_snapshot_key" ON "ChatContinuation"("sourceChatId", "sourceMessageId", "snapshotUpdatedAt");
CREATE INDEX "ChatContinuation_actorUserId_idx" ON "ChatContinuation"("actorUserId");
