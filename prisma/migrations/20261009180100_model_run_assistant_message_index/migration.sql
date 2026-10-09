-- Deleting a message clears this SET NULL foreign key once per message, and
-- runs are joined by their answer (branch deletion, context compaction,
-- Workspace exports, Memory history). Without this index each clear scans
-- every run: deleting a 2,100-message chat among 41,000 runs took 19 s in
-- these clears alone. ModelRun is a large live table, so the index is built
-- CONCURRENTLY and stays the only statement of this file (Persistence,
-- Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "ModelRun_assistantMessageId_idx" ON "ModelRun"("assistantMessageId");
