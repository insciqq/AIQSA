-- Catalog tariffs of GPT-6.1 Sol, Gemini 4 Argon and Claude Sonnet/Haiku 5.5, checked 2026-10-15
-- (USD per 1M tokens; web search fees as in 20261008170000_web_search_prices). Gemini 4 Argon
-- carries its introductory price, which expires 2026-11-30; Claude Haiku 5.5 the base card for
-- prompts up to 100K tokens.
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- Only `catalog` rows adopt: an administrator could already price these answer rows, so an
-- `admin` row keeps its prices, unknown ones included, until the administrator restores the
-- catalog price.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openai:gpt-6.1-sol', 2, 0.1, 2.5, 10),
  ('anthropic:claude-sonnet-5-5', 2, 0.2, 2.5, 10),
  ('anthropic:claude-haiku-5-5', 0.1, 0.01, 0.125, 0.5),
  ('gemini:gemini-4-argon', 2, 0.1, NULL, 10),
  ('openrouter:openai/gpt-6.1-sol', 2, 0.1, 2.5, 10),
  ('openrouter:openai/gpt-6.1-sol-pro', 2, 0.1, 2.5, 10),
  ('openrouter:anthropic/claude-sonnet-5.5', 2, 0.2, 2.5, 10),
  ('openrouter:anthropic/claude-haiku-5.5', 0.1, 0.01, 0.125, 0.5),
  ('openrouter:google/gemini-4-argon', 2, 0.1, NULL, 10)
), web_search_prices(template, price) AS (VALUES
  ('openai:gpt-6.1-sol', 10),
  ('anthropic:claude-sonnet-5-5', 10),
  ('anthropic:claude-haiku-5-5', 10),
  ('gemini:gemini-4-argon', 14)
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
  "webSearchPriceUsdPerThousand" = web_search_prices.price
FROM identities JOIN prices ON prices.template = identities.template
  LEFT JOIN web_search_prices ON web_search_prices.template = identities.template
WHERE model.id = identities.id AND model."priceSource" = 'catalog';
