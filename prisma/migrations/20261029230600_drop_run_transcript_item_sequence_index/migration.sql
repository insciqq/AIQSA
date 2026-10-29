-- The per-run sequence key gives way to the per-thread one
-- (`20261029230200_run_transcript_item_thread_sequence_index`), which keeps
-- the main agent's sequence unique. Dropped CONCURRENTLY as the only
-- statement of this file, so readers and writers of this large live table
-- never wait on an exclusive lock.
DROP INDEX CONCURRENTLY "RunTranscriptItem_modelRunId_sequence_key";
