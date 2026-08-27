CREATE TYPE "MemoryEmbeddingBatchItemState" AS ENUM (
  'PENDING',
  'RESULT_READY',
  'SETTLED',
  'FAILED',
  'STALE',
  'OUTCOME_UNKNOWN'
);

CREATE TABLE "MemoryEmbeddingBatchItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryJobId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "searchEntryId" TEXT NOT NULL,
  "state" "MemoryEmbeddingBatchItemState" NOT NULL DEFAULT 'PENDING',
  "triggerIdentityHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64),
  "executionBindingId" TEXT,
  "acceptedOutputHash" CHAR(64),
  "resultVector" JSONB,
  "resultDimension" INTEGER,
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryEmbeddingBatchItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryEmbeddingBatchItem_ordinal_check"
    CHECK ("ordinal" >= 0 AND "ordinal" < 128),
  CONSTRAINT "MemoryEmbeddingBatchItem_hashes_check" CHECK (
    "triggerIdentityHash" ~ '^[a-f0-9]{64}$'
    AND ("inputHash" IS NULL OR "inputHash" ~ '^[a-f0-9]{64}$')
    AND (
      "acceptedOutputHash" IS NULL
      OR "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT "MemoryEmbeddingBatchItem_result_shape_check" CHECK (
    ("resultVector" IS NULL) = ("resultDimension" IS NULL)
    AND ("resultDimension" IS NULL OR "resultDimension" IN (1024, 1536))
    AND (
      "state" <> 'RESULT_READY'::"MemoryEmbeddingBatchItemState"
      OR (
        "inputHash" IS NOT NULL
        AND "executionBindingId" IS NOT NULL
        AND "acceptedOutputHash" IS NOT NULL
        AND "resultVector" IS NOT NULL
        AND jsonb_typeof("resultVector") = 'array'
        AND jsonb_array_length("resultVector") = "resultDimension"
      )
    )
    AND (
      "state" NOT IN (
        'SETTLED'::"MemoryEmbeddingBatchItemState",
        'FAILED'::"MemoryEmbeddingBatchItemState",
        'STALE'::"MemoryEmbeddingBatchItemState",
        'OUTCOME_UNKNOWN'::"MemoryEmbeddingBatchItemState"
      )
      OR "resultVector" IS NULL
    )
    AND (
      "state" <> 'SETTLED'::"MemoryEmbeddingBatchItemState"
      OR (
        "inputHash" IS NOT NULL
        AND "executionBindingId" IS NOT NULL
        AND "acceptedOutputHash" IS NOT NULL
        AND "completedAt" IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX "MemoryEmbeddingBatchItem_user_id_key"
  ON "MemoryEmbeddingBatchItem"("userId", "id");
CREATE UNIQUE INDEX "MemoryEmbeddingBatchItem_user_job_ordinal_key"
  ON "MemoryEmbeddingBatchItem"("userId", "memoryJobId", "ordinal");
CREATE UNIQUE INDEX "MemoryEmbeddingBatchItem_user_job_entry_key"
  ON "MemoryEmbeddingBatchItem"("userId", "memoryJobId", "searchEntryId");
CREATE UNIQUE INDEX "MemoryEmbeddingBatchItem_user_entry_trigger_key"
  ON "MemoryEmbeddingBatchItem"(
    "userId", "searchEntryId", "triggerIdentityHash"
  );
CREATE INDEX "MemoryEmbeddingBatchItem_user_job_state_idx"
  ON "MemoryEmbeddingBatchItem"("userId", "memoryJobId", "state");
CREATE INDEX "MemoryEmbeddingBatchItem_user_entry_state_idx"
  ON "MemoryEmbeddingBatchItem"("userId", "searchEntryId", "state");
CREATE INDEX "MemoryEmbeddingBatchItem_user_generation_state_idx"
  ON "MemoryEmbeddingBatchItem"("userId", "indexGenerationId", "state");
CREATE INDEX "MemoryEmbeddingBatchItem_executionBindingId_idx"
  ON "MemoryEmbeddingBatchItem"("executionBindingId");

ALTER TABLE "MemoryEmbeddingBatchItem"
  ADD CONSTRAINT "MemoryEmbeddingBatchItem_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "MemoryEmbeddingBatchItem"
  ADD CONSTRAINT "MemoryEmbeddingBatchItem_job_fkey"
  FOREIGN KEY ("userId", "memoryJobId")
  REFERENCES "MemoryJob"("userId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "MemoryEmbeddingBatchItem"
  ADD CONSTRAINT "MemoryEmbeddingBatchItem_generation_fkey"
  FOREIGN KEY ("userId", "indexGenerationId")
  REFERENCES "MemoryIndexGeneration"("userId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "MemoryEmbeddingBatchItem"
  ADD CONSTRAINT "MemoryEmbeddingBatchItem_search_entry_fkey"
  FOREIGN KEY ("userId", "searchEntryId")
  REFERENCES "MemorySearchEntry"("userId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- Extend the content-free job metrics allowlist for batch throughput and
-- settlement evidence. The existing MemoryJob check constraint calls this
-- function dynamically, so replacing it updates both clean installs and
-- upgraded databases without rewriting rows.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_operational_counters_valid(
  p_counters JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT p_counters IS NULL OR (
    jsonb_typeof(p_counters) = 'object'
    AND pg_column_size(p_counters) <= 4096
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_counters) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY[
        'digestFullRebuild',
        'digestIncremental',
        'digestNoop',
        'digestSegmentsProcessed',
        'digestSourceChunksProcessed',
        'embeddingBatchItems',
        'embeddingFailedItems',
        'embeddingProviderRequests',
        'embeddingSettledItems',
        'embeddingStaleItems',
        'historyChunksBuilt',
        'historyChunksReplaced',
        'historyChunksReused',
        'historyMessageContentRowsLoaded',
        'historyMessagesProjected',
        'historyModelRunRowsLoaded',
        'historyPathMetadataRowsRead'
      ]::TEXT[])
        OR jsonb_typeof(entry.value) <> 'number'
        OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$'
        OR (entry.value #>> '{}')::NUMERIC > 2147483647
    )
  );
$function$;
