-- Projects and Knowledge were removed together with their data (operator
-- decisions 2026-10-23). Since 0.4.0 retirement has deleted what they held
-- through their own deletion paths, and nothing else reads or writes them;
-- this release drops their storage (decision 2026-10-25). Until Compose has
-- replaced the previous release, its reads of these tables (retirement,
-- deletion reference checks, the Memory embedding default) and its Assistant
-- and MCP runtime generation queries, which still select the columns dropped
-- below, fail; deletion obligations retry. Nothing that remains depends on
-- them.
--
-- Retirement is expected to have emptied them on every installation before
-- this release is deployed. The migration does not refuse to run when it has
-- not: a leftover Project chat then stays behind without an owner and is never
-- shown, and leftover Knowledge objects are queued for the ordinary,
-- reference-checked object deletion below. Leftovers are reported as
-- content-free warnings in the PostgreSQL log.
--
-- Kept on purpose: the always-null Project columns of chats, messages, files,
-- uploads, shares and usage (core integrity routines still name them, so they
-- stay under null checks), the ProjectRole type of the message attribution
-- column, the historical Knowledge usage columns and purposes of UsageEvent,
-- and the Knowledge source and tool names old answers and observations still
-- carry.

-- Dropping a table removes its foreign key triggers from every table it
-- references or that references it, under an exclusive lock, while a
-- previous-release writer may lock one of those tables before its cascade
-- reaches a dropped one. Every lock is therefore taken up front, the tables
-- that stay first (including those whose triggers or checks change below),
-- and a deadlock retries instead of failing the upgrade.
DO $migration$
DECLARE
  locks text;
BEGIN
  WITH retired AS (
    SELECT relation.oid
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p')
      AND (relation.relname ~ '^(Project|Knowledge)' OR relation.relname = 'McpSharedRuntime')
  ), linked AS (
    SELECT constraint_row.confrelid AS oid FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f' AND constraint_row.conrelid IN (SELECT oid FROM retired)
    UNION
    SELECT constraint_row.conrelid FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f' AND constraint_row.confrelid IN (SELECT oid FROM retired)
    UNION
    SELECT relation.oid FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname IN ('MemoryUtilityModelPolicy', 'McpRuntimeGeneration', 'AssistantDefinition',
        'User', 'UserGroup', 'Group', 'Message', 'ModelRun', 'ModelRunEvent', 'ModelRunToolCall',
        'Chat', 'Attachment', 'AttachmentUpload', 'SharedChatSnapshot', 'UsageEvent')
  ), ordered AS (
    SELECT relation.relname, relation.oid IN (SELECT oid FROM retired) AS retiring
    FROM pg_class AS relation
    WHERE relation.oid IN (SELECT oid FROM retired UNION SELECT oid FROM linked)
  )
  SELECT string_agg(format('%I', ordered.relname), ', ' ORDER BY ordered.retiring, ordered.relname)
  INTO locks
  FROM ordered;
  LOOP
    BEGIN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', locks);
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

DO $migration$
DECLARE
  leftover_projects bigint;
  leftover_bases bigint;
  leftover_sources bigint;
  leftover_jobs bigint;
BEGIN
  SELECT count(*) INTO leftover_projects FROM "Project";
  SELECT count(*) INTO leftover_bases FROM "KnowledgeBase";
  SELECT count(*) INTO leftover_sources FROM "KnowledgeSource";
  SELECT count(*) INTO leftover_jobs FROM "KnowledgeDeletionJob";
  IF leftover_projects + leftover_bases + leftover_sources + leftover_jobs > 0 THEN
    RAISE WARNING 'project_knowledge_retirement_incomplete projects=% knowledge_bases=% knowledge_sources=% knowledge_deletion_jobs=%',
      leftover_projects, leftover_bases, leftover_sources, leftover_jobs;
  END IF;
END;
$migration$;

-- Stored Knowledge objects leave through the ordinary object deletion, which
-- rechecks every remaining reference before it removes bytes.
INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "multipartUploadId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, object."storageKey", max(object."multipartUploadId"), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT "storageKey", "multipartUploadId" FROM "KnowledgeUploadItem" WHERE "storageKey" IS NOT NULL
  UNION ALL SELECT "storageKey", NULL FROM "KnowledgeDeletionObject"
  UNION ALL SELECT "originalStorageKey", NULL FROM "KnowledgeSourceVersion" WHERE "originalStorageKey" IS NOT NULL
  UNION ALL SELECT "normalizedTextStorageKey", NULL FROM "KnowledgeSourceIndexArtifact" WHERE "normalizedTextStorageKey" IS NOT NULL
  UNION ALL SELECT "originalStorageKey", NULL FROM "KnowledgeDocumentVersion" WHERE "originalStorageKey" IS NOT NULL
  UNION ALL SELECT "normalizedTextStorageKey", NULL FROM "KnowledgeDocumentVersion" WHERE "normalizedTextStorageKey" IS NOT NULL
) AS object
GROUP BY object."storageKey"
ON CONFLICT ("storageKey") DO NOTHING;

-- The installation embedding default that Personal Memory adopts once per
-- owner (agent_docs/MEMORY.md) moves from the retired Knowledge profile to
-- the Memory Utility Model policy, with the same rule: only an active
-- installation revision whose preflight passed. No setting changes it.
ALTER TABLE "MemoryUtilityModelPolicy" ADD COLUMN "embeddingDefaultProviderModelId" TEXT;
ALTER TABLE "MemoryUtilityModelPolicy"
  ADD CONSTRAINT "MemoryUtilityModelPolicy_embeddingDefaultProviderModelId_fkey"
  FOREIGN KEY ("embeddingDefaultProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MemoryUtilityModelPolicy_embeddingDefaultProviderModelId_idx"
  ON "MemoryUtilityModelPolicy"("embeddingDefaultProviderModelId");
UPDATE "MemoryUtilityModelPolicy" AS policy
SET "embeddingDefaultProviderModelId" = revision."embeddingProviderModelId"
FROM "KnowledgeIndexProfile" AS profile
JOIN "KnowledgeIndexProfileRevision" AS revision
  ON revision."id" = profile."activeRevisionId" AND revision."profileId" = profile."id"
WHERE policy."id" = 'installation'
  AND profile."id" = 'installation'
  AND revision."executionAuthority" = 'installation'
  AND revision."preflightStatus" = 'ready';

-- Routines on tables that stay lose their Project branches before the tables
-- they read go.
CREATE OR REPLACE FUNCTION aiqsa_assert_model_run_owner_boundary(p_model_run_id TEXT)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ModelRun" AS run_row
    INNER JOIN "Chat" AS chat_row ON chat_row."id" = run_row."chatId"
    WHERE run_row."id" = p_model_run_id
      AND NOT (chat_row."projectId" IS NULL AND chat_row."userId" = run_row."userId")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ModelRun ownership must match its chat owner';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_mcp_personal_boundary_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  violation BOOLEAN := false;
BEGIN
  -- Deferred to commit: judge each row as committed, never a superseded NEW.
  IF TG_TABLE_NAME = 'McpUserServer' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpUserServer" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND child."userId" <> server_row."ownerUserId"
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpOAuthConnection' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpOAuthConnection" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND child."userId" <> server_row."ownerUserId"
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpGrant' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpGrant" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
        AND (child."groupId" IS NOT NULL OR child."userId" IS DISTINCT FROM server_row."ownerUserId")
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpToolAccessPolicy' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpToolAccessPolicy" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpActivationJob' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpActivationJob" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  END IF;
  IF violation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = TG_TABLE_NAME || ' crosses the personal MCP owner boundary';
  END IF;
  RETURN NULL;
END;
$function$;

-- Triggers on tables that stay and serve only Projects or Knowledge.
DROP TRIGGER IF EXISTS "User_project_access_revision" ON "User";
DROP TRIGGER IF EXISTS "UserGroup_project_access_revision" ON "UserGroup";
DROP TRIGGER IF EXISTS "Group_project_access_revision" ON "Group";
DROP TRIGGER IF EXISTS "Message_project_authorship" ON "Message";
DROP TRIGGER IF EXISTS "ProjectMessage_to_ProjectEvent" ON "Message";
DROP TRIGGER IF EXISTS "ProjectRun_to_ProjectEvent" ON "ModelRun";
DROP TRIGGER IF EXISTS "ProjectAttachment_to_ProjectEvent" ON "Attachment";
DROP TRIGGER IF EXISTS "ProjectRunOutput_to_ProjectEvent" ON "ModelRunEvent";
DROP TRIGGER IF EXISTS "ProjectRunTool_to_ProjectEvent" ON "ModelRunToolCall";
DROP TRIGGER IF EXISTS "ModelRunToolCall_basic_focused_guard" ON "ModelRunToolCall";
DROP TRIGGER IF EXISTS "UsageEvent_knowledge_relevance_owner_check" ON "UsageEvent";
DROP TRIGGER IF EXISTS "AssistantDefinition_project_invalidation" ON "AssistantDefinition";

-- Every Project and Knowledge table, SQL-only ones included, and the shared
-- MCP runtimes only Project chats used. CASCADE removes their foreign keys
-- from the tables that stay; their columns stay.
DO $migration$
DECLARE
  retired text;
BEGIN
  SELECT string_agg(format('%I', relation.relname), ', ' ORDER BY relation.relname)
  INTO retired
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p')
    AND (relation.relname ~ '^(Project|Knowledge)' OR relation.relname = 'McpSharedRuntime');
  IF retired IS NOT NULL THEN
    EXECUTE format('DROP TABLE %s CASCADE', retired);
  END IF;
END;
$migration$;

-- Runtime generations of the shared runtimes went with them; every remaining
-- generation belongs to one member's server.
DELETE FROM "McpRuntimeGeneration" WHERE "sharedServerId" IS NOT NULL;
ALTER TABLE "McpRuntimeGeneration" DROP COLUMN "sharedServerId";
ALTER TABLE "McpRuntimeGeneration"
  ADD CONSTRAINT "McpRuntimeGeneration_owner_check" CHECK ("userServerId" IS NOT NULL);

-- The Assistant Knowledge row nothing reads since its removal.
ALTER TABLE "AssistantDefinition" DROP COLUMN "knowledgeSelection", DROP COLUMN "knowledgePolicy";

-- Routines that only served the dropped tables. A trigger still calling one
-- on a table that stays would be a missed dependency, so it fails the
-- migration instead of being dropped silently; a constraint or index still
-- using one fails the DROP FUNCTION the same way.
DO $migration$
DECLARE
  routine record;
  stray text;
BEGIN
  FOR routine IN
    SELECT procedure_row.oid, procedure_row.oid::regprocedure AS signature
    FROM pg_proc AS procedure_row
    JOIN pg_namespace AS namespace ON namespace.oid = procedure_row.pronamespace
    WHERE namespace.nspname = current_schema() AND procedure_row.prokind = 'f'
      AND (procedure_row.proname ~* 'knowledge'
        OR procedure_row.proname ~ '(^|_)projects?(_|$)'
        OR procedure_row.prosrc ~ '"(Project|Knowledge)[A-Za-z0-9]*"'
        OR procedure_row.prosrc ~ '"McpSharedRuntime"')
    ORDER BY procedure_row.proname
  LOOP
    SELECT string_agg(format('%I on %s', trigger_row.tgname, trigger_row.tgrelid::regclass), ', ')
    INTO stray
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = routine.oid AND NOT trigger_row.tgisinternal;
    IF stray IS NOT NULL THEN
      RAISE EXCEPTION 'retired_routine_still_triggered: % (%)', routine.signature, stray;
    END IF;
    EXECUTE format('DROP FUNCTION %s', routine.signature);
  END LOOP;
END;
$migration$;

-- Types only the dropped tables used. ProjectRole stays with the message
-- attribution column.
DO $migration$
DECLARE
  retired_type record;
BEGIN
  FOR retired_type IN
    SELECT type_row.oid::regtype AS name
    FROM pg_type AS type_row
    JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
    WHERE namespace.nspname = current_schema() AND type_row.typtype = 'e'
      AND type_row.typname ~ '^(Project|Knowledge)' AND type_row.typname <> 'ProjectRole'
    ORDER BY type_row.typname
  LOOP
    EXECUTE format('DROP TYPE %s', retired_type.name);
  END LOOP;
END;
$migration$;

-- Nothing writes Project ownership any more, so every row stays personal. A
-- check is added only where no row breaks it: one a missed retirement left
-- would otherwise refuse every later write of that row, the user references
-- account deletion clears included, so such a table keeps no check and is
-- reported. A deleted Project's uploads keep their Project scope after their
-- Project reference was cleared, and upload cleanup still updates them, so
-- only the reference is checked there.
DO $migration$
DECLARE
  retired_check record;
BEGIN
  FOR retired_check IN
    SELECT * FROM (VALUES
      ('Chat', 'Chat_project_retired_check', '"projectId" IS NULL AND "projectFolderId" IS NULL'),
      ('Message', 'Message_project_attribution_retired_check',
        'num_nonnulls("authorUserId", "authorDisplayName", "authorProjectRole") = 0'),
      ('Attachment', 'Attachment_project_retired_check', '"projectId" IS NULL'),
      ('AttachmentUpload', 'AttachmentUpload_project_retired_check', '"projectId" IS NULL'),
      ('SharedChatSnapshot', 'SharedChatSnapshot_project_retired_check', '"projectId" IS NULL'),
      ('UsageEvent', 'UsageEvent_project_retired_check', '"projectId" IS NULL')
    ) AS retired(table_name, check_name, check_rule)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)',
        retired_check.table_name, retired_check.check_name, retired_check.check_rule);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'project_retirement_leftover_rows table=%', retired_check.table_name;
    END;
  END LOOP;
END;
$migration$;
