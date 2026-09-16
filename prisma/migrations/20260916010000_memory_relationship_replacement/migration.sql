-- Admit the explicit relationship-replacement adjudication wire version.
-- Keep earlier settled result formats and every independent result guard.

ALTER TABLE "MemoryAuxiliarySemanticCall"
  DROP CONSTRAINT "MemoryAuxiliarySemanticCall_result_contract_check";

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_result_contract_check" CHECK (
    "purpose" = 'EXPLICIT_FACT_EQUIVALENCE'
    OR "completedAt" IS NULL
    OR (
      "purpose" = 'FACT_EXTRACTION_ADJUDICATION'
      AND jsonb_typeof("result") = 'object'
      AND "result" ?& ARRAY[
        'decisions', 'inputHash', 'outputHash', 'schemaVersion'
      ]
      AND "result" - ARRAY[
        'decisions', 'inputHash', 'outputHash', 'schemaVersion'
      ] = '{}'::jsonb
      AND "result" ->> 'inputHash' = "inputHash"
      AND "result" ->> 'outputHash' = "acceptedOutputHash"
      AND "result" ->> 'schemaVersion' IN (
        'memory-semantic-adjudication-schema-v1',
        'memory-semantic-adjudication-schema-v2',
        'memory-semantic-adjudication-schema-v3'
      )
      AND jsonb_typeof("result" -> 'decisions') = 'array'
      AND jsonb_array_length("result" -> 'decisions') BETWEEN 1 AND 8
      AND octet_length("result"::text) <= 32768
    )
    OR (
      "purpose" = 'FACT_RELATION'
      AND jsonb_typeof("result") = 'object'
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
          AND jsonb_typeof("result" -> 'decision' -> 'target_ref') =
            'string'
          AND "result" -> 'decision' ->> 'target_ref'
            ~ '^R([1-9]|1[0-2])$'
        )
      )
    )
  );
