/** Synthetic predecessor state; migration-contract owns the disposable target. */
export const MEMORY_UTILITY_MODEL_MIGRATION = "20260917030000_memory_utility_model_policy";

export function memoryUtilityModelFixtureSql(assigned: boolean): string {
  return `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('memory-policy-provider', 'Synthetic provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "updatedAt")
VALUES ('memory-policy-model', 'memory-policy-provider', 'fake', 'fixture', 'Synthetic model', '{}', '{}', now());
INSERT INTO "SystemModelPolicy" (id, "providerModelId", "reasoningEffort", version, "updatedAt")
VALUES ('installation', ${assigned ? "'memory-policy-model', 'low'" : "NULL, NULL"}, 19, now())
ON CONFLICT (id) DO UPDATE SET "providerModelId" = EXCLUDED."providerModelId",
  "reasoningEffort" = EXCLUDED."reasoningEffort", version = 19;
`;
}

export function memoryUtilityModelProofSql(assigned: boolean): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryUtilityModelPolicy" m JOIN "SystemModelPolicy" s ON s.id = m.id
    WHERE m.id = 'installation' AND m."providerModelId" IS NOT DISTINCT FROM s."providerModelId"
      AND m."reasoningEffort" IS NOT DISTINCT FROM s."reasoningEffort"
      AND m."providerModelId" IS NOT DISTINCT FROM ${assigned ? "'memory-policy-model'" : "NULL"}
      AND m.version = 19 AND s.version = 19 AND m."assignmentSource" = 'INHERITED'
      AND m."createdAt" = s."createdAt" AND m."updatedAt" = s."updatedAt"
      AND m."updatedByUserId" IS NOT DISTINCT FROM s."updatedByUserId") THEN
    RAISE EXCEPTION 'memory_assignment_identity_not_preserved';
  END IF;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = 'low';
    RAISE EXCEPTION 'orphan_memory_reasoning_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = 'memory-policy-model', "assignmentSource" = 'UNASSIGNED';
    RAISE EXCEPTION 'unassigned_memory_target_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
UPDATE "MemoryUtilityModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = NULL,
  "assignmentSource" = 'OPERATOR', version = 20 WHERE id = 'installation';
-- Previous-release writers remain valid, but no longer control Memory.
UPDATE "SystemModelPolicy" SET "providerModelId" = 'memory-policy-model', "reasoningEffort" = 'high', version = 21
WHERE id = 'installation';
`;
}

export const memoryUtilityModelRepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryUtilityModelPolicy" WHERE id = 'installation'
    AND "providerModelId" IS NULL AND "reasoningEffort" IS NULL AND version = 20 AND "assignmentSource" = 'OPERATOR')
    OR NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation'
      AND "providerModelId" = 'memory-policy-model' AND "reasoningEffort" = 'high' AND version = 21) THEN
    RAISE EXCEPTION 'explicit_memory_clear_overwritten';
  END IF;
END $$;
`;
