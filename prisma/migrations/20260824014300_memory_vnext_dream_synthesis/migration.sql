-- Package G: opt-in forward-only Dream synthesis. Pattern rows remain inside
-- the existing Personal Memory fact/version graph and are admitted only with
-- exact depth-one source relations and a governed execution receipt.

ALTER TABLE "UserMemorySettings"
  ADD COLUMN "synthesisEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "synthesisEnabledAt" TIMESTAMP(3),
  ADD COLUMN "synthesisPolicyVersion" VARCHAR(64),
  ADD COLUMN "lastSynthesisAt" TIMESTAMP(3);

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "synthesisDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "synthesisGeneration" INTEGER,
  ADD COLUMN "synthesisSourceSetFingerprint" VARCHAR(128);

ALTER TABLE "MemoryFactVersionRelation"
  ADD COLUMN "sourceEligibilityHash" VARCHAR(128);

CREATE TABLE "MemorySynthesisExecution" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryJobId" TEXT NOT NULL,
  "executionBindingId" TEXT NOT NULL,
  "inputHash" VARCHAR(128) NOT NULL,
  "acceptedOutputHash" VARCHAR(128) NOT NULL,
  "sourceSetFingerprint" VARCHAR(128) NOT NULL,
  "sourceSnapshotHash" VARCHAR(128) NOT NULL,
  "acceptedOutput" JSONB,
  "sourceBindings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),

  CONSTRAINT "MemorySynthesisExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserMemorySettings_synthesisEnabled_lastSynthesisAt_userId_idx"
  ON "UserMemorySettings"("synthesisEnabled", "lastSynthesisAt", "userId");

CREATE INDEX "MemoryFactVersion_userId_modality_synthesisGeneration_state_idx"
  ON "MemoryFactVersion"("userId", "modality", "synthesisGeneration", "state");

CREATE INDEX "MemoryFactVersion_userId_synthesisSourceSetFingerprint_idx"
  ON "MemoryFactVersion"("userId", "synthesisSourceSetFingerprint");

CREATE INDEX "MemoryFactVersionRelation_synthesis_target_idx"
  ON "MemoryFactVersionRelation"("userId", "targetVersionId", "kind")
  WHERE "kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind";

CREATE UNIQUE INDEX "MemorySynthesisExecution_userId_id_key"
  ON "MemorySynthesisExecution"("userId", "id");

CREATE UNIQUE INDEX "MemorySynthesisExecution_userId_memoryJobId_key"
  ON "MemorySynthesisExecution"("userId", "memoryJobId");

CREATE UNIQUE INDEX "MemorySynthesisExecution_userId_executionBindingId_key"
  ON "MemorySynthesisExecution"("userId", "executionBindingId");

CREATE INDEX "MemorySynthesisExecution_userId_appliedAt_createdAt_idx"
  ON "MemorySynthesisExecution"("userId", "appliedAt", "createdAt");

ALTER TABLE "MemorySynthesisExecution"
  ADD CONSTRAINT "MemorySynthesisExecution_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySynthesisExecution"
  ADD CONSTRAINT "MemorySynthesisExecution_job_fkey"
  FOREIGN KEY ("userId", "memoryJobId")
  REFERENCES "MemoryJob"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySynthesisExecution"
  ADD CONSTRAINT "MemorySynthesisExecution_binding_fkey"
  FOREIGN KEY ("userId", "executionBindingId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "UserMemorySettings"
  ADD CONSTRAINT "UserMemorySettings_synthesis_shape_check" CHECK (
    (
      "synthesisEnabledAt" IS NULL
      AND "synthesisPolicyVersion" IS NULL
      AND "synthesisEnabled" = FALSE
      AND "lastSynthesisAt" IS NULL
    )
    OR (
      "synthesisEnabledAt" IS NOT NULL
      AND "synthesisPolicyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
      AND ("lastSynthesisAt" IS NULL OR "lastSynthesisAt" >= "synthesisEnabledAt")
    )
  );

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_synthesis_shape_check" CHECK (
    (
      "modality" = 'PATTERN'::"MemoryFactModality"
      AND "sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND "directness" = 'INFERRED'::"MemoryDirectness"
      AND "synthesisDepth" = 1
      AND "synthesisGeneration" >= 0
      AND "synthesisSourceSetFingerprint" ~ '^[a-f0-9]{64}$'
      AND "coreEligible" = FALSE
      AND "coreSalience" = 'NONE'::"MemoryCoreSalience"
    )
    OR (
      "modality" <> 'PATTERN'::"MemoryFactModality"
      AND "synthesisDepth" = 0
      AND "synthesisGeneration" IS NULL
      AND "synthesisSourceSetFingerprint" IS NULL
    )
  );

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_synthesis_shape_check" CHECK (
    (
      "kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
      AND "executionId" IS NOT NULL
      AND "sourceEligibilityHash" ~ '^[a-f0-9]{64}$'
    )
    OR (
      "kind" <> 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
      AND "sourceEligibilityHash" IS NULL
    )
  );

ALTER TABLE "MemorySynthesisExecution"
  ADD CONSTRAINT "MemorySynthesisExecution_shape_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$'
    AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    AND "sourceSetFingerprint" ~ '^[a-f0-9]{64}$'
    AND "sourceSnapshotHash" ~ '^[a-f0-9]{64}$'
    AND (
      (
        "appliedAt" IS NULL
        AND jsonb_typeof("acceptedOutput") = 'object'
        AND jsonb_typeof("sourceBindings") = 'array'
      )
      OR (
        "appliedAt" IS NOT NULL
        AND "appliedAt" >= "createdAt"
        AND "acceptedOutput" IS NULL
        AND "sourceBindings" IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_synthesis_execution_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id", NEW."userId", NEW."memoryJobId", NEW."executionBindingId",
    NEW."inputHash", NEW."acceptedOutputHash", NEW."sourceSetFingerprint",
    NEW."sourceSnapshotHash", NEW."createdAt"
  ) IS DISTINCT FROM (
    OLD."id", OLD."userId", OLD."memoryJobId", OLD."executionBindingId",
    OLD."inputHash", OLD."acceptedOutputHash", OLD."sourceSetFingerprint",
    OLD."sourceSnapshotHash", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Memory synthesis execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."appliedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Applied Memory synthesis execution is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."appliedAt" IS NULL AND (
    NEW."acceptedOutput", NEW."sourceBindings"
  ) IS DISTINCT FROM (
    OLD."acceptedOutput", OLD."sourceBindings"
  ) THEN
    RAISE EXCEPTION 'Pending Memory synthesis output is immutable'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM "MemoryJob" AS job
  INNER JOIN "MemoryExecutionBinding" AS binding
    ON binding."userId" = job."userId"
   AND binding."memoryJobId" = job."id"
  WHERE job."userId" = NEW."userId"
    AND job."id" = NEW."memoryJobId"
    AND job."kind" = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
    AND job."pipelineVersion" = 'memory-synthesis-v2'
    AND binding."id" = NEW."executionBindingId"
    AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
    AND binding."logicalRole" = 'MEMORY_SYNTHESIZE'
    AND binding."inputHash" = NEW."inputHash"
    AND binding."acceptedOutputHash" = NEW."acceptedOutputHash"
    AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory synthesis execution receipt is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemorySynthesisExecution_guard"
BEFORE INSERT OR UPDATE ON "MemorySynthesisExecution"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_synthesis_execution_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_synthesis_relation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."kind" <> 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind" THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "MemoryFactVersion" AS pattern
  INNER JOIN "MemoryFact" AS pattern_fact
    ON pattern_fact."userId" = pattern."userId"
   AND pattern_fact."id" = pattern."factId"
  INNER JOIN "MemoryFactVersion" AS source
    ON source."userId" = pattern."userId"
   AND source."id" = NEW."targetVersionId"
  INNER JOIN "MemoryExecutionBinding" AS binding
    ON binding."userId" = pattern."userId"
   AND binding."id" = NEW."executionId"
  WHERE pattern."userId" = NEW."userId"
    AND pattern."id" = NEW."sourceVersionId"
    AND pattern."modality" = 'PATTERN'::"MemoryFactModality"
    AND pattern."directness" = 'INFERRED'::"MemoryDirectness"
    AND pattern."synthesisDepth" = 1
    AND pattern_fact."identityKind" = 'PROPOSITION'::"MemoryFactIdentityKind"
    AND source."modality" <> 'PATTERN'::"MemoryFactModality"
    AND source."directness" <> 'INFERRED'::"MemoryDirectness"
    AND source."synthesisDepth" = 0
    AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
    AND binding."logicalRole" = 'MEMORY_SYNTHESIZE'
    AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory synthesis relation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactVersionRelation_synthesis_guard"
BEFORE INSERT ON "MemoryFactVersionRelation"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_synthesis_relation_guard();

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
  pointed_modality "MemoryFactModality";
  synthesis_source_count integer;
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
    SELECT "state", "expiresAt", "systemTo", "mergedIntoVersionId", "modality"
    INTO pointed_state, pointed_expires_at, pointed_system_to,
      pointed_merge_target, pointed_modality
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

    IF pointed_modality = 'PATTERN'::"MemoryFactModality" THEN
      SELECT count(DISTINCT relation."targetVersionId") INTO synthesis_source_count
      FROM "MemoryFactVersionRelation" AS relation
      WHERE relation."userId" = p_user_id
        AND relation."sourceVersionId" = fact_row."currentVersionId"
        AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind";
      IF fact_row."identityKind" IS DISTINCT FROM 'PROPOSITION'
         OR synthesis_source_count < 3 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'ACTIVE PATTERN must be a depth-one source-linked proposition';
      END IF;
    END IF;
  ELSIF fact_row."currentVersionId" IS NOT NULL OR active_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-ACTIVE Memory fact cannot retain an ACTIVE version or current pointer';
  END IF;
END;
$function$;
