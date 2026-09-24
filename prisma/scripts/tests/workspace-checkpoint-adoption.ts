import { workspaceSelectedCaptureFixtureSql } from "./workspace-selected-capture-adoption";

export const WORKSPACE_CHECKPOINT_MIGRATION = "20260924120000_workspace_output_checkpoints";
export const workspaceCheckpointFixtureSql = workspaceSelectedCaptureFixtureSql.replaceAll("capture-adoption", "checkpoint-adoption");
export const workspaceCheckpointProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_WorkspaceCaptureUpgradeFixture" f
    JOIN "WorkspaceRunBinding" b ON b."modelRunId" = 'checkpoint-adoption-run'
    JOIN "WorkspaceSession" s ON s.id = b."workspaceSessionId" WHERE f.binding = to_jsonb(b) AND f.session = to_jsonb(s))
    THEN RAISE EXCEPTION 'checkpoint_upgrade_changed_legacy_export'; END IF;
  IF EXISTS (SELECT 1 FROM "WorkspaceOutputCheckpoint") OR EXISTS (SELECT 1 FROM "WorkspaceCheckpointFile")
    THEN RAISE EXCEPTION 'checkpoint_upgrade_invented_publication'; END IF;
END $$;
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, "updatedAt")
VALUES ('checkpoint-adoption-tool', 'checkpoint-adoption-run', 1, 0, 'synthetic-call', 'checkpoint_outputs', '{}', 'running', now());
INSERT INTO "WorkspaceOutputCheckpoint" (id, "modelRunId", "toolCallId", "requestHash", description, selection, arguments)
VALUES ('checkpoint-adoption-row', 'checkpoint-adoption-run', 'checkpoint-adoption-tool', repeat('a',64), 'Synthetic draft', '[{"root":"project","relativePath":"draft.txt"}]', '{}');
DO $$ BEGIN
  BEGIN
    UPDATE "WorkspaceOutputCheckpoint" SET "requestHash" = repeat('b',64) WHERE id = 'checkpoint-adoption-row';
    RAISE EXCEPTION 'checkpoint_request_mutable';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE "WorkspaceOutputCheckpoint" SET state = 'SETTLED', result = '{}', "settledAt" = now() WHERE id = 'checkpoint-adoption-row';
    RAISE EXCEPTION 'checkpoint_missing_bytes_published';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE "WorkspaceRunBinding" SET "exportAttemptCount" = 1 WHERE "modelRunId" = 'checkpoint-adoption-run';
DROP TABLE "_WorkspaceCaptureUpgradeFixture";
`;
