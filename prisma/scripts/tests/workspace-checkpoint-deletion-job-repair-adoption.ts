/** Synthetic prior-release state; the migration contract owns the disposable target. */
export const WORKSPACE_CHECKPOINT_DELETION_JOB_REPAIR_MIGRATION = "20261002120000_workspace_checkpoint_deletion_job_repair";

const RUN = "checkpoint-job-repair-run";
const CHECKPOINT_CAPTURE = "c".repeat(32);
const CAPTURE_ONLY = "d".repeat(32);
const K1 = `workspace-captures/${CHECKPOINT_CAPTURE}/file-a/attempt-1`;
const K2 = `workspace-captures/${CHECKPOINT_CAPTURE}/file-b/attempt-1`;
const K3 = `workspace-captures/${CAPTURE_ONLY}/file-c/attempt-1`;
const K4 = "uploads/checkpoint-job-repair-user/upload";
const selection = (files: readonly string[]) => JSON.stringify({
  files: files.map(relativePath => ({ root: "project", relativePath })),
  producerOperation: { generation: 1, owner: `run:${RUN}` }
});
const nonJobRows = `
SELECT 'attachment' AS source, to_jsonb(a) AS snapshot FROM "Attachment" a WHERE a."userId" = 'checkpoint-job-repair-user'
UNION ALL SELECT 'checkpoint', to_jsonb(c) FROM "WorkspaceOutputCheckpoint" c WHERE c."modelRunId" = '${RUN}'
UNION ALL SELECT 'checkpoint-file', to_jsonb(f) FROM "WorkspaceCheckpointFile" f WHERE f."captureId" IN ('${CHECKPOINT_CAPTURE}', '${CAPTURE_ONLY}')
UNION ALL SELECT 'capture', to_jsonb(s) FROM "WorkspaceSelectedCapture" s WHERE s."modelRunId" = '${RUN}'
UNION ALL SELECT 'captured-file', to_jsonb(f) FROM "WorkspaceCapturedFile" f WHERE f."captureId" IN ('${CHECKPOINT_CAPTURE}', '${CAPTURE_ONLY}')
UNION ALL SELECT 'reference', to_jsonb(r) FROM "WorkspaceCaptureReference" r WHERE r."consumerRunId" = '${RUN}'
UNION ALL SELECT 'tool-call', to_jsonb(t) FROM "ModelRunToolCall" t WHERE t."modelRunId" = '${RUN}'
UNION ALL SELECT 'run', to_jsonb(r) - ARRAY['scheduledTaskId', 'scheduledOccurrenceId', 'scheduledTaskGeneration'] FROM "ModelRun" r WHERE r."id" = '${RUN}'`;

/** One published two-file checkpoint (K1 unclaimed, K2 claimed job), one
 * capture-only key (K3) and one ordinary upload (K4), each with a job. */
export const workspaceCheckpointDeletionJobRepairFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('checkpoint-job-repair-user', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('checkpoint-job-repair-chat', 'checkpoint-job-repair-user', 'Synthetic checkpoint', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('checkpoint-job-repair-question', 'checkpoint-job-repair-chat', 'user', '{}', now());
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, "updatedAt")
VALUES ('checkpoint-job-repair-answer', 'checkpoint-job-repair-chat', 'assistant', 'checkpoint-job-repair-question', '{}', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", "normalizedRequest", status, "updatedAt")
VALUES ('${RUN}', 'checkpoint-job-repair-chat', 'checkpoint-job-repair-user', 'checkpoint-job-repair-question', 'checkpoint-job-repair-answer', 'fake', 'fake', '{}', 'in_progress', now());
INSERT INTO "WorkspaceSession" (id, "chatId", "sandboxName", "runtimeSandboxId", "imageRef", "internetEnabled", "policyRevision", "expiresAt", "updatedAt")
VALUES ('checkpoint-job-repair-session', 'checkpoint-job-repair-chat', 'aiqsa-ws-checkpoint-job-repair', 'synthetic-disk', 'synthetic-image', false, 1, now() + interval '1 hour', now());
INSERT INTO "WorkspaceRunBinding" ("modelRunId", "workspaceSessionId", "imageRef", "internetEnabled", "policyRevision", "runtimeVersion", "mcpVersion", "toolCatalogHash", "toolDefinitions", "outputDirectory", "updatedAt")
VALUES ('${RUN}', 'checkpoint-job-repair-session', 'synthetic-image', false, 1, 'synthetic', 'synthetic', repeat('a',64), '[{}]', '/workspace/output/${RUN}', now());
INSERT INTO "WorkspaceSelectedCapture" (id, "modelRunId", "workspaceSessionId", "runtimeSandboxId", "requestKey", "requestHash", "producerGeneration", "producerOwner", selection)
VALUES ('${CHECKPOINT_CAPTURE}', '${RUN}', 'checkpoint-job-repair-session', 'synthetic-disk', 'checkpoint-job-repair-tool', repeat('a',64), 1, 'run:${RUN}', '${selection(["a.txt", "b.txt"])}'),
  ('${CAPTURE_ONLY}', '${RUN}', 'checkpoint-job-repair-session', 'synthetic-disk', 'capture-only', repeat('a',64), 1, 'run:${RUN}', '${selection(["c.txt"])}');
INSERT INTO "WorkspaceCaptureReference" ("captureId", "consumerRunId", "consumerKey")
VALUES ('${CHECKPOINT_CAPTURE}', '${RUN}', 'checkpoint-job-repair-tool'), ('${CAPTURE_ONLY}', '${RUN}', 'capture-only');
INSERT INTO "WorkspaceCapturedFile" (id, "captureId", "relativePath", "byteSize", checksum, "mimeType", "storageKey", "storageState")
VALUES ('file-a', '${CHECKPOINT_CAPTURE}', 'project/a.txt', 1, repeat('1',64), 'text/plain', '${K1}', 'READY'),
  ('file-b', '${CHECKPOINT_CAPTURE}', 'project/b.txt', 2, repeat('2',64), 'text/plain', '${K2}', 'READY'),
  ('file-c', '${CAPTURE_ONLY}', 'project/c.txt', 3, repeat('3',64), 'text/plain', '${K3}', 'READY');
UPDATE "WorkspaceSelectedCapture" SET state = 'CAPTURED', "sealedAt" = now() WHERE "modelRunId" = '${RUN}';
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, "updatedAt")
VALUES ('checkpoint-job-repair-tool', '${RUN}', 1, 0, 'synthetic-call', 'checkpoint_outputs', '{}', 'running', now());
INSERT INTO "WorkspaceOutputCheckpoint" (id, "modelRunId", "toolCallId", "requestHash", description, selection, arguments, "captureId")
VALUES ('checkpoint-job-repair-row', '${RUN}', 'checkpoint-job-repair-tool', repeat('a',64), 'Synthetic draft',
  '[{"root":"project","relativePath":"a.txt"},{"root":"project","relativePath":"b.txt"}]', '{}', '${CHECKPOINT_CAPTURE}');
INSERT INTO "Attachment" (id, "userId", "chatId", "messageId", "producerModelRunId", kind, "mimeType", "fileName", "storageKey", checksum, status, origin, "byteSize", metadata, "updatedAt")
VALUES ('checkpoint-job-repair-a', 'checkpoint-job-repair-user', 'checkpoint-job-repair-chat', 'checkpoint-job-repair-answer', '${RUN}', 'file', 'text/plain', 'a.txt', '${K1}', repeat('1',64), 'ready', 'WORKSPACE_OUTPUT', 1, '{}', now()),
  ('checkpoint-job-repair-b', 'checkpoint-job-repair-user', 'checkpoint-job-repair-chat', 'checkpoint-job-repair-answer', '${RUN}', 'file', 'text/plain', 'b.txt', '${K2}', repeat('2',64), 'ready', 'WORKSPACE_OUTPUT', 2, '{}', now()),
  ('checkpoint-job-repair-upload', 'checkpoint-job-repair-user', NULL, NULL, NULL, 'file', 'text/plain', 'upload.txt', '${K4}', repeat('4',64), 'ready', 'USER_UPLOAD', 4, '{}', now());
INSERT INTO "WorkspaceCheckpointFile" ("checkpointId", "captureId", "relativePath", "attachmentId")
VALUES ('checkpoint-job-repair-row', '${CHECKPOINT_CAPTURE}', 'project/a.txt', 'checkpoint-job-repair-a'),
  ('checkpoint-job-repair-row', '${CHECKPOINT_CAPTURE}', 'project/b.txt', 'checkpoint-job-repair-b');
UPDATE "WorkspaceOutputCheckpoint" SET state = 'SETTLED', result = '{}', "settledAt" = now() WHERE id = 'checkpoint-job-repair-row';
INSERT INTO "AttachmentDeletionJob" (id, "storageKey", "claimToken", "claimedAt", "updatedAt")
VALUES ('checkpoint-job-repair-k1', '${K1}', NULL, NULL, now()),
  ('checkpoint-job-repair-k2', '${K2}', 'synthetic-claim', now(), now()),
  ('checkpoint-job-repair-k3', '${K3}', NULL, NULL, now()),
  ('checkpoint-job-repair-k4', '${K4}', NULL, NULL, now());
CREATE TABLE "_CheckpointJobRepairKeptJobs" AS
SELECT to_jsonb(job) AS snapshot FROM "AttachmentDeletionJob" job WHERE job."storageKey" <> '${K1}';
CREATE TABLE "_CheckpointJobRepairRows" AS ${nonJobRows};
`;

const jobSetEquals = (table: string, failure: string) => `
  IF EXISTS (SELECT snapshot FROM "${table}" EXCEPT SELECT to_jsonb(job) FROM "AttachmentDeletionJob" job)
    OR EXISTS (SELECT to_jsonb(job) FROM "AttachmentDeletionJob" job EXCEPT SELECT snapshot FROM "${table}")
    THEN RAISE EXCEPTION '${failure}'; END IF;`;

export const workspaceCheckpointDeletionJobRepairProofSql = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "AttachmentDeletionJob" WHERE "storageKey" = '${K1}')
    THEN RAISE EXCEPTION 'checkpoint_job_repair_kept_inert_job'; END IF;
  ${jobSetEquals("_CheckpointJobRepairKeptJobs", "checkpoint_job_repair_changed_other_jobs")}
  IF EXISTS (SELECT source, snapshot FROM "_CheckpointJobRepairRows" EXCEPT (${nonJobRows}))
    OR EXISTS ((${nonJobRows}) EXCEPT SELECT source, snapshot FROM "_CheckpointJobRepairRows")
    THEN RAISE EXCEPTION 'checkpoint_job_repair_changed_rows'; END IF;
END $$;
-- A capture-only key keeps its cascade-backed cleanup obligation.
DELETE FROM "AttachmentDeletionJob" WHERE "storageKey" = '${K3}';
DELETE FROM "WorkspaceSelectedCapture" WHERE id = '${CAPTURE_ONLY}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AttachmentDeletionJob" WHERE "storageKey" = '${K3}' AND "claimToken" IS NULL AND "claimedAt" IS NULL)
    THEN RAISE EXCEPTION 'checkpoint_job_repair_capture_only_unstaged'; END IF;
END $$;
-- A key still held by an Attachment stages nothing; the claimed job remains.
DELETE FROM "WorkspaceSelectedCapture" WHERE id = '${CHECKPOINT_CAPTURE}';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "AttachmentDeletionJob" WHERE "storageKey" = '${K1}')
    THEN RAISE EXCEPTION 'checkpoint_job_repair_staged_referenced_key'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "_CheckpointJobRepairKeptJobs" kept JOIN "AttachmentDeletionJob" job ON job."storageKey" = '${K2}'
    WHERE kept.snapshot->>'storageKey' = '${K2}' AND kept.snapshot = to_jsonb(job))
    THEN RAISE EXCEPTION 'checkpoint_job_repair_changed_claimed_job'; END IF;
  IF (SELECT count(*) FROM "Attachment" WHERE "storageKey" IN ('${K1}', '${K2}')) <> 2
    THEN RAISE EXCEPTION 'checkpoint_job_repair_removed_attachment'; END IF;
END $$;
CREATE TABLE "_CheckpointJobRepairEndJobs" AS SELECT to_jsonb(job) AS snapshot FROM "AttachmentDeletionJob" job;
`;

export const workspaceCheckpointDeletionJobRepairRepeatProofSql = `
DO $$ BEGIN
  ${jobSetEquals("_CheckpointJobRepairEndJobs", "checkpoint_job_repair_not_idempotent")}
END $$;
DROP TABLE "_CheckpointJobRepairKeptJobs";
DROP TABLE "_CheckpointJobRepairRows";
DROP TABLE "_CheckpointJobRepairEndJobs";
`;
