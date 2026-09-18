export const CHAT_TITLE_SETUP_MIGRATION = "20260918093000_chat_title_setup_adoption";

export const chatTitleSetupFixtureSql = `
UPDATE "SystemModelPolicy" SET "chatTitleProviderModelId" = NULL,
  "chatTitleReasoningEffort" = NULL, version = 17 WHERE id = 'installation';
`;

export const chatTitleSetupProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SystemModelPolicy" WHERE id = 'installation'
    AND "chatTitleProviderModelId" IS NULL AND "chatTitleReasoningEffort" IS NULL
    AND "chatTitleConfiguredAt" IS NOT NULL AND version = 17) THEN
    RAISE EXCEPTION 'previous_title_clear_not_preserved';
  END IF;
END $$;
`;
