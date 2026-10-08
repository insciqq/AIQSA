export const DECISION_UPGRADE_MIGRATION = "20260919140000_decision_upgrade_adoption";

export const decisionUpgradeFixtureSql = `
UPDATE "SystemModelPolicy" SET "decisionFeaturesJson" = '{"memoryRelevance":false}' WHERE id = 'installation';
CREATE TABLE "DecisionUpgradePolicyFixture" AS
  SELECT to_jsonb(policy) AS snapshot FROM "SystemModelPolicy" policy WHERE id = 'installation';
CREATE TABLE "DecisionUpgradeModelsFixture" AS
  SELECT id, to_jsonb(model) AS snapshot FROM "ProviderModel" model;
`;

export const decisionUpgradeProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" policy
    JOIN "DecisionUpgradePolicyFixture" original ON original.snapshot =
      (to_jsonb(policy) - 'decisionAdoptionVersion' - 'decisionAdoptionReason'
        - 'visionProviderModelId' - 'visionReasoningEffort'
        - 'speechToTextConnectionId' - 'speechToTextModelId' - 'speechToTextCredentialVersionId'
        - 'speechToTextConfiguredAt')
    WHERE policy.id = 'installation' AND "decisionAdoptionVersion" = 0 AND "decisionAdoptionReason" IS NULL) THEN
    RAISE EXCEPTION 'decision_upgrade_changed_existing_policy';
  END IF;
  IF EXISTS (SELECT 1 FROM "DecisionUpgradeModelsFixture" original
    LEFT JOIN "ProviderModel" model ON model.id = original.id
    -- These predecessor fixtures carry no catalog template rows. The later
    -- pricing expansion preserves any legacy rate numerically; all other
    -- columns remain byte-for-byte unchanged.
    WHERE model.id IS NULL OR original.snapshot ->> 'templateKey' IS NOT NULL OR
      original.snapshot || jsonb_build_object(
        'inputTokenPriceUsdPerMillion', NULLIF((original.snapshot ->> 'inputTokenPriceMicros')::numeric, 0),
        'cachedInputTokenPriceUsdPerMillion', NULL, 'cacheWriteInputTokenPriceUsdPerMillion', NULL,
        'outputTokenPriceUsdPerMillion', NULLIF((original.snapshot ->> 'outputTokenPriceMicros')::numeric, 0),
        'webSearchPriceUsdPerThousand', NULL, 'priceSource', 'catalog') <> to_jsonb(model)) THEN
    RAISE EXCEPTION 'decision_upgrade_changed_provider_models';
  END IF;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'SystemModelPolicy' AND column_name = 'decisionAdoptionVersion') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'decision_upgrade_repeats_on_fresh_installation';
  END IF;
END $$;
`;
