DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryJob"
    WHERE COALESCE(("operationalCounters" ->>
        'contextualFallbackDeclared')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackEn')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackOther')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackRu')::NUMERIC, 0)
        > 2147483647
      OR COALESCE(("operationalCounters" ->>
        'contextualGeneratedDeclared')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedEn')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedOther')::NUMERIC, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedRu')::NUMERIC, 0)
        > 2147483647
  ) THEN
    RAISE EXCEPTION 'memory language counter total exceeds supported range';
  END IF;
END
$migration$;

ALTER TABLE "MemoryJob"
  DROP CONSTRAINT "MemoryJob_operational_counters_check";

UPDATE "MemoryJob"
SET "operationalCounters" =
  (
    "operationalCounters" - ARRAY[
      'contextualFallbackEn',
      'contextualFallbackOther',
      'contextualFallbackRu',
      'contextualGeneratedEn',
      'contextualGeneratedOther',
      'contextualGeneratedRu'
    ]::TEXT[]
  )
  || CASE WHEN "operationalCounters" ?| ARRAY[
      'contextualFallbackDeclared',
      'contextualFallbackEn',
      'contextualFallbackOther',
      'contextualFallbackRu'
    ]::TEXT[] THEN jsonb_build_object(
      'contextualFallbackDeclared',
      COALESCE(("operationalCounters" ->>
        'contextualFallbackDeclared')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackEn')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackOther')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualFallbackRu')::BIGINT, 0)
    ) ELSE '{}'::JSONB END
  || CASE WHEN "operationalCounters" ?| ARRAY[
      'contextualGeneratedDeclared',
      'contextualGeneratedEn',
      'contextualGeneratedOther',
      'contextualGeneratedRu'
    ]::TEXT[] THEN jsonb_build_object(
      'contextualGeneratedDeclared',
      COALESCE(("operationalCounters" ->>
        'contextualGeneratedDeclared')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedEn')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedOther')::BIGINT, 0)
        + COALESCE(("operationalCounters" ->> 'contextualGeneratedRu')::BIGINT, 0)
    ) ELSE '{}'::JSONB END
WHERE "operationalCounters" ?| ARRAY[
  'contextualFallbackEn',
  'contextualFallbackOther',
  'contextualFallbackRu',
  'contextualGeneratedEn',
  'contextualGeneratedOther',
  'contextualGeneratedRu'
]::TEXT[];

CREATE OR REPLACE FUNCTION public.aiqsa_memory_operational_counters_valid(
  p_counters JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT p_counters IS NULL OR (
    jsonb_typeof(p_counters) = 'object'
    AND pg_column_size(p_counters) <= 4096
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_counters) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY[
        'digestFullRebuild',
        'digestIncremental',
        'digestNoop',
        'digestSegmentsProcessed',
        'digestSourceChunksProcessed',
        'contextualProviderRequests',
        'contextualRoundsFallback',
        'contextualRoundsGenerated',
        'embeddingBatchItems',
        'embeddingFailedItems',
        'embeddingProviderRequests',
        'embeddingSettledItems',
        'embeddingStaleItems',
        'historyChunksBuilt',
        'historyChunksReplaced',
        'historyChunksReused',
        'historyMessageContentRowsLoaded',
        'historyMessagesProjected',
        'historyModelRunRowsLoaded',
        'historyPathMetadataRowsRead',
        'historyRoundSegmentsBuilt',
        'historyRoundSegmentsReplaced',
        'historyRoundSegmentsReused',
        'historyRoundsBuilt',
        'historyRoundsReplaced',
        'historyRoundsReused',
        'contextualFallbackDuplicateStatement',
        'contextualFallbackEmptyStatements',
        'contextualFallbackHandleMismatch',
        'contextualFallbackNotEligible',
        'contextualFallbackProviderOutputInvalid',
        'contextualFallbackProviderUnavailable',
        'contextualFallbackSafetyRedactedOrRejected',
        'contextualFallbackSearchTextBudgetExceeded',
        'contextualFallbackSourceRefInvalid',
        'contextualFallbackStatementCountInvalid',
        'contextualFallbackStatementTooLong',
        'contextualFallbackUnsupportedDate',
        'contextualFallbackUnsupportedEntity',
        'contextualFallbackUnsupportedNumber',
        'contextualFallbackUnsupportedToken',
        'contextualFallbackDeclared',
        'contextualFallbackMixed',
        'contextualFallbackUnd',
        'contextualGeneratedDeclared',
        'contextualGeneratedMixed',
        'contextualGeneratedUnd',
        'synthesisClusterCount',
        'synthesisEligibleSourceCount',
        'synthesisEmptyOutputCount',
        'synthesisProposalCount'
      ]::TEXT[])
        OR jsonb_typeof(entry.value) <> 'number'
        OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$'
        OR (entry.value #>> '{}')::NUMERIC > 2147483647
    )
  );
$function$;

ALTER TABLE "MemoryJob"
  ADD CONSTRAINT "MemoryJob_operational_counters_check"
  CHECK (public.aiqsa_memory_operational_counters_valid("operationalCounters"))
  NOT VALID;

ALTER TABLE "MemoryJob"
  VALIDATE CONSTRAINT "MemoryJob_operational_counters_check";
