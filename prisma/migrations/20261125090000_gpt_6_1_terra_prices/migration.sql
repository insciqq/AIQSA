-- Catalog tariff of GPT-6.1 Terra, checked 2026-11-25 at https://developers.openai.com/api/docs/pricing
-- and https://developers.openai.com/api/docs/models/gpt-6.1-terra (USD per 1M tokens; web search fee as in
-- 20261008170000_web_search_prices). It carries the short-context card (input up to 272K tokens) with
-- 30-minute cache writes. The GPT Image 2.5 and 2.6 models this release adds have no catalog tariff.
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- Only `catalog` rows adopt: a row an administrator added before this release is `admin`, and
-- keeps its prices, unknown ones included, until the administrator restores the catalog price.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openai:gpt-6.1-terra', 1, 0.05, 1.25, 5),
  ('openrouter:openai/gpt-6.1-terra', 1, 0.05, 1.25, 5)
), web_search_prices(template, price) AS (VALUES
  ('openai:gpt-6.1-terra', 10)
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
  "webSearchPriceUsdPerThousand" = COALESCE(web_search_prices.price, model."webSearchPriceUsdPerThousand")
FROM identities JOIN prices ON prices.template = identities.template
  LEFT JOIN web_search_prices ON web_search_prices.template = identities.template
WHERE model.id = identities.id AND model."priceSource" = 'catalog';
