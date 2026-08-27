ALTER TABLE "MemoryFactVersion"
  DROP CONSTRAINT "MemoryFactVersion_safety_provenance_check";

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_safety_provenance_check" CHECK (
    (
      "safetyClassificationState" = 'PENDING'::"MemorySafetyClassificationState"
      AND num_nonnulls(
        "safetyClassifierExecutionId", "safetyClassifierProviderId",
        "safetyClassifierModelId", "safetyClassifierPolicyVersion",
        "safetyClassificationReasonCode", "safetyClassifiedAt"
      ) = 0
    )
    OR (
      "safetyClassificationState" <> 'PENDING'::"MemorySafetyClassificationState"
      AND num_nonnulls(
        "safetyClassifierExecutionId", "safetyClassifierProviderId",
        "safetyClassifierModelId", "safetyClassifierPolicyVersion",
        "safetyClassificationReasonCode", "safetyClassifiedAt"
      ) = 6
    )
    OR (
      "safetyClassificationState" IN (
        'CLASSIFIED'::"MemorySafetyClassificationState",
        'SECRET_FENCED'::"MemorySafetyClassificationState"
      )
      AND num_nonnulls(
        "safetyClassifierExecutionId", "safetyClassifierProviderId",
        "safetyClassifierModelId"
      ) = 0
      AND "safetyClassifierPolicyVersion" = 'memory-safety-lite-v1'
      AND "safetyClassificationReasonCode" IN (
        'lite_non_secret_default',
        'lite_secret_only',
        'lite_span_redacted'
      )
      AND "safetyClassifiedAt" IS NOT NULL
      AND (
        "safetyClassificationState" = 'SECRET_FENCED'::"MemorySafetyClassificationState"
      ) = (
        "safetyClassificationReasonCode" = 'lite_secret_only'
      )
    )
    OR (
      "safetyClassificationState" =
        'SECRET_FENCED'::"MemorySafetyClassificationState"
      AND "safetyClassifierExecutionId" IS NULL
      AND "safetyClassifierProviderId" = 'aiqsa-local-policy'
      AND "safetyClassifierModelId" = 'format-aware-secret-parser-v1'
      AND "safetyClassifierPolicyVersion" = 'memory-local-secret-parser-v1'
      AND "safetyClassificationReasonCode" = 'secret_material'
      AND "safetyClassifiedAt" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "MemoryFactVersion"
  VALIDATE CONSTRAINT "MemoryFactVersion_safety_provenance_check";

ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v4';

ALTER TABLE "ChatMemoryDigest"
  DROP CONSTRAINT "ChatMemoryDigest_incremental_metadata_check",
  ADD CONSTRAINT "ChatMemoryDigest_incremental_metadata_check"
  CHECK (
    "pipelineVersion" NOT IN (
      'memory-chat-digest-v2',
      'memory-chat-digest-v3',
      'memory-chat-digest-v4',
      'memory-chat-digest-v5'
    )
    OR (
      "sourceFingerprint" IS NOT NULL
      AND "sourceFingerprint" ~ '^[a-f0-9]{64}$'
      AND "inputFingerprint" IS NOT NULL
      AND "inputFingerprint" ~ '^[a-f0-9]{64}$'
      AND "rebuildPolicyVersion" IS NOT NULL
      AND "rebuildPolicyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "updateMode" IS NOT NULL
      AND "updateMode" IN (
        'FULL_REBUILD', 'INCREMENTAL', 'REBOUND', 'UNCHANGED'
      )
    )
  );

DO $migration$
DECLARE
  function_definition text;
BEGIN
  function_definition := pg_get_functiondef(
    'aiqsa_memory_assert_history_source(text,text)'::regprocedure
  );
  function_definition := replace(
    function_definition,
    '''memory-history-chunking-v3''',
    '''memory-history-chunking-v4'''
  );
  IF position('memory-history-chunking-v4' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Memory history source guard v4 extension failed';
  END IF;
  EXECUTE function_definition;

  function_definition := pg_get_functiondef(
    'aiqsa_memory_assert_digest_sources(text)'::regprocedure
  );
  function_definition := replace(
    function_definition,
    '''memory-history-chunking-v3''',
    '''memory-history-chunking-v4'''
  );
  function_definition := replace(
    function_definition,
    '''memory-history-source-projection-v3''',
    '''memory-history-source-projection-v4'''
  );
  IF position('memory-history-chunking-v4' IN function_definition) = 0
    OR position('memory-history-source-projection-v4' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Memory digest source guard v4 extension failed';
  END IF;
  EXECUTE function_definition;
END;
$migration$;

-- Extraction v6 changes only the safe source projection. Preserve every
-- existing receipt/ownership rule while admitting the new exact pipeline in
-- the database-owned guards. Using each installed function definition avoids
-- copying four long guard bodies into a second migration owner.
DO $migration$
DECLARE
  function_identity regprocedure;
  function_definition text;
BEGIN
  FOREACH function_identity IN ARRAY ARRAY[
    'aiqsa_memory_fact_extraction_execution_guard()'::regprocedure,
    'aiqsa_memory_auxiliary_semantic_call_guard()'::regprocedure,
    'aiqsa_memory_fact_extraction_binding_guard()'::regprocedure,
    'aiqsa_memory_job_source_message_guard()'::regprocedure
  ]
  LOOP
    function_definition := pg_get_functiondef(function_identity);
    IF position('memory-fact-extraction-vnext-v6' IN function_definition) = 0 THEN
      function_definition := replace(
        function_definition,
        '''memory-fact-extraction-vnext-v5''',
        '''memory-fact-extraction-vnext-v5'', ''memory-fact-extraction-vnext-v6'''
      );
      IF position('memory-fact-extraction-vnext-v6' IN function_definition) = 0 THEN
        RAISE EXCEPTION 'Memory extraction guard v6 extension failed for %',
          function_identity;
      END IF;
      EXECUTE function_definition;
    END IF;
  END LOOP;
END;
$migration$;
