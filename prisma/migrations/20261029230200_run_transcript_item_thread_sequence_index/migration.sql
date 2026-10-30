-- Each sub-agent thread of a run keeps its own transcript sequence, and NULLS
-- NOT DISTINCT keeps the main agent's (no thread) unique per run as before.
-- RunTranscriptItem is a large live table, so the index is built CONCURRENTLY
-- and stays the only statement of this file (Persistence, Migrations And
-- Bootstrap); the old key is dropped once this one exists
-- (`20261029230600_drop_run_transcript_item_sequence_index`).
CREATE UNIQUE INDEX CONCURRENTLY "RunTranscriptItem_thread_sequence_key" ON "RunTranscriptItem"("modelRunId", "subagentThreadId", "sequence") NULLS NOT DISTINCT;
