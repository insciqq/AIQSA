-- Package D: represent merge and supersede as distinct append-only lifecycle
-- outcomes, give relation work a durable target identity, and make every
-- current-pointer mutation race-safe at the database boundary.

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "mergedIntoVersionId" TEXT,
  ADD COLUMN "relationResolutionVersion" VARCHAR(64),
  ADD COLUMN "relationSnapshotHash" VARCHAR(128),
  ADD COLUMN "relationResolvedAt" TIMESTAMP(3);

ALTER TABLE "MemoryJob"
  ADD COLUMN "targetFactVersionId" TEXT;

CREATE TABLE "MemoryFactVersionRelation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "targetVersionId" TEXT NOT NULL,
  "kind" "MemoryFactVersionRelationKind" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reasonCode" VARCHAR(64) NOT NULL,
  "pipelineVersion" VARCHAR(64) NOT NULL,
  "executionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryFactVersionRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryAuxiliarySemanticCall" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "ownerJobId" TEXT NOT NULL,
  "purpose" VARCHAR(64) NOT NULL,
  "inputHash" VARCHAR(128),
  "acceptedOutputHash" VARCHAR(128),
  "executionId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryAuxiliarySemanticCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryFactVersionRelation_userId_id_key"
  ON "MemoryFactVersionRelation"("userId", "id");

CREATE UNIQUE INDEX "MemoryFactVersionRelation_identity_key"
  ON "MemoryFactVersionRelation"(
    "userId", "sourceVersionId", "targetVersionId", "kind"
  );

CREATE INDEX "MemoryFactVersionRelation_source_kind_idx"
  ON "MemoryFactVersionRelation"("userId", "sourceVersionId", "kind");

CREATE INDEX "MemoryFactVersionRelation_target_kind_idx"
  ON "MemoryFactVersionRelation"("userId", "targetVersionId", "kind");

CREATE UNIQUE INDEX "MemoryAuxiliarySemanticCall_userId_id_key"
  ON "MemoryAuxiliarySemanticCall"("userId", "id");

CREATE UNIQUE INDEX "MemoryAuxiliarySemanticCall_message_key"
  ON "MemoryAuxiliarySemanticCall"("userId", "sourceMessageId");

CREATE UNIQUE INDEX "MemoryAuxiliarySemanticCall_job_key"
  ON "MemoryAuxiliarySemanticCall"("userId", "ownerJobId");

CREATE INDEX "MemoryAuxiliarySemanticCall_purpose_created_idx"
  ON "MemoryAuxiliarySemanticCall"("userId", "purpose", "createdAt");

CREATE INDEX "MemoryFactVersion_userId_mergedIntoVersionId_idx"
  ON "MemoryFactVersion"("userId", "mergedIntoVersionId");

CREATE INDEX "MemoryJob_source_relation_pipeline_idx"
  ON "MemoryJob"("userId", "sourceMessageId", "kind", "pipelineVersion");

CREATE INDEX "MemoryJob_target_relation_state_idx"
  ON "MemoryJob"("userId", "targetFactVersionId", "kind", "state");

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_source_fkey"
  FOREIGN KEY ("userId", "sourceVersionId")
  REFERENCES "MemoryFactVersion"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_target_fkey"
  FOREIGN KEY ("userId", "targetVersionId")
  REFERENCES "MemoryFactVersion"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_message_fkey"
  FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_job_fkey"
  FOREIGN KEY ("userId", "ownerJobId")
  REFERENCES "MemoryJob"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_execution_fkey"
  FOREIGN KEY ("userId", "executionId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_shape_check" CHECK (
    "purpose" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
    AND (
      num_nonnulls(
        "inputHash", "acceptedOutputHash", "executionId", "result", "completedAt"
      ) = 0
      OR (
        num_nonnulls(
          "inputHash", "acceptedOutputHash", "executionId", "result", "completedAt"
        ) = 5
        AND "inputHash" ~ '^[a-f0-9]{64}$'
        AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
        AND char_length("executionId") BETWEEN 1 AND 256
        AND "executionId" !~ '[[:cntrl:]]'
        AND "completedAt" >= "createdAt"
      )
    )
  );

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_shape_check" CHECK (
    "sourceVersionId" <> "targetVersionId"
    AND "confidence" >= 0.0
    AND "confidence" <= 1.0
    AND "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
    AND "pipelineVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
    AND (
      "executionId" IS NULL
      OR (
        char_length("executionId") BETWEEN 1 AND 256
        AND "executionId" !~ '[[:cntrl:]]'
      )
    )
  );

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_merged_into_fkey"
  FOREIGN KEY ("userId", "mergedIntoVersionId")
  REFERENCES "MemoryFactVersion"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_relation_lifecycle_check" CHECK (
    ("mergedIntoVersionId" IS NULL OR "mergedIntoVersionId" <> "id")
    AND (
      "state" <> 'MERGED'::"MemoryFactVersionState"
      OR (
        "mergedIntoVersionId" IS NOT NULL
        AND "systemTo" IS NOT NULL
      )
    )
    AND (
      "mergedIntoVersionId" IS NULL
      OR "state" IN (
        'MERGED'::"MemoryFactVersionState",
        'ORPHANED'::"MemoryFactVersionState",
        'RETRACTED'::"MemoryFactVersionState",
        'FORGOTTEN'::"MemoryFactVersionState"
      )
    )
    AND num_nonnulls(
      "relationResolutionVersion",
      "relationSnapshotHash",
      "relationResolvedAt"
    ) IN (0, 3)
    AND (
      "relationResolutionVersion" IS NULL
      OR (
        "relationResolutionVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
        AND "relationSnapshotHash" ~ '^[a-f0-9]{64}$'
        AND "relationResolvedAt" >= "systemFrom"
      )
    )
    AND (
      "ingestionFingerprint" IS NULL
      OR "state" NOT IN (
        'ACTIVE'::"MemoryFactVersionState",
        'PENDING_RELATION'::"MemoryFactVersionState"
      )
      OR "systemTo" IS NULL
    )
  );

ALTER TABLE "MemoryJob"
  ADD CONSTRAINT "MemoryJob_target_fact_version_fkey"
  FOREIGN KEY ("userId", "targetFactVersionId")
  REFERENCES "MemoryFactVersion"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryJob"
  ADD CONSTRAINT "MemoryJob_relation_target_shape_check" CHECK (
    (
      "kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
      AND "targetFactVersionId" IS NOT NULL
      AND "sourceMessageId" IS NOT NULL
      AND "chatId" IS NOT NULL
      AND "activeLeafMessageId" IS NOT NULL
      AND "branchGeneration" IS NOT NULL
      AND "sourceRevision" IS NOT NULL
      AND "sourceHash" IS NOT NULL
    )
    OR (
      "kind" <> 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
      AND "targetFactVersionId" IS NULL
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_relation_pointer_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  has_cycle boolean;
  chain_too_deep boolean;
BEGIN
  -- Serialize each owner's pointer graph. Row locks still define repository
  -- order; this lock closes the concurrent disjoint-edge cycle race.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('aiqsa:memory:relation:' || NEW."userId", 0)
  );

  IF TG_TABLE_NAME = 'MemoryFact' THEN
    IF NEW."movedToFactId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW."movedToFactId" = NEW."id" THEN
      RAISE EXCEPTION 'Memory fact move cannot reference itself'
        USING ERRCODE = '23514';
    END IF;
    WITH RECURSIVE moved_chain AS (
      SELECT fact."id", fact."movedToFactId", 1 AS depth
      FROM "MemoryFact" AS fact
      WHERE fact."userId" = NEW."userId"
        AND fact."id" = NEW."movedToFactId"

      UNION ALL

      SELECT next_fact."id", next_fact."movedToFactId", chain.depth + 1
      FROM moved_chain AS chain
      INNER JOIN "MemoryFact" AS next_fact
        ON next_fact."userId" = NEW."userId"
        AND next_fact."id" = chain."movedToFactId"
      WHERE chain.depth < 64
    )
    SELECT
      COALESCE(bool_or("id" = NEW."id"), FALSE),
      COALESCE(bool_or(depth = 64 AND "movedToFactId" IS NOT NULL), FALSE)
    INTO has_cycle, chain_too_deep
    FROM moved_chain;
  ELSE
    IF NEW."mergedIntoVersionId" IS NOT NULL THEN
      IF NEW."mergedIntoVersionId" = NEW."id" THEN
        RAISE EXCEPTION 'Memory version merge cannot reference itself'
          USING ERRCODE = '23514';
      END IF;
      WITH RECURSIVE merge_chain AS (
        SELECT version."id", version."mergedIntoVersionId", 1 AS depth
        FROM "MemoryFactVersion" AS version
        WHERE version."userId" = NEW."userId"
          AND version."id" = NEW."mergedIntoVersionId"

        UNION ALL

        SELECT next_version."id", next_version."mergedIntoVersionId",
          chain.depth + 1
        FROM merge_chain AS chain
        INNER JOIN "MemoryFactVersion" AS next_version
          ON next_version."userId" = NEW."userId"
          AND next_version."id" = chain."mergedIntoVersionId"
        WHERE chain.depth < 64
      )
      SELECT
        COALESCE(bool_or("id" = NEW."id"), FALSE),
        COALESCE(bool_or(depth = 64 AND "mergedIntoVersionId" IS NOT NULL), FALSE)
      INTO has_cycle, chain_too_deep
      FROM merge_chain;
      IF has_cycle OR chain_too_deep THEN
        RAISE EXCEPTION 'Memory relation pointer cycle or excessive depth'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW."supersedesVersionId" IS NOT NULL THEN
      IF NEW."supersedesVersionId" = NEW."id" THEN
        RAISE EXCEPTION 'Memory version supersede cannot reference itself'
          USING ERRCODE = '23514';
      END IF;
      WITH RECURSIVE supersede_chain AS (
        SELECT version."id", version."supersedesVersionId", 1 AS depth
        FROM "MemoryFactVersion" AS version
        WHERE version."userId" = NEW."userId"
          AND version."id" = NEW."supersedesVersionId"

        UNION ALL

        SELECT next_version."id", next_version."supersedesVersionId",
          chain.depth + 1
        FROM supersede_chain AS chain
        INNER JOIN "MemoryFactVersion" AS next_version
          ON next_version."userId" = NEW."userId"
          AND next_version."id" = chain."supersedesVersionId"
        WHERE chain.depth < 64
      )
      SELECT
        COALESCE(bool_or("id" = NEW."id"), FALSE),
        COALESCE(bool_or(depth = 64 AND "supersedesVersionId" IS NOT NULL), FALSE)
      INTO has_cycle, chain_too_deep
      FROM supersede_chain;
    END IF;
  END IF;

  IF has_cycle OR chain_too_deep THEN
    RAISE EXCEPTION 'Memory relation pointer cycle or excessive depth'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFact_relation_pointer_insert_guard"
BEFORE INSERT ON "MemoryFact"
FOR EACH ROW
WHEN (NEW."movedToFactId" IS NOT NULL)
EXECUTE FUNCTION aiqsa_memory_relation_pointer_guard();

CREATE TRIGGER "MemoryFact_relation_pointer_update_guard"
BEFORE UPDATE OF "movedToFactId" ON "MemoryFact"
FOR EACH ROW
WHEN (NEW."movedToFactId" IS NOT NULL)
EXECUTE FUNCTION aiqsa_memory_relation_pointer_guard();

CREATE TRIGGER "MemoryFactVersion_relation_pointer_insert_guard"
BEFORE INSERT ON "MemoryFactVersion"
FOR EACH ROW
WHEN (
  NEW."mergedIntoVersionId" IS NOT NULL
  OR NEW."supersedesVersionId" IS NOT NULL
)
EXECUTE FUNCTION aiqsa_memory_relation_pointer_guard();

CREATE TRIGGER "MemoryFactVersion_relation_pointer_update_guard"
BEFORE UPDATE OF "mergedIntoVersionId", "supersedesVersionId"
ON "MemoryFactVersion"
FOR EACH ROW
WHEN (
  NEW."mergedIntoVersionId" IS NOT NULL
  OR NEW."supersedesVersionId" IS NOT NULL
)
EXECUTE FUNCTION aiqsa_memory_relation_pointer_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_relation_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Memory version relation provenance is immutable'
    USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER "MemoryFactVersionRelation_immutable"
BEFORE UPDATE ON "MemoryFactVersionRelation"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_relation_provenance_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_relation_resolution_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."relationResolutionVersion" IS NOT NULL
     AND (
       NEW."relationResolutionVersion",
       NEW."relationSnapshotHash",
       NEW."relationResolvedAt"
     ) IS DISTINCT FROM (
       OLD."relationResolutionVersion",
       OLD."relationSnapshotHash",
       OLD."relationResolvedAt"
     ) THEN
    RAISE EXCEPTION 'Memory relation resolution provenance is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactVersion_relation_resolution_immutable"
BEFORE UPDATE OF
  "relationResolutionVersion", "relationSnapshotHash", "relationResolvedAt"
ON "MemoryFactVersion"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_relation_resolution_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_auxiliary_call_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id", NEW."userId", NEW."sourceMessageId", NEW."ownerJobId",
    NEW."purpose", NEW."createdAt"
  ) IS DISTINCT FROM (
    OLD."id", OLD."userId", OLD."sourceMessageId", OLD."ownerJobId",
    OLD."purpose", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Memory auxiliary semantic call identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."completedAt" IS NOT NULL AND (
    NEW."inputHash", NEW."acceptedOutputHash", NEW."executionId",
    NEW."result", NEW."completedAt"
  ) IS DISTINCT FROM (
    OLD."inputHash", OLD."acceptedOutputHash", OLD."executionId",
    OLD."result", OLD."completedAt"
  ) THEN
    RAISE EXCEPTION 'Memory auxiliary semantic call result is immutable'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM "MemoryJob" AS job
  WHERE job."userId" = NEW."userId"
    AND job."id" = NEW."ownerJobId"
    AND job."sourceMessageId" = NEW."sourceMessageId"
    AND job."kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind";
  IF NOT FOUND OR NEW."purpose" <> 'FACT_RELATION' THEN
    RAISE EXCEPTION 'Memory auxiliary semantic call owner is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."executionId" IS NOT NULL THEN
    PERFORM 1
    FROM "MemoryExecutionBinding" AS binding
    WHERE binding."userId" = NEW."userId"
      AND binding."id" = NEW."executionId"
      AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
      AND binding."memoryJobId" = NEW."ownerJobId"
      AND binding."logicalRole" = 'MEMORY_CONSOLIDATE'
      AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
      AND binding."acceptedOutputHash" = NEW."acceptedOutputHash";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Memory auxiliary semantic call receipt is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryAuxiliarySemanticCall_guard"
BEFORE INSERT OR UPDATE ON "MemoryAuxiliarySemanticCall"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_auxiliary_call_guard();

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_fact_pointer(
  p_user_id text,
  p_fact_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  fact_row "MemoryFact"%ROWTYPE;
  active_count integer;
  pointed_state "MemoryFactVersionState";
  pointed_expires_at timestamp(3);
  pointed_system_to timestamp(3);
  pointed_merge_target text;
BEGIN
  SELECT * INTO fact_row FROM "MemoryFact"
  WHERE "userId" = p_user_id AND "id" = p_fact_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO active_count FROM "MemoryFactVersion"
  WHERE "userId" = p_user_id
    AND "factId" = p_fact_id
    AND "state" = 'ACTIVE';

  IF fact_row."state" = 'ACTIVE' THEN
    SELECT "state", "expiresAt", "systemTo", "mergedIntoVersionId"
    INTO pointed_state, pointed_expires_at, pointed_system_to, pointed_merge_target
    FROM "MemoryFactVersion"
    WHERE "userId" = p_user_id
      AND "factId" = p_fact_id
      AND "id" = fact_row."currentVersionId";
    IF fact_row."currentVersionId" IS NULL
       OR pointed_state IS DISTINCT FROM 'ACTIVE'
       OR pointed_system_to IS NOT NULL
       OR pointed_merge_target IS NOT NULL
       OR active_count <> 1
       OR pointed_expires_at <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory fact must point to one live open ACTIVE same-owner version';
    END IF;
  ELSIF fact_row."currentVersionId" IS NOT NULL OR active_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-ACTIVE Memory fact cannot retain an ACTIVE version or current pointer';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_job_source_message_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."sourceMessageId" IS NOT NULL
     AND NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId" THEN
    RAISE EXCEPTION 'MemoryJob.sourceMessageId is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."targetFactVersionId" IS NOT NULL
     AND NEW."targetFactVersionId" IS DISTINCT FROM OLD."targetFactVersionId" THEN
    RAISE EXCEPTION 'MemoryJob.targetFactVersionId is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
     AND NEW."pipelineVersion" IN (
       'memory-fact-extraction-vnext-v1',
       'memory-fact-extraction-vnext-v2'
     ) THEN
    IF NEW."sourceMessageId" IS NULL
       OR btrim(NEW."sourceMessageId") = ''
       OR char_length(NEW."sourceMessageId") > 256 THEN
      RAISE EXCEPTION 'MemoryJob.sourceMessageId is required for vNext EXTRACT_FACTS'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."kind" IN (
       'EXTRACT_FACTS'::"MemoryJobKind",
       'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
     )
     AND NEW."sourceMessageId" IS NOT NULL THEN
    PERFORM 1
    FROM "Message" AS message
    INNER JOIN "Chat" AS chat ON chat."id" = message."chatId"
    WHERE message."id" = NEW."sourceMessageId"
      AND message."chatId" = NEW."chatId"
      AND message."role" = 'user'
      AND message."status" = 'complete'::"MessageStatus"
      AND chat."userId" = NEW."userId"
      AND chat."projectId" IS NULL
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."permanentDeletionAt" IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MemoryJob.sourceMessageId must reference an exact settled direct USER message'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "MemoryJob_source_message_guard" ON "MemoryJob";

CREATE TRIGGER "MemoryJob_source_message_guard"
BEFORE INSERT OR UPDATE OF
  "sourceMessageId", "targetFactVersionId", "kind", "pipelineVersion",
  "chatId", "userId"
ON "MemoryJob"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_job_source_message_guard();
