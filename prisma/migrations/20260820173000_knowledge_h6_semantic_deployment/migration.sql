-- H6 deploys only an already-frozen, profile-authorized local semantic
-- validator. External execution remains unavailable until it has a durable
-- recovery-safe attempt ledger; this migration cannot authorize provider I/O.

CREATE FUNCTION "knowledge_semantic_validator_deployment_valid"(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN "knowledge_jsonb_has_exact_keys"(value, ARRAY[
    'authorization', 'calibrationOutputSha256', 'candidateId',
    'candidateIdentitySha256', 'candidateImplementationSha256', 'egress',
    'executionClass', 'finalOutputSha256', 'profileId', 'qualityEvidenceSha256',
    'recoveryMode', 'selectionFreezeVersion', 'selectionManifestSha256',
    'semanticProof', 'validatorVersion', 'version'
  ]::TEXT[])
  AND value ->> 'authorization' = 'profile_authorized'
  AND value ->> 'calibrationOutputSha256' ~ '^[0-9a-f]{64}$'
  AND value ->> 'candidateId' = 'local_multilingual_nli_v1'
  AND value ->> 'candidateIdentitySha256' ~ '^[0-9a-f]{64}$'
  AND value ->> 'candidateImplementationSha256' ~ '^[0-9a-f]{64}$'
  AND value ->> 'egress' = 'local'
  AND value ->> 'executionClass' = 'real_model'
  AND value ->> 'finalOutputSha256' ~ '^[0-9a-f]{64}$'
  AND value ->> 'profileId' ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'
  AND value ->> 'qualityEvidenceSha256' ~ '^[0-9a-f]{64}$'
  AND value ->> 'recoveryMode' = 'deterministic_replay'
  AND value ->> 'selectionFreezeVersion' = 'knowledge-semantic-selection-freeze-v1'
  AND value ->> 'selectionManifestSha256' ~ '^[0-9a-f]{64}$'
  AND value -> 'semanticProof' = 'true'::JSONB
  AND jsonb_typeof(value -> 'validatorVersion') = 'number'
  AND value ->> 'validatorVersion' ~ '^[1-9][0-9]*$'
  AND (value ->> 'validatorVersion')::NUMERIC BETWEEN 1 AND 10000
  AND value -> 'version' = '1'::JSONB;

-- Shape is not release authority. H6 currently has no independently verified
-- winner, so this allowlist is intentionally empty. A later promotion migration
-- must replace this function with an exact full-commitment match after the real
-- selection freeze is available; self-hashed input cannot authorize itself.
CREATE FUNCTION "knowledge_semantic_validator_deployment_released"(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN false;

CREATE FUNCTION "knowledge_semantic_profile_authorized_shadow_result_valid"(
  "retrievalSessionId" TEXT,
  version INTEGER,
  mode TEXT,
  "executionStatus" TEXT,
  "validatorProfile" TEXT,
  "validatorVersion" INTEGER,
  "semanticProof" BOOLEAN,
  "egressMode" TEXT,
  "profileRevisionIds" TEXT[],
  diagnostic JSONB,
  "contentFreeMetrics" JSONB,
  "receiptHash" TEXT,
  "purgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  normalized_diagnostic JSONB;
  normalized_metrics JSONB;
  normalized_receipt_hash TEXT;
BEGIN
  IF version <> 1 OR mode <> 'shadow'
    OR "executionStatus" NOT IN ('complete', 'unavailable')
    OR "validatorProfile" !~ '^[a-z0-9][a-z0-9_.-]{0,79}$'
    OR "validatorProfile" = 'structural-baseline-v1'
    OR "validatorVersion" NOT BETWEEN 1 AND 10000
    OR "semanticProof" IS DISTINCT FROM ("executionStatus" = 'complete')
    OR "egressMode" <> 'local'
    OR NOT "knowledge_semantic_profile_revision_ids_valid"("profileRevisionIds")
    OR "contentFreeMetrics" ->> 'egress' IS DISTINCT FROM "egressMode"
    OR "contentFreeMetrics" ->> 'executionStatus' IS DISTINCT FROM "executionStatus"
    OR "contentFreeMetrics" ->> 'validatorProfile' IS DISTINCT FROM "validatorProfile"
    OR "contentFreeMetrics" -> 'validatorVersion' IS DISTINCT FROM to_jsonb("validatorVersion")
    OR "contentFreeMetrics" -> 'semanticProof' IS DISTINCT FROM to_jsonb("semanticProof")
    OR "contentFreeMetrics" -> 'latencyMs' IS DISTINCT FROM 'null'::JSONB
    OR ("executionStatus" = 'complete' AND
      "contentFreeMetrics" -> 'failureReasonCode' IS DISTINCT FROM 'null'::JSONB)
    OR ("executionStatus" = 'unavailable' AND
      "contentFreeMetrics" ->> 'failureReasonCode' NOT IN (
        'local_executor_failed', 'local_executor_identity_mismatch',
        'local_executor_output_invalid', 'local_executor_timeout',
        'local_executor_unavailable', 'local_shadow_sealing_failed',
        'local_validator_input_too_large',
        'local_validator_request_invalid'
      ))
  THEN
    RETURN false;
  END IF;

  normalized_metrics := "contentFreeMetrics" || jsonb_build_object(
    'egress', 'none',
    'semanticProof', false,
    'validatorProfile', 'structural-baseline-v1',
    'validatorVersion', 1
  );

  IF "purgedAt" IS NOT NULL THEN
    IF diagnostic IS NOT NULL OR "receiptHash" IS NOT NULL THEN
      RETURN false;
    END IF;
    RETURN "knowledge_semantic_shadow_result_valid"(
      "retrievalSessionId", version, mode, "executionStatus", 'structural-baseline-v1',
      1, false, 'none', "profileRevisionIds", diagnostic, normalized_metrics, "receiptHash",
      "purgedAt", "createdAt"
    );
  END IF;

  IF "receiptHash" IS NULL OR "receiptHash" !~ '^[0-9a-f]{64}$'
    OR NOT COALESCE("knowledge_jsonb_has_exact_keys"(diagnostic, ARRAY[
      'answerHash', 'attemptId', 'blockingApplied', 'claims', 'evidenceReceiptHash',
      'executionStatus', 'failureReasonCode', 'latencyMs', 'receiptHash', 'runId', 'sessionId',
      'summary', 'usage', 'validator', 'version'
    ]::TEXT[]), false)
    OR pg_column_size(diagnostic) > 4194304
    OR NOT COALESCE("knowledge_jsonb_has_exact_keys"(diagnostic -> 'validator', ARRAY[
      'egress', 'profileId', 'profileVersion', 'semanticProof'
    ]::TEXT[]), false)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(diagnostic -> 'claims') = 'array'
        THEN diagnostic -> 'claims'
        ELSE '[]'::JSONB
      END) AS entries(claim)
      WHERE CASE
        WHEN jsonb_typeof(claim -> 'confidence') = 'number'
        THEN (claim ->> 'confidence')::NUMERIC * 1000000 <>
          trunc((claim ->> 'confidence')::NUMERIC * 1000000)
        ELSE true
      END
    )
    OR diagnostic ->> 'receiptHash' IS DISTINCT FROM "receiptHash"
    OR encode(sha256(convert_to(
      "knowledge_semantic_canonical_json"(diagnostic - 'receiptHash'), 'UTF8'
    )), 'hex') IS DISTINCT FROM "receiptHash"
    OR diagnostic ->> 'executionStatus' IS DISTINCT FROM "executionStatus"
    OR diagnostic -> 'failureReasonCode' IS DISTINCT FROM
      "contentFreeMetrics" -> 'failureReasonCode'
    OR diagnostic -> 'latencyMs' IS DISTINCT FROM 'null'::JSONB
    OR diagnostic #>> '{validator,egress}' IS DISTINCT FROM "egressMode"
    OR diagnostic #>> '{validator,profileId}' IS DISTINCT FROM "validatorProfile"
    OR diagnostic #> '{validator,profileVersion}' IS DISTINCT FROM
      to_jsonb("validatorVersion")
    OR diagnostic #> '{validator,semanticProof}' IS DISTINCT FROM
      to_jsonb("semanticProof")
  THEN
    RETURN false;
  END IF;

  normalized_diagnostic := diagnostic || jsonb_build_object(
    'validator', jsonb_build_object(
      'egress', 'none',
      'profileId', 'structural-baseline-v1',
      'profileVersion', 1,
      'semanticProof', false
    )
  );
  normalized_receipt_hash := encode(sha256(convert_to(
    "knowledge_semantic_canonical_json"(normalized_diagnostic - 'receiptHash'), 'UTF8'
  )), 'hex');
  normalized_diagnostic := normalized_diagnostic ||
    jsonb_build_object('receiptHash', normalized_receipt_hash);

  RETURN "knowledge_semantic_shadow_result_valid"(
    "retrievalSessionId", version, mode, "executionStatus", 'structural-baseline-v1',
    1, false, 'none', "profileRevisionIds", normalized_diagnostic,
    normalized_metrics, normalized_receipt_hash, "purgedAt", "createdAt"
  );
END
$function$;

ALTER TABLE "KnowledgeSemanticShadowResult"
  DROP CONSTRAINT "KnowledgeSemanticShadowResult_shape_check";

ALTER TABLE "KnowledgeSemanticShadowResult"
  ADD CONSTRAINT "KnowledgeSemanticShadowResult_shape_check" CHECK (
    "knowledge_semantic_shadow_result_valid"(
      "retrievalSessionId", "version", "mode", "executionStatus", "validatorProfile",
      "validatorVersion", "semanticProof", "egressMode", "profileRevisionIds", "diagnostic",
      "contentFreeMetrics", "receiptHash", "purgedAt", "createdAt"
    ) OR "knowledge_semantic_profile_authorized_shadow_result_valid"(
      "retrievalSessionId", "version", "mode", "executionStatus", "validatorProfile",
      "validatorVersion", "semanticProof", "egressMode", "profileRevisionIds", "diagnostic",
      "contentFreeMetrics", "receiptHash", "purgedAt", "createdAt"
    )
  );

CREATE OR REPLACE FUNCTION "guard_accepted_knowledge_semantic_shadow_result_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  accepted_model_run_id TEXT;
  configuration_grounding_role JSONB;
  deployment JSONB;
  egress_grounding_role JSONB;
  expected_profile_revision_ids TEXT[];
  final_attempt_id TEXT;
  final_attempt_state "KnowledgeProviderAttemptState";
  final_dispatch_profile_revision_ids TEXT[];
  operation_role JSONB;
  profile_configuration JSONB;
  profile_egress_policy JSONB;
  profile_execution_authority TEXT;
  profile_revision_id TEXT;
  role_count INTEGER;
  selected_deployment JSONB := NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT session."modelRunId" INTO accepted_model_run_id
      FROM "KnowledgeRetrievalSession" AS session
      INNER JOIN "KnowledgeGroundingResult" AS grounding
        ON grounding."retrievalSessionId" = session."id"
      WHERE session."id" = NEW."retrievalSessionId"
        AND session."acceptedAt" IS NOT NULL
        AND NEW.diagnostic ->> 'runId' = session."modelRunId"
        AND NEW.diagnostic ->> 'evidenceReceiptHash' = session."receiptHash"
        AND NEW.diagnostic ->> 'answerHash' = grounding."finalAnswerHash";
    IF accepted_model_run_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Knowledge semantic shadow result requires exact accepted grounding lineage';
    END IF;
    SELECT attempt.id, attempt.state, manifest."profileRevisionIds"
      INTO final_attempt_id, final_attempt_state, final_dispatch_profile_revision_ids
    FROM "KnowledgeProviderAttempt" AS attempt
    LEFT JOIN "KnowledgeEvidenceDispatchManifest" AS manifest
      ON manifest."providerAttemptId" = attempt.id
    WHERE attempt."modelRunId" = accepted_model_run_id
    ORDER BY attempt.ordinal DESC
    LIMIT 1;
    IF final_attempt_id IS NOT NULL AND (
      final_attempt_state IS DISTINCT FROM 'settled'::"KnowledgeProviderAttemptState"
      OR final_dispatch_profile_revision_ids IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Knowledge semantic shadow result requires exact final dispatch lineage';
    END IF;
    IF final_attempt_id IS NOT NULL THEN
      expected_profile_revision_ids := final_dispatch_profile_revision_ids;
    ELSE
      SELECT COALESCE(
        array_agg(binding."profileRevisionId" ORDER BY binding."profileRevisionId"),
        ARRAY[]::TEXT[]
      ) INTO expected_profile_revision_ids
      FROM "KnowledgeRunProfileBinding" AS binding
      WHERE binding."modelRunId" = accepted_model_run_id;
    END IF;
    IF NEW."profileRevisionIds" IS DISTINCT FROM expected_profile_revision_ids THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Knowledge semantic shadow result profile lineage mismatch';
    END IF;

    IF NEW."egressMode" = 'local' THEN
      IF cardinality(expected_profile_revision_ids) = 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'Knowledge semantic shadow result requires a frozen Profile selection';
      END IF;
      FOREACH profile_revision_id IN ARRAY expected_profile_revision_ids LOOP
        SELECT revision."profileConfiguration", revision."egressPolicy",
            revision."executionAuthority"::TEXT
          INTO profile_configuration, profile_egress_policy, profile_execution_authority
        FROM "KnowledgeIndexProfileRevision" AS revision
        WHERE revision.id = profile_revision_id;
        IF NOT FOUND
          OR profile_execution_authority IS DISTINCT FROM 'installation'
          OR profile_configuration -> 'schemaVersion' IS DISTINCT FROM '4'::JSONB
          OR profile_configuration -> 'rolePolicyVersion' IS DISTINCT FROM '2'::JSONB
          OR profile_egress_policy ->> 'policyVersion' IS DISTINCT FROM
            'knowledge-profile-egress-v4'
          OR jsonb_typeof(profile_configuration -> 'operationRoles') IS DISTINCT FROM 'array'
          OR jsonb_typeof(profile_egress_policy -> 'operations') IS DISTINCT FROM 'array'
        THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Knowledge semantic shadow result Profile selection is unavailable';
        END IF;

        configuration_grounding_role := NULL;
        role_count := 0;
        FOR operation_role IN
          SELECT item FROM jsonb_array_elements(
            profile_configuration -> 'operationRoles'
          ) AS roles(item)
        LOOP
          IF operation_role ->> 'operation' = 'grounding_validation' THEN
            role_count := role_count + 1;
            configuration_grounding_role := operation_role;
          END IF;
        END LOOP;
        IF role_count <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Knowledge semantic shadow result Profile role is ambiguous';
        END IF;

        egress_grounding_role := NULL;
        role_count := 0;
        FOR operation_role IN
          SELECT item FROM jsonb_array_elements(
            profile_egress_policy -> 'operations'
          ) AS roles(item)
        LOOP
          IF operation_role ->> 'operation' = 'grounding_validation' THEN
            role_count := role_count + 1;
            egress_grounding_role := operation_role;
          END IF;
        END LOOP;
        IF role_count <> 1
          OR configuration_grounding_role IS DISTINCT FROM egress_grounding_role
          OR NOT "knowledge_jsonb_has_exact_keys"(configuration_grounding_role, ARRAY[
            'allowedRepresentations', 'dataProcessingDisclosure', 'fallback', 'logging',
            'maxCostMicros', 'maxInputBytes', 'maxInputTokens', 'mode', 'operation',
            'profileRevision', 'providerModelId', 'rawPrivateText', 'retention',
            'semanticValidator', 'timeoutMs'
          ]::TEXT[])
          OR configuration_grounding_role -> 'allowedRepresentations' IS DISTINCT FROM
            '["answer_claims", "evidence_excerpts"]'::JSONB
          OR configuration_grounding_role ->> 'dataProcessingDisclosure' IS DISTINCT FROM
            'code_default'
          OR configuration_grounding_role ->> 'fallback' IS DISTINCT FROM
            'citation_binding_fallback'
          OR configuration_grounding_role ->> 'logging' IS DISTINCT FROM 'content_free'
          OR configuration_grounding_role -> 'maxCostMicros' IS DISTINCT FROM '0'::JSONB
          OR configuration_grounding_role -> 'maxInputBytes' IS DISTINCT FROM '524288'::JSONB
          OR configuration_grounding_role -> 'maxInputTokens' IS DISTINCT FROM '65536'::JSONB
          OR configuration_grounding_role ->> 'mode' IS DISTINCT FROM 'local'
          OR configuration_grounding_role ->> 'profileRevision' IS DISTINCT FROM
            'owning_revision'
          OR configuration_grounding_role -> 'providerModelId' IS DISTINCT FROM 'null'::JSONB
          OR configuration_grounding_role -> 'rawPrivateText' IS DISTINCT FROM 'false'::JSONB
          OR configuration_grounding_role ->> 'retention' IS DISTINCT FROM 'none'
          OR configuration_grounding_role -> 'timeoutMs' IS DISTINCT FROM '2000'::JSONB
        THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Knowledge semantic shadow result Profile role is unsafe';
        END IF;

        deployment := configuration_grounding_role -> 'semanticValidator';
        IF NOT COALESCE("knowledge_semantic_validator_deployment_valid"(deployment), false)
          OR NOT COALESCE("knowledge_semantic_validator_deployment_released"(deployment), false)
          OR deployment ->> 'profileId' IS DISTINCT FROM NEW."validatorProfile"
          OR deployment -> 'validatorVersion' IS DISTINCT FROM to_jsonb(NEW."validatorVersion")
          OR (selected_deployment IS NOT NULL AND
            selected_deployment IS DISTINCT FROM deployment)
        THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Knowledge semantic shadow result frozen selection mismatch';
        END IF;
        selected_deployment := deployment;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND COALESCE(current_setting('aiqsa.knowledge_purge', true), '') = 'on'
  THEN
    IF OLD."purgedAt" IS NULL
      AND NEW."purgedAt" IS NOT NULL
      AND NEW."purgedAt" >= OLD."createdAt"
      AND NEW."retrievalSessionId" IS NOT DISTINCT FROM OLD."retrievalSessionId"
      AND NEW.version IS NOT DISTINCT FROM OLD.version
      AND NEW.mode IS NOT DISTINCT FROM OLD.mode
      AND NEW."executionStatus" IS NOT DISTINCT FROM OLD."executionStatus"
      AND NEW."validatorProfile" IS NOT DISTINCT FROM OLD."validatorProfile"
      AND NEW."validatorVersion" IS NOT DISTINCT FROM OLD."validatorVersion"
      AND NEW."semanticProof" IS NOT DISTINCT FROM OLD."semanticProof"
      AND NEW."egressMode" IS NOT DISTINCT FROM OLD."egressMode"
      AND NEW."contentFreeMetrics" IS NOT DISTINCT FROM OLD."contentFreeMetrics"
      AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
      AND NEW."profileRevisionIds" = ARRAY[]::TEXT[]
      AND NEW.diagnostic IS NULL
      AND NEW."receiptHash" IS NULL
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge semantic shadow result is immutable';
  END IF;
  IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
    AND EXISTS (
      SELECT 1
      FROM "KnowledgeRetrievalSession" AS session
      WHERE session."id" = OLD."retrievalSessionId"
        AND session."acceptedAt" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge semantic shadow result is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
