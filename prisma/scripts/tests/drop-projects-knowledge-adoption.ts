/** Synthetic predecessor state for dropping Project and Knowledge storage
 * (operator decisions 2026-10-23); migration-contract owns the disposable database. */
export const DROP_PROJECTS_KNOWLEDGE_MIGRATION = "20261025092000_drop_projects_knowledge";

const avatar = `'{"kind":"generated","recipeVersion":1,"paletteId":"ember","backgroundShape":"circle","foregroundShape":"ring","rotations":[0,0],"accents":[]}'`;
const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
// The chat check comes first: the missed-retirement fixture leaves a Project chat.
const retiredChecks = [
  "Chat_project_retired_check", "Message_project_attribution_retired_check", "Attachment_project_retired_check",
  "AttachmentUpload_project_retired_check", "SharedChatSnapshot_project_retired_check", "UsageEvent_project_retired_check"
] as const;

// What the previous release leaves once retirement has run, plus what a
// missed retirement could leave: an installation embedding default in the
// Knowledge profile, a Knowledge deletion whose object still exists, a
// Project with a chat, and an Assistant that still carries the Knowledge row.
export const dropProjectsKnowledgeFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", role, status, "updatedAt") VALUES
  ('drop-owner', 'Synthetic owner', 'user', 'active', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, enabled, "activeConfig", "activeVersion", "activatedAt", "updatedAt")
VALUES ('drop-connection', 'Synthetic embeddings', 'openai_compatible', true, '{}'::jsonb, 1, now(), now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass",
  "activeConfig", "activeVersion", "activatedAt", capabilities, "defaultParams", "updatedAt")
VALUES ('drop-embedding-model', 'drop-connection', 'openai_compatible', 'synthetic-embed', 'Synthetic embed', 'embedding',
  '{"schemaVersion":1}'::jsonb, 1, now(), '{}'::jsonb, '{}'::jsonb, now());
INSERT INTO "MemoryUtilityModelPolicy" (id, "updatedAt") VALUES ('installation', now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "KnowledgeIndexProfile" (id, "updatedAt") VALUES ('installation', now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "KnowledgeIndexProfileRevision" (id, "profileId", "revisionNumber", "embeddingProviderModelId",
  "embeddingConfiguration", "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
  "executionAuthority", "profileConfiguration", "egressPolicy", "preflightStatus", "preflightCheckedAt", "activatedAt")
VALUES ('drop-profile-revision', 'installation',
  (SELECT COALESCE(max("revisionNumber"), 0) + 1 FROM "KnowledgeIndexProfileRevision" WHERE "profileId" = 'installation'),
  'drop-embedding-model', '{"schemaVersion":1}'::jsonb, repeat('a', 64), 1024, 2,
  'installation', '{}'::jsonb, '{}'::jsonb, 'ready', now(), now());
UPDATE "KnowledgeIndexProfile" SET "activeRevisionId" = 'drop-profile-revision' WHERE id = 'installation';
INSERT INTO "KnowledgeBase" (id, "ownerUserId", name, "updatedAt") VALUES ('drop-base', 'drop-owner', 'Synthetic base', now());
INSERT INTO "KnowledgeDeletionJob" (id, "ownerUserId", "targetType", "targetId", "updatedAt")
VALUES ('drop-deletion-job', 'drop-owner', 'BASE', 'drop-base', now());
INSERT INTO "KnowledgeDeletionObject" ("knowledgeDeletionJobId", "storageKey", "updatedAt")
VALUES ('drop-deletion-job', 'knowledge/drop-original', now());
INSERT INTO "Project" (id, name, "createdByDisplayName", status, "deletionRequestedAt", "updatedAt")
VALUES ('drop-project', 'Synthetic Project', 'Synthetic owner', 'DELETING', now(), now());
INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", title, "memoryMode", "updatedAt") VALUES
  ('drop-project-chat', NULL, 'drop-project', 'drop-owner', 'Synthetic owner', 'Synthetic Project chat', 'EXCLUDED', now()),
  ('drop-personal-chat', 'drop-owner', NULL, NULL, '', 'Synthetic personal chat', 'NORMAL', now());
INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "systemPrompt", "searchPlan", "modelPolicy",
  "knowledgePolicy", "knowledgeSelection", "updatedAt")
VALUES ('drop-assistant', 'drop-owner', 'Synthetic helper', ${avatar}, 'Answer.', '{"mode":"all_selected","optionIds":[]}',
  'adjustable', 'adjustable', '{"baseIds":["drop-base"],"mode":"explicit","sourceIds":[],"version":1}'::jsonb, now());
COMMIT;
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const dropProjectsKnowledgeProofSql = `
BEGIN;
DO $proof$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p')
        AND (relation.relname ~ '^(Project|Knowledge)' OR relation.relname = 'McpSharedRuntime'))
  THEN RAISE EXCEPTION 'retired_project_knowledge_tables_retained'; END IF;
  IF EXISTS (SELECT 1 FROM pg_type AS type_row JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
      WHERE namespace.nspname = current_schema() AND type_row.typtype = 'e'
        AND type_row.typname ~ '^(Project|Knowledge)' AND type_row.typname <> 'ProjectRole')
  THEN RAISE EXCEPTION 'retired_project_knowledge_types_retained'; END IF;
  IF to_regtype('"ProjectRole"') IS NULL THEN RAISE EXCEPTION 'message_attribution_type_dropped'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS routine JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = current_schema()
        AND (routine.prosrc ~ '"(Project|Knowledge)[A-Za-z0-9]*"' OR routine.prosrc ~ '"McpSharedRuntime"'
          OR routine.proname ~* 'knowledge' OR routine.proname ~ '(^|_)projects?(_|$)'))
  THEN RAISE EXCEPTION 'retired_project_knowledge_routines_retained'; END IF;
  IF to_regprocedure('aiqsa_assert_model_run_owner_boundary(text)') IS NULL
    OR to_regprocedure('aiqsa_mcp_personal_boundary_trigger()') IS NULL
  THEN RAISE EXCEPTION 'core_owner_boundaries_dropped'; END IF;
  -- The embedding default moved with its rule.
  IF (SELECT "embeddingDefaultProviderModelId" FROM "MemoryUtilityModelPolicy" WHERE id = 'installation')
      IS DISTINCT FROM 'drop-embedding-model'
  THEN RAISE EXCEPTION 'memory_embedding_default_not_moved'; END IF;
  -- The leftover Knowledge object is queued for the reference-checked deletion.
  IF NOT EXISTS (SELECT 1 FROM "AttachmentDeletionJob" WHERE "storageKey" = 'knowledge/drop-original')
  THEN RAISE EXCEPTION 'knowledge_object_not_queued'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND ((table_name = 'AssistantDefinition' AND column_name IN ('knowledgeSelection', 'knowledgePolicy'))
        OR (table_name = 'McpRuntimeGeneration' AND column_name = 'sharedServerId')))
  THEN RAISE EXCEPTION 'retired_columns_retained'; END IF;
  -- Personal rows are untouched; a missed retirement's chat stays without an owner.
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drop-personal-chat' AND "userId" = 'drop-owner')
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drop-project-chat' AND "userId" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id = 'drop-assistant')
  THEN RAISE EXCEPTION 'retired_drop_changed_personal_rows'; END IF;
  -- The table holding the leftover keeps no Project check; the others get theirs.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Chat_project_retired_check')
  THEN RAISE EXCEPTION 'leftover_project_chat_table_checked'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN (${quoted(retiredChecks.slice(1))}))
      <> ${retiredChecks.length - 1}
  THEN RAISE EXCEPTION 'project_retired_checks_missing'; END IF;
END $proof$;
-- The leftover chat stays writable: account deletion clears its creator.
UPDATE "Chat" SET "createdByUserId" = NULL WHERE id = 'drop-project-chat';
-- An Assistant and its owner still change.
UPDATE "AssistantDefinition" SET version = version + 1 WHERE id = 'drop-assistant';
UPDATE "User" SET status = 'disabled' WHERE id = 'drop-owner';
ROLLBACK;
`;

// A completed retirement leaves no Project or Knowledge row, but an upload a
// deleted Project started keeps its Project scope after its Project reference
// was cleared, and upload cleanup still updates it.
export const dropProjectsKnowledgeRetiredFixtureSql = `
INSERT INTO "AttachmentUpload" (id, "projectId", "projectScoped", "idempotencyKey", "fileName", "mimeType",
  "byteSize", "expiresAt", "deadlineAt")
VALUES ('drop-retired-upload', NULL, true, 'drop-retired-upload', 'original.bin', 'application/octet-stream', 3,
  now() + interval '1 hour', now() + interval '2 hours');
`;

/** Every Project check is validated, refuses a new Project row and leaves the
 * scoped upload writable. Runs in a rolled-back transaction, so it also proves
 * a repeated deploy. */
export const dropProjectsKnowledgeRetiredProofSql = `
BEGIN;
DO $proof$
DECLARE refused text;
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN (${quoted(retiredChecks)}))
      <> ${retiredChecks.length}
  THEN RAISE EXCEPTION 'project_retired_checks_not_validated'; END IF;
  IF (SELECT "embeddingDefaultProviderModelId" FROM "MemoryUtilityModelPolicy" WHERE id = 'installation') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_embedding_default_invented'; END IF;
  UPDATE "AttachmentUpload" SET state = 'expired' WHERE id = 'drop-retired-upload';
  BEGIN
    INSERT INTO "AttachmentUpload" (id, "projectId", "projectScoped", "idempotencyKey", "fileName", "mimeType",
      "byteSize", "expiresAt", "deadlineAt")
    VALUES ('drop-new-project-upload', 'drop-retired-project', true, 'drop-new-project-upload', 'new.bin',
      'application/octet-stream', 3, now() + interval '1 hour', now() + interval '2 hours');
    RAISE EXCEPTION 'project_upload_admitted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
    IF refused IS DISTINCT FROM 'AttachmentUpload_project_retired_check'
    THEN RAISE EXCEPTION 'project_upload_refused_by_%', refused; END IF;
  END;
END $proof$;
ROLLBACK;
`;
