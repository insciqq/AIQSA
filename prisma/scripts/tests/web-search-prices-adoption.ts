export const WEB_SEARCH_PRICES_MIGRATION = "20261008170000_web_search_prices";

const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';

// The release before this migration has no per-search price. Rows with a catalog
// identity of a family that publishes a search fee adopt it, whatever their price
// source; an administrator's token prices stay as they were. Every other row and the
// existing usage stay unpriced.
export const webSearchPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('web-search-price-openai', 'Synthetic OpenAI', 'openai', '{}', '{}', 1, now(), now()),
  ('web-search-price-anthropic', 'Synthetic Anthropic', 'anthropic', '{}', '{}', 1, now(), now()),
  ('web-search-price-gemini', 'Synthetic Gemini', 'gemini', '{}', '{}', 1, now(), now()),
  ('web-search-price-deepseek', 'Synthetic DeepSeek', 'deepseek', '{}', '{}', 1, now(), now()),
  ('web-search-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('web-search-price-codex', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('web-search-price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", capabilities, "defaultParams", "updatedAt")
VALUES
  ('web-search-price-template', 'web-search-price-openai', 'openai', 'gpt-6-sol', 'answer', 'Synthetic template', 'openai:gpt-6-sol', 'catalog', 2, 10, '{}', '{}', now()),
  ('web-search-price-admin', 'web-search-price-openai', 'openai', 'gpt-6-luna', 'answer', 'Synthetic admin', NULL, 'admin', 0.5, NULL, '{}', '{}', now()),
  ('web-search-price-anthropic-row', 'web-search-price-anthropic', 'anthropic', 'claude-opus-5-5', 'answer', 'Synthetic Anthropic', NULL, 'catalog', 4, 20, '{}', '{}', now()),
  ('web-search-price-gemini-row', 'web-search-price-gemini', 'gemini', 'gemini-3.8-flash', 'answer', 'Synthetic Gemini', NULL, 'catalog', 0.75, 3.75, '{}', '{}', now()),
  ('web-search-price-codex-row', 'web-search-price-codex', 'openai_compatible', 'gpt-5.6-sol', 'answer', 'Synthetic codex', NULL, 'catalog', 4, 20, '{}', '{}', now()),
  ('web-search-price-deepseek-row', 'web-search-price-deepseek', 'deepseek', 'deepseek-v4-pro', 'answer', 'Synthetic DeepSeek', NULL, 'catalog', 1.32, 3.96, '{}', '{}', now()),
  ('web-search-price-openrouter-row', 'web-search-price-openrouter', 'openrouter', 'openai/gpt-6-sol', 'answer', 'Synthetic reported', NULL, 'catalog', 2, 10, '{}', '{}', now()),
  ('web-search-price-compatible-row', 'web-search-price-compatible', 'openai_compatible', 'gpt-6-sol', 'answer', 'Synthetic generic', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('web-search-price-unlisted', 'web-search-price-openai', 'openai', 'vendor/unlisted', 'answer', 'Synthetic unlisted', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('web-search-price-embedding', 'web-search-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic embedding', NULL, 'catalog', 0.13, NULL, '{}', '{}', now()),
  ('web-search-price-image', 'web-search-price-openai', 'openai', 'gpt-6-luna', 'image', 'Synthetic image', 'openai:gpt-6-luna', 'catalog', NULL, NULL, '{}', '{}', now());
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('web-search-price-user', 'Synthetic owner', 'active', now());
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "inputTokens", "outputTokens", "totalTokens", "usageCompleteness", "estimatedCostMicros")
VALUES ('web-search-price-usage', 'web-search-price-user', 'web_search', 'openai', 'gpt-6-sol', 3, 2, 5, 'COMPLETE', 26);
`;

export const webSearchPricesProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ProviderModel" WHERE id IN ('web-search-price-template', 'web-search-price-admin',
      'web-search-price-anthropic-row', 'web-search-price-codex-row') AND "webSearchPriceUsdPerThousand" = 10) <> 4
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'web-search-price-gemini-row' AND "webSearchPriceUsdPerThousand" = 14)
  THEN RAISE EXCEPTION 'catalog_web_search_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'web-search-price-admin' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" = 0.5 AND "outputTokenPriceUsdPerMillion" IS NULL
      AND "cachedInputTokenPriceUsdPerMillion" IS NULL AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL)
    OR (SELECT count(*) FROM "ProviderModel" WHERE id IN ('web-search-price-template', 'web-search-price-anthropic-row',
      'web-search-price-gemini-row', 'web-search-price-codex-row') AND "priceSource" = 'catalog') <> 4
  THEN RAISE EXCEPTION 'token_prices_or_sources_changed'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('web-search-price-deepseek-row', 'web-search-price-openrouter-row',
      'web-search-price-compatible-row', 'web-search-price-unlisted', 'web-search-price-embedding', 'web-search-price-image')
    AND "webSearchPriceUsdPerThousand" IS NOT NULL)
  THEN RAISE EXCEPTION 'rows_without_web_search_catalog_fee_priced'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UsageEvent" WHERE id = 'web-search-price-usage' AND "webSearchCount" IS NULL
    AND "estimatedCostMicros" = 26 AND "inputTokens" = 3 AND "outputTokens" = 2)
  THEN RAISE EXCEPTION 'existing_usage_changed'; END IF;
  BEGIN
    UPDATE "UsageEvent" SET "webSearchCount" = 0 WHERE id = 'web-search-price-usage';
    RAISE EXCEPTION 'non_positive_web_search_count_accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE "ProviderModel" SET "webSearchPriceUsdPerThousand" = -1 WHERE id = 'web-search-price-deepseek-row';
    RAISE EXCEPTION 'negative_web_search_price_accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
`;
