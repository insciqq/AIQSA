/** Synthetic upgrade state; migration-contract owns the disposable database. */
export const VISION_MODEL_ROLE_MIGRATION = "20260924090000_system_vision_model_role";

export function visionModelRoleFixtureSql(assigned: boolean): string {
  return `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('vision-adoption-provider', 'Synthetic provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "updatedAt")
VALUES ('vision-adoption-images', 'vision-adoption-provider', 'fake', 'images', 'Synthetic images', '{}', '{}', now()),
  ('vision-adoption-native', 'vision-adoption-provider', 'fake', 'native', 'Synthetic native', '{}', '{}', now());
INSERT INTO "SystemModelPolicy" (id, "chatPdfProviderModelId", "chatPdfReasoningEffort",
  "chatPdfNativeProviderModelId", "chatPdfNativeReasoningEffort", "chatPdfProcessingMode", "chatPdfFallbackMethod", version, "updatedAt")
VALUES ('installation', ${assigned ? "'vision-adoption-images', 'low'" : "NULL, NULL"},
  'vision-adoption-native', 'high', 'READ_PAGE_IMAGES', 'PDF_READER', 17, now())
ON CONFLICT (id) DO UPDATE SET "chatPdfProviderModelId" = EXCLUDED."chatPdfProviderModelId",
  "chatPdfReasoningEffort" = EXCLUDED."chatPdfReasoningEffort", "chatPdfNativeProviderModelId" = EXCLUDED."chatPdfNativeProviderModelId",
  "chatPdfNativeReasoningEffort" = EXCLUDED."chatPdfNativeReasoningEffort", "chatPdfProcessingMode" = 'READ_PAGE_IMAGES',
  "chatPdfFallbackMethod" = 'PDF_READER', version = 17;
`;
}

export function visionModelRoleProofSql(assigned: boolean): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation'
    AND "visionProviderModelId" IS NOT DISTINCT FROM ${assigned ? "'vision-adoption-images'" : "NULL"}
    AND "visionReasoningEffort" IS NOT DISTINCT FROM ${assigned ? "'low'" : "NULL"}
    AND "chatPdfProviderModelId" IS NOT DISTINCT FROM ${assigned ? "'vision-adoption-images'" : "NULL"}
    AND "chatPdfReasoningEffort" IS NOT DISTINCT FROM ${assigned ? "'low'" : "NULL"}
    AND "chatPdfNativeProviderModelId" = 'vision-adoption-native' AND "chatPdfNativeReasoningEffort" = 'high'
    AND "chatPdfProcessingMode" = 'READ_PAGE_IMAGES' AND "chatPdfFallbackMethod" = 'PDF_READER' AND version = 17)
  THEN RAISE EXCEPTION 'vision_adoption_changed_configuration'; END IF;
  IF EXISTS (SELECT 1 FROM "ProviderModelCredentialCheck" WHERE "providerModelId" IN ('vision-adoption-images','vision-adoption-native'))
  THEN RAISE EXCEPTION 'vision_adoption_invented_capability'; END IF;
  BEGIN
    UPDATE "SystemModelPolicy" SET "visionProviderModelId" = NULL, "visionReasoningEffort" = 'low' WHERE id = 'installation';
    RAISE EXCEPTION 'vision_orphan_reasoning_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- A previous release writer can continue changing PDF fields alone.
UPDATE "SystemModelPolicy" SET "chatPdfProviderModelId" = 'vision-adoption-native', "chatPdfReasoningEffort" = 'high' WHERE id = 'installation';
DO $$ BEGIN
  IF (SELECT "visionProviderModelId" FROM "SystemModelPolicy" WHERE id = 'installation')
    IS DISTINCT FROM ${assigned ? "'vision-adoption-images'" : "NULL"}
  THEN RAISE EXCEPTION 'old_pdf_writer_changed_vision'; END IF;
END $$;
UPDATE "SystemModelPolicy" SET "visionProviderModelId" = NULL, "visionReasoningEffort" = NULL WHERE id = 'installation';
`;
}

export const visionModelRoleRepeatProofSql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation'
    AND "visionProviderModelId" IS NULL AND "visionReasoningEffort" IS NULL
    AND "chatPdfProviderModelId" = 'vision-adoption-native' AND "chatPdfReasoningEffort" = 'high' AND version = 17)
  THEN RAISE EXCEPTION 'vision_clear_reinherited_pdf'; END IF;
END $$;`;
