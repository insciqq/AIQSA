-- Catalog tariffs of GPT-6.2 Astra and Sol, Claude Fable 5.2 and Gemini 4 Neon, checked 2026-11-19
-- at https://developers.openai.com/api/docs/pricing, https://platform.claude.com/docs/en/about-claude/pricing
-- and https://ai.google.dev/gemini-api/docs/pricing (USD per 1M tokens; web search fees as in
-- 20261008170000_web_search_prices). GPT-6.2 carries the short-context card (input up to 272K
-- tokens); Gemini 4 Neon announces no price change.
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an answer row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- Only `catalog` rows adopt: a row an administrator added before this release is `admin`, and
-- keeps its prices, unknown ones included, until the administrator restores the catalog price.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openai:gpt-6.2-astra', 8, 0.4, 10, 40),
  ('openai:gpt-6.2-sol', 2, 0.1, 2.5, 10),
  ('anthropic:claude-fable-5-2', 8, 0.2, 10, 40),
  ('gemini:gemini-4-neon', 3, 0.15, NULL, 15),
  ('openrouter:openai/gpt-6.2-astra', 8, 0.4, 10, 40),
  ('openrouter:openai/gpt-6.2-sol', 2, 0.1, 2.5, 10),
  ('openrouter:anthropic/claude-fable-5.2', 8, 0.2, 10, 40),
  ('openrouter:google/gemini-4-neon', 3, 0.15, NULL, 15)
), web_search_prices(template, price) AS (VALUES
  ('openai:gpt-6.2-astra', 10),
  ('openai:gpt-6.2-sol', 10),
  ('anthropic:claude-fable-5-2', 10),
  ('gemini:gemini-4-neon', 14)
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
