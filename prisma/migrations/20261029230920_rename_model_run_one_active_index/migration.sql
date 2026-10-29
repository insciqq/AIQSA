-- The per-thread guard takes the old index's name, which the active-run
-- conflict mapping (`lib/server/runs/prismaRepositoryShared.ts`) and previous
-- releases recognize. Renaming an index takes only a brief lock on the index.
ALTER INDEX "ModelRun_one_active_per_thread_idx" RENAME TO "ModelRun_one_active_per_chat_idx";
