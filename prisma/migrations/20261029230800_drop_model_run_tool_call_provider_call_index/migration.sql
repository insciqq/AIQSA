-- The per-run provider call key gives way to the per-thread one
-- (`20261029230400_model_run_tool_call_thread_provider_call_index`), which
-- keeps the main agent's calls unique. Dropped CONCURRENTLY as the only
-- statement of this file, so readers and writers of this large live table
-- never wait on an exclusive lock.
DROP INDEX CONCURRENTLY "ModelRunToolCall_modelRunId_roundIndex_providerCallId_key";
