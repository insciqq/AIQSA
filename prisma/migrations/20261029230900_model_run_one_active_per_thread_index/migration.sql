-- One active run per thread of a chat: a background sub-agent run (its
-- thread in "subagentThreadId") may run beside the main agent's answer, and
-- two runs of one thread never overlap. NULLS NOT DISTINCT keeps the main
-- agent's runs, which have no thread, one per chat exactly as the index it
-- replaces (`ModelRun_one_active_per_chat_idx`, dropped next and then renamed
-- to, so the guard is never missing while previous-release writers run).
-- ModelRun is a large live table, so the index is built CONCURRENTLY and stays
-- the only statement of this file (Persistence, Migrations And Bootstrap).
CREATE UNIQUE INDEX CONCURRENTLY "ModelRun_one_active_per_thread_idx" ON "ModelRun"("chatId", "subagentThreadId") NULLS NOT DISTINCT
  WHERE NOT "workspaceWaitPending" AND "status" IN ('preparing', 'queued', 'streaming', 'in_progress');
