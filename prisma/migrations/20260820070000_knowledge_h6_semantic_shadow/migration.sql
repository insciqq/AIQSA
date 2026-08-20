CREATE FUNCTION "knowledge_semantic_profile_revision_ids_valid"(value TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  entry TEXT;
  previous_entry TEXT := NULL;
BEGIN
  IF value IS NULL OR COALESCE(array_ndims(value), 1) <> 1
    OR cardinality(value) > 128
  THEN
    RETURN false;
  END IF;
  FOREACH entry IN ARRAY value LOOP
    IF entry IS NULL OR length(entry) NOT BETWEEN 1 AND 128
      OR entry ~ '[[:cntrl:]]'
      OR (previous_entry IS NOT NULL AND previous_entry >= entry)
    THEN
      RETURN false;
    END IF;
    previous_entry := entry;
  END LOOP;
  RETURN true;
END
$function$;

-- The persisted structural-baseline diagnostic contains only bounded integer
-- numbers and ASCII enum/hash/opaque-id strings. Recursing over JSONB with
-- sorted object keys therefore matches semanticShadow.ts canonicalJson byte
-- for byte without an extension-provided JSON canonicalizer.
CREATE FUNCTION "knowledge_semantic_canonical_json"(value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  encoded TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(
        to_jsonb(entries.key)::TEXT || ':' ||
          "knowledge_semantic_canonical_json"(entries.value),
        ',' ORDER BY entries.key
      ), '') || '}' INTO encoded
      FROM jsonb_each(value) AS entries(key, value);
      RETURN encoded;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(
        "knowledge_semantic_canonical_json"(entries.value),
        ',' ORDER BY entries.ordinal
      ), '') || ']' INTO encoded
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(value, ordinal);
      RETURN encoded;
    WHEN 'string' THEN
      RETURN to_jsonb(value #>> '{}')::TEXT;
    ELSE
      RETURN value::TEXT;
  END CASE;
END
$function$;

CREATE FUNCTION "knowledge_semantic_string_array_valid"(
  value JSONB,
  maximum_items INTEGER,
  maximum_length INTEGER,
  required_pattern TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  entry TEXT;
  entry_json JSONB;
  seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) > maximum_items
  THEN
    RETURN false;
  END IF;
  FOR entry_json IN SELECT item FROM jsonb_array_elements(value) AS items(item) LOOP
    IF jsonb_typeof(entry_json) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    entry := entry_json #>> '{}';
    IF length(entry) NOT BETWEEN 1 AND maximum_length
      OR entry !~ required_pattern
      OR entry = ANY(seen)
    THEN
      RETURN false;
    END IF;
    seen := array_append(seen, entry);
  END LOOP;
  RETURN true;
END
$function$;

CREATE FUNCTION "knowledge_semantic_count_record_valid"(
  value JSONB,
  required_keys TEXT[],
  maximum INTEGER,
  expected_total INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  count_value INTEGER;
  key TEXT;
  total INTEGER := 0;
BEGIN
  IF NOT "knowledge_jsonb_has_exact_keys"(value, required_keys) THEN
    RETURN false;
  END IF;
  FOREACH key IN ARRAY required_keys LOOP
    IF jsonb_typeof(value -> key) IS DISTINCT FROM 'number'
      OR value ->> key !~ '^(0|[1-9][0-9]*)$'
    THEN
      RETURN false;
    END IF;
    count_value := (value ->> key)::INTEGER;
    IF count_value > maximum THEN
      RETURN false;
    END IF;
    total := total + count_value;
  END LOOP;
  RETURN total = expected_total;
END
$function$;

CREATE FUNCTION "knowledge_semantic_zero_usage_valid"(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN "knowledge_jsonb_has_exact_keys"(value, ARRAY[
    'cacheWriteInputTokens', 'cachedInputTokens', 'estimatedCostMicros', 'inputTokens',
    'outputTokens', 'reasoningTokens', 'requests', 'totalTokens'
  ]::TEXT[])
  AND value -> 'cacheWriteInputTokens' = 'null'::JSONB
  AND value -> 'cachedInputTokens' = 'null'::JSONB
  AND value -> 'estimatedCostMicros' = 'null'::JSONB
  AND value -> 'inputTokens' = 'null'::JSONB
  AND value -> 'outputTokens' = 'null'::JSONB
  AND value -> 'reasoningTokens' = 'null'::JSONB
  AND value -> 'requests' = '0'::JSONB
  AND value -> 'totalTokens' = 'null'::JSONB;

CREATE FUNCTION "knowledge_semantic_shadow_result_valid"(
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
  claim JSONB;
  claim_count INTEGER;
  claim_ordinal INTEGER := 0;
  citation_local_claim_count INTEGER := 0;
  attributable_claim_count INTEGER := 0;
  locator_state JSONB;
  observed_claim_type_counts JSONB := jsonb_build_object(
    'comparison', 0, 'coverage_claim', 0, 'derived_arithmetic', 0,
    'explicit_inference', 0, 'general_knowledge', 0, 'non_factual', 0,
    'source_fact', 0, 'source_summary', 0, 'temporal_observation', 0,
    'versioned_fact', 0
  );
  observed_confidence_bucket_counts JSONB := jsonb_build_object(
    'high', 0, 'low', 0, 'medium', 0, 'unavailable', 0
  );
  observed_decision_counts JSONB := jsonb_build_object(
    'contradicted', 0, 'supported', 0, 'uncertain', 0, 'unsupported', 0
  );
  observed_recommended_action_counts JSONB := jsonb_build_object(
    'retain', 0, 'review', 0
  );
BEGIN
  IF version <> 1 OR mode <> 'shadow'
    OR "executionStatus" NOT IN ('complete', 'failed', 'unavailable')
    OR "validatorProfile" <> 'structural-baseline-v1'
    OR "validatorVersion" <> 1
    OR "semanticProof" IS DISTINCT FROM false
    OR "egressMode" <> 'none'
    OR NOT "knowledge_semantic_profile_revision_ids_valid"("profileRevisionIds")
    OR NOT "knowledge_jsonb_has_exact_keys"("contentFreeMetrics", ARRAY[
      'attributableClaimCount', 'blockingApplied', 'citationLocalClaimCount', 'claimCount',
      'claimTypeCounts', 'confidenceBucketCounts', 'decisionCounts', 'egress',
      'executionStatus', 'failureReasonCode', 'latencyMs', 'mode', 'recommendedActionCounts',
      'semanticProof', 'usage', 'validatorProfile', 'validatorVersion', 'version'
    ]::TEXT[])
    OR pg_column_size("contentFreeMetrics") > 65536
    OR "contentFreeMetrics" -> 'version' IS DISTINCT FROM to_jsonb(version)
    OR "contentFreeMetrics" ->> 'mode' IS DISTINCT FROM mode
    OR "contentFreeMetrics" ->> 'executionStatus' IS DISTINCT FROM "executionStatus"
    OR "contentFreeMetrics" ->> 'validatorProfile' IS DISTINCT FROM "validatorProfile"
    OR "contentFreeMetrics" -> 'validatorVersion' IS DISTINCT FROM to_jsonb("validatorVersion")
    OR "contentFreeMetrics" -> 'semanticProof' IS DISTINCT FROM to_jsonb("semanticProof")
    OR "contentFreeMetrics" ->> 'egress' IS DISTINCT FROM "egressMode"
    OR "contentFreeMetrics" -> 'blockingApplied' IS DISTINCT FROM 'false'::JSONB
    OR jsonb_typeof("contentFreeMetrics" -> 'claimCount') IS DISTINCT FROM 'number'
    OR "contentFreeMetrics" ->> 'claimCount' !~ '^(0|[1-9][0-9]*)$'
    OR ("contentFreeMetrics" ->> 'claimCount')::INTEGER > 512
    OR jsonb_typeof("contentFreeMetrics" -> 'attributableClaimCount') IS DISTINCT FROM 'number'
    OR "contentFreeMetrics" ->> 'attributableClaimCount' !~ '^(0|[1-9][0-9]*)$'
    OR ("contentFreeMetrics" ->> 'attributableClaimCount')::INTEGER >
      ("contentFreeMetrics" ->> 'claimCount')::INTEGER
    OR jsonb_typeof("contentFreeMetrics" -> 'citationLocalClaimCount') IS DISTINCT FROM 'number'
    OR "contentFreeMetrics" ->> 'citationLocalClaimCount' !~ '^(0|[1-9][0-9]*)$'
    OR ("contentFreeMetrics" ->> 'citationLocalClaimCount')::INTEGER >
      ("contentFreeMetrics" ->> 'claimCount')::INTEGER
    OR NOT "knowledge_semantic_count_record_valid"(
      "contentFreeMetrics" -> 'claimTypeCounts', ARRAY[
      'comparison', 'coverage_claim', 'derived_arithmetic', 'explicit_inference',
      'general_knowledge', 'non_factual', 'source_fact', 'source_summary',
      'temporal_observation', 'versioned_fact'
      ]::TEXT[], 512, ("contentFreeMetrics" ->> 'claimCount')::INTEGER)
    OR NOT "knowledge_semantic_count_record_valid"(
      "contentFreeMetrics" -> 'confidenceBucketCounts',
      ARRAY['high', 'low', 'medium', 'unavailable']::TEXT[], 512,
      ("contentFreeMetrics" ->> 'claimCount')::INTEGER)
    OR NOT "knowledge_semantic_count_record_valid"(
      "contentFreeMetrics" -> 'decisionCounts',
      ARRAY['contradicted', 'supported', 'uncertain', 'unsupported']::TEXT[], 512,
      ("contentFreeMetrics" ->> 'claimCount')::INTEGER)
    OR NOT "knowledge_semantic_count_record_valid"(
      "contentFreeMetrics" -> 'recommendedActionCounts',
      ARRAY['retain', 'review']::TEXT[], 512,
      ("contentFreeMetrics" ->> 'claimCount')::INTEGER)
    OR NOT "knowledge_semantic_zero_usage_valid"("contentFreeMetrics" -> 'usage')
    OR ("contentFreeMetrics" -> 'latencyMs' IS DISTINCT FROM 'null'::JSONB AND (
      jsonb_typeof("contentFreeMetrics" -> 'latencyMs') IS DISTINCT FROM 'number'
      OR ("contentFreeMetrics" ->> 'latencyMs')::NUMERIC < 0
      OR ("contentFreeMetrics" ->> 'latencyMs')::NUMERIC > 3600000
    ))
    OR ("executionStatus" = 'complete' AND
      "contentFreeMetrics" -> 'failureReasonCode' IS DISTINCT FROM 'null'::JSONB)
    OR ("executionStatus" <> 'complete' AND (
      jsonb_typeof("contentFreeMetrics" -> 'failureReasonCode') IS DISTINCT FROM 'string'
      OR "contentFreeMetrics" ->> 'failureReasonCode' IS NULL
      OR "contentFreeMetrics" ->> 'failureReasonCode' !~
        '^[a-z0-9][a-z0-9_.-]{0,79}$'
    ))
  THEN
    RETURN false;
  END IF;

  IF "purgedAt" IS NOT NULL THEN
    RETURN "purgedAt" >= "createdAt"
      AND diagnostic IS NULL
      AND "receiptHash" IS NULL
      AND cardinality("profileRevisionIds") = 0;
  END IF;

  IF "receiptHash" IS NULL OR "receiptHash" !~ '^[0-9a-f]{64}$'
    OR NOT "knowledge_jsonb_has_exact_keys"(diagnostic, ARRAY[
      'answerHash', 'attemptId', 'blockingApplied', 'claims', 'evidenceReceiptHash',
      'executionStatus', 'failureReasonCode', 'latencyMs', 'receiptHash', 'runId', 'sessionId',
      'summary', 'usage', 'validator', 'version'
    ]::TEXT[])
    OR pg_column_size(diagnostic) > 4194304
    OR diagnostic -> 'version' IS DISTINCT FROM to_jsonb(version)
    OR jsonb_typeof(diagnostic -> 'answerHash') IS DISTINCT FROM 'string'
    OR diagnostic ->> 'answerHash' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(diagnostic -> 'evidenceReceiptHash') IS DISTINCT FROM 'string'
    OR diagnostic ->> 'evidenceReceiptHash' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(diagnostic -> 'receiptHash') IS DISTINCT FROM 'string'
    OR encode(sha256(convert_to(
      "knowledge_semantic_canonical_json"(diagnostic - 'receiptHash'), 'UTF8'
    )), 'hex') IS DISTINCT FROM "receiptHash"
    OR jsonb_typeof(diagnostic -> 'runId') IS DISTINCT FROM 'string'
    OR length(diagnostic ->> 'runId') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(diagnostic -> 'sessionId') IS DISTINCT FROM 'string'
    OR length(diagnostic ->> 'sessionId') NOT BETWEEN 1 AND 128
    OR diagnostic ->> 'sessionId' IS DISTINCT FROM "retrievalSessionId"
    OR diagnostic ->> 'executionStatus' IS DISTINCT FROM "executionStatus"
    OR diagnostic ->> 'receiptHash' IS DISTINCT FROM "receiptHash"
    OR diagnostic -> 'attemptId' IS DISTINCT FROM 'null'::JSONB
    OR diagnostic -> 'blockingApplied' IS DISTINCT FROM 'false'::JSONB
    OR jsonb_typeof(diagnostic -> 'claims') IS DISTINCT FROM 'array'
    OR jsonb_array_length(diagnostic -> 'claims') > 512
    OR ("executionStatus" <> 'complete' AND jsonb_array_length(diagnostic -> 'claims') <> 0)
    OR diagnostic -> 'failureReasonCode' IS DISTINCT FROM
      "contentFreeMetrics" -> 'failureReasonCode'
    OR diagnostic -> 'latencyMs' IS DISTINCT FROM "contentFreeMetrics" -> 'latencyMs'
    OR NOT "knowledge_jsonb_has_exact_keys"(diagnostic -> 'summary', ARRAY[
      'attributableClaimCount', 'citationLocalClaimCount', 'claimCount',
      'claimTypeCounts', 'decisionCounts'
    ]::TEXT[])
    OR diagnostic #> '{summary,claimCount}' IS DISTINCT FROM
      "contentFreeMetrics" -> 'claimCount'
    OR diagnostic #> '{summary,attributableClaimCount}' IS DISTINCT FROM
      "contentFreeMetrics" -> 'attributableClaimCount'
    OR diagnostic #> '{summary,citationLocalClaimCount}' IS DISTINCT FROM
      "contentFreeMetrics" -> 'citationLocalClaimCount'
    OR diagnostic #> '{summary,claimTypeCounts}' IS DISTINCT FROM
      "contentFreeMetrics" -> 'claimTypeCounts'
    OR diagnostic #> '{summary,decisionCounts}' IS DISTINCT FROM
      "contentFreeMetrics" -> 'decisionCounts'
    OR NOT "knowledge_jsonb_has_exact_keys"(diagnostic -> 'validator', ARRAY[
      'egress', 'profileId', 'profileVersion', 'semanticProof'
    ]::TEXT[])
    OR diagnostic #>> '{validator,egress}' IS DISTINCT FROM "egressMode"
    OR diagnostic #>> '{validator,profileId}' IS DISTINCT FROM "validatorProfile"
    OR diagnostic #> '{validator,profileVersion}' IS DISTINCT FROM to_jsonb("validatorVersion")
    OR diagnostic #> '{validator,semanticProof}' IS DISTINCT FROM to_jsonb("semanticProof")
    OR NOT "knowledge_semantic_zero_usage_valid"(diagnostic -> 'usage')
    OR diagnostic -> 'usage' IS DISTINCT FROM "contentFreeMetrics" -> 'usage'
  THEN
    RETURN false;
  END IF;

  FOR claim IN SELECT value FROM jsonb_array_elements(diagnostic -> 'claims') LOOP
    claim_ordinal := claim_ordinal + 1;
    IF NOT "knowledge_jsonb_has_exact_keys"(claim, ARRAY[
      'answerEnd', 'answerStart', 'attributableHandles', 'citationHandles', 'claimHash',
      'confidence', 'confidenceBucket', 'contextKeyHash', 'decision', 'locatorStates',
      'neighborhoodHash', 'neighborhoodRule', 'ordinal', 'reasonFamily', 'recommendedAction',
      'sourceShape', 'type', 'unknownCitationHandles', 'version'
    ]::TEXT[])
      OR claim -> 'version' IS DISTINCT FROM '1'::JSONB
      OR claim -> 'ordinal' IS DISTINCT FROM to_jsonb(claim_ordinal)
      OR jsonb_typeof(claim -> 'answerStart') IS DISTINCT FROM 'number'
      OR jsonb_typeof(claim -> 'answerEnd') IS DISTINCT FROM 'number'
      OR claim ->> 'answerStart' !~ '^(0|[1-9][0-9]*)$'
      OR claim ->> 'answerEnd' !~ '^(0|[1-9][0-9]*)$'
      OR (claim ->> 'answerStart')::INTEGER > (claim ->> 'answerEnd')::INTEGER
      OR (claim ->> 'answerEnd')::INTEGER > 2000000
      OR claim ->> 'claimHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(claim -> 'claimHash') IS DISTINCT FROM 'string'
      OR claim ->> 'neighborhoodHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(claim -> 'neighborhoodHash') IS DISTINCT FROM 'string'
      OR (claim -> 'contextKeyHash' IS DISTINCT FROM 'null'::JSONB AND (
        jsonb_typeof(claim -> 'contextKeyHash') IS DISTINCT FROM 'string'
        OR claim ->> 'contextKeyHash' !~ '^[0-9a-f]{64}$'
      ))
      OR jsonb_typeof(claim -> 'confidence') IS DISTINCT FROM 'number'
      OR (claim ->> 'confidence')::NUMERIC < 0
      OR (claim ->> 'confidence')::NUMERIC > 1
      OR jsonb_typeof(claim -> 'locatorStates') IS DISTINCT FROM 'array'
      OR jsonb_array_length(claim -> 'locatorStates') > 1000
      OR NOT "knowledge_semantic_string_array_valid"(
        claim -> 'attributableHandles', 1000, 18,
        '^K[1-9][0-9]{0,3}(\.[1-9][0-9]?)?$')
      OR NOT "knowledge_semantic_string_array_valid"(
        claim -> 'citationHandles', 1000, 18,
        '^K[1-9][0-9]{0,3}(\.[1-9][0-9]?)?$')
      OR NOT "knowledge_semantic_string_array_valid"(
        claim -> 'unknownCitationHandles', 1000, 18, '^K')
      OR jsonb_typeof(claim -> 'confidenceBucket') IS DISTINCT FROM 'string'
      OR claim ->> 'confidenceBucket' NOT IN ('high', 'low', 'medium', 'unavailable')
      OR claim ->> 'confidenceBucket' IS DISTINCT FROM (CASE
        WHEN (claim ->> 'confidence')::NUMERIC = 0 THEN 'unavailable'::TEXT
        WHEN (claim ->> 'confidence')::NUMERIC >= 0.8 THEN 'high'::TEXT
        WHEN (claim ->> 'confidence')::NUMERIC >= 0.5 THEN 'medium'::TEXT
        ELSE 'low'::TEXT
      END)::TEXT
      OR jsonb_typeof(claim -> 'decision') IS DISTINCT FROM 'string'
      OR claim ->> 'decision' NOT IN ('contradicted', 'supported', 'uncertain', 'unsupported')
      OR jsonb_typeof(claim -> 'neighborhoodRule') IS DISTINCT FROM 'string'
      OR claim ->> 'neighborhoodRule' NOT IN (
        'inline', 'none', 'table_cell', 'table_row_inherited'
      )
      OR jsonb_typeof(claim -> 'reasonFamily') IS DISTINCT FROM 'string'
      OR claim ->> 'reasonFamily' NOT IN (
        'deterministic_receipt', 'entailed', 'insufficient_context', 'no_evidence',
        'not_supported', 'same_context_conflict', 'structural_baseline'
      )
      OR jsonb_typeof(claim -> 'recommendedAction') IS DISTINCT FROM 'string'
      OR claim ->> 'recommendedAction' NOT IN ('retain', 'review')
      OR claim ->> 'recommendedAction' IS DISTINCT FROM (CASE
        WHEN claim ->> 'decision' = 'supported'
          OR claim ->> 'type' IN ('general_knowledge', 'non_factual')
        THEN 'retain'::TEXT
        ELSE 'review'::TEXT
      END)::TEXT
      OR jsonb_typeof(claim -> 'sourceShape') IS DISTINCT FROM 'string'
      OR claim ->> 'sourceShape' NOT IN ('list', 'prose', 'table_cell')
      OR jsonb_typeof(claim -> 'type') IS DISTINCT FROM 'string'
      OR claim ->> 'type' NOT IN (
        'comparison', 'coverage_claim', 'derived_arithmetic', 'explicit_inference',
        'general_knowledge', 'non_factual', 'source_fact', 'source_summary',
        'temporal_observation', 'versioned_fact'
      )
    THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(claim -> 'attributableHandles') AS handles(handle)
      WHERE NOT (claim -> 'citationHandles' ? handles.handle)
    ) THEN
      RETURN false;
    END IF;
    FOR locator_state IN SELECT value FROM jsonb_array_elements(claim -> 'locatorStates') LOOP
      IF NOT "knowledge_jsonb_has_exact_keys"(locator_state, ARRAY['handle', 'state']::TEXT[])
        OR jsonb_typeof(locator_state -> 'handle') IS DISTINCT FROM 'string'
        OR locator_state ->> 'handle' !~ '^K[1-9][0-9]{0,3}(\.[1-9][0-9]?)?$'
        OR jsonb_typeof(locator_state -> 'state') IS DISTINCT FROM 'string'
        OR locator_state ->> 'state' NOT IN ('deleted', 'invalid', 'missing', 'valid')
        OR NOT (claim -> 'citationHandles' ? (locator_state ->> 'handle'))
      THEN
        RETURN false;
      END IF;
    END LOOP;
    IF (SELECT count(*) <> count(DISTINCT value ->> 'handle')
      FROM jsonb_array_elements(claim -> 'locatorStates'))
    THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(claim -> 'attributableHandles') > 0 THEN
      attributable_claim_count := attributable_claim_count + 1;
    END IF;
    IF jsonb_array_length(claim -> 'citationHandles') > 0 THEN
      citation_local_claim_count := citation_local_claim_count + 1;
    END IF;
    observed_claim_type_counts := jsonb_set(
      observed_claim_type_counts, ARRAY[claim ->> 'type'],
      to_jsonb((observed_claim_type_counts ->> (claim ->> 'type'))::INTEGER + 1)
    );
    observed_confidence_bucket_counts := jsonb_set(
      observed_confidence_bucket_counts, ARRAY[claim ->> 'confidenceBucket'],
      to_jsonb((observed_confidence_bucket_counts ->>
        (claim ->> 'confidenceBucket'))::INTEGER + 1)
    );
    observed_decision_counts := jsonb_set(
      observed_decision_counts, ARRAY[claim ->> 'decision'],
      to_jsonb((observed_decision_counts ->> (claim ->> 'decision'))::INTEGER + 1)
    );
    observed_recommended_action_counts := jsonb_set(
      observed_recommended_action_counts, ARRAY[claim ->> 'recommendedAction'],
      to_jsonb((observed_recommended_action_counts ->>
        (claim ->> 'recommendedAction'))::INTEGER + 1)
    );
  END LOOP;
  claim_count := jsonb_array_length(diagnostic -> 'claims');
  IF claim_count <> ("contentFreeMetrics" ->> 'claimCount')::INTEGER
    OR attributable_claim_count <>
      ("contentFreeMetrics" ->> 'attributableClaimCount')::INTEGER
    OR citation_local_claim_count <>
      ("contentFreeMetrics" ->> 'citationLocalClaimCount')::INTEGER
    OR observed_claim_type_counts IS DISTINCT FROM
      "contentFreeMetrics" -> 'claimTypeCounts'
    OR observed_confidence_bucket_counts IS DISTINCT FROM
      "contentFreeMetrics" -> 'confidenceBucketCounts'
    OR observed_decision_counts IS DISTINCT FROM
      "contentFreeMetrics" -> 'decisionCounts'
    OR observed_recommended_action_counts IS DISTINCT FROM
      "contentFreeMetrics" -> 'recommendedActionCounts'
  THEN
    RETURN false;
  END IF;
  RETURN true;
END
$function$;

CREATE TABLE "KnowledgeSemanticShadowResult" (
  "retrievalSessionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "mode" VARCHAR(16) NOT NULL DEFAULT 'shadow',
  "executionStatus" VARCHAR(16) NOT NULL,
  "validatorProfile" VARCHAR(80) NOT NULL,
  "validatorVersion" INTEGER NOT NULL,
  "semanticProof" BOOLEAN NOT NULL DEFAULT false,
  "egressMode" VARCHAR(16) NOT NULL,
  "profileRevisionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "diagnostic" JSONB,
  "contentFreeMetrics" JSONB NOT NULL,
  "receiptHash" CHAR(64),
  "purgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeSemanticShadowResult_pkey" PRIMARY KEY ("retrievalSessionId"),
  CONSTRAINT "KnowledgeSemanticShadowResult_shape_check" CHECK (
    "knowledge_semantic_shadow_result_valid"(
      "retrievalSessionId", "version", "mode", "executionStatus", "validatorProfile",
      "validatorVersion", "semanticProof", "egressMode", "profileRevisionIds", "diagnostic",
      "contentFreeMetrics", "receiptHash", "purgedAt", "createdAt"
    )
  ),
  CONSTRAINT "KnowledgeSemanticShadowResult_retrievalSessionId_fkey"
    FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE FUNCTION "guard_accepted_knowledge_semantic_shadow_result_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  accepted_model_run_id TEXT;
  expected_profile_revision_ids TEXT[];
  final_attempt_id TEXT;
  final_attempt_state "KnowledgeProviderAttemptState";
  final_dispatch_profile_revision_ids TEXT[];
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
    -- A current manifest is the exact Profile-lineage authority even when its
    -- lineage is empty. Falling back here would silently authorize a broader
    -- set of run bindings than the provider actually received. Only legacy
    -- runs with no durable attempt may recover lineage from run bindings.
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
    RETURN NEW;
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

CREATE TRIGGER "KnowledgeSemanticShadowResult_accepted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeSemanticShadowResult"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_semantic_shadow_result_write"();
