-- The per-chat active run guard gives way to the per-thread one
-- (`20261029230900_model_run_one_active_per_thread_index`), which already
-- holds the main agent's runs to one per chat. Dropped CONCURRENTLY as the
-- only statement of this file, so writers of this large live table never wait
-- on an exclusive lock.
DROP INDEX CONCURRENTLY "ModelRun_one_active_per_chat_idx";
