-- What every usage record paid for, chosen by the code that writes it
-- (lib/domain/usagePurpose.ts). Personal budgets count only personal purposes;
-- analytics break system spend down by the others.
CREATE TYPE "UsagePurpose" AS ENUM (
  'chat_answer', 'web_search', 'image_generation',
  'chat_title', 'chat_summary', 'chat_vision', 'chat_pdf', 'skill_selection',
  'memory_processing', 'memory_indexing', 'memory_retrieval',
  'knowledge_indexing', 'knowledge_retrieval', 'model_check', 'other'
);

ALTER TABLE "UsageEvent" ADD COLUMN "purpose" "UsagePurpose";

-- The class of the catalogue model a row without a purpose names, resolved as
-- Control Center usage analytics resolves it (lib/server/admin/usage/models.ts):
-- the exact providerModelId; else the ProviderModel whose id is modelId under
-- that connection or family; else the single model whose upstream id (its
-- modelId or active upstreamModelId) is modelId under that connection or
-- family. NULL when nothing, or more than one model, matches.
CREATE FUNCTION usage_event_legacy_model_class(p_provider TEXT, p_model_id TEXT, p_provider_model_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT model."modelClass"::text FROM "ProviderModel" AS model WHERE model.id = p_provider_model_id),
    (SELECT model."modelClass"::text FROM "ProviderModel" AS model
      JOIN "ProviderConnection" AS connection ON connection.id = model."connectionId"
      WHERE model.id = p_model_id AND p_provider IN (model."connectionId", connection.family)),
    (SELECT CASE WHEN count(*) = 1 THEN min(model."modelClass"::text) END FROM "ProviderModel" AS model
      JOIN "ProviderConnection" AS connection ON connection.id = model."connectionId"
      WHERE p_provider IN (model."connectionId", connection.family)
        AND (model."modelId" = p_model_id OR (jsonb_typeof(model."activeConfig"->'upstreamModelId') = 'string'
          AND btrim(model."activeConfig"->>'upstreamModelId') <> ''
          AND model."activeConfig"->>'upstreamModelId' = p_model_id)))
  )
$$;

-- The purpose of a row written without one. First match wins: purpose flags
-- and their links, the Memory execution role (mapped as memoryRoleUsagePurpose
-- maps it), then the row's shape. A row is embedding-shaped when its model
-- resolves to the embedding class or, unresolved, reports input but no output
-- tokens. A run or chat row is an answer unless embedding-shaped (a Knowledge
-- query embedding). A row without links is Knowledge ingestion when
-- embedding-shaped, and a Memory call detached by a purge when its model is an
-- answer model or it reports output. Anything else stays `other`.
CREATE FUNCTION usage_event_legacy_purpose(p_usage "UsageEvent", p_logical_role TEXT, p_model_class TEXT)
RETURNS "UsagePurpose" LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_usage."imageGeneration" THEN 'image_generation'
    WHEN p_usage."chatTitleGeneration" THEN 'chat_title'
    WHEN p_usage.id LIKE 'chat-summary:%' THEN 'chat_summary'
    WHEN p_usage."knowledgeImageObservationRunId" IS NOT NULL THEN 'knowledge_indexing'
    WHEN p_usage."visionAnalysis" THEN 'chat_vision'
    WHEN p_usage."chatPdfPreparation" THEN 'chat_pdf'
    WHEN p_usage."knowledgePdfProcessingAttemptId" IS NOT NULL THEN 'knowledge_indexing'
    WHEN p_usage."optionalDecision" THEN 'skill_selection'
    WHEN p_usage."knowledgeRelevance" THEN 'knowledge_retrieval'
    WHEN p_usage."mcpHubDiscovery" THEN 'other'
    WHEN p_usage."memoryExecutionBindingId" IS NOT NULL THEN CASE
      WHEN p_logical_role = 'MEMORY_DOCUMENT_EMBED' THEN 'memory_indexing'
      WHEN p_logical_role IN ('MEMORY_QUERY_EMBED', 'MEMORY_RERANK', 'MEMORY_HISTORY_RELEVANCE', 'MEMORY_QUERY_RESOLVE')
        THEN 'memory_retrieval'
      ELSE 'memory_processing' END
    WHEN p_usage."modelRunId" IS NOT NULL OR p_usage."chatId" IS NOT NULL THEN CASE
      WHEN COALESCE(p_model_class = 'embedding', p_usage."inputTokens" IS NOT NULL AND p_usage."outputTokens" IS NULL)
        THEN 'knowledge_retrieval'
      ELSE 'chat_answer' END
    WHEN COALESCE(p_model_class = 'embedding', p_usage."inputTokens" IS NOT NULL AND p_usage."outputTokens" IS NULL)
      THEN 'knowledge_indexing'
    WHEN p_model_class = 'answer' OR p_usage."outputTokens" IS NOT NULL THEN 'memory_processing'
    ELSE 'other'
  END)::"UsagePurpose"
$$;

-- One pass over the table; model classes are resolved once per identity.
WITH identities AS (
  SELECT DISTINCT "provider", "modelId", "providerModelId" FROM "UsageEvent"
), resolved AS (
  SELECT "provider", "modelId", COALESCE("providerModelId", '') AS "providerModelKey",
    usage_event_legacy_model_class("provider", "modelId", "providerModelId") AS "modelClass"
  FROM identities
)
UPDATE "UsageEvent" AS ue
SET "purpose" = usage_event_legacy_purpose(ue,
  (SELECT binding."logicalRole" FROM "MemoryExecutionBinding" AS binding
    WHERE binding.id = ue."memoryExecutionBindingId" AND binding."userId" = ue."userId"),
  resolved."modelClass")
FROM resolved
WHERE resolved."provider" = ue."provider" AND resolved."modelId" = ue."modelId"
  AND resolved."providerModelKey" = COALESCE(ue."providerModelId", '');

ALTER TABLE "UsageEvent" ALTER COLUMN "purpose" SET NOT NULL;

-- Current writers always choose a purpose. The previous release names none
-- while Compose replaces it; its inserts are classified exactly as the backfill
-- classified older rows instead of failing. A later contract migration may
-- retire this once no previous-release writer can remain.
CREATE FUNCTION usage_event_legacy_writer_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."purpose" := usage_event_legacy_purpose(NEW,
    (SELECT binding."logicalRole" FROM "MemoryExecutionBinding" AS binding
      WHERE binding.id = NEW."memoryExecutionBindingId" AND binding."userId" = NEW."userId"),
    usage_event_legacy_model_class(NEW."provider", NEW."modelId", NEW."providerModelId"));
  RETURN NEW;
END $$;
CREATE TRIGGER "UsageEvent_legacy_writer_purpose" BEFORE INSERT ON "UsageEvent"
  FOR EACH ROW WHEN (NEW."purpose" IS NULL) EXECUTE FUNCTION usage_event_legacy_writer_purpose();
