-- The per-run ordinal key gives way to the per-thread one
-- (`20261029230300_model_run_tool_call_thread_ordinal_index`), which keeps the
-- main agent's calls unique. Dropped CONCURRENTLY as the only statement of
-- this file, so readers and writers of this large live table never wait on an
-- exclusive lock.
DROP INDEX CONCURRENTLY "ModelRunToolCall_modelRunId_roundIndex_ordinal_key";
