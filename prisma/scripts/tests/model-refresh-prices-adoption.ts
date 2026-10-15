export const MODEL_REFRESH_PRICES_MIGRATION = "20261015120000_model_refresh_prices";

const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';

// Release 0.3.14 has no tariff for these models: a row added from the Models menu stores
// priceSource 'admin' with unknown prices, which stays the administrator's. Only `catalog`
// rows of a newly priced identity adopt the tariff; other identities stay as they were.
export const modelRefreshPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('model-refresh-price-openai', 'Synthetic OpenAI', 'openai', '{}', '{}', 1, now(), now()),
  ('model-refresh-price-anthropic', 'Synthetic Anthropic', 'anthropic', '{}', '{}', 1, now(), now()),
  ('model-refresh-price-gemini', 'Synthetic Gemini', 'gemini', '{}', '{}', 1, now(), now()),
  ('model-refresh-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('model-refresh-price-codex', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('model-refresh-price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", capabilities, "defaultParams", "updatedAt")
VALUES
  ('model-refresh-price-template', 'model-refresh-price-openai', 'openai', 'gpt-6.1-sol', 'answer', 'Synthetic template', 'openai:gpt-6.1-sol', 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-codex-row', 'model-refresh-price-codex', 'openai_compatible', 'gpt-6.1-sol', 'answer', 'Synthetic codex', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-gemini-row', 'model-refresh-price-gemini', 'gemini', 'gemini-4-argon', 'answer', 'Synthetic Gemini', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-openrouter-row', 'model-refresh-price-openrouter', 'openrouter', 'anthropic/claude-haiku-5.5', 'answer', 'Synthetic reported', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-admin', 'model-refresh-price-codex', 'openai_compatible', 'gpt-6.1-sol', 'answer', 'Synthetic admin', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-admin-priced', 'model-refresh-price-anthropic', 'anthropic', 'claude-sonnet-5-5', 'answer', 'Synthetic priced', NULL, 'admin', 1.5, NULL, '{}', '{}', now()),
  ('model-refresh-price-compatible-row', 'model-refresh-price-compatible', 'openai_compatible', 'gpt-6.1-sol', 'answer', 'Synthetic generic', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-image', 'model-refresh-price-openai', 'openai', 'gpt-6.1-sol', 'image', 'Synthetic image', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('model-refresh-price-existing', 'model-refresh-price-openai', 'openai', 'gpt-6-sol', 'answer', 'Synthetic existing', NULL, 'catalog', 9, 9, '{}', '{}', now());
`;

export const modelRefreshPricesProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ProviderModel" WHERE id IN ('model-refresh-price-template', 'model-refresh-price-codex-row')
      AND "inputTokenPriceUsdPerMillion" = 2 AND "cachedInputTokenPriceUsdPerMillion" = 0.1
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 2.5 AND "outputTokenPriceUsdPerMillion" = 10
      AND "webSearchPriceUsdPerThousand" = 10 AND "priceSource" = 'catalog') <> 2
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-refresh-price-gemini-row'
      AND "inputTokenPriceUsdPerMillion" = 2 AND "cachedInputTokenPriceUsdPerMillion" = 0.1
      AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 10
      AND "webSearchPriceUsdPerThousand" = 14)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-refresh-price-openrouter-row'
      AND "inputTokenPriceUsdPerMillion" = 0.1 AND "cachedInputTokenPriceUsdPerMillion" = 0.01
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 0.125 AND "outputTokenPriceUsdPerMillion" = 0.5
      AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'model_refresh_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-refresh-price-admin-priced' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" = 1.5 AND "outputTokenPriceUsdPerMillion" IS NULL AND "webSearchPriceUsdPerThousand" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-refresh-price-admin' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'administrator_price_replaced'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('model-refresh-price-compatible-row', 'model-refresh-price-image')
      AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL OR "webSearchPriceUsdPerThousand" IS NOT NULL))
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-refresh-price-existing'
      AND "inputTokenPriceUsdPerMillion" = 9 AND "outputTokenPriceUsdPerMillion" = 9 AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'rows_outside_new_tariffs_changed'; END IF;
END $$;
`;
