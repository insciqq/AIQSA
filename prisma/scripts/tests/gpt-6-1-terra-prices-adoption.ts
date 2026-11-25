/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const GPT_6_1_TERRA_PRICES_MIGRATION = "20261125090000_gpt_6_1_terra_prices";

const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';

// Release 0.5.2 has no tariff for GPT-6.1 Terra: a row added from the Models menu stores priceSource
// 'admin' with unknown prices, which stays the administrator's. Only `catalog` rows of its identities
// adopt the tariff, codex-lb rows at the OpenAI price; other identities, model classes (the new GPT
// Image rows among them) and administrator prices stay as they were.
export const gpt61TerraPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('model-1125-price-openai', 'Synthetic OpenAI', 'openai', '{}', '{}', 1, now(), now()),
  ('model-1125-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('model-1125-price-codex', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('model-1125-price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", "webSearchPriceUsdPerThousand", capabilities, "defaultParams", "updatedAt")
VALUES
  ('model-1125-price-terra', 'model-1125-price-openai', 'openai', 'gpt-6.1-terra', 'answer', 'Synthetic Terra', 'openai:gpt-6.1-terra', 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-codex-terra', 'model-1125-price-codex', 'openai_compatible', 'gpt-6.1-terra', 'answer', 'Synthetic codex Terra', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-terra-router', 'model-1125-price-openrouter', 'openrouter', 'openai/gpt-6.1-terra', 'answer', 'Synthetic routed Terra', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-admin', 'model-1125-price-openai', 'openai', 'gpt-6.1-terra', 'answer', 'Synthetic admin', NULL, 'admin', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-compatible-row', 'model-1125-price-compatible', 'openai_compatible', 'gpt-6.1-terra', 'answer', 'Synthetic generic', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-image', 'model-1125-price-openai', 'openai', 'gpt-image-2.6-sunburst', 'image', 'Synthetic image', 'openai:gpt-image-2.6-sunburst', 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1125-price-existing', 'model-1125-price-openai', 'openai', 'gpt-6.1-sol', 'answer', 'Synthetic existing', NULL, 'catalog', 9, 9, 9, '{}', '{}', now());
`;

export const gpt61TerraPricesProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1125-price-terra' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 1 AND "cachedInputTokenPriceUsdPerMillion" = 0.05
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 1.25 AND "outputTokenPriceUsdPerMillion" = 5
      AND "webSearchPriceUsdPerThousand" = 10)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1125-price-codex-terra' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 1 AND "cachedInputTokenPriceUsdPerMillion" = 0.05
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 1.25 AND "outputTokenPriceUsdPerMillion" = 5
      AND "webSearchPriceUsdPerThousand" = 10)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1125-price-terra-router' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 1 AND "cachedInputTokenPriceUsdPerMillion" = 0.05
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 1.25 AND "outputTokenPriceUsdPerMillion" = 5
      AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'model_1125_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1125-price-admin' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'administrator_price_replaced'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('model-1125-price-compatible-row', 'model-1125-price-image')
      AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "cachedInputTokenPriceUsdPerMillion" IS NOT NULL
        OR "cacheWriteInputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL
        OR "webSearchPriceUsdPerThousand" IS NOT NULL))
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1125-price-existing'
      AND "inputTokenPriceUsdPerMillion" = 9 AND "outputTokenPriceUsdPerMillion" = 9 AND "webSearchPriceUsdPerThousand" = 9)
  THEN RAISE EXCEPTION 'rows_outside_new_tariffs_changed'; END IF;
END $$;
`;
