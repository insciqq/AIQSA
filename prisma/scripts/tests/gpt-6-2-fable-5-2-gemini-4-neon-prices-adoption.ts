export const GPT_6_2_FABLE_5_2_GEMINI_4_NEON_PRICES_MIGRATION = "20261119090000_gpt_6_2_fable_5_2_gemini_4_neon_prices";

const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';

// Release 0.4.37 has no tariff for GPT-6.2 Astra or Sol, Claude Fable 5.2 or Gemini 4 Neon: a
// row added from the Models menu stores priceSource 'admin' with unknown prices, which stays the
// administrator's. Only `catalog` rows of these identities adopt the tariff, codex-lb rows at the
// OpenAI price; other identities, model classes and administrator prices stay as they were.
export const gpt62Fable52Gemini4NeonPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('model-1119-price-openai', 'Synthetic OpenAI', 'openai', '{}', '{}', 1, now(), now()),
  ('model-1119-price-anthropic', 'Synthetic Anthropic', 'anthropic', '{}', '{}', 1, now(), now()),
  ('model-1119-price-gemini', 'Synthetic Gemini', 'gemini', '{}', '{}', 1, now(), now()),
  ('model-1119-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('model-1119-price-codex', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('model-1119-price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", "webSearchPriceUsdPerThousand", capabilities, "defaultParams", "updatedAt")
VALUES
  ('model-1119-price-astra', 'model-1119-price-openai', 'openai', 'gpt-6.2-astra', 'answer', 'Synthetic Astra', 'openai:gpt-6.2-astra', 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-codex-sol', 'model-1119-price-codex', 'openai_compatible', 'gpt-6.2-sol', 'answer', 'Synthetic codex Sol', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-fable', 'model-1119-price-anthropic', 'anthropic', 'claude-fable-5-2', 'answer', 'Synthetic Fable', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-neon', 'model-1119-price-gemini', 'gemini', 'gemini-4-neon', 'answer', 'Synthetic Neon', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-fable-router', 'model-1119-price-openrouter', 'openrouter', 'anthropic/claude-fable-5.2', 'answer', 'Synthetic routed Fable', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-admin', 'model-1119-price-codex', 'openai_compatible', 'gpt-6.2-astra', 'answer', 'Synthetic admin', NULL, 'admin', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-compatible-row', 'model-1119-price-compatible', 'openai_compatible', 'gpt-6.2-sol', 'answer', 'Synthetic generic', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-image', 'model-1119-price-gemini', 'gemini', 'gemini-4-neon', 'image', 'Synthetic image', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('model-1119-price-existing', 'model-1119-price-openai', 'openai', 'gpt-6.1-sol', 'answer', 'Synthetic existing', NULL, 'catalog', 9, 9, 9, '{}', '{}', now());
`;

export const gpt62Fable52Gemini4NeonPricesProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-astra' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 8 AND "cachedInputTokenPriceUsdPerMillion" = 0.4
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 10 AND "outputTokenPriceUsdPerMillion" = 40
      AND "webSearchPriceUsdPerThousand" = 10)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-codex-sol' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 2 AND "cachedInputTokenPriceUsdPerMillion" = 0.1
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 2.5 AND "outputTokenPriceUsdPerMillion" = 10
      AND "webSearchPriceUsdPerThousand" = 10)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-fable' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 8 AND "cachedInputTokenPriceUsdPerMillion" = 0.2
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 10 AND "outputTokenPriceUsdPerMillion" = 40
      AND "webSearchPriceUsdPerThousand" = 10)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-neon' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 3 AND "cachedInputTokenPriceUsdPerMillion" = 0.15
      AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 15
      AND "webSearchPriceUsdPerThousand" = 14)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-fable-router' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 8 AND "cachedInputTokenPriceUsdPerMillion" = 0.2
      AND "cacheWriteInputTokenPriceUsdPerMillion" = 10 AND "outputTokenPriceUsdPerMillion" = 40
      AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'model_1119_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-admin' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'administrator_price_replaced'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('model-1119-price-compatible-row', 'model-1119-price-image')
      AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL OR "webSearchPriceUsdPerThousand" IS NOT NULL))
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'model-1119-price-existing'
      AND "inputTokenPriceUsdPerMillion" = 9 AND "outputTokenPriceUsdPerMillion" = 9 AND "webSearchPriceUsdPerThousand" = 9)
  THEN RAISE EXCEPTION 'rows_outside_new_tariffs_changed'; END IF;
END $$;
`;
