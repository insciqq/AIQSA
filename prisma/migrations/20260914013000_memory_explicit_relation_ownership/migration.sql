-- Explicit saves have a durable owner event/receipt, not a source chat.
-- Extend the existing relation and auxiliary-call owners without admitting
-- source-less automatic extraction or changing any prior result contract.
ALTER TABLE "MemoryAuxiliarySemanticCall"
  ALTER COLUMN "sourceMessageId" DROP NOT NULL,
  ADD COLUMN "targetFactVersionId" TEXT;

CREATE UNIQUE INDEX "MemoryAuxiliarySemanticCall_userId_targetFactVersionId_key"
  ON "MemoryAuxiliarySemanticCall" ("userId", "targetFactVersionId");

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_target_version_fkey"
    FOREIGN KEY ("userId", "targetFactVersionId")
    REFERENCES "MemoryFactVersion" ("userId", "id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_source_kind_check" CHECK (
    (
      "purpose" = 'EXPLICIT_FACT_EQUIVALENCE'
      AND "sourceMessageId" IS NULL AND "targetFactVersionId" IS NOT NULL
    ) OR (
      "purpose" <> 'EXPLICIT_FACT_EQUIVALENCE'
      AND "sourceMessageId" IS NOT NULL AND "targetFactVersionId" IS NULL
    )
  );

ALTER TABLE "MemoryJob" DROP CONSTRAINT "MemoryJob_relation_target_shape_check";
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_relation_target_shape_check" CHECK (
  (
    "kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
    AND "targetFactVersionId" IS NOT NULL
    AND (
      (
        "pipelineVersion" = 'memory-explicit-relation-v1'
        AND num_nonnulls("sourceMessageId", "chatId", "activeLeafMessageId",
          "branchGeneration", "sourceRevision", "sourceHash") = 0
      ) OR (
        "pipelineVersion" <> 'memory-explicit-relation-v1'
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

-- Preserve the installed extraction/legacy relation expression exactly.
-- The new purpose is constrained by the independent closed decoder below.
DO $migration$
DECLARE
  previous_expression TEXT;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous_expression
  FROM pg_constraint
  WHERE conrelid = '"MemoryAuxiliarySemanticCall"'::regclass
    AND conname = 'MemoryAuxiliarySemanticCall_result_contract_check';
  ALTER TABLE "MemoryAuxiliarySemanticCall"
    DROP CONSTRAINT "MemoryAuxiliarySemanticCall_result_contract_check";
  EXECUTE format(
    'ALTER TABLE "MemoryAuxiliarySemanticCall" ADD CONSTRAINT "MemoryAuxiliarySemanticCall_result_contract_check" CHECK ("purpose" = %L OR (%s))',
    'EXPLICIT_FACT_EQUIVALENCE', previous_expression
  );
END;
$migration$;

CREATE FUNCTION aiqsa_memory_explicit_relation_result_valid(
  packet JSONB, source_version TEXT, input_hash TEXT, output_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $function$
DECLARE
  candidate JSONB;
  decision JSONB;
  candidate_ids TEXT[] := ARRAY[]::TEXT[];
  seen_refs TEXT[] := ARRAY[]::TEXT[];
  expected_refs TEXT[];
  candidate_count INTEGER;
  ref TEXT;
BEGIN
  IF jsonb_typeof(packet) IS DISTINCT FROM 'object'
    OR NOT (packet ?& ARRAY['schemaVersion', 'sourceVersionId', 'candidateVersionIds',
      'snapshotHash', 'inputHash', 'outputHash', 'decisions'])
    OR packet - ARRAY['schemaVersion', 'sourceVersionId', 'candidateVersionIds',
      'snapshotHash', 'inputHash', 'outputHash', 'decisions'] <> '{}'::JSONB
    OR jsonb_typeof(packet -> 'schemaVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(packet -> 'sourceVersionId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(packet -> 'inputHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(packet -> 'outputHash') IS DISTINCT FROM 'string'
    OR packet ->> 'schemaVersion' IS DISTINCT FROM 'memory-explicit-relation-recovery-v1'
    OR packet ->> 'sourceVersionId' IS DISTINCT FROM source_version
    OR packet ->> 'inputHash' IS DISTINCT FROM input_hash
    OR packet ->> 'outputHash' IS DISTINCT FROM output_hash
    OR jsonb_typeof(packet -> 'snapshotHash') IS DISTINCT FROM 'string'
    OR NOT (packet ->> 'snapshotHash' ~ '^[a-f0-9]{64}$')
    OR jsonb_typeof(packet -> 'candidateVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(packet -> 'decisions') IS DISTINCT FROM 'array'
    OR octet_length(packet::TEXT) > 16384 THEN
    RETURN FALSE;
  END IF;
  candidate_count := jsonb_array_length(packet -> 'candidateVersionIds');
  IF candidate_count NOT BETWEEN 1 AND 12
    OR jsonb_array_length(packet -> 'decisions') <> candidate_count THEN
    RETURN FALSE;
  END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(packet -> 'candidateVersionIds') LOOP
    IF jsonb_typeof(candidate) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
    ref := candidate #>> '{}';
    IF char_length(ref) NOT BETWEEN 1 AND 256 OR btrim(ref) <> ref
      OR ref ~ '[[:cntrl:]]' OR ref = source_version OR ref = ANY(candidate_ids) THEN
      RETURN FALSE;
    END IF;
    candidate_ids := array_append(candidate_ids, ref);
  END LOOP;
  SELECT array_agg('R' || ordinal::TEXT) INTO expected_refs
  FROM generate_series(1, candidate_count) AS ordinal;
  FOR decision IN SELECT value FROM jsonb_array_elements(packet -> 'decisions') LOOP
    IF jsonb_typeof(decision) IS DISTINCT FROM 'object'
      OR NOT (decision ?& ARRAY['confidenceBand', 'relation', 'targetRef'])
      OR decision - ARRAY['confidenceBand', 'relation', 'targetRef'] <> '{}'::JSONB
      OR jsonb_typeof(decision -> 'targetRef') IS DISTINCT FROM 'string'
      OR NOT COALESCE(decision ->> 'confidenceBand' IN ('HIGH', 'MEDIUM', 'LOW'), FALSE)
      OR NOT COALESCE(decision ->> 'relation' IN ('EQUIVALENT', 'DISTINCT', 'UNCERTAIN'), FALSE) THEN
      RETURN FALSE;
    END IF;
    ref := decision ->> 'targetRef';
    IF NOT (ref = ANY(expected_refs)) OR ref = ANY(seen_refs) THEN RETURN FALSE; END IF;
    seen_refs := array_append(seen_refs, ref);
  END LOOP;
  RETURN cardinality(seen_refs) = candidate_count;
END;
$function$;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_explicit_result_check" CHECK (
    "purpose" <> 'EXPLICIT_FACT_EQUIVALENCE' OR "completedAt" IS NULL OR
    COALESCE(aiqsa_memory_explicit_relation_result_valid(
      "result", "targetFactVersionId", "inputHash", "acceptedOutputHash"
    ), FALSE)
  );

CREATE FUNCTION aiqsa_memory_explicit_relation_call_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."targetFactVersionId" IS DISTINCT FROM OLD."targetFactVersionId" THEN
    RAISE EXCEPTION 'Memory auxiliary fact identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."purpose" <> 'EXPLICIT_FACT_EQUIVALENCE' THEN RETURN NEW; END IF;
  PERFORM 1
  FROM "MemoryJob" AS job
  INNER JOIN "MemoryFactVersion" AS version
    ON version."userId" = job."userId" AND version."id" = job."targetFactVersionId"
  WHERE job."userId" = NEW."userId" AND job."id" = NEW."ownerJobId"
    AND job."kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
    AND job."pipelineVersion" = 'memory-explicit-relation-v1'
    AND job."targetFactVersionId" = NEW."targetFactVersionId"
    AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
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
      AND binding."pipelineVersion" = 'memory-explicit-relation-v1'
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

CREATE TRIGGER "MemoryAuxiliarySemanticCall_explicit_guard"
BEFORE INSERT OR UPDATE ON "MemoryAuxiliarySemanticCall"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_explicit_relation_call_guard();

CREATE FUNCTION aiqsa_memory_explicit_relation_binding_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."logicalRole" = 'MEMORY_CONSOLIDATE'
    AND NEW."pipelineVersion" = 'memory-explicit-relation-v1'
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

CREATE CONSTRAINT TRIGGER "MemoryExecutionBinding_explicit_relation_guard"
AFTER INSERT OR UPDATE ON "MemoryExecutionBinding"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_explicit_relation_binding_guard();
