export const MODEL_PRICES_MIGRATION = "20260930130000_model_token_prices";

// Release 0.2.31 stores no template key for codex-lb (an openai_compatible connection)
// or for a second connection of a Quick Setup family; their rows carry generated ids.
const CODEX_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000}';
const MARKED_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://relay.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000,"responsesRequestIsolation":"auto","responsesRequestIsolationDetected":true}';
const NEGATIVE_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://codex.example.test/backend-api/codex","authenticationMode":"bearer","responseTimeoutMs":300000,"responsesRequestIsolation":"auto","responsesRequestIsolationDetected":false}';
const GENERIC_ENDPOINT = '{"allowPrivateNetwork":false,"apiRoot":"https://llm.example.test/v1","authenticationMode":"bearer","responseTimeoutMs":300000}';
const CODEX_ROW_ID = "0f3b6c2e-5d4a-4e8b-9c71-2a6d8e4f1b90";

export const modelPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('price-adoption', 'Synthetic pricing', 'openai', '{}', NULL, 0, NULL, now()),
  ('price-codex-lb', 'Synthetic codex-lb', 'openai_compatible', '${CODEX_ENDPOINT}', '${CODEX_ENDPOINT}', 1, now(), now()),
  ('price-codex-marked', 'Synthetic marked relay', 'openai_compatible', '${MARKED_ENDPOINT}', NULL, 0, NULL, now()),
  ('price-codex-negative', 'Synthetic negative relay', 'openai_compatible', '${NEGATIVE_ENDPOINT}', '${NEGATIVE_ENDPOINT}', 1, now(), now()),
  ('price-compatible', 'Synthetic compatible', 'openai_compatible', '${GENERIC_ENDPOINT}', '${GENERIC_ENDPOINT}', 1, now(), now()),
  ('price-openrouter-second', 'Synthetic second OpenRouter', 'openrouter', '{}', '{}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "inputTokenPriceMicros", "outputTokenPriceMicros", capabilities, "defaultParams", "updatedAt")
VALUES
  ('price-openai', 'price-adoption', 'openai', 'gpt-6-luna', 'answer', 'Synthetic Luna', 'openai:gpt-6-luna', 0, 0, '{}', '{}', now()),
  ('${CODEX_ROW_ID}', 'price-codex-lb', 'openai_compatible', 'gpt-5.6-sol', 'answer', 'Synthetic Codex', NULL, 0, 0, '{}', '{}', now()),
  ('price-codex-unknown', 'price-codex-lb', 'openai_compatible', 'vendor/unlisted', 'answer', 'Synthetic unlisted', NULL, 0, 0, '{}', '{}', now()),
  ('price-codex-image', 'price-codex-lb', 'openai_compatible', 'gpt-image-2', 'image', 'Synthetic image', NULL, 0, 0, '{}', '{}', now()),
  ('price-codex-marked-row', 'price-codex-marked', 'openai_compatible', 'gpt-6-luna', 'answer', 'Synthetic marked', NULL, 0, 0, '{}', '{}', now()),
  ('price-codex-negative-row', 'price-codex-negative', 'openai_compatible', 'gpt-6-sol', 'answer', 'Synthetic negative', NULL, 0, 0, '{}', '{}', now()),
  ('price-compatible-row', 'price-compatible', 'openai_compatible', 'gpt-6-sol', 'answer', 'Synthetic compatible', NULL, 0, 0, '{}', '{}', now()),
  ('price-openrouter-second-row', 'price-openrouter-second', 'openrouter', 'google/gemini-3.5-flash', 'answer', 'Synthetic second', NULL, 2, 9, '{}', '{}', now()),
  ('price-old', 'price-adoption', 'openai', 'legacy', 'answer', 'Synthetic legacy', 'legacy:priced', 3, 12, '{}', '{}', now()),
  ('price-manual', 'price-adoption', 'openai', 'manual', 'answer', 'Synthetic manual', NULL, 0, 0, '{}', '{}', now());
INSERT INTO "User" (id, "displayName", "updatedAt") VALUES ('price-user', 'Synthetic owner', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('price-chat', 'price-user', 'Synthetic title', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt") VALUES ('price-message', 'price-chat', 'user', '{}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('price-run', 'price-user', 'price-chat', 'price-message', 'openai', 'gpt-6-luna', 'complete', '{}', now());
INSERT INTO "ChatTitleGeneration" ("runId", "chatId", "userId", "expectedTitle", "titleRevision", "questionText", "answerText", "providerSnapshot", status, "expiresAt")
VALUES ('price-run', 'price-chat', 'price-user', 'Synthetic title', 0, 'Synthetic question', 'Synthetic answer',
  '{"providerModelId":"price-openai","providerFamily":"openai","model":{"upstreamModelId":"gpt-6-luna"}}', 'dispatched', now() + interval '1 minute');
INSERT INTO "UsageEvent" (id, "userId", "chatId", "modelRunId", provider, "modelId", "providerModelId", "chatTitleGeneration", "chatTitleGenerationId",
  "inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "usageCompleteness")
VALUES ('price-title-event', 'price-user', 'price-chat', 'price-run', 'openai', 'gpt-6-luna', 'price-openai', true, 'price-run', 10000, 8000, 1000, 11000, 'COMPLETE');
UPDATE "ChatTitleGeneration" SET status = 'settled' WHERE "runId" = 'price-run';
`;

export const modelPricesProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-openai'
    AND "inputTokenPriceUsdPerMillion" = 0.1 AND "cachedInputTokenPriceUsdPerMillion" = 0.01
    AND "cacheWriteInputTokenPriceUsdPerMillion" = 0.125 AND "outputTokenPriceUsdPerMillion" = 0.5 AND "priceSource" = 'catalog')
  THEN RAISE EXCEPTION 'fractional_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = '${CODEX_ROW_ID}' AND "templateKey" IS NULL
    AND "inputTokenPriceUsdPerMillion" = 4 AND "cachedInputTokenPriceUsdPerMillion" = 0.4
    AND "cacheWriteInputTokenPriceUsdPerMillion" = 5 AND "outputTokenPriceUsdPerMillion" = 20 AND "priceSource" = 'catalog')
  THEN RAISE EXCEPTION 'codex_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-codex-marked-row'
    AND "inputTokenPriceUsdPerMillion" = 0.1 AND "cachedInputTokenPriceUsdPerMillion" = 0.01
    AND "cacheWriteInputTokenPriceUsdPerMillion" = 0.125 AND "outputTokenPriceUsdPerMillion" = 0.5 AND "priceSource" = 'catalog')
  THEN RAISE EXCEPTION 'codex_marker_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-openrouter-second-row'
    AND "inputTokenPriceUsdPerMillion" = 1.5 AND "cachedInputTokenPriceUsdPerMillion" = 0.15
    AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 9 AND "priceSource" = 'catalog')
  THEN RAISE EXCEPTION 'second_connection_catalog_prices_missing'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id IN ('price-codex-unknown', 'price-codex-image',
      'price-codex-negative-row', 'price-compatible-row')
    AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "cachedInputTokenPriceUsdPerMillion" IS NOT NULL OR
      "cacheWriteInputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL))
  THEN RAISE EXCEPTION 'rows_without_catalog_identity_priced'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-old'
    AND "inputTokenPriceUsdPerMillion" = 3 AND "outputTokenPriceUsdPerMillion" = 12)
  THEN RAISE EXCEPTION 'legacy_price_conversion_changed_units'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-manual'
    AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL)
  THEN RAISE EXCEPTION 'manual_model_unknown_price_lost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "CatalogCostBackfill" WHERE id = '20260930'
    AND jsonb_array_length(prices) = 5 AND "completedAt" IS NULL)
  THEN RAISE EXCEPTION 'upgrade_prices_not_frozen'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "CatalogCostBackfill" state, jsonb_array_elements(state.prices) price
    WHERE state.id = '20260930' AND price->>'id' = '${CODEX_ROW_ID}' AND price->>'provider' = 'openai_compatible'
      AND price->>'modelId' = 'gpt-5.6-sol' AND (price->>'inputTokenPriceUsdPerMillion')::numeric = 4
      AND (price->>'cachedInputTokenPriceUsdPerMillion')::numeric = 0.4 AND (price->>'outputTokenPriceUsdPerMillion')::numeric = 20)
  THEN RAISE EXCEPTION 'codex_upgrade_prices_not_frozen'; END IF;
END $$;
UPDATE "ProviderModel" SET "cachedInputTokenPriceUsdPerMillion" = 0.0125 WHERE id = 'price-manual';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'price-manual' AND "cachedInputTokenPriceUsdPerMillion" = 0.0125)
  THEN RAISE EXCEPTION 'fractional_price_not_exact'; END IF;
END $$;
-- Previous-release inserts still accept the retained integer columns.
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "inputTokenPriceMicros", "outputTokenPriceMicros", capabilities, "defaultParams", "updatedAt")
VALUES ('price-previous-writer', 'price-adoption', 'openai', 'previous', 'Synthetic previous writer', 0, 0, '{}', '{}', now())
ON CONFLICT (id) DO NOTHING;
`;

export const modelPricesGuardProofSql = `
DO $$ DECLARE previous "UsageEvent"; incoming "UsageEvent"; BEGIN
  SELECT * INTO previous FROM "UsageEvent" WHERE id = 'price-title-event';
  incoming := previous;
  previous."outputTokens" := NULL;
  incoming."outputTokens" := NULL;
  incoming."estimatedCostMicros" := 780;
  IF COALESCE(catalog_cost_adoption_valid(previous, incoming), false)
  THEN RAISE EXCEPTION 'malformed_usage_cost_adoption_allowed'; END IF;
END $$;
UPDATE "UsageEvent" SET "estimatedCostMicros" = 780 WHERE id = 'price-title-event' AND "estimatedCostMicros" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UsageEvent" WHERE id = 'price-title-event' AND "estimatedCostMicros" = 780)
  THEN RAISE EXCEPTION 'historical_title_cost_not_adopted'; END IF;
  BEGIN
    UPDATE "UsageEvent" SET "estimatedCostMicros" = 781 WHERE id = 'price-title-event';
    RAISE EXCEPTION 'known_title_cost_was_changed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE "UsageEvent" SET "inputTokens" = 10001 WHERE id = 'price-title-event';
    RAISE EXCEPTION 'title_usage_was_changed';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
`;
