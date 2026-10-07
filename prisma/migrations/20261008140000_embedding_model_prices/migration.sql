-- Every model class may carry token prices, and a catalog tariff prices only rows of
-- its own class. One-time adoption of the first embedding tariff by existing rows.
-- Published input tariff checked 2026-10-07: https://developers.openai.com/api/docs/pricing
-- Catalog identity mirrors providerModelCatalogKey (lib/server/admin/providers/providerModelPricing.ts):
-- the template key; else, for an embedding row, `openai:<modelId>` on a codex-lb endpoint
-- (openai_compatible whose active, else draft, configuration has a boolean
-- responsesRequestIsolationDetected, or otherwise an apiRoot ending in /backend-api/codex)
-- and `<family>:<modelId>` on any Quick Setup family connection.
-- An administrator's price is never replaced. Before this release no administrator could
-- price an embedding row, so an `admin` row whose four prices are all unknown holds the
-- creation default of a row without catalog identity, not an administrator's price, and is
-- adopted like a `catalog` row.
WITH prices(template, input, cached, write, output) AS (VALUES
  ('openai:text-embedding-3-large', 0.13, NULL, NULL, NULL)
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
  WHERE model."modelClass" = 'embedding'
)
-- A VALUES column without any number resolves to text; the casts keep NULL numeric.
UPDATE "ProviderModel" AS model SET
  "inputTokenPriceUsdPerMillion" = prices.input::numeric,
  "cachedInputTokenPriceUsdPerMillion" = prices.cached::numeric,
  "cacheWriteInputTokenPriceUsdPerMillion" = prices.write::numeric,
  "outputTokenPriceUsdPerMillion" = prices.output::numeric,
  "priceSource" = 'catalog'
FROM identities JOIN prices ON prices.template = identities.template
WHERE model.id = identities.id AND (model."priceSource" = 'catalog' OR (
  model."inputTokenPriceUsdPerMillion" IS NULL AND model."cachedInputTokenPriceUsdPerMillion" IS NULL AND
  model."cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND model."outputTokenPriceUsdPerMillion" IS NULL));
