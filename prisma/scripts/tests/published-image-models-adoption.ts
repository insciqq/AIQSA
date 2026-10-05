/** Synthetic upgrade state; migration-contract owns the disposable database. */
export const PUBLISHED_IMAGE_MODELS_MIGRATION = "20261004180000_published_image_models";

export function publishedImageModelsFixtureSql(assigned: boolean): string {
  return `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('image-adoption-provider', 'Synthetic image provider', 'openai', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt")
VALUES ('image-adoption-model', 'image-adoption-provider', 'openai', 'gpt-image-2', 'Synthetic image', 'image', '{}', '{}', now()),
  ('image-adoption-candidate', 'image-adoption-provider', 'openai', 'gpt-image-1', 'Synthetic candidate', 'image', '{}', '{}', now());
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('image-adoption-user', 'Synthetic user', 'active', now());
INSERT INTO "UserSettings" (id, "userId", "updatedAt")
VALUES ('image-adoption-settings', 'image-adoption-user', now());
INSERT INTO "SystemModelPolicy" (id, "imageProviderModelId", "imageParamsJson", version, "updatedAt")
VALUES ('installation', ${assigned ? "'image-adoption-model', '{\"quality\":\"low\"}'" : "NULL, '{}'"}, 13, now())
ON CONFLICT (id) DO UPDATE SET "imageProviderModelId" = EXCLUDED."imageProviderModelId",
  "imageParamsJson" = EXCLUDED."imageParamsJson", version = 13;
`;
}

/** Runs in a rolled-back transaction, so it also proves a repeated deploy.
 * Inserting a reference to a missing row raises foreign_key_violation; deleting
 * a row an ON DELETE RESTRICT key still references raises restrict_violation. */
export function publishedImageModelsProofSql(assigned: boolean): string {
  return `
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation' AND version = 13
    AND "imageProviderModelId" IS NOT DISTINCT FROM ${assigned ? "'image-adoption-model'" : "NULL"})
  THEN RAISE EXCEPTION 'image_default_or_policy_version_changed'; END IF;
  IF (SELECT count(*) FROM "PublishedImageModel") <> ${assigned ? 1 : 0}
    OR ${assigned ? `NOT EXISTS (SELECT 1 FROM "PublishedImageModel" WHERE "providerModelId" = 'image-adoption-model'
      AND "paramsJson" = '{"quality":"low"}'::jsonb)` : "false"}
  THEN RAISE EXCEPTION 'current_image_model_not_published_once_with_its_parameters'; END IF;
  IF EXISTS (SELECT 1 FROM "UserSettings" WHERE "imageProviderModelId" IS NOT NULL)
  THEN RAISE EXCEPTION 'existing_user_does_not_follow_the_default'; END IF;
  BEGIN
    UPDATE "SystemModelPolicy" SET "imageProviderModelId" = 'image-adoption-candidate' WHERE id = 'installation';
    RAISE EXCEPTION 'unpublished_default_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE "UserSettings" SET "imageProviderModelId" = 'image-adoption-candidate' WHERE "userId" = 'image-adoption-user';
    RAISE EXCEPTION 'unpublished_user_choice_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO "PublishedImageModel" ("providerModelId", "updatedAt") VALUES ('image-adoption-candidate', now());
  UPDATE "UserSettings" SET "imageProviderModelId" = 'image-adoption-candidate' WHERE "userId" = 'image-adoption-user';
  BEGIN
    DELETE FROM "PublishedImageModel" WHERE "providerModelId" = 'image-adoption-candidate';
    RAISE EXCEPTION 'chosen_model_withdrawn_without_resetting_the_choice';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  UPDATE "UserSettings" SET "imageProviderModelId" = NULL WHERE "userId" = 'image-adoption-user';
  BEGIN
    DELETE FROM "ProviderModel" WHERE id = 'image-adoption-candidate';
    RAISE EXCEPTION 'published_provider_model_deleted';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  ${assigned ? `BEGIN
    DELETE FROM "PublishedImageModel" WHERE "providerModelId" = 'image-adoption-model';
    RAISE EXCEPTION 'default_withdrawn_while_default';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;` : ""}
  DELETE FROM "PublishedImageModel" WHERE "providerModelId" = 'image-adoption-candidate';
END $$;
ROLLBACK;
`;
}
