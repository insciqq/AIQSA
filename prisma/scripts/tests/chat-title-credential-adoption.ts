/** Existing optional jobs in the migration runner's owned disposable DB. */
export const CHAT_TITLE_CREDENTIAL_MIGRATION = "20260911233000_chat_title_credential_retention";

const cases = ["pending", "dispatched", "settled", "missing"];

export const chatTitleCredentialAdoptionFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('title-key-owner', 'Synthetic title owner', 'active', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('title-key-connection', 'Synthetic titles', 'openai_compatible', now());
INSERT INTO "ProviderCredential" (id, "connectionId", label, "updatedAt")
VALUES ('title-key-credential', 'title-key-connection', 'Synthetic key', now());
INSERT INTO "ProviderCredentialVersion" (id, "credentialId", version, "testEvidence", "testedAt", "activatedAt")
VALUES ('title-key-version', 'title-key-credential', 1, '{"authenticationMode":"none"}', now(), now());
${cases.map((name) => `
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('title-key-${name}', 'title-key-owner', 'Synthetic question', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('title-key-message-${name}', 'title-key-${name}', 'user', '{}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('title-key-run-${name}', 'title-key-owner', 'title-key-${name}', 'title-key-message-${name}', 'fake', 'fake-model', 'complete', '{}', now());
INSERT INTO "ChatTitleGeneration" ("runId", "chatId", "userId", "expectedTitle", "titleRevision", "questionText", "answerText", "providerSnapshot", status, "expiresAt")
VALUES ('title-key-run-${name}', 'title-key-${name}', 'title-key-owner', 'Synthetic question', 0, 'Synthetic question', 'Synthetic answer',
  '{"credentialId":"title-key-credential","credentialVersionId":"${name === "missing" ? "already-removed" : "title-key-version"}"}',
  '${name === "missing" ? "pending" : name}', now() + interval '5 minutes');
`).join("\n")}
`;

export const chatTitleCredentialAdoptionProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ChatTitleGeneration" WHERE "runId" IN ('title-key-run-pending', 'title-key-run-dispatched')
      AND "credentialVersionId" = 'title-key-version') <> 2
    THEN RAISE EXCEPTION 'title_accepted_key_not_retained'; END IF;
  IF EXISTS (SELECT 1 FROM "ChatTitleGeneration" WHERE "runId" IN ('title-key-run-settled', 'title-key-run-missing')
      AND "credentialVersionId" IS NOT NULL)
    THEN RAISE EXCEPTION 'title_terminal_or_missing_key_rebound'; END IF;
  BEGIN
    DELETE FROM "ProviderCredentialVersion" WHERE id = 'title-key-version';
    RAISE EXCEPTION 'title_accepted_key_deleted';
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL;
  END;
END $$;
-- The previous app clears the snapshot and status without knowing the new column.
UPDATE "ChatTitleGeneration" SET status = 'skipped', "providerSnapshot" = NULL,
  "questionText" = '', "answerText" = '', "expectedTitle" = ''
WHERE "runId" = 'title-key-run-pending';
UPDATE "ChatTitleGeneration" SET status = 'ambiguous', "providerSnapshot" = NULL,
  "questionText" = '', "answerText" = '', "expectedTitle" = ''
WHERE "runId" = 'title-key-run-dispatched';
DELETE FROM "ProviderCredentialVersion" WHERE id = 'title-key-version';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ChatTitleGeneration" WHERE "userId" = 'title-key-owner' AND "credentialVersionId" IS NOT NULL)
    THEN RAISE EXCEPTION 'title_terminal_key_not_released'; END IF;
END $$;
`;
