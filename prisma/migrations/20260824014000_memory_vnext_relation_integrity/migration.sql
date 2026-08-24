-- Close the remaining raw-SQL boundaries for Package D: one ACTIVE row per
-- server-owned SLOT identity, exact resolver-result recovery shape, and a
-- same-owner execution receipt for provider-backed relation provenance.

CREATE UNIQUE INDEX "MemoryFact_active_slot_identity_key"
  ON "MemoryFact"(
    "userId", "scopeId", "subjectKey", "predicateKey", "dimensionKey"
  ) NULLS NOT DISTINCT
  WHERE "state" = 'ACTIVE'::"MemoryFactState"
    AND "identityKind" = 'SLOT'::"MemoryFactIdentityKind";

ALTER TABLE "MemoryFactVersionRelation"
  ADD CONSTRAINT "MemoryFactVersionRelation_execution_fkey"
  FOREIGN KEY ("userId", "executionId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_result_contract_check" CHECK (
    "completedAt" IS NULL
    OR (
      jsonb_typeof("result") = 'object'
      AND "result" ?& ARRAY[
        'acceptedOutputHash', 'decision', 'executionId', 'inputHash',
        'modelId', 'policyVersion', 'providerId'
      ]
      AND "result" - ARRAY[
        'acceptedOutputHash', 'decision', 'executionId', 'inputHash',
        'modelId', 'policyVersion', 'providerId'
      ] = '{}'::jsonb
      AND "result" ->> 'acceptedOutputHash' = "acceptedOutputHash"
      AND "result" ->> 'executionId' = "executionId"
      AND "result" ->> 'inputHash' = "inputHash"
      AND char_length("result" ->> 'modelId') BETWEEN 1 AND 256
      AND ("result" ->> 'modelId') !~ '[[:cntrl:]]'
      AND char_length("result" ->> 'policyVersion') BETWEEN 1 AND 64
      AND ("result" ->> 'policyVersion') !~ '[[:cntrl:]]'
      AND char_length("result" ->> 'providerId') BETWEEN 1 AND 64
      AND ("result" ->> 'providerId') !~ '[[:cntrl:]]'
      AND jsonb_typeof("result" -> 'decision') = 'object'
      AND ("result" -> 'decision') ?& ARRAY[
        'confidence_band', 'operation', 'reason_code', 'target_ref'
      ]
      AND ("result" -> 'decision') - ARRAY[
        'confidence_band', 'operation', 'reason_code', 'target_ref'
      ] = '{}'::jsonb
      AND "result" -> 'decision' ->> 'confidence_band' IN (
        'HIGH', 'MEDIUM', 'LOW'
      )
      AND "result" -> 'decision' ->> 'operation' IN (
        'MERGE_NEW_INTO_TARGET',
        'MERGE_TARGET_INTO_NEW',
        'SUPERSEDE_TARGET',
        'MOVE_TO_DISTINCT_FACT',
        'AMBIGUOUS'
      )
      AND "result" -> 'decision' ->> 'reason_code'
        ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
      AND (
        (
          "result" -> 'decision' ->> 'operation' = 'AMBIGUOUS'
          AND "result" -> 'decision' -> 'target_ref' = 'null'::jsonb
        )
        OR (
          "result" -> 'decision' ->> 'operation' <> 'AMBIGUOUS'
          AND jsonb_typeof("result" -> 'decision' -> 'target_ref') = 'string'
          AND "result" -> 'decision' ->> 'target_ref'
            ~ '^R([1-9]|1[0-2])$'
        )
      )
    )
  );

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
      AND binding."inputHash" = NEW."inputHash"
      AND binding."acceptedOutputHash" = NEW."acceptedOutputHash";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Memory auxiliary semantic call receipt is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
