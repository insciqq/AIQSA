-- OpenRouter's default tariffs of DeepSeek V4.1 Flash 1017 and of the September snapshot it
-- supersedes, checked 2026-10-18 at https://openrouter.ai/api/v1/models (USD per 1M tokens;
-- the weekday UTC peak overrides of 1017 are not modeled, and OpenRouter reports each call's cost).
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- Only `catalog` rows adopt: an `admin` row keeps its prices, unknown ones included.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openrouter:deepseek/deepseek-v4.1-flash-1017', 0.15, 0.003, NULL, 0.6),
  ('openrouter:deepseek/deepseek-v4.1-flash', 0.04, 0.0016, NULL, 0.144)
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
  -- No listed tariff has a cache-write price, and an all-NULL VALUES column is text.
  "cacheWriteInputTokenPriceUsdPerMillion" = prices.write::numeric,
  "outputTokenPriceUsdPerMillion" = prices.output
FROM identities JOIN prices ON prices.template = identities.template
WHERE model.id = identities.id AND model."priceSource" = 'catalog';

-- The September snapshot keeps its slug and settings and takes the catalog's new name, so
-- it stays apart from the 1017 model that now carries "DeepSeek V4.1 Flash". Only rows that
-- still have the catalog's former name change; an administrator's own name stays.
UPDATE "ProviderModel" AS model SET "displayName" = 'DeepSeek V4.1 Flash 0910'
FROM "ProviderConnection" connection
WHERE connection.id = model."connectionId" AND connection.family = 'openrouter'
  AND model."modelClass" = 'answer' AND model."displayName" = 'DeepSeek V4.1 Flash'
  AND (model."templateKey" = 'openrouter:deepseek/deepseek-v4.1-flash'
    OR (model."templateKey" IS NULL AND model."modelId" = 'deepseek/deepseek-v4.1-flash'));
