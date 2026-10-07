-- Web search fees: a per-search price on answer models and the provider-reported
-- search count of usage rows. Expand only: previous-release writers leave both NULL.
ALTER TABLE "ProviderModel"
  ADD COLUMN "webSearchPriceUsdPerThousand" DECIMAL(18,8),
  ADD CONSTRAINT "ProviderModel_nonnegative_web_search_price" CHECK ("webSearchPriceUsdPerThousand" >= 0);
ALTER TABLE "UsageEvent"
  ADD COLUMN "webSearchCount" INTEGER,
  ADD CONSTRAINT "UsageEvent_web_search_count_check" CHECK ("webSearchCount" IS NULL OR "webSearchCount" > 0);

-- One-time adoption of the published per-search fees (USD per 1,000 searches) by existing
-- answer rows, checked 2026-10-07:
--   OpenAI "Web search (all models) $10.00 / 1k calls": https://developers.openai.com/api/docs/pricing
--   Anthropic "$10 per 1,000 searches": https://platform.claude.com/docs/en/about-claude/pricing
--   Gemini 3.x "$14 per 1,000 requests", per search query: https://ai.google.dev/gemini-api/docs/pricing
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- No administrator could set this price before this release, so every row with a catalog
-- identity adopts it whatever its price source; token prices and price sources stay unchanged.
WITH web_search_prices(template, price) AS (VALUES
  ('openai:gpt-6-astra', 10),
  ('openai:gpt-6-sol', 10),
  ('openai:gpt-6-luna', 10),
  ('openai:gpt-5.6-sol', 10),
  ('openai:gpt-5.6-terra', 10),
  ('openai:gpt-5.6-luna', 10),
  ('openai:gpt-5.5', 10),
  ('anthropic:claude-fable-5-1', 10),
  ('anthropic:claude-opus-5-5', 10),
  ('anthropic:claude-opus-5', 10),
  ('anthropic:claude-opus-4-8', 10),
  ('anthropic:claude-sonnet-5', 10),
  ('gemini:gemini-3.8-flash', 14),
  ('gemini:gemini-3.6-flash', 14),
  ('gemini:gemini-3.5-flash', 14),
  ('gemini:gemini-3.5-flash-lite', 14),
  ('gemini:gemini-3.1-pro-preview', 14)
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
UPDATE "ProviderModel" AS model SET "webSearchPriceUsdPerThousand" = web_search_prices.price
FROM identities JOIN web_search_prices ON web_search_prices.template = identities.template
WHERE model.id = identities.id AND model."webSearchPriceUsdPerThousand" IS NULL;
