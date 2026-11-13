export const GEMINI_4_CARBON_HYDROGEN_PRICES_MIGRATION = "20261113180000_gemini_4_carbon_hydrogen_prices";

// Release 0.4.30 has no tariff for Gemini 4 Carbon or Hydrogen: a row added from the Models menu
// stores priceSource 'admin' with unknown prices, which stays the administrator's. Only `catalog`
// rows of these identities adopt the tariff; Argon and other families stay as they were.
export const gemini4CarbonHydrogenPricesFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "draftConfig", "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('gemini-4-price-gemini', 'Synthetic Gemini', 'gemini', '{}', '{}', 1, now(), now()),
  ('gemini-4-price-openrouter', 'Synthetic OpenRouter', 'openrouter', '{}', '{}', 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName", "templateKey", "priceSource",
  "inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion", "webSearchPriceUsdPerThousand", capabilities, "defaultParams", "updatedAt")
VALUES
  ('gemini-4-price-carbon', 'gemini-4-price-gemini', 'gemini', 'gemini-4-carbon', 'answer', 'Synthetic Carbon', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('gemini-4-price-hydrogen-router', 'gemini-4-price-openrouter', 'openrouter', 'google/gemini-4-hydrogen', 'answer', 'Synthetic Hydrogen', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('gemini-4-price-admin', 'gemini-4-price-gemini', 'gemini', 'gemini-4-hydrogen', 'answer', 'Synthetic admin', NULL, 'admin', NULL, NULL, NULL, '{}', '{}', now()),
  ('gemini-4-price-image', 'gemini-4-price-gemini', 'gemini', 'gemini-4-carbon', 'image', 'Synthetic image', NULL, 'catalog', NULL, NULL, NULL, '{}', '{}', now()),
  ('gemini-4-price-argon', 'gemini-4-price-gemini', 'gemini', 'gemini-4-argon', 'answer', 'Synthetic Argon', NULL, 'catalog', 9, 9, 9, '{}', '{}', now());
`;

export const gemini4CarbonHydrogenPricesProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'gemini-4-price-carbon' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 4 AND "cachedInputTokenPriceUsdPerMillion" = 0.2
      AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 20
      AND "webSearchPriceUsdPerThousand" = 14)
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'gemini-4-price-hydrogen-router' AND "priceSource" = 'catalog'
      AND "inputTokenPriceUsdPerMillion" = 1.5 AND "cachedInputTokenPriceUsdPerMillion" = 0.075
      AND "cacheWriteInputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" = 7.5
      AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'gemini_4_catalog_prices_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'gemini-4-price-admin' AND "priceSource" = 'admin'
      AND "inputTokenPriceUsdPerMillion" IS NULL AND "outputTokenPriceUsdPerMillion" IS NULL AND "webSearchPriceUsdPerThousand" IS NULL)
  THEN RAISE EXCEPTION 'administrator_price_replaced'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'gemini-4-price-image'
      AND ("inputTokenPriceUsdPerMillion" IS NOT NULL OR "outputTokenPriceUsdPerMillion" IS NOT NULL OR "webSearchPriceUsdPerThousand" IS NOT NULL))
    OR NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'gemini-4-price-argon'
      AND "inputTokenPriceUsdPerMillion" = 9 AND "outputTokenPriceUsdPerMillion" = 9 AND "webSearchPriceUsdPerThousand" = 9)
  THEN RAISE EXCEPTION 'rows_outside_new_tariffs_changed'; END IF;
END $$;
`;
