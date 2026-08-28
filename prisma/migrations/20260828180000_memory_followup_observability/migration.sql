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
        'contextualFallbackEn',
        'contextualFallbackMixed',
        'contextualFallbackOther',
        'contextualFallbackRu',
        'contextualFallbackUnd',
        'contextualGeneratedEn',
        'contextualGeneratedMixed',
        'contextualGeneratedOther',
        'contextualGeneratedRu',
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
