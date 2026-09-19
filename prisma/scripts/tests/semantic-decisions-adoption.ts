export const SEMANTIC_DECISIONS_MIGRATION = "20260919021500_optional_semantic_decisions";

export const semanticDecisionsFixtureSql = `
CREATE TABLE "SemanticDecisionsPolicyFixture" AS
  SELECT to_jsonb(policy) AS snapshot FROM "SystemModelPolicy" AS policy WHERE id = 'installation';
CREATE TABLE "SemanticDecisionsModelsFixture" AS
  SELECT id, to_jsonb(model) AS snapshot FROM "ProviderModel" AS model;
`;

export const semanticDecisionsProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" AS policy
    JOIN "SemanticDecisionsPolicyFixture" AS original ON original.snapshot =
      (to_jsonb(policy) - 'decisionProviderModelId' - 'decisionConfiguredAt' - 'decisionFeaturesJson'
        - 'decisionAdoptionVersion' - 'decisionAdoptionReason')
    WHERE policy.id = 'installation' AND "decisionProviderModelId" IS NULL
      AND "decisionConfiguredAt" IS NULL AND "decisionFeaturesJson" = '{}') THEN
    RAISE EXCEPTION 'optional_decisions_changed_existing_policy_or_enabled_unqualified_feature';
  END IF;
  IF EXISTS (SELECT 1 FROM "SemanticDecisionsModelsFixture" AS original
    LEFT JOIN "ProviderModel" AS model ON model.id = original.id
    WHERE model.id IS NULL OR original.snapshot <> to_jsonb(model)) THEN
    RAISE EXCEPTION 'optional_decisions_changed_existing_model';
  END IF;
  PERFORM 'decision'::"ProviderModelClass";
  BEGIN
    UPDATE "SystemModelPolicy" SET "decisionFeaturesJson" = '[]' WHERE id = 'installation';
    RAISE EXCEPTION 'optional_decisions_accepted_non_object_flags';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "SystemModelPolicy" SET "decisionProviderModelId" = 'nonexistent-decision-model' WHERE id = 'installation';
    RAISE EXCEPTION 'optional_decisions_accepted_missing_model';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
`;
