-- Lookup of a scheduled task's chats for its history retention and for the
-- SET NULL of task deletion. Chat is a large live table, so the index is
-- built CONCURRENTLY and stays the only statement of this file (Persistence,
-- Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "Chat_scheduledTaskId_idx" ON "Chat"("scheduledTaskId");
