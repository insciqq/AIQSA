-- Catalog tariffs of Gemini 4 Carbon and Gemini 4 Hydrogen, checked 2026-11-13 at
-- https://ai.google.dev/gemini-api/docs/pricing (USD per 1M tokens; the Gemini web search fee as
-- in 20261008170000_web_search_prices). Carbon carries its list price, which follows the
-- introductory price on 2026-12-01 as Argon's does; Hydrogen announces no price change.
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- Only `catalog` rows adopt: a row an administrator added before this release is `admin`, and
-- keeps its prices, unknown ones included, until the administrator restores the catalog price.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('gemini:gemini-4-carbon', 4, 0.2, NULL, 20),
  ('gemini:gemini-4-hydrogen', 1.5, 0.075, NULL, 7.5),
  ('openrouter:google/gemini-4-carbon', 4, 0.2, NULL, 20),
  ('openrouter:google/gemini-4-hydrogen', 1.5, 0.075, NULL, 7.5)
), web_search_prices(template, price) AS (VALUES
  ('gemini:gemini-4-carbon', 14),
  ('gemini:gemini-4-hydrogen', 14)
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
  -- Every row's cache-write price is NULL, so the VALUES column has no numeric type of its own.
  "cacheWriteInputTokenPriceUsdPerMillion" = prices.write::numeric,
  "outputTokenPriceUsdPerMillion" = prices.output,
  "webSearchPriceUsdPerThousand" = COALESCE(web_search_prices.price, model."webSearchPriceUsdPerThousand")
FROM identities JOIN prices ON prices.template = identities.template
  LEFT JOIN web_search_prices ON web_search_prices.template = identities.template
WHERE model.id = identities.id AND model."priceSource" = 'catalog';
