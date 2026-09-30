-- Expand only: retain the old Int columns/defaults for previous-release writers.
-- New releases never read/write them. A later contract migration may retire them.
CREATE TYPE "ModelPriceSource" AS ENUM ('catalog', 'admin');
ALTER TABLE "ProviderModel"
  ADD COLUMN "inputTokenPriceUsdPerMillion" DECIMAL(18,8),
  ADD COLUMN "cachedInputTokenPriceUsdPerMillion" DECIMAL(18,8),
  ADD COLUMN "cacheWriteInputTokenPriceUsdPerMillion" DECIMAL(18,8),
  ADD COLUMN "outputTokenPriceUsdPerMillion" DECIMAL(18,8),
  ADD COLUMN "priceSource" "ModelPriceSource" NOT NULL DEFAULT 'catalog',
  ADD CONSTRAINT "ProviderModel_nonnegative_token_prices" CHECK (
    "inputTokenPriceUsdPerMillion" >= 0 AND "cachedInputTokenPriceUsdPerMillion" >= 0 AND
    "cacheWriteInputTokenPriceUsdPerMillion" >= 0 AND "outputTokenPriceUsdPerMillion" >= 0);

-- Whole micro-dollars/token have the same numerical value as USD/million tokens.
UPDATE "ProviderModel" SET
  "inputTokenPriceUsdPerMillion" = NULLIF("inputTokenPriceMicros", 0),
  "outputTokenPriceUsdPerMillion" = NULLIF("outputTokenPriceMicros", 0);

-- One-time adoption. No manual price editor existed before this migration.
-- Published base tariffs checked 2026-09-30; future changes target priceSource=catalog.
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection. Other rows keep the conversion.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openai:gpt-6-astra', 10, 1, 12.5, 50),
  ('openai:gpt-6-sol', 2, 0.2, 2.5, 10),
  ('openai:gpt-6-luna', 0.1, 0.01, 0.125, 0.5),
  ('openai:gpt-5.6-sol', 4, 0.4, 5, 20),
  ('openai:gpt-5.6-terra', 2, 0.2, 2.5, 12),
  ('openai:gpt-5.6-luna', 0.2, 0.02, 0.25, 1.2),
  ('openai:gpt-5.5', 5, 0.5, NULL, 30),
  ('anthropic:claude-fable-5-1', 10, 0.25, 12.5, 50),
  ('anthropic:claude-opus-5-5', 4, 0.2, 5, 20),
  ('anthropic:claude-opus-5', 5, 0.5, 6.25, 25),
  ('anthropic:claude-opus-4-8', 5, 0.5, 6.25, 25),
  ('anthropic:claude-sonnet-5', 2, 0.2, 2.5, 10),
  ('gemini:gemini-3.8-flash', 0.75, 0.075, NULL, 3.75),
  ('gemini:gemini-3.6-flash', 0.75, 0.075, NULL, 3.75),
  ('gemini:gemini-3.5-flash', 1.5, 0.15, NULL, 9),
  ('gemini:gemini-3.5-flash-lite', 0.3, 0.03, NULL, 2.5),
  ('gemini:gemini-3.1-pro-preview', 2, 0.2, NULL, 12),
  ('deepseek:deepseek-flash', 0.3, 0.006, NULL, 1.2),
  ('deepseek:deepseek-v4-flash', 0.3, 0.006, NULL, 1.2),
  ('deepseek:deepseek-v4-flash-vision-exp', 0.3, 0.006, NULL, 1.2),
  ('deepseek:deepseek-v4-pro', 1.32, 0.044, NULL, 3.96),
  ('openrouter:openai/gpt-6-astra', 10, 1, 12.5, 50),
  ('openrouter:openai/gpt-6-sol', 2, 0.2, 2.5, 10),
  ('openrouter:openai/gpt-6-sol-pro', 2, 0.2, 2.5, 10),
  ('openrouter:openai/gpt-6-luna', 0.1, 0.01, 0.125, 0.5),
  ('openrouter:openai/gpt-6-luna-pro', 0.1, 0.01, 0.125, 0.5),
  ('openrouter:anthropic/claude-fable-5.1', 10, 0.25, 12.5, 50),
  ('openrouter:anthropic/claude-opus-5.5', 4, 0.2, 5, 20),
  ('openrouter:anthropic/claude-opus-5', 5, 0.5, 6.25, 25),
  ('openrouter:anthropic/claude-opus-4.8', 5, 0.5, 6.25, 25),
  ('openrouter:google/gemini-3.8-flash', 0.75, 0.075, NULL, 3.75),
  ('openrouter:google/gemini-3.5-flash', 1.5, 0.15, NULL, 9),
  ('openrouter:~google/gemini-pro-latest', 2, 0.2, NULL, 12),
  ('openrouter:deepseek/deepseek-v4.1-flash', 0.0198, 0.00291, NULL, 0.396),
  ('openrouter:deepseek/deepseek-v4-pro-0813', 0.66, 0.022, NULL, 1.98),
  ('openrouter:perplexity/sonar-pro-search', 3, NULL, NULL, 15)
), identities AS (
  SELECT model.id, CASE
    WHEN model."templateKey" IS NOT NULL THEN model."templateKey"
    WHEN connection.family = 'openai_compatible' AND CASE jsonb_typeof(endpoint.config->'responsesRequestIsolationDetected')
      WHEN 'boolean' THEN (endpoint.config->>'responsesRequestIsolationDetected')::boolean
      ELSE right(endpoint.config->>'apiRoot', 18) = '/backend-api/codex' END THEN 'openai:' || model."modelId"
    WHEN connection.family IN ('openai', 'anthropic', 'gemini', 'deepseek', 'openrouter') THEN connection.family || ':' || model."modelId"
  END AS template
  FROM "ProviderModel" model
  JOIN "ProviderConnection" connection ON connection.id = model."connectionId"
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(connection."activeConfig") = 'object'
    THEN connection."activeConfig" ELSE connection."draftConfig" END AS config) endpoint
  WHERE model."modelClass" = 'answer'
)
UPDATE "ProviderModel" AS model SET
  "inputTokenPriceUsdPerMillion" = prices.input,
  "cachedInputTokenPriceUsdPerMillion" = prices.cached,
  "cacheWriteInputTokenPriceUsdPerMillion" = prices.write,
  "outputTokenPriceUsdPerMillion" = prices.output,
  "priceSource" = 'catalog'
FROM identities JOIN prices ON prices.template = identities.template
WHERE model.id = identities.id;

-- Frozen upgrade prices plus restart-safe cursors. No large historical update holds
-- deployment readiness; the app processes this single adoption in bounded batches.
CREATE TABLE "CatalogCostBackfill" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cutoffAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prices" JSONB NOT NULL,
  "usageCursor" TEXT,
  "runCursor" TEXT,
  "usageFinished" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3)
);
INSERT INTO "CatalogCostBackfill" (id, prices)
SELECT '20260930', COALESCE(jsonb_agg(jsonb_build_object(
  'id', id, 'provider', provider, 'modelId', "modelId",
  'inputTokenPriceUsdPerMillion', "inputTokenPriceUsdPerMillion",
  'cachedInputTokenPriceUsdPerMillion', "cachedInputTokenPriceUsdPerMillion",
  'cacheWriteInputTokenPriceUsdPerMillion', "cacheWriteInputTokenPriceUsdPerMillion",
  'outputTokenPriceUsdPerMillion', "outputTokenPriceUsdPerMillion"
)), '[]'::jsonb)
FROM "ProviderModel" WHERE "modelClass" = 'answer'
  AND "inputTokenPriceUsdPerMillion" IS NOT NULL AND "outputTokenPriceUsdPerMillion" IS NOT NULL;

-- Settled utility usage remains immutable except for this exact, one-time null
-- cost adoption. Counts, identity and existing/provider-reported costs never change.
CREATE FUNCTION catalog_cost_adoption_valid(previous "UsageEvent", incoming "UsageEvent")
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH tariffs AS (
    SELECT price FROM "CatalogCostBackfill" state,
      LATERAL jsonb_array_elements(state.prices) price
    WHERE state.id = '20260930' AND state."completedAt" IS NULL
      AND previous."createdAt" <= state."cutoffAt"
      AND CASE WHEN previous."providerModelId" IS NOT NULL
        THEN price->>'id' = previous."providerModelId"
        ELSE price->>'provider' = previous.provider AND price->>'modelId' = previous."modelId" END
  )
  SELECT previous."estimatedCostMicros" IS NULL AND incoming."estimatedCostMicros" IS NOT NULL
    AND previous."usageCompleteness" = 'COMPLETE'
    AND NOT previous."imageGeneration" AND NOT previous."optionalDecision"
    AND (to_jsonb(previous) - 'estimatedCostMicros') = (to_jsonb(incoming) - 'estimatedCostMicros')
    AND (SELECT count(*) FROM tariffs) = 1
    AND incoming."estimatedCostMicros" = (SELECT round(
      greatest(0, previous."inputTokens" - coalesce(previous."cachedInputTokens", 0) - coalesce(previous."cacheWriteInputTokens", 0))::numeric * (price->>'inputTokenPriceUsdPerMillion')::numeric +
      coalesce(previous."cachedInputTokens", 0)::numeric * coalesce((price->>'cachedInputTokenPriceUsdPerMillion')::numeric, (price->>'inputTokenPriceUsdPerMillion')::numeric) +
      coalesce(previous."cacheWriteInputTokens", 0)::numeric * coalesce((price->>'cacheWriteInputTokenPriceUsdPerMillion')::numeric, (price->>'inputTokenPriceUsdPerMillion')::numeric) +
      previous."outputTokens"::numeric * (price->>'outputTokenPriceUsdPerMillion')::numeric
    ) FROM tariffs LIMIT 1)
$$;

CREATE OR REPLACE FUNCTION chat_pdf_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT COALESCE(catalog_cost_adoption_valid(OLD, NEW), false) AND (NEW."chatPdfPreparation" IS DISTINCT FROM OLD."chatPdfPreparation" OR
    OLD."chatPdfPreparation" AND (
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens",NEW."cachedInputTokens",NEW."cacheWriteInputTokens",NEW."outputTokens",
          NEW."reasoningTokens",NEW."totalTokens",NEW."estimatedCostMicros",NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens",OLD."cachedInputTokens",OLD."cacheWriteInputTokens",OLD."outputTokens",
          OLD."reasoningTokens",OLD."totalTokens",OLD."estimatedCostMicros",OLD."usageCompleteness")) OR
      ROW(NEW."userId",NEW."provider",NEW."modelId",NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId",OLD."provider",OLD."modelId",OLD."providerModelId") OR
      (NEW."chatPdfPageAttemptId" IS NOT NULL AND NEW."chatPdfPageAttemptId" IS DISTINCT FROM OLD."chatPdfPageAttemptId")
    )) THEN RAISE EXCEPTION 'chat_pdf_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatPdfPreparation" AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfPageAttempt" a
    JOIN "ChatPdfAttachmentPreparation" p ON p."id" = a."preparationId"
    JOIN "ModelRun" r ON r."id" = p."modelRunId"
    WHERE a."id" = NEW."chatPdfPageAttemptId" AND a."state" = 'dispatched'
      AND p."providerModelId" = NEW."providerModelId" AND p."modelRunId" = NEW."modelRunId"
      AND r."userId" = NEW."userId" AND r."chatId" = NEW."chatId"
  ) THEN RAISE EXCEPTION 'chat_pdf_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chat_title_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT COALESCE(catalog_cost_adoption_valid(OLD, NEW), false) AND (
    NEW."chatTitleGeneration" IS DISTINCT FROM OLD."chatTitleGeneration" OR
    OLD."chatTitleGeneration" AND (
      ROW(NEW."userId", NEW."provider", NEW."modelId", NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId", OLD."provider", OLD."modelId", OLD."providerModelId") OR
      (NEW."chatTitleGenerationId" IS NOT NULL AND NEW."chatTitleGenerationId" IS DISTINCT FROM OLD."chatTitleGenerationId") OR
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens", NEW."outputTokens",
          NEW."reasoningTokens", NEW."totalTokens", NEW."estimatedCostMicros", NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens", OLD."cachedInputTokens", OLD."cacheWriteInputTokens", OLD."outputTokens",
          OLD."reasoningTokens", OLD."totalTokens", OLD."estimatedCostMicros", OLD."usageCompleteness"))
    )
  ) THEN RAISE EXCEPTION 'chat_title_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatTitleGeneration" AND NOT EXISTS (
    SELECT 1 FROM "ChatTitleGeneration" title
    WHERE title."runId" = NEW."chatTitleGenerationId" AND title."runId" = NEW."modelRunId"
      AND title."status" = 'dispatched' AND title."userId" = NEW."userId" AND title."chatId" = NEW."chatId"
      AND title."providerSnapshot"->>'providerModelId' = NEW."providerModelId"
      AND title."providerSnapshot"->>'providerFamily' = NEW."provider"
      AND title."providerSnapshot"->'model'->>'upstreamModelId' = NEW."modelId"
  ) THEN RAISE EXCEPTION 'chat_title_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
