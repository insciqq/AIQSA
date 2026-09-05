/** Synthetic predecessor state; callers guard and own the disposable database. */
export const SYSTEM_MODEL_ROLES_MIGRATION = "20260905080000_independent_system_model_roles";

export function systemModelRolesAdoptionFixtureSql(pdfAllowed: boolean): string {
  return `
BEGIN;
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('roles-adoption-provider', 'Fixture provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "updatedAt")
VALUES ('roles-adoption-memory', 'roles-adoption-provider', 'fake', 'fixture', 'Fixture model', '{}', '{}', now()),
  ('roles-adoption-reranker', 'roles-adoption-provider', 'fake', 'fixture-rank', 'Fixture ranker', '{}', '{}', now());
INSERT INTO "SystemModelPolicy" (id, "providerModelId", "reasoningEffort", "rerankerProviderModelId", "chatPdfPreparationAllowed", version, "updatedAt")
VALUES ('installation', 'roles-adoption-memory', 'low', 'roles-adoption-reranker', ${pdfAllowed}, 7, now())
ON CONFLICT (id) DO UPDATE SET "providerModelId" = EXCLUDED."providerModelId", "reasoningEffort" = EXCLUDED."reasoningEffort",
  "rerankerProviderModelId" = EXCLUDED."rerankerProviderModelId", "chatPdfPreparationAllowed" = EXCLUDED."chatPdfPreparationAllowed", version = 7;
COMMIT;
`;
}

export function systemModelRolesAdoptionProofSql(pdfAllowed: boolean): string {
  return `
BEGIN;
DO $$
DECLARE policy "SystemModelPolicy"; definition text;
BEGIN
  SELECT * INTO STRICT policy FROM "SystemModelPolicy" WHERE id = 'installation';
  IF policy."providerModelId" IS DISTINCT FROM 'roles-adoption-memory' OR policy."reasoningEffort" IS DISTINCT FROM 'low'
    OR policy."rerankerProviderModelId" IS DISTINCT FROM 'roles-adoption-reranker' OR policy.version <> 7
    OR policy."chatPdfPreparationAllowed" IS DISTINCT FROM ${pdfAllowed} THEN
    RAISE EXCEPTION 'unrelated_role_changed';
  END IF;
  IF policy."chatPdfProviderModelId" IS DISTINCT FROM ${pdfAllowed ? "'roles-adoption-memory'" : "NULL"}
    OR policy."chatPdfReasoningEffort" IS DISTINCT FROM ${pdfAllowed ? "'low'" : "NULL"} THEN
    RAISE EXCEPTION 'explicit_pdf_permission_not_preserved';
  END IF;
  definition := pg_get_functiondef('chat_pdf_preparation_guard()'::regprocedure);
  IF position('p."chatPdfProviderModelId" = NEW."providerModelId"' IN definition) = 0
    OR position('p."providerModelId" = NEW."providerModelId"' IN definition) <> 0 THEN
    RAISE EXCEPTION 'pdf_guard_still_borrows_memory';
  END IF;
  UPDATE "SystemModelPolicy" SET "providerModelId" = NULL, "reasoningEffort" = NULL WHERE id = 'installation';
  IF (SELECT "chatPdfProviderModelId" FROM "SystemModelPolicy" WHERE id = 'installation')
    IS DISTINCT FROM policy."chatPdfProviderModelId" THEN RAISE EXCEPTION 'memory_clear_changed_pdf'; END IF;
  BEGIN
    UPDATE "SystemModelPolicy" SET "chatPdfProviderModelId" = NULL, "chatPdfReasoningEffort" = 'low' WHERE id = 'installation';
    RAISE EXCEPTION 'orphan_pdf_reasoning_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
`;
}
