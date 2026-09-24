/** Synthetic prior-release state; the migration contract owns the disposable target. */
export const WORKSPACE_SELECTED_CAPTURE_MIGRATION = "20260924100000_workspace_selected_capture";

export const workspaceSelectedCaptureFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('capture-adoption-user', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('capture-adoption-chat', 'capture-adoption-user', 'Synthetic capture', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('capture-adoption-message', 'capture-adoption-chat', 'user', '{}', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", provider, "modelId", "normalizedRequest", status, "updatedAt")
VALUES ('capture-adoption-run', 'capture-adoption-chat', 'capture-adoption-user', 'capture-adoption-message', 'fake', 'fake', '{}', 'in_progress', now());
INSERT INTO "WorkspaceSession" (id, "chatId", "sandboxName", "runtimeSandboxId", "imageRef", "internetEnabled", "policyRevision", "expiresAt", "updatedAt")
VALUES ('capture-adoption-session', 'capture-adoption-chat', 'aiqsa-ws-capture-adoption', 'synthetic-disk', 'synthetic-image', false, 1, now() + interval '1 hour', now());
INSERT INTO "WorkspaceRunBinding" ("modelRunId", "workspaceSessionId", "imageRef", "internetEnabled", "policyRevision", "runtimeVersion", "mcpVersion", "toolCatalogHash", "toolDefinitions", "outputDirectory", "updatedAt")
VALUES ('capture-adoption-run', 'capture-adoption-session', 'synthetic-image', false, 1, 'synthetic', 'synthetic', repeat('a',64), '[{}]', '/workspace/output/capture-adoption-run', now());
CREATE TABLE "_WorkspaceCaptureUpgradeFixture" AS
SELECT to_jsonb(binding) AS binding, to_jsonb(session) AS session
FROM "WorkspaceRunBinding" binding JOIN "WorkspaceSession" session ON session.id = binding."workspaceSessionId"
WHERE binding."modelRunId" = 'capture-adoption-run';
`;

export const workspaceSelectedCaptureProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "_WorkspaceCaptureUpgradeFixture" fixture
    JOIN "WorkspaceRunBinding" binding ON binding."modelRunId" = 'capture-adoption-run'
    JOIN "WorkspaceSession" session ON session.id = binding."workspaceSessionId"
    WHERE fixture.binding = to_jsonb(binding) AND fixture.session = to_jsonb(session)
  ) THEN RAISE EXCEPTION 'capture_upgrade_changed_existing_workspace'; END IF;
  IF EXISTS (SELECT 1 FROM "WorkspaceSelectedCapture")
    THEN RAISE EXCEPTION 'capture_upgrade_invented_evidence'; END IF;
  BEGIN
    INSERT INTO "WorkspaceSelectedCapture" (id, "modelRunId", "workspaceSessionId", "runtimeSandboxId", "requestKey", "requestHash", "producerGeneration", "producerOwner", selection)
    VALUES (repeat('b',32), 'capture-adoption-run', 'capture-adoption-session', 'synthetic-disk', 'invalid', repeat('a',64), 1, 'run:capture-adoption-run', '{}');
    RAISE EXCEPTION 'capture_missing_selection_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- Previous-release writers need neither a capture nor a new required field.
UPDATE "WorkspaceRunBinding" SET "exportAttemptCount" = 1 WHERE "modelRunId" = 'capture-adoption-run';
INSERT INTO "WorkspaceSelectedCapture" (id, "modelRunId", "workspaceSessionId", "runtimeSandboxId", "requestKey", "requestHash", "producerGeneration", "producerOwner", selection)
VALUES (repeat('a',32), 'capture-adoption-run', 'capture-adoption-session', 'synthetic-disk', 'valid', repeat('a',64), 1, 'run:capture-adoption-run',
  '{"files":[{"root":"project","relativePath":"fixture.txt"}],"producerOperation":{"generation":1,"owner":"run:capture-adoption-run"}}');
DO $$ BEGIN
  BEGIN
    UPDATE "WorkspaceSelectedCapture" SET state = 'CAPTURED', "sealedAt" = now() WHERE id = repeat('a',32);
    RAISE EXCEPTION 'capture_incomplete_manifest_sealed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "WorkspaceCapturedFile" (id, "captureId", "relativePath", "byteSize", checksum, "mimeType")
    VALUES ('capture-adoption-unselected', repeat('a',32), 'project/unselected.txt', 1, repeat('a',64), 'text/plain');
    RAISE EXCEPTION 'capture_unselected_file_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO "WorkspaceCapturedFile" (id, "captureId", "relativePath", "byteSize", checksum, "mimeType")
VALUES ('capture-adoption-file', repeat('a',32), 'project/fixture.txt', 1, repeat('a',64), 'text/plain');
UPDATE "WorkspaceSelectedCapture" SET state = 'CAPTURED', "sealedAt" = now() WHERE id = repeat('a',32);
DO $$ BEGIN
  BEGIN
    UPDATE "WorkspaceCapturedFile" SET checksum = repeat('b',64) WHERE id = 'capture-adoption-file';
    RAISE EXCEPTION 'capture_bytes_identity_mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DROP TABLE "_WorkspaceCaptureUpgradeFixture";
`;
