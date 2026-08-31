-- The Memory lexical OpenSearch index is derived state. These rows deliberately
-- have no foreign keys to User/generation/search-entry rows: deletion work must
-- survive removal of its canonical source until the external purge is verified.

CREATE TYPE "MemoryLexicalProjectionOperation" AS ENUM (
  'SYNC_ENTRY',
  'DELETE_ENTRY',
  'PURGE_GENERATION',
  'PURGE_USER'
);

CREATE TYPE "MemoryLexicalProjectionEventState" AS ENUM (
  'PENDING',
  'CLAIMED',
  'RETRY_WAIT',
  'SUCCEEDED',
  'BLOCKED_REQUIRES_ADMIN'
);

CREATE TYPE "MemoryLexicalProjectionStatus" AS ENUM (
  'BUILDING',
  'CATCHING_UP',
  'READY',
  'DEGRADED',
  'RETIRED'
);

CREATE TABLE "MemoryLexicalProjectionEvent" (
  "sequence" BIGSERIAL NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "indexGenerationId" TEXT,
  "searchEntryId" TEXT,
  "operation" "MemoryLexicalProjectionOperation" NOT NULL,
  "memoryRevisionSnapshot" INTEGER NOT NULL,
  "idempotencyFingerprint" VARCHAR(128) NOT NULL,
  "state" "MemoryLexicalProjectionEventState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" VARCHAR(128),
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryLexicalProjectionEvent_pkey" PRIMARY KEY ("sequence"),
  CONSTRAINT "MemoryLexicalProjectionEvent_sequence_check"
    CHECK ("sequence" > 0),
  CONSTRAINT "MemoryLexicalProjectionEvent_revision_check"
    CHECK ("memoryRevisionSnapshot" >= 0),
  CONSTRAINT "MemoryLexicalProjectionEvent_attempt_check"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "MemoryLexicalProjectionEvent_shape_check" CHECK (
    ("operation" IN ('SYNC_ENTRY', 'DELETE_ENTRY')
      AND "indexGenerationId" IS NOT NULL
      AND "searchEntryId" IS NOT NULL)
    OR ("operation" = 'PURGE_GENERATION'
      AND "indexGenerationId" IS NOT NULL
      AND "searchEntryId" IS NULL)
    OR ("operation" = 'PURGE_USER'
      AND "indexGenerationId" IS NULL
      AND "searchEntryId" IS NULL)
  ),
  CONSTRAINT "MemoryLexicalProjectionEvent_lease_check" CHECK (
    ("state" = 'CLAIMED'
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL)
    OR ("state" <> 'CLAIMED'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "MemoryLexicalProjectionEvent_completion_check" CHECK (
    ("state" = 'SUCCEEDED' AND "completedAt" IS NOT NULL)
    OR ("state" <> 'SUCCEEDED' AND "completedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "MemoryLexicalProjectionEvent_id_key"
  ON "MemoryLexicalProjectionEvent"("id");
CREATE UNIQUE INDEX "MemoryLexicalProjectionEvent_idempotencyFingerprint_key"
  ON "MemoryLexicalProjectionEvent"("idempotencyFingerprint");
CREATE INDEX "MemoryLexicalProjectionEvent_queue_idx"
  ON "MemoryLexicalProjectionEvent"(
    "state", "nextAttemptAt", "leaseExpiresAt", "sequence"
  );
CREATE INDEX "MemoryLexicalProjectionEvent_generation_idx"
  ON "MemoryLexicalProjectionEvent"(
    "userId", "indexGenerationId", "state", "sequence"
  );
CREATE INDEX "MemoryLexicalProjectionEvent_entry_idx"
  ON "MemoryLexicalProjectionEvent"("userId", "searchEntryId", "sequence");
CREATE INDEX "MemoryLexicalProjectionEvent_user_order_idx"
  ON "MemoryLexicalProjectionEvent"("userId", "state", "sequence");
CREATE UNIQUE INDEX "MemoryLexicalProjectionEvent_user_purge_key"
  ON "MemoryLexicalProjectionEvent"("userId")
  WHERE "operation" = 'PURGE_USER';

CREATE TABLE "MemoryLexicalProjectionState" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "backendKind" VARCHAR(64) NOT NULL,
  "mappingVersion" VARCHAR(64) NOT NULL,
  "normalizationVersion" VARCHAR(64) NOT NULL,
  "analysisProfile" VARCHAR(64) NOT NULL,
  "retrievalPipelineVersion" VARCHAR(64) NOT NULL,
  "status" "MemoryLexicalProjectionStatus" NOT NULL DEFAULT 'BUILDING',
  "enqueuedThroughSequence" BIGINT NOT NULL DEFAULT 0,
  "visibleThroughSequence" BIGINT NOT NULL DEFAULT 0,
  "targetMemoryRevision" INTEGER NOT NULL,
  "projectedThroughRevision" INTEGER NOT NULL DEFAULT 0,
  "expectedDocumentCount" INTEGER,
  "visibleDocumentCount" INTEGER,
  "projectionFingerprint" CHAR(64),
  "expectedContentFingerprint" CHAR(64),
  "visibleContentFingerprint" CHAR(64),
  "lastSuccessfulRefreshAt" TIMESTAMP(3),
  "lastIntegrityCheckAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),

  CONSTRAINT "MemoryLexicalProjectionState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryLexicalProjectionState_watermark_check" CHECK (
    "enqueuedThroughSequence" >= 0
    AND "visibleThroughSequence" >= 0
    AND "visibleThroughSequence" <= "enqueuedThroughSequence"
  ),
  CONSTRAINT "MemoryLexicalProjectionState_revision_check" CHECK (
    "targetMemoryRevision" >= 0
    AND "projectedThroughRevision" >= 0
    AND "projectedThroughRevision" <= "targetMemoryRevision"
  ),
  CONSTRAINT "MemoryLexicalProjectionState_count_check" CHECK (
    ("expectedDocumentCount" IS NULL AND "visibleDocumentCount" IS NULL)
    OR ("expectedDocumentCount" >= 0 AND "visibleDocumentCount" >= 0)
  ),
  CONSTRAINT "MemoryLexicalProjectionState_ready_check" CHECK (
    ("status" = 'READY'
      AND "visibleThroughSequence" = "enqueuedThroughSequence"
      AND "projectedThroughRevision" = "targetMemoryRevision"
      AND "expectedDocumentCount" = "visibleDocumentCount"
      AND "projectionFingerprint" IS NOT NULL
      AND "expectedContentFingerprint" IS NOT NULL
      AND "expectedContentFingerprint" = "visibleContentFingerprint"
      AND "lastSuccessfulRefreshAt" IS NOT NULL
      AND "lastIntegrityCheckAt" IS NOT NULL
      AND "readyAt" IS NOT NULL)
    OR ("status" <> 'READY' AND "readyAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "MemoryLexicalProjectionState_user_generation_key"
  ON "MemoryLexicalProjectionState"("userId", "indexGenerationId");
CREATE INDEX "MemoryLexicalProjectionState_user_status_idx"
  ON "MemoryLexicalProjectionState"("userId", "status", "updatedAt");

CREATE FUNCTION aiqsa_memory_lexical_revision(
  projection_user_id TEXT,
  projection_generation_id TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  revision INTEGER;
BEGIN
  SELECT settings."memoryRevision"
  INTO revision
  FROM "UserMemorySettings" AS settings
  WHERE settings."userId" = projection_user_id;

  IF revision IS NULL THEN
    SELECT generation."targetMemoryRevision"
    INTO revision
    FROM "MemoryIndexGeneration" AS generation
    WHERE generation."userId" = projection_user_id
      AND generation."id" = projection_generation_id;
  END IF;

  RETURN GREATEST(COALESCE(revision, 0), 0);
END;
$$;

CREATE FUNCTION aiqsa_enqueue_memory_lexical_projection_event(
  projection_user_id TEXT,
  projection_generation_id TEXT,
  projection_search_entry_id TEXT,
  projection_operation "MemoryLexicalProjectionOperation",
  projection_memory_revision INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  event_id UUID := gen_random_uuid();
  event_sequence BIGINT;
  safe_revision INTEGER := GREATEST(COALESCE(projection_memory_revision, 0), 0);
BEGIN
  INSERT INTO "MemoryLexicalProjectionEvent" (
    "id",
    "userId",
    "indexGenerationId",
    "searchEntryId",
    "operation",
    "memoryRevisionSnapshot",
    "idempotencyFingerprint"
  ) VALUES (
    event_id,
    projection_user_id,
    projection_generation_id,
    projection_search_entry_id,
    projection_operation,
    safe_revision,
    event_id::TEXT
  )
  RETURNING "sequence" INTO event_sequence;

  IF projection_generation_id IS NOT NULL THEN
    INSERT INTO "MemoryLexicalProjectionState" (
      "userId",
      "indexGenerationId",
      "backendKind",
      "mappingVersion",
      "normalizationVersion",
      "analysisProfile",
      "retrievalPipelineVersion",
      "status",
      "enqueuedThroughSequence",
      "visibleThroughSequence",
      "targetMemoryRevision",
      "projectedThroughRevision"
    ) VALUES (
      projection_user_id,
      projection_generation_id,
      'opensearch_icu_lexical_v1',
      'memory-lexical-mapping-v1',
      'memory-unicode-query-analysis-v1',
      'memory-unicode-icu-v1',
      'memory-personal-retrieval-v63',
      'CATCHING_UP',
      event_sequence,
      0,
      safe_revision,
      0
    )
    ON CONFLICT ("userId", "indexGenerationId") DO UPDATE SET
      "status" = 'CATCHING_UP',
      "enqueuedThroughSequence" = GREATEST(
        "MemoryLexicalProjectionState"."enqueuedThroughSequence",
        EXCLUDED."enqueuedThroughSequence"
      ),
      "targetMemoryRevision" = GREATEST(
        "MemoryLexicalProjectionState"."targetMemoryRevision",
        EXCLUDED."targetMemoryRevision"
      ),
      "expectedDocumentCount" = NULL,
      "visibleDocumentCount" = NULL,
      "expectedContentFingerprint" = NULL,
      "visibleContentFingerprint" = NULL,
      "lastIntegrityCheckAt" = NULL,
      "readyAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP;
  END IF;

  RETURN event_sequence;
END;
$$;

CREATE FUNCTION aiqsa_capture_memory_lexical_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_revision INTEGER;
  new_revision INTEGER;
  lexical_changed BOOLEAN;
  identity_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_revision := aiqsa_memory_lexical_revision(
      NEW."userId",
      NEW."indexGenerationId"
    );
    PERFORM aiqsa_enqueue_memory_lexical_projection_event(
      NEW."userId",
      NEW."indexGenerationId",
      NEW."id",
      'SYNC_ENTRY',
      new_revision
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_revision := aiqsa_memory_lexical_revision(
      OLD."userId",
      OLD."indexGenerationId"
    );
    PERFORM aiqsa_enqueue_memory_lexical_projection_event(
      OLD."userId",
      OLD."indexGenerationId",
      OLD."id",
      'DELETE_ENTRY',
      old_revision
    );
    RETURN OLD;
  END IF;

  lexical_changed := ROW(
    OLD."id",
    OLD."userId",
    OLD."indexGenerationId",
    OLD."itemType",
    OLD."factVersionId",
    OLD."recallChunkId",
    OLD."recallRoundId",
    OLD."recallRoundSegmentId",
    OLD."toolEventId",
    OLD."normalizedSearchText",
    OLD."safeContentHash",
    OLD."safetyIdentitySnapshot",
    OLD."sourceIdentitySnapshot",
    OLD."suppressionIdentitySnapshot"
  ) IS DISTINCT FROM ROW(
    NEW."id",
    NEW."userId",
    NEW."indexGenerationId",
    NEW."itemType",
    NEW."factVersionId",
    NEW."recallChunkId",
    NEW."recallRoundId",
    NEW."recallRoundSegmentId",
    NEW."toolEventId",
    NEW."normalizedSearchText",
    NEW."safeContentHash",
    NEW."safetyIdentitySnapshot",
    NEW."sourceIdentitySnapshot",
    NEW."suppressionIdentitySnapshot"
  );

  IF NOT lexical_changed THEN
    RETURN NEW;
  END IF;

  identity_changed := ROW(
    OLD."id", OLD."userId", OLD."indexGenerationId"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."userId", NEW."indexGenerationId"
  );

  IF identity_changed THEN
    old_revision := aiqsa_memory_lexical_revision(
      OLD."userId",
      OLD."indexGenerationId"
    );
    PERFORM aiqsa_enqueue_memory_lexical_projection_event(
      OLD."userId",
      OLD."indexGenerationId",
      OLD."id",
      'DELETE_ENTRY',
      old_revision
    );
  END IF;

  new_revision := aiqsa_memory_lexical_revision(
    NEW."userId",
    NEW."indexGenerationId"
  );
  PERFORM aiqsa_enqueue_memory_lexical_projection_event(
    NEW."userId",
    NEW."indexGenerationId",
    NEW."id",
    'SYNC_ENTRY',
    new_revision
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemorySearchEntry_lexical_projection_insert"
AFTER INSERT ON "MemorySearchEntry"
FOR EACH ROW EXECUTE FUNCTION aiqsa_capture_memory_lexical_projection();

CREATE TRIGGER "MemorySearchEntry_lexical_projection_update"
AFTER UPDATE OF
  "id",
  "userId",
  "indexGenerationId",
  "itemType",
  "factVersionId",
  "recallChunkId",
  "recallRoundId",
  "recallRoundSegmentId",
  "toolEventId",
  "normalizedSearchText",
  "safeContentHash",
  "safetyIdentitySnapshot",
  "sourceIdentitySnapshot",
  "suppressionIdentitySnapshot"
ON "MemorySearchEntry"
FOR EACH ROW EXECUTE FUNCTION aiqsa_capture_memory_lexical_projection();

CREATE TRIGGER "MemorySearchEntry_lexical_projection_delete"
AFTER DELETE ON "MemorySearchEntry"
FOR EACH ROW EXECUTE FUNCTION aiqsa_capture_memory_lexical_projection();

CREATE FUNCTION aiqsa_capture_memory_generation_purge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM aiqsa_enqueue_memory_lexical_projection_event(
    OLD."userId",
    OLD."id",
    NULL,
    'PURGE_GENERATION',
    GREATEST(OLD."targetMemoryRevision", 0)
  );
  RETURN OLD;
END;
$$;

CREATE TRIGGER "MemoryIndexGeneration_lexical_projection_purge"
AFTER DELETE ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION aiqsa_capture_memory_generation_purge();

CREATE FUNCTION aiqsa_guard_memory_lexical_projection_event_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD."id",
    OLD."userId",
    OLD."indexGenerationId",
    OLD."searchEntryId",
    OLD."operation",
    OLD."memoryRevisionSnapshot",
    OLD."idempotencyFingerprint",
    OLD."createdAt"
  ) IS DISTINCT FROM ROW(
    NEW."id",
    NEW."userId",
    NEW."indexGenerationId",
    NEW."searchEntryId",
    NEW."operation",
    NEW."memoryRevisionSnapshot",
    NEW."idempotencyFingerprint",
    NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'memory_lexical_projection_event_admission_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryLexicalProjectionEvent_admission_immutable"
BEFORE UPDATE ON "MemoryLexicalProjectionEvent"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_guard_memory_lexical_projection_event_admission();

-- Every pre-existing generation receives a readiness row, including empty
-- generations. Existing lexical entries then receive one ordered SYNC event.
INSERT INTO "MemoryLexicalProjectionState" (
  "userId",
  "indexGenerationId",
  "backendKind",
  "mappingVersion",
  "normalizationVersion",
  "analysisProfile",
  "retrievalPipelineVersion",
  "status",
  "enqueuedThroughSequence",
  "visibleThroughSequence",
  "targetMemoryRevision",
  "projectedThroughRevision"
)
SELECT
  generation."userId",
  generation."id",
  'opensearch_icu_lexical_v1',
  'memory-lexical-mapping-v1',
  'memory-unicode-query-analysis-v1',
  'memory-unicode-icu-v1',
  'memory-personal-retrieval-v63',
  'BUILDING',
  0,
  0,
  GREATEST(generation."targetMemoryRevision", 0),
  0
FROM "MemoryIndexGeneration" AS generation;

WITH source_rows AS MATERIALIZED (
  SELECT
    gen_random_uuid() AS event_id,
    entry."userId" AS user_id,
    entry."indexGenerationId" AS generation_id,
    entry."id" AS search_entry_id,
    GREATEST(
      COALESCE(settings."memoryRevision", generation."targetMemoryRevision", 0),
      0
    ) AS memory_revision
  FROM "MemorySearchEntry" AS entry
  LEFT JOIN "UserMemorySettings" AS settings
    ON settings."userId" = entry."userId"
  LEFT JOIN "MemoryIndexGeneration" AS generation
    ON generation."userId" = entry."userId"
    AND generation."id" = entry."indexGenerationId"
), inserted AS (
  INSERT INTO "MemoryLexicalProjectionEvent" (
    "id",
    "userId",
    "indexGenerationId",
    "searchEntryId",
    "operation",
    "memoryRevisionSnapshot",
    "idempotencyFingerprint"
  )
  SELECT
    event_id,
    user_id,
    generation_id,
    search_entry_id,
    'SYNC_ENTRY',
    memory_revision,
    event_id::TEXT
  FROM source_rows
  RETURNING
    "userId",
    "indexGenerationId",
    "memoryRevisionSnapshot",
    "sequence"
), grouped AS (
  SELECT
    "userId",
    "indexGenerationId",
    MAX("memoryRevisionSnapshot") AS memory_revision,
    MAX("sequence") AS maximum_sequence
  FROM inserted
  GROUP BY "userId", "indexGenerationId"
)
UPDATE "MemoryLexicalProjectionState" AS state
SET
  "status" = 'CATCHING_UP',
  "enqueuedThroughSequence" = grouped.maximum_sequence,
  "targetMemoryRevision" = GREATEST(
    state."targetMemoryRevision",
    grouped.memory_revision
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM grouped
WHERE state."userId" = grouped."userId"
  AND state."indexGenerationId" = grouped."indexGenerationId";
