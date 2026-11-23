-- What the removed Projects left in the tables that stay goes in v0.5.1. Projects were removed with their data
-- (operator decisions 2026-10-23); `20261025092000_drop_projects_knowledge` dropped their tables but kept the
-- always-null Project columns of chats, messages, files, uploads, shares and usage, and a chat, file or share a missed
-- retirement left behind kept no owner and was never shown again. Nothing in this release reads or writes any of it.
-- The previous release's full-row reads of these tables name the dropped columns, so, as for v0.5.0, the production
-- rollout stops the previous release's app and worker before migrating (`agent_docs/PERSISTENCE.md`).
--
-- Rows without an owner, all of them Project leftovers (each owner check allowed a missing owner only beside a
-- Project):
-- - A share without an owner was revoked by `20261023210000_retire_projects`; it goes.
-- - A chat without an owner goes with its messages, runs and everything they hold in the database, in the order
--   ordinary chat deletion takes them (`lib/server/chats/aggregateDeletion.ts`): the scheduled occurrences' links,
--   the runs, then the chat. Usage keeps its rows.
-- - Stored objects nobody owns have no deletion path, and this migration builds none: a file without an owner
--   anywhere, or a chat without an owner that still holds a file, a Workspace or a stored tool result, refuses the
--   whole migration with content-free counts, and nothing changes. Both production installations held none (checked
--   read-only on 2026-11-23). An installation that does must remove those rows and their objects by hand, or restore
--   the backup taken before the upgrade, before it deploys again. A Workspace copy a continuation made for such a chat
--   is queued for object deletion by the chat's own deletion trigger, as for any chat.
-- - An upload a Project started that is still open ends now, as the upload cleanup ended it, and is cleaned up as
--   before.
--
-- Then the columns go: the Project ownership and attribution of chats, messages, files, uploads, shares and usage,
-- the Project memory of folders, and the ProjectRole type. A chat has an owner from now on (`Chat.userId` NOT NULL);
-- the owner checks of files and shares, and every check and routine that named a dropped column, keep only their
-- personal branch and are otherwise unchanged.
--
-- Every lock is taken up front in a fixed order, the tables that stay first, and a deadlock retries instead of failing
-- the upgrade. Columns go without a rewrite; the owner column and each re-added check read their table once.

DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "User", "Folder", "Chat", "Message", "ModelRun", "ScheduledTaskOccurrence", "Attachment",
        "AttachmentUpload", "SharedChatSnapshot", "UsageEvent" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

CREATE TEMPORARY TABLE "aiqsa_ownerless_chat" ("id" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "aiqsa_ownerless_chat" ("id") SELECT "id" FROM "Chat" WHERE "userId" IS NULL;
CREATE TEMPORARY TABLE "aiqsa_ownerless_run" ("id" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "aiqsa_ownerless_run" ("id")
SELECT run."id" FROM "ModelRun" AS run JOIN "aiqsa_ownerless_chat" AS chat ON chat."id" = run."chatId";

-- Stored objects nobody owns refuse the migration before anything changes.
DO $migration$
DECLARE
  chats bigint;
  files bigint;
  workspaces bigint;
  tool_results bigint;
BEGIN
  SELECT count(*) INTO chats FROM "aiqsa_ownerless_chat";
  SELECT count(*) INTO files FROM "Attachment" AS attachment
  WHERE attachment."userId" IS NULL
    OR attachment."chatId" IN (SELECT "id" FROM "aiqsa_ownerless_chat")
    OR attachment."producerModelRunId" IN (SELECT "id" FROM "aiqsa_ownerless_run");
  SELECT count(*) INTO workspaces FROM "WorkspaceSession"
  WHERE "chatId" IN (SELECT "id" FROM "aiqsa_ownerless_chat");
  SELECT count(*) INTO tool_results FROM "ToolObservation"
  WHERE "modelRunId" IN (SELECT "id" FROM "aiqsa_ownerless_run") AND "storageKey" IS NOT NULL;
  IF files + workspaces + tool_results > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('project_leftovers_hold_objects chats_without_owner=%s files=%s workspaces=%s tool_results=%s',
        chats, files, workspaces, tool_results),
      HINT = 'Rows removed Projects left without an owner still hold stored objects. Remove them and their objects, '
        || 'or restore the backup taken before the upgrade, then deploy again (see this migration''s header).';
  END IF;
END;
$migration$;

-- Content-free counts of what goes, for the operator of an installation whose data nobody inspected.
DO $migration$
DECLARE
  chats bigint;
  shares bigint;
  uploads bigint;
BEGIN
  SELECT count(*) INTO chats FROM "aiqsa_ownerless_chat";
  SELECT count(*) INTO shares FROM "SharedChatSnapshot" WHERE "ownerUserId" IS NULL;
  SELECT count(*) INTO uploads FROM "AttachmentUpload"
  WHERE "state" IN ('uploading', 'verifying') AND ("projectScoped" OR "projectId" IS NOT NULL);
  IF chats > 0 OR shares > 0 OR uploads > 0 THEN
    RAISE WARNING 'project_leftovers_removed chats=% shares=% uploads_ended=%', chats, shares, uploads;
  END IF;
END;
$migration$;

DELETE FROM "SharedChatSnapshot" WHERE "ownerUserId" IS NULL;

-- Occurrence history outlives the chat with its run and message links cleared, in one statement before any run goes,
-- as chat deletion clears them (`detachScheduledTaskOccurrences`). No occurrence can name a chat without an owner: its
-- chat key carries the owner.
UPDATE "ScheduledTaskOccurrence" AS occurrence
SET
  "runId" = CASE WHEN occurrence."runId" IN (SELECT "id" FROM "aiqsa_ownerless_run") THEN NULL ELSE occurrence."runId" END,
  "userMessageId" = CASE WHEN occurrence."userMessageId" IN (
      SELECT message."id" FROM "Message" AS message JOIN "aiqsa_ownerless_chat" AS chat ON chat."id" = message."chatId"
    ) THEN NULL ELSE occurrence."userMessageId" END
WHERE occurrence."runId" IN (SELECT "id" FROM "aiqsa_ownerless_run")
  OR occurrence."userMessageId" IN (
    SELECT message."id" FROM "Message" AS message JOIN "aiqsa_ownerless_chat" AS chat ON chat."id" = message."chatId"
  );

DELETE FROM "ModelRun" WHERE "id" IN (SELECT "id" FROM "aiqsa_ownerless_run");
DELETE FROM "Chat" WHERE "id" IN (SELECT "id" FROM "aiqsa_ownerless_chat");

UPDATE "AttachmentUpload" SET "state" = 'expired', "updatedAt" = CURRENT_TIMESTAMP
WHERE "state" IN ('uploading', 'verifying') AND ("projectScoped" OR "projectId" IS NOT NULL);

-- The deletions' deferred checks run now, so no trigger event is pending when the tables change below.
SET CONSTRAINTS ALL IMMEDIATE;

-- Routines that named a dropped column keep only their personal branch; otherwise each is unchanged.
CREATE OR REPLACE FUNCTION aiqsa_assert_model_run_owner_boundary(p_model_run_id TEXT)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ModelRun" AS run_row
    INNER JOIN "Chat" AS chat_row ON chat_row."id" = run_row."chatId"
    WHERE run_row."id" = p_model_run_id
      AND chat_row."userId" IS DISTINCT FROM run_row."userId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ModelRun ownership must match its chat owner';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION "enforce_branch_source_model_run_tenant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination_user_id TEXT;
  source_user_id TEXT;
BEGIN
  IF NEW."branchSourceModelRunId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT destination_chat."userId"
  INTO destination_user_id
  FROM "Chat" AS destination_chat
  WHERE destination_chat.id = NEW."chatId";

  SELECT source_chat."userId"
  INTO source_user_id
  FROM "ModelRun" AS source_run
  INNER JOIN "Chat" AS source_chat ON source_chat.id = source_run."chatId"
  WHERE source_run.id = NEW."branchSourceModelRunId";

  -- The personal branch of the previous rule, with its NULL semantics: a source run no longer found when this
  -- deferred check fires (removed later in the same transaction) leaves the comparison unknown and passes, as before.
  IF NOT (destination_user_id IS NOT NULL AND source_user_id = destination_user_id) THEN
    RAISE EXCEPTION 'branch source model run tenant mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "workspace_secret_identity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'WorkspaceSecret' THEN
    IF NOT EXISTS (SELECT 1 FROM "WorkspaceSecretValue" v
      WHERE v."id" = NEW."valueId" AND v."secretId" = NEW."id" AND v."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'workspace_secret_identity_invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "WorkspaceSecretValue" v
      JOIN "ModelRun" r ON r."id" = NEW."modelRunId"
      JOIN "Chat" c ON c."id" = r."chatId"
      WHERE v."id" = NEW."valueId" AND v."secretId" = NEW."secretId"
        AND v."userId" = r."userId" AND c."userId" = r."userId") THEN
      RAISE EXCEPTION 'workspace_secret_identity_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_optional_decision_usage_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UsageEvent" u WHERE u."id" = NEW."id" AND u."optionalDecisionAttemptId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "OptionalDecisionAttempt" a
      LEFT JOIN "ModelRun" r ON r."id" = a."modelRunId" AND r."userId" = a."userId"
      WHERE a."id" = u."optionalDecisionAttemptId" AND a."userId" = u."userId"
        AND a."modelRunId" IS NOT DISTINCT FROM u."modelRunId"
        AND r."chatId" IS NOT DISTINCT FROM u."chatId"
    )) THEN RAISE EXCEPTION 'optional_decision_usage_owner_mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "workspace_checkpoint_file_guard"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'workspace_checkpoint_file_immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceOutputCheckpoint" p JOIN "ModelRun" r ON r."id" = p."modelRunId"
    JOIN "WorkspaceCapturedFile" f ON f."captureId" = NEW."captureId" AND f."relativePath" = NEW."relativePath"
    JOIN "Attachment" a ON a."id" = NEW."attachmentId"
    WHERE p."id" = NEW."checkpointId" AND p."captureId" = NEW."captureId" AND p."state" = 'PENDING'
    AND f."storageState" = 'READY' AND a."status" = 'ready' AND a."origin" = 'WORKSPACE_OUTPUT'
    AND a."producerModelRunId" = r."id" AND a."chatId" = r."chatId" AND a."messageId" = r."assistantMessageId"
    AND a."userId" = r."userId"
    AND ROW(a."storageKey", a."checksum", a."byteSize", a."mimeType") = ROW(f."storageKey", f."checksum", f."byteSize", f."mimeType")
    AND p."selection" @> jsonb_build_array(jsonb_build_object('root', split_part(NEW."relativePath", '/', 1), 'relativePath', substring(NEW."relativePath" from position('/' in NEW."relativePath") + 1)))
  ) THEN RAISE EXCEPTION 'workspace_checkpoint_file_scope' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION chat_pdf_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."state" <> OLD."state" AND NOT (
      NEW."state" IN ('failed','cancelled') OR
      OLD."state" IN ('checking','preparing','assembling') AND NEW."state" = 'original_only' OR
      OLD."state" = 'checking' AND NEW."state" = 'preparing' OR
      OLD."state" = 'preparing' AND NEW."state" = 'assembling' OR
      OLD."state" = 'assembling' AND NEW."state" = 'ready'
    ) THEN RAISE EXCEPTION 'chat_pdf_transition_invalid' USING ERRCODE = '23514'; END IF;
    IF (to_jsonb(NEW) - ARRAY['state','pageCount','completedPages','workPlan','localArtifactId',
        'documentArtifactId','errorCode','retryable','updatedAt']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','pageCount','completedPages','workPlan','localArtifactId',
        'documentArtifactId','errorCode','retryable','updatedAt']) OR
       (OLD."workPlan" IS NOT NULL AND NEW."workPlan" IS DISTINCT FROM OLD."workPlan") OR
       (OLD."pageCount" IS NOT NULL AND NEW."pageCount" IS DISTINCT FROM OLD."pageCount") OR
       NEW."completedPages" < OLD."completedPages" OR
       (OLD."state" IN ('ready','original_only','failed','cancelled') AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'chat_pdf_preparation_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Attachment" a
    JOIN "ModelRun" r ON r."id" = NEW."modelRunId"
    WHERE a."id" = NEW."attachmentId" AND a."kind" = 'pdf'
      AND a."checksum" = NEW."sourceChecksum" AND a."byteSize" = NEW."sourceByteSize"
      AND a."messageId" = r."userMessageId" AND a."chatId" = r."chatId"
      AND a."userId" = r."userId"
  ) THEN RAISE EXCEPTION 'chat_pdf_scope_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."route" <> 'local_text' AND (
    NEW."bindingSnapshot"->>'providerModelId' IS DISTINCT FROM NEW."providerModelId" OR
    NEW."bindingSnapshot"->>'credentialVersionId' IS DISTINCT FROM NEW."credentialVersionId" OR
    NOT EXISTS (
      SELECT 1 FROM "ProviderModel" m JOIN "ProviderCredentialVersion" v ON v."id" = NEW."credentialVersionId"
      JOIN "ProviderCredential" k ON k."id" = v."credentialId"
      WHERE m."id" = NEW."providerModelId" AND m."connectionId" = k."connectionId"
        AND k."id" = NEW."bindingSnapshot"->>'credentialId'
        AND m."connectionId" = NEW."bindingSnapshot"->>'connectionId'
    )
  ) THEN RAISE EXCEPTION 'chat_pdf_binding_invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND (NEW."processingMode" IS NOT NULL OR NEW."route" = 'system_vision') AND NOT EXISTS (
    SELECT 1 FROM "SystemModelPolicy" p WHERE p."id" = 'installation' AND p."version" = NEW."policyVersion"
      AND (NEW."processingMode" IS NULL OR (p."chatPdfProcessingMode"::text = upper(NEW."processingMode")
        AND p."chatPdfFallbackMethod"::text = upper(NEW."fallbackMethod")))
      AND (NEW."route" = 'direct_pdf' OR NEW."route" = 'system_vision' AND p."chatPdfProviderModelId" = NEW."providerModelId"
        OR NEW."route" = 'system_pdf' AND p."chatPdfNativeProviderModelId" = NEW."providerModelId")
  ) THEN RAISE EXCEPTION 'chat_pdf_policy_changed' USING ERRCODE = '23514'; END IF;
  IF NEW."route" = 'system_pdf' AND NEW."bindingSnapshot"->'model'->'capabilities'->>'nativePdfInput' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'chat_pdf_binding_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."route" IN ('direct_pdf','selected_model_vision') AND NOT EXISTS (
    SELECT 1 FROM "ProviderRunBinding" b WHERE b."modelRunId" = NEW."modelRunId" AND b."role" = 'answer'
      AND b."providerModelId" = NEW."providerModelId" AND b."credentialVersionId" = NEW."credentialVersionId"
      AND b."executionSnapshot" = NEW."bindingSnapshot"
  ) THEN RAISE EXCEPTION 'chat_pdf_answer_binding_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."workPlan" IS NOT NULL AND (
    (NEW."workPlan"->>'pageCount')::int IS DISTINCT FROM NEW."pageCount" OR
    NEW."workPlan"->>'compatibilityKey' IS DISTINCT FROM NEW."compatibilityKey" OR
    jsonb_array_length(NEW."workPlan"->'units') IS DISTINCT FROM NEW."pageCount" OR
    EXISTS (SELECT 1 FROM generate_series(1, NEW."pageCount") page_number WHERE
      (SELECT count(*) FROM jsonb_array_elements(NEW."workPlan"->'units') unit
        WHERE (unit->>'page')::int = page_number AND (NEW."route" = 'system_pdf' AND unit->>'route' = 'pdf_required' OR
          NEW."route" <> 'system_pdf' AND unit->>'route' IN ('native_only','vision_required'))
          AND unit->>'key' ~ '^[a-f0-9]{64}$') <> 1)
  ) THEN RAISE EXCEPTION 'chat_pdf_plan_invalid' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "ChatPdfArtifact" a
    WHERE a."id" IN (NEW."localArtifactId", NEW."documentArtifactId") AND
      (a."attachmentId" <> NEW."attachmentId" OR a."sourceChecksum" <> NEW."sourceChecksum"
        OR a."route" <> NEW."route" OR a."state" <> 'ready'
        OR a."preparationGeneration" <> NEW."modelRunId" OR a."pageCount" <> NEW."pageCount"
        OR (a."id" = NEW."localArtifactId" AND a."kind" <> 'local')
        OR (a."id" = NEW."documentArtifactId" AND a."kind" <> 'document'))
  ) THEN RAISE EXCEPTION 'chat_pdf_artifact_scope_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."state" = 'original_only' AND (
    NEW."route" = 'direct_pdf' OR NEW."documentArtifactId" IS NOT NULL OR NEW."retryable" OR
    NEW."errorCode" IS NULL OR NEW."errorCode" NOT IN ('pdf_local_text_unusable','pdf_transcription_failed') OR
    NOT EXISTS (SELECT 1 FROM "WorkspaceRunBinding" w JOIN "ModelRun" r ON r."id" = w."modelRunId"
      WHERE w."modelRunId" = NEW."modelRunId" AND r."status" = 'preparing')
  ) THEN RAISE EXCEPTION 'chat_pdf_workspace_original_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

-- The checks, keys and indexes that name a dropped column. Those with a personal branch are added back below with only
-- that branch; the rest served Projects alone, the retired null checks of `20261025092000` among them.
ALTER TABLE "Chat"
  DROP CONSTRAINT "Chat_owner_boundary_check",
  DROP CONSTRAINT "Chat_import_source_key_check",
  DROP CONSTRAINT IF EXISTS "Chat_project_retired_check",
  DROP CONSTRAINT "Chat_createdByUserId_fkey";
ALTER TABLE "Message"
  DROP CONSTRAINT IF EXISTS "Message_project_attribution_retired_check",
  DROP CONSTRAINT "Message_authorUserId_fkey";
ALTER TABLE "Attachment"
  DROP CONSTRAINT "Attachment_owner_boundary_check",
  DROP CONSTRAINT "Attachment_saved_file_boundary_check",
  DROP CONSTRAINT IF EXISTS "Attachment_project_retired_check",
  DROP CONSTRAINT "Attachment_uploaderUserId_fkey";
ALTER TABLE "AttachmentUpload"
  DROP CONSTRAINT "AttachmentUpload_scope_check",
  DROP CONSTRAINT IF EXISTS "AttachmentUpload_project_retired_check";
ALTER TABLE "SharedChatSnapshot"
  DROP CONSTRAINT "SharedChatSnapshot_owner_boundary_check",
  DROP CONSTRAINT IF EXISTS "SharedChatSnapshot_project_retired_check";
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_shape_check",
  DROP CONSTRAINT IF EXISTS "UsageEvent_project_retired_check";
DROP INDEX "Chat_projectId_archived_updatedAt_idx";
DROP INDEX "Chat_projectFolderId_idx";
DROP INDEX "Message_authorUserId_idx";
DROP INDEX "Attachment_projectId_createdAt_idx";
DROP INDEX "Attachment_uploaderUserId_idx";
DROP INDEX "AttachmentUpload_projectId_idx";
DROP INDEX "SharedChatSnapshot_projectId_createdAt_idx";
DROP INDEX "UsageEvent_projectId_createdAt_idx";

-- Dropping a column silently takes every check and index that names it. Anything still depending on one of them
-- (beyond its default and NOT NULL) is a missed dependency, so it fails the migration instead of going unnoticed.
DO $migration$
DECLARE
  missed text;
BEGIN
  WITH retired ("table_name", "column_name") AS (VALUES
    ('Chat', 'projectId'), ('Chat', 'projectFolderId'), ('Chat', 'createdByUserId'), ('Chat', 'createdByDisplayName'),
    ('Message', 'authorUserId'), ('Message', 'authorDisplayName'), ('Message', 'authorProjectRole'),
    ('Attachment', 'projectId'), ('Attachment', 'uploaderUserId'), ('Attachment', 'uploaderDisplayName'),
    ('AttachmentUpload', 'projectId'), ('AttachmentUpload', 'projectScoped'),
    ('SharedChatSnapshot', 'projectId'), ('SharedChatSnapshot', 'createdByDisplayName'),
    ('UsageEvent', 'projectId'), ('Folder', 'projectMemory')
  ), found AS (
    SELECT DISTINCT pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid) AS item
    FROM retired
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = format('%I', retired."table_name")::regclass AND attribute.attname = retired."column_name"
    JOIN pg_depend AS dependency
      ON dependency.refclassid = 'pg_class'::regclass AND dependency.refobjid = attribute.attrelid
        AND dependency.refobjsubid = attribute.attnum
    WHERE dependency.classid <> 'pg_attrdef'::regclass
      AND NOT EXISTS (SELECT 1 FROM pg_constraint AS constraint_row
        WHERE dependency.classid = 'pg_constraint'::regclass AND constraint_row.oid = dependency.objid
          AND constraint_row.contype = 'n')
  )
  SELECT string_agg(item, ', ' ORDER BY item) INTO missed FROM found;
  IF missed IS NOT NULL THEN
    RAISE EXCEPTION 'project_column_dependency_left: %', missed;
  END IF;
END;
$migration$;

ALTER TABLE "Chat"
  DROP COLUMN "projectId",
  DROP COLUMN "projectFolderId",
  DROP COLUMN "createdByUserId",
  DROP COLUMN "createdByDisplayName";
ALTER TABLE "Message"
  DROP COLUMN "authorUserId",
  DROP COLUMN "authorDisplayName",
  DROP COLUMN "authorProjectRole";
ALTER TABLE "Attachment"
  DROP COLUMN "projectId",
  DROP COLUMN "uploaderUserId",
  DROP COLUMN "uploaderDisplayName";
ALTER TABLE "AttachmentUpload" DROP COLUMN "projectId", DROP COLUMN "projectScoped";
ALTER TABLE "SharedChatSnapshot" DROP COLUMN "projectId", DROP COLUMN "createdByDisplayName";
ALTER TABLE "UsageEvent" DROP COLUMN "projectId";
ALTER TABLE "Folder" DROP COLUMN "projectMemory";
DROP TYPE "ProjectRole";

-- Every chat has an owner. The owner checks of files and shares keep their personal branch: an owner is required.
ALTER TABLE "Chat" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_import_source_key_check" CHECK (
  "importSourceKey" IS NULL OR (
    "importSource" IS NOT NULL
    AND "importSourceKey" ~ '^[0-9a-f]{64}$'
  )
);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_owner_boundary_check" CHECK ("userId" IS NOT NULL);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_saved_file_boundary_check" CHECK (
  "savedAt" IS NULL OR (
    "userId" IS NOT NULL
    AND "chatId" IS NULL
    AND "messageId" IS NULL
    AND "producerModelRunId" IS NULL
  )
);
ALTER TABLE "SharedChatSnapshot" ADD CONSTRAINT "SharedChatSnapshot_owner_boundary_check" CHECK ("ownerUserId" IS NOT NULL);

-- Usage keeps every row; the shape check loses only its Project link.
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_shape_check" CHECK (
  (NOT "visionAnalysis" AND "visionAnalysisAttemptId" IS NULL AND (
    (NOT "optionalDecision" AND (
      (NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL AND (
        (NOT "imageGeneration" AND "imageToolCallId" IS NULL AND (
          (NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
          OR ("chatPdfPreparation" AND "providerModelId" IS NOT NULL)
        ))
        OR ("imageGeneration" AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
          AND "providerModelId" IS NOT NULL)
      ))
      OR ("chatTitleGeneration" AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
        AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
        AND "providerModelId" IS NOT NULL)
    ))
    OR ("optionalDecision" AND "providerModelId" IS NOT NULL
      AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
      AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
      AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
  ))
  OR ("visionAnalysis" AND "providerModelId" IS NOT NULL
    AND NOT "optionalDecision" AND "optionalDecisionAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
);

-- Nothing that stays may still name what went: a routine, constraint or index naming a dropped column or type would
-- fail on its next use, so it fails the migration here instead. `authorUserId` and `createdByUserId` stay on other
-- tables, so the routines that name them were reviewed by hand instead.
DO $migration$
DECLARE
  missed text;
BEGIN
  WITH retired AS (
    SELECT '"(projectId|projectFolderId|createdByDisplayName|authorDisplayName|authorProjectRole|projectScoped|'
      || 'projectMemory|uploaderUserId|uploaderDisplayName|ProjectRole)"' AS pattern
  ), found AS (
    SELECT 'routine ' || routine.oid::regprocedure::text AS item
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = current_schema() AND routine.prosrc ~ (SELECT pattern FROM retired)
    UNION ALL
    SELECT 'constraint ' || relation.relname || '.' || constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND constraint_row.contype <> 'n'
      AND pg_get_constraintdef(constraint_row.oid) ~ (SELECT pattern FROM retired)
    UNION ALL
    SELECT 'index ' || index_relation.relname
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND pg_get_indexdef(index_row.indexrelid) ~ (SELECT pattern FROM retired)
  )
  SELECT string_agg(item, ', ' ORDER BY item) INTO missed FROM found;
  IF missed IS NOT NULL THEN
    RAISE EXCEPTION 'project_leftover_dependency_left: %', missed;
  END IF;
END;
$migration$;
