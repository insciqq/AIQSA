export const WORKSPACE_RUN_ATTACHMENTS_MIGRATION = "20261030010000_workspace_run_attachments";

const session = (id: string, chat: string, owner: string | null, version: number) =>
  `INSERT INTO "WorkspaceSession" (id, "chatId", "sandboxName", "runtimeSandboxId", "imageRef", "internetEnabled", "policyRevision",
     "expiresAt", "updatedAt", version, "operationOwner", state)
   VALUES ('${id}', '${chat}', 'aiqsa-ws-${id}', 'synthetic-disk', 'synthetic-image', false, 1, now() + interval '1 hour', now(), ${version},
     ${owner === null ? "NULL" : `'${owner}'`}, 'RUNNING');`;

/**
 * Before the upgrade: a session a run owns mid-turn (the single owner of earlier releases), one an export owns, an idle
 * one, and one whose owner names a run of another chat (never written by the application; it must not be adopted).
 */
export const workspaceRunAttachmentsFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('attach-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES
  ('attach-chat', 'attach-owner', 'Synthetic chat', now()),
  ('attach-export-chat', 'attach-owner', 'Synthetic chat', now()),
  ('attach-idle-chat', 'attach-owner', 'Synthetic chat', now()),
  ('attach-foreign-chat', 'attach-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('attach-question', 'attach-chat', 'user', '{"blocks":[{"type":"text","text":"Synthetic question"}]}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('attach-run', 'attach-owner', 'attach-chat', 'attach-question', 'fake', 'fake-qsa', 'streaming', '{}', now());
${session("attach-session", "attach-chat", "run:attach-run", 4)}
${session("attach-export-session", "attach-export-chat", "export:attach-run:token", 2)}
${session("attach-idle-session", "attach-idle-chat", null, 1)}
${session("attach-foreign-session", "attach-foreign-chat", "run:attach-run", 3)}
CREATE TABLE "_WorkspaceRunAttachmentsFixture" AS SELECT id, to_jsonb(s) AS session FROM "WorkspaceSession" s WHERE id LIKE 'attach-%';
`;

/**
 * The run that owned its session is attached under the generation it held; no other session gets a row; no session
 * row changes. A previous-release writer keeps claiming sessions by owner alone during the upgrade, and a run's
 * deletion takes its attachment.
 */
export const workspaceRunAttachmentsProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "WorkspaceRunAttachment") <> 1 OR NOT EXISTS (SELECT 1 FROM "WorkspaceRunAttachment"
      WHERE "modelRunId" = 'attach-run' AND "chatId" = 'attach-chat' AND "operationGeneration" = 4)
    THEN RAISE EXCEPTION 'workspace_run_attachments_owner_not_adopted'; END IF;
  IF EXISTS (SELECT 1 FROM "_WorkspaceRunAttachmentsFixture" f
      LEFT JOIN "WorkspaceSession" s ON s.id = f.id WHERE s.id IS NULL OR to_jsonb(s) <> f.session)
    THEN RAISE EXCEPTION 'workspace_run_attachments_changed_session'; END IF;
END $$;
BEGIN;
UPDATE "WorkspaceSession" SET "operationOwner" = NULL, state = 'STOPPED' WHERE id = 'attach-idle-session';
UPDATE "WorkspaceSession" SET "operationOwner" = 'run:attach-run', version = version + 1 WHERE id = 'attach-idle-session';
DELETE FROM "ModelRun" WHERE id = 'attach-run';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "WorkspaceRunAttachment")
    THEN RAISE EXCEPTION 'workspace_run_attachments_outlived_run'; END IF;
END $$;
ROLLBACK;
`;
