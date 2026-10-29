-- A provider call id is unique per round of each sub-agent thread of a run,
-- and NULLS NOT DISTINCT keeps the main agent's (no thread) unique per run as
-- before. ModelRunToolCall is a large live table, so the index is built
-- CONCURRENTLY and stays the only statement of this file (Persistence,
-- Migrations And Bootstrap); the old key is dropped once this one exists
-- (`20261029230800_drop_model_run_tool_call_provider_call_index`).
CREATE UNIQUE INDEX CONCURRENTLY "ModelRunToolCall_thread_round_provider_call_key" ON "ModelRunToolCall"("modelRunId", "subagentThreadId", "roundIndex", "providerCallId") NULLS NOT DISTINCT;
