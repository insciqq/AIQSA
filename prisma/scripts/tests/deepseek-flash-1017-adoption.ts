export const DEEPSEEK_FLASH_1017_MIGRATION = "20261018213000_deepseek_flash_1017";

// Release 0.3.18 names the September OpenRouter snapshot "DeepSeek V4.1 Flash" at its
// 2026-10-15 tariff. Its `catalog` rows move to the 2026-10-18 tariff and the catalog's new
// name; administrator prices and names, other models and other families stay as they were.
export const deepSeekFlash1017FixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('flash-1017-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('flash-1017-openrouter-second', 'Synthetic second OpenRouter', 'openrouter', '{}', '{}', 1, now(), now()),
  ('flash-1017-deepseek', 'Synthetic DeepSeek', 'deepseek', '{}', '{}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "cachedInputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", capabilities, "defaultParams", "updatedAt")
VALUES
  ('flash-1017-template', 'flash-1017-openrouter', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'answer', 'DeepSeek V4.1 Flash',
    'openrouter:deepseek/deepseek-v4.1-flash', 'catalog', 0.0198, 0.00291, 0.396, '{}', '{}', now()),
  ('flash-1017-second', 'flash-1017-openrouter-second', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'answer', 'DeepSeek V4.1 Flash',
    NULL, 'catalog', 0.0198, 0.00291, 0.396, '{}', '{}', now()),
  ('flash-1017-admin', 'flash-1017-openrouter-second', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'answer', 'Fast memory',
    NULL, 'admin', 0.5, NULL, 1, '{}', '{}', now()),
  ('flash-1017-new-admin', 'flash-1017-openrouter-second', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017', 'answer', 'DeepSeek V4.1 Flash',
    NULL, 'admin', NULL, NULL, NULL, '{}', '{}', now()),
  ('flash-1017-native', 'flash-1017-deepseek', 'deepseek', 'deepseek-flash', 'answer', 'DeepSeek V4.1 Flash',
    NULL, 'catalog', 0.3, 0.006, 1.2, '{}', '{}', now());
`;

export const deepSeekFlash1017ProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ProviderModel" WHERE id IN ('flash-1017-template', 'flash-1017-second')
      AND "displayName" = 'DeepSeek V4.1 Flash 0910' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 0.04 AND "cachedInputTokenPriceUsdPerMillion" = 0.0016
      AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 0.144) <> 2
  THEN RAISE EXCEPTION 'september_flash_not_adopted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'flash-1017-admin' AND "displayName" = 'Fast memory'
      AND "priceSource" = 'admin' AND "inputTokenPriceUsdPerMillion" = 0.5 AND "outputTokenPriceUsdPerMillion" = 1)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'flash-1017-new-admin' AND "displayName" = 'DeepSeek V4.1 Flash'
      AND "priceSource" = 'admin' AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL)
  THEN RAISE EXCEPTION 'administrator_row_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'flash-1017-native' AND "displayName" = 'DeepSeek V4.1 Flash'
      AND "inputTokenPriceUsdPerMillion" = 0.3 AND "cachedInputTokenPriceUsdPerMillion" = 0.006 AND "outputTokenPriceUsdPerMillion" = 1.2)
  THEN RAISE EXCEPTION 'native_flash_changed'; END IF;
END $$;
`;
