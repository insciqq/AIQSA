export const MEMORY_RECOMMENDATION_MIGRATION = "20260917123000_memory_model_recommendation_adoption";

export const memoryRecommendationFixtureSql = `
INSERT INTO "MemoryUtilityModelPolicy" (id, "assignmentSource", version, "updatedAt")
VALUES ('installation', 'OPERATOR', 17, now())
ON CONFLICT (id) DO UPDATE SET "providerModelId" = NULL, "reasoningEffort" = NULL,
  "assignmentSource" = 'OPERATOR', version = 17;
CREATE TABLE "MemoryRecommendationAdoptionFixture" AS
SELECT to_jsonb(policy) AS snapshot FROM "MemoryUtilityModelPolicy" policy WHERE id = 'installation';
`;

export const memoryRecommendationProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryRecommendationAdoptionFixture" original
    JOIN "MemoryUtilityModelPolicy" policy ON policy.id = 'installation'
    WHERE original.snapshot = to_jsonb(policy) - 'recommendationAdoptionVersion' - 'recommendationAdoptionReason'
      AND policy."recommendationAdoptionVersion" = 0 AND policy."recommendationAdoptionReason" IS NULL) THEN
    RAISE EXCEPTION 'recommendation_migration_changed_existing_policy';
  END IF;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 1;
    RAISE EXCEPTION 'recommendation_marker_without_reason_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 1, "recommendationAdoptionReason" = 'unknown';
    RAISE EXCEPTION 'unknown_recommendation_reason_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 1,
  "recommendationAdoptionReason" = 'preserved_operator' WHERE id = 'installation';
-- A previous release can still save an explicit clear without resetting the marker.
UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = NULL,
  "assignmentSource" = 'OPERATOR', version = 18 WHERE id = 'installation';
`;

export const memoryRecommendationRepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryUtilityModelPolicy" WHERE id = 'installation'
    AND "providerModelId" IS NULL AND "reasoningEffort" IS NULL AND "assignmentSource" = 'OPERATOR'
    AND version = 18 AND "recommendationAdoptionVersion" = 1 AND "recommendationAdoptionReason" = 'preserved_operator') THEN
    RAISE EXCEPTION 'recommendation_migration_replayed';
  END IF;
END $$;
`;

export const MEMORY_RECOMMENDATION_V2_MIGRATION = "20260918010000_memory_model_recommendation_adoption_v2";

export const memoryRecommendationV2FixtureSql = `
UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = NULL,
  "assignmentSource" = 'OPERATOR', version = 29, "recommendationAdoptionVersion" = 1,
  "recommendationAdoptionReason" = 'preserved_operator' WHERE id = 'installation';
CREATE TABLE "MemoryRecommendationV2AdoptionFixture" AS
SELECT to_jsonb(policy) AS snapshot FROM "MemoryUtilityModelPolicy" policy WHERE id = 'installation';
`;

export const memoryRecommendationV2ProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryRecommendationV2AdoptionFixture" original
    JOIN "MemoryUtilityModelPolicy" policy ON policy.id = 'installation'
    WHERE original.snapshot = to_jsonb(policy)) THEN
    RAISE EXCEPTION 'recommendation_v2_migration_changed_existing_policy';
  END IF;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 2, "recommendationAdoptionReason" = NULL;
    RAISE EXCEPTION 'recommendation_v2_marker_without_reason_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 2, "recommendationAdoptionReason" = 'unknown';
    RAISE EXCEPTION 'unknown_recommendation_v2_reason_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 3;
    RAISE EXCEPTION 'unknown_recommendation_version_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- Both old bootstrap writers and the new adoption marker remain valid.
UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 0, "recommendationAdoptionReason" = NULL;
UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 1, "recommendationAdoptionReason" = 'no_eligible_model';
UPDATE "MemoryUtilityModelPolicy" SET "recommendationAdoptionVersion" = 2, "recommendationAdoptionReason" = 'preserved_operator';
-- A previous-release settings writer preserves the completed v2 adoption.
UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = NULL,
  "assignmentSource" = 'OPERATOR', version = 30 WHERE id = 'installation';
`;

export const memoryRecommendationV2RepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryUtilityModelPolicy" WHERE id = 'installation'
    AND "providerModelId" IS NULL AND "reasoningEffort" IS NULL AND "assignmentSource" = 'OPERATOR'
    AND version = 30 AND "recommendationAdoptionVersion" = 2 AND "recommendationAdoptionReason" = 'preserved_operator') THEN
    RAISE EXCEPTION 'recommendation_v2_migration_replayed';
  END IF;
END $$;
`;
