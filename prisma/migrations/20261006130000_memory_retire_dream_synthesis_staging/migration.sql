-- Retired Dream synthesis staging has no reader, and earlier releases already
-- scrubbed its provider output, so its rows go and this release stops cleaning
-- them up. The table, its guard and foreign keys stay until the next release:
-- a previous-release writer still deletes and scrubs these rows during Compose
-- replacement and never inserts one. Execution bindings and usage of the past
-- synthesis calls are not touched.
DELETE FROM "MemorySynthesisExecution";

-- Queued, retrying or waiting jobs of retired Dream synthesis close
-- content-free for every owner, as the previous release closed them for active
-- owners. A claimed one stays with its lease holder; maintenance, the only
-- remaining SYNTHESIZE_MEMORIES pipeline, cancels it at preflight.
UPDATE "MemoryJob"
SET
  "state" = 'CANCELLED'::"MemoryJobState",
  "completedAt" = CURRENT_TIMESTAMP,
  "errorCode" = 'memory_synthesis_retired',
  "errorMessage" = NULL,
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "nextAttemptAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
  AND "pipelineVersion" <> 'memory-maintenance-v1'
  AND "state" IN (
    'QUEUED'::"MemoryJobState",
    'RETRYABLE_FAILED'::"MemoryJobState",
    'WAITING_FOR_CONFIGURATION'::"MemoryJobState",
    'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
  );
