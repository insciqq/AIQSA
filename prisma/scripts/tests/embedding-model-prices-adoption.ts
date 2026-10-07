export const EMBEDDING_MODEL_PRICES_MIGRATION = "20261008140000_embedding_model_prices";

const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';

// Release 0.3.8 refuses prices for every non-answer class: a preset added from the
// Models menu stores priceSource 'admin' with unknown prices, an older or Quick Setup
// row keeps the column default. The priced admin row is synthetic and proves that an
// administrator's price is never replaced.
export const embeddingModelPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('embedding-price-openai', 'Synthetic OpenAI', 'openai', '{}', '{}', 1, now(), now()),
  ('embedding-price-codex', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('embedding-price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now()),
  ('embedding-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", capabilities, "defaultParams", "updatedAt")
VALUES
  ('embedding-price-preset', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic preset', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-default', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic default', NULL, 'catalog', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-template', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic template', 'openai:text-embedding-3-large', 'catalog', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-catalog-legacy', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic legacy', NULL, 'catalog', 0.5, 0.5, '{}', '{}', now()),
  ('embedding-price-codex-row', 'embedding-price-codex', 'openai_compatible', 'text-embedding-3-large', 'embedding', 'Synthetic codex', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-admin', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'embedding', 'Synthetic admin', NULL, 'admin', 0.2, NULL, '{}', '{}', now()),
  ('embedding-price-compatible-row', 'embedding-price-compatible', 'openai_compatible', 'text-embedding-3-large', 'embedding', 'Synthetic generic', NULL, 'admin', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-openrouter-row', 'embedding-price-openrouter', 'openrouter', 'qwen/qwen3-embedding-8b', 'embedding', 'Synthetic reported', 'openrouter:qwen/qwen3-embedding-8b', 'catalog', NULL, NULL, '{}', '{}', now()),
  ('embedding-price-answer', 'embedding-price-openai', 'openai', 'text-embedding-3-large', 'answer', 'Synthetic answer', NULL, 'catalog', NULL, NULL, '{}', '{}', now());
`;

export const embeddingModelPricesProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ProviderModel" WHERE id IN ('embedding-price-preset', 'embedding-price-default', 'embedding-price-template',
      'embedding-price-catalog-legacy', 'embedding-price-codex-row')
    AND "inputTokenPriceUsdPerMillion" = 0.13 AND "cachedInputTokenPriceUsdPerMillion" IS NULL
    AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL AND "priceSource" = 'catalog') <> 5
  THEN RAISE EXCEPTION 'embedding_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'embedding-price-admin' AND "priceSource" = 'admin'
    AND "inputTokenPriceUsdPerMillion" = 0.2 AND "outputTokenPriceUsdPerMillion" IS NULL)
  THEN RAISE EXCEPTION 'administrator_embedding_price_replaced'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'embedding-price-compatible-row' AND "priceSource" = 'admin')
    OR (SELECT count(*) FROM "ProviderModel" WHERE id IN ('embedding-price-openrouter-row', 'embedding-price-answer') AND "priceSource" = 'catalog') <> 2
    OR EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('embedding-price-compatible-row', 'embedding-price-openrouter-row', 'embedding-price-answer')
      AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "cachedInputTokenPriceUsdPerMillion" IS NOT NULL OR
        "cacheWriteInputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL))
  THEN RAISE EXCEPTION 'rows_without_embedding_catalog_identity_priced'; END IF;
END $$;
`;
