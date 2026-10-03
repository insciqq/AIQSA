-- Explicit relation v2 also compares an explicit save with unprotected
-- automatic facts, and a newly learned automatic fact with explicit saves. Its
-- job keeps the source-less explicit shape and its single durable result keeps
-- the EXPLICIT_FACT_EQUIVALENCE call, whose target may now be either side.
-- Expand only: previous-release writers keep creating v1 jobs and calls during
-- Compose replacement, and every v1 row still satisfies these checks.
ALTER TABLE "MemoryJob" DROP CONSTRAINT "MemoryJob_relation_target_shape_check";
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_relation_target_shape_check" CHECK (
  (
    "kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
    AND "targetFactVersionId" IS NOT NULL
    AND (
      (
        "pipelineVersion" IN ('memory-explicit-relation-v1', 'memory-explicit-relation-v2')
        AND num_nonnulls("sourceMessageId", "chatId", "activeLeafMessageId",
          "branchGeneration", "sourceRevision", "sourceHash") = 0
      ) OR (
        "pipelineVersion" NOT IN ('memory-explicit-relation-v1', 'memory-explicit-relation-v2')
        AND num_nonnulls("sourceMessageId", "chatId", "activeLeafMessageId",
          "branchGeneration", "sourceRevision", "sourceHash") = 6
      )
    )
  ) OR (
    "kind" = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
    AND num_nonnulls("sourceMessageId", "chatId", "activeLeafMessageId",
      "branchGeneration", "sourceRevision", "sourceHash") = 0
  ) OR (
    "kind" NOT IN ('RESOLVE_FACT_RELATIONS'::"MemoryJobKind", 'SYNTHESIZE_MEMORIES'::"MemoryJobKind")
    AND "targetFactVersionId" IS NULL
  )
);

-- v1 keeps its explicit target. A v2 target is the compared version, explicit
-- or automatic; its receipt must come from a binding of the owner job's own
-- pipeline.
CREATE OR REPLACE FUNCTION aiqsa_memory_explicit_relation_call_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  owner_pipeline TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."targetFactVersionId" IS DISTINCT FROM OLD."targetFactVersionId" THEN
    RAISE EXCEPTION 'Memory auxiliary fact identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."purpose" <> 'EXPLICIT_FACT_EQUIVALENCE' THEN RETURN NEW; END IF;
  SELECT job."pipelineVersion" INTO owner_pipeline
  FROM "MemoryJob" AS job
  INNER JOIN "MemoryFactVersion" AS version
    ON version."userId" = job."userId" AND version."id" = job."targetFactVersionId"
  WHERE job."userId" = NEW."userId" AND job."id" = NEW."ownerJobId"
    AND job."kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
    AND job."targetFactVersionId" = NEW."targetFactVersionId"
    AND (
      (job."pipelineVersion" = 'memory-explicit-relation-v1'
        AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode")
      OR job."pipelineVersion" = 'memory-explicit-relation-v2'
    )
    AND (TG_OP <> 'INSERT' OR (
      job."state" = 'CLAIMED'::"MemoryJobState"
      AND job."leaseToken" IS NOT NULL AND job."leaseExpiresAt" > CURRENT_TIMESTAMP
    ));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory explicit relation owner is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."completedAt" IS NOT NULL THEN
    PERFORM 1 FROM "MemoryExecutionBinding" AS binding
    WHERE binding."userId" = NEW."userId" AND binding."id" = NEW."executionId"
      AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
      AND binding."memoryJobId" = NEW."ownerJobId"
      AND binding."logicalRole" = 'MEMORY_CONSOLIDATE'
      AND binding."pipelineVersion" = owner_pipeline
      AND binding."inputHash" = NEW."inputHash"
      AND (
        (binding."state" = 'RUNNING'::"MemoryExecutionState" AND binding."acceptedOutputHash" IS NULL)
        OR (binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
          AND binding."acceptedOutputHash" = NEW."acceptedOutputHash")
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Memory explicit relation receipt is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_explicit_relation_binding_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."logicalRole" = 'MEMORY_CONSOLIDATE'
    AND NEW."pipelineVersion" IN ('memory-explicit-relation-v1', 'memory-explicit-relation-v2')
    AND NEW."state" = 'SUCCEEDED'::"MemoryExecutionState"
    AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM NEW."state") THEN
    PERFORM 1 FROM "MemoryAuxiliarySemanticCall" AS call
    WHERE call."userId" = NEW."userId" AND call."executionId" = NEW."id"
      AND call."purpose" = 'EXPLICIT_FACT_EQUIVALENCE'
      AND call."ownerJobId" = NEW."memoryJobId"
      AND call."completedAt" IS NOT NULL AND call."inputHash" = NEW."inputHash"
      AND call."acceptedOutputHash" = NEW."acceptedOutputHash";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Memory explicit relation durable result is missing' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Owners whose current pairs predate these triggers get one bounded sweep per
-- version; the marker records completion so it never becomes a periodic scan.
ALTER TABLE "UserMemorySettings" ADD COLUMN "explicitEquivalenceSweepVersion" VARCHAR(64);
