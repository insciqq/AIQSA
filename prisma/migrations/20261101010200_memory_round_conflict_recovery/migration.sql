-- P2002 was logged as unknown because its content-free code was not registered.
-- The stored code identifies these failed commits. Release them once; normal
-- backfill rechecks the current owner, settings, source, pauses and suppressions.
-- Keep the failure evidence until that path actually admits a retry.
UPDATE "MemoryJob"
SET "state" = 'STALE'::"MemoryJobState",
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'INDEX_HISTORY'::"MemoryJobKind"
  AND "state" = 'TERMINAL_FAILED'::"MemoryJobState"
  AND "pipelineVersion" = 'memory-history-incremental-v10'
  AND "stage" = 'lexical_apply'
  AND "errorCode" = 'memory_job_commit_database_p2002';
