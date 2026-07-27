ALTER TABLE "SharedChatSnapshot" ADD COLUMN "chatId" TEXT;

ALTER TABLE "SharedChatSnapshot"
  ADD CONSTRAINT "SharedChatSnapshot_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SharedChatSnapshot_chatId_createdAt_idx" ON "SharedChatSnapshot"("chatId", "createdAt");
