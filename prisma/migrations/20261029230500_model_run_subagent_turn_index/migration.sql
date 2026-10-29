-- One background run per sub-agent turn, and the index that deleting a turn
-- uses to find its run (`ModelRun_subagentTurn_fkey`). Main-agent runs have no
-- turn, and their NULLs stay distinct. ModelRun is a large live table, so the
-- index is built CONCURRENTLY and stays the only statement of this file
-- (Persistence, Migrations And Bootstrap).
CREATE UNIQUE INDEX CONCURRENTLY "ModelRun_subagentTurn_key" ON "ModelRun"("userId", "chatId", "subagentThreadId", "subagentTurnId");
