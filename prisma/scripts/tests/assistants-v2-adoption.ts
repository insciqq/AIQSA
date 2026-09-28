/** Disposable predecessor fixtures for the Assistants v2 storage migration.
 * The migration contract owns database creation, acknowledgement, and cleanup. */
export const ASSISTANTS_V2_MIGRATION = "20260928000000_assistants_v2_storage";

const avatar = `'{"kind":"generated","recipeVersion":1,"paletteId":"ember","backgroundShape":"circle","foregroundShape":"ring","rotations":[0,0],"accents":[]}'`;
const identity = (name: string) =>
  `jsonb_build_object('name', '${name}', 'avatar', ${avatar}::jsonb)`;

export const assistantsV2AdoptionFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
 ('av2-owner', 'Fixture owner', 'active', now()),
 ('av2-other', 'Fixture reviewer', 'active', now());
INSERT INTO "UserSettings" (id, "userId", "updatedAt") VALUES ('av2-settings', 'av2-owner', now());
INSERT INTO "Group" (id, name, "updatedAt") VALUES ('av2-group', 'Fixture group', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('av2-provider', 'Fixture provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "updatedAt")
VALUES ('av2-model', 'av2-provider', 'fake', 'fixture', 'Fixture model', '{}', '{}', now());
INSERT INTO "AssistantDefinition" (id, "ownerUserId", version, "archivedAt", "updatedAt", name, avatar, "providerModelId",
  "systemPrompt", "developerPrompt", "runControls", "searchPlan", "mcpServerIds", "starterPrompts") VALUES
 ('av2-merge', 'av2-owner', 3, NULL, '2026-01-01 00:00:00', 'Merge', ${avatar}, 'av2-model',
  'System rules', 'Developer rules', '{}', '{"mode":"all_selected","optionIds":[]}', ARRAY[]::text[],
  ARRAY['One','Two','Three','Four']),
 ('av2-exact', 'av2-owner', 5, NULL, '2026-01-01 00:00:00', 'Exact', ${avatar}, 'av2-model',
  'Exact rules', NULL, '{"temperature":0.2}', '{"mode":"model_choice","optionIds":["fixture-search"]}', ARRAY['fixture-mcp'],
  ARRAY[]::text[]),
 ('av2-archived', 'av2-owner', 2, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'Archived', ${avatar}, 'av2-model',
  '', 'Archived rules', '{}', '{"mode":"all_selected","optionIds":[]}', ARRAY[]::text[], ARRAY[]::text[]),
 ('av2-long', 'av2-owner', 7, NULL, '2026-01-01 00:00:00', 'Long', ${avatar}, 'av2-model',
  repeat('s', 32000), repeat('d', 16000), '{"reasoningEffort":"high"}', '{"mode":"model_choice","optionIds":[]}',
  ARRAY[]::text[], ARRAY[]::text[]),
 ('av2-blank', 'av2-owner', 1, NULL, '2026-01-01 00:00:00', 'Blank', ${avatar}, 'av2-model',
  'Blank rules', E' \\n\\t', '{}', '{"mode":"all_selected","optionIds":["fixture-search"]}', ARRAY[]::text[],
  ARRAY[]::text[]);
INSERT INTO "AssistantPublication" (id, "assistantId", scope, "groupId", "updatedAt") VALUES
 ('av2-merge-installation', 'av2-merge', 'installation', NULL, now()),
 ('av2-merge-group', 'av2-merge', 'group', 'av2-group', now());
INSERT INTO "Project" (id, name, "createdByDisplayName", "updatedAt") VALUES ('av2-project', 'Fixture Project', 'Fixture owner', now());
INSERT INTO "ProjectGrant" (id, "projectId", "userId", role, "updatedAt") VALUES ('av2-project-owner', 'av2-project', 'av2-owner', 'OWNER', now());
INSERT INTO "ProjectAssistantBinding" (id, "projectId", "assistantId") VALUES ('av2-merge-binding', 'av2-project', 'av2-merge');

INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", title, "memoryMode", "updatedAt") VALUES
 ('av2-chat-personal', 'av2-owner', NULL, NULL, '', 'Latest Assistant run wins', 'EXCLUDED', '2026-01-02 00:00:00'),
 ('av2-chat-archived', 'av2-owner', NULL, NULL, '', 'Latest Assistant archived', 'EXCLUDED', '2026-01-02 00:00:00'),
 ('av2-chat-deleting', 'av2-owner', NULL, NULL, '', 'Pending permanent deletion', 'EXCLUDED', '2026-01-02 00:00:00'),
 ('av2-chat-plain', 'av2-owner', NULL, NULL, '', 'Ordinary chat', 'EXCLUDED', '2026-01-02 00:00:00'),
 ('av2-chat-project', NULL, 'av2-project', 'av2-owner', 'Fixture owner', 'Bound Project Assistant', 'EXCLUDED', '2026-01-02 00:00:00'),
 ('av2-chat-project-unbound', NULL, 'av2-project', 'av2-owner', 'Fixture owner', 'Unbound Project Assistant', 'EXCLUDED', '2026-01-02 00:00:00');
INSERT INTO "Message" (id, "chatId", role, content, status, "authorUserId", "authorDisplayName", "authorProjectRole", "updatedAt")
SELECT id || '-question', id, 'user', '{"blocks":[]}', 'complete',
  CASE WHEN "projectId" IS NULL THEN NULL ELSE 'av2-owner' END,
  CASE WHEN "projectId" IS NULL THEN NULL ELSE 'Fixture owner' END,
  CASE WHEN "projectId" IS NULL THEN NULL ELSE 'OWNER'::"ProjectRole" END, now()
FROM "Chat" WHERE id LIKE 'av2-chat-%';
INSERT INTO "Message" (id, "chatId", "parentMessageId", role, content, status, "updatedAt")
SELECT run.id || '-answer', run.chat, run.chat || '-question', 'assistant', '{"blocks":[]}', 'complete', now()
FROM (VALUES
 ('av2-run-personal-1', 'av2-chat-personal'), ('av2-run-personal-2', 'av2-chat-personal'), ('av2-run-personal-3', 'av2-chat-personal'),
 ('av2-run-archived-1', 'av2-chat-archived'), ('av2-run-archived-2', 'av2-chat-archived'),
 ('av2-run-deleting', 'av2-chat-deleting'), ('av2-run-plain', 'av2-chat-plain'),
 ('av2-run-project', 'av2-chat-project'), ('av2-run-project-unbound', 'av2-chat-project-unbound')
) AS run(id, chat);
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", "assistantId", "assistantIdentity",
  provider, "modelId", status, "normalizedRequest", "createdAt", "updatedAt")
SELECT run.id, run.chat, 'av2-owner', run.chat || '-question', run.id || '-answer', run.assistant,
  CASE WHEN run.assistant IS NULL THEN NULL ELSE ${identity("Accepted identity")} END,
  'fake', 'fixture', 'complete', '{"prompt":{"system":"Accepted instructions"}}', run.created, now()
FROM (VALUES
 ('av2-run-personal-1', 'av2-chat-personal', 'av2-merge', timestamp '2026-01-01 01:00:00'),
 ('av2-run-personal-2', 'av2-chat-personal', 'av2-exact', timestamp '2026-01-01 02:00:00'),
 ('av2-run-personal-3', 'av2-chat-personal', NULL, timestamp '2026-01-01 03:00:00'),
 ('av2-run-archived-1', 'av2-chat-archived', 'av2-merge', timestamp '2026-01-01 01:00:00'),
 ('av2-run-archived-2', 'av2-chat-archived', 'av2-archived', timestamp '2026-01-01 02:00:00'),
 ('av2-run-deleting', 'av2-chat-deleting', 'av2-merge', timestamp '2026-01-01 01:00:00'),
 ('av2-run-plain', 'av2-chat-plain', NULL, timestamp '2026-01-01 01:00:00'),
 ('av2-run-project', 'av2-chat-project', 'av2-merge', timestamp '2026-01-01 01:00:00'),
 ('av2-run-project-unbound', 'av2-chat-project-unbound', 'av2-exact', timestamp '2026-01-01 01:00:00')
) AS run(id, chat, assistant, created);
INSERT INTO "ProjectRunBinding" ("modelRunId", "projectId", "initiatorUserId", "acceptedRole", "accessRevision",
  "policyRevision", "instructionsRevision", "memoryRevision")
SELECT id, 'av2-project', 'av2-owner', 'OWNER', 1, 1, 1, 0 FROM "ModelRun" WHERE "chatId" IN ('av2-chat-project', 'av2-chat-project-unbound');
INSERT INTO "MemoryDeletionOutbox" (id, "userId", operation, "targetType", "targetId", "memoryGeneration",
  "admissionAuthorizationId", "admittedChatSourceRevision", "alsoForgetOriginMemories", "updatedAt")
VALUES ('av2-deletion', 'av2-owner', 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', 'av2-chat-deleting', 0,
  'av2-deletion-admission', 0, false, now());
UPDATE "Chat" SET archived = true, "permanentDeletionAt" = now(), "permanentDeletionOperationId" = 'av2-deletion',
  "updatedAt" = '2026-01-02 00:00:00' WHERE id = 'av2-chat-deleting';
COMMIT;
`;

export const assistantsV2AdoptionProofSql = `
DO $$
DECLARE fence INTEGER; event_cursor BIGINT; detached JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id LIKE 'av2-%' AND (
      "modelPolicy" <> 'fixed' OR "searchPolicy" <> 'fixed' OR "toolsPolicy" <> 'fixed' OR
      "knowledgePolicy" <> 'fixed' OR "skillsPolicy" <> 'fixed' OR "developerPrompt" IS NOT NULL OR
      "answerRules" IS NOT NULL OR "providerModelId" IS DISTINCT FROM 'av2-model' OR
      "updatedAt" <> timestamp '2026-01-01 00:00:00')) THEN
    RAISE EXCEPTION 'assistants_v2_rows_not_fixed_or_touched';
  END IF;
  IF (SELECT jsonb_object_agg(id, jsonb_build_array(version, "controlsPolicy", "mcpMode", "searchPlan"))
      FROM "AssistantDefinition" WHERE id LIKE 'av2-%') IS DISTINCT FROM '{
        "av2-merge": [3, "adjustable", "off", {"mode":"off"}],
        "av2-exact": [5, "fixed", "exact", {"mode":"model_choice","optionIds":["fixture-search"]}],
        "av2-archived": [2, "adjustable", "off", {"mode":"off"}],
        "av2-long": [7, "fixed", "off", {"mode":"off"}],
        "av2-blank": [1, "adjustable", "off", {"mode":"all_selected","optionIds":["fixture-search"]}]
      }'::jsonb THEN
    RAISE EXCEPTION 'assistants_v2_rows_not_adopted';
  END IF;
  IF (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'av2-merge') <> E'System rules\\n\\nDeveloper rules' OR
     (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'av2-exact') <> 'Exact rules' OR
     (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'av2-archived') <> 'Archived rules' OR
     (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'av2-long') <> repeat('s', 32000) || repeat('d', 16000) OR
     (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'av2-blank') <> 'Blank rules' OR
     (SELECT cardinality("starterPrompts") FROM "AssistantDefinition" WHERE id = 'av2-merge') <> 4 THEN
    RAISE EXCEPTION 'assistants_v2_instructions_not_merged';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProjectEvent" WHERE "projectId" = 'av2-project' AND "eventType" = 'assistant_definition_changed') OR
     (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AssistantDefinition"'::regclass AND tgenabled = 'O'
       AND tgname IN ('AssistantDefinition_version', 'AssistantDefinition_project_invalidation')) <> 2 THEN
    RAISE EXCEPTION 'assistants_v2_adoption_invalidated_projects';
  END IF;
  IF (SELECT jsonb_object_agg(id, "assistantId") FROM "Chat" WHERE id LIKE 'av2-chat-%') IS DISTINCT FROM '{
        "av2-chat-personal": "av2-exact", "av2-chat-archived": null, "av2-chat-deleting": null,
        "av2-chat-plain": null, "av2-chat-project": "av2-merge", "av2-chat-project-unbound": null
      }'::jsonb OR
     EXISTS (SELECT 1 FROM "Chat" WHERE id LIKE 'av2-chat-%' AND
       ("updatedAt" <> timestamp '2026-01-02 00:00:00' OR "assistantOverrides" IS NOT NULL)) OR
     EXISTS (SELECT 1 FROM "ModelRun" WHERE id LIKE 'av2-run-%' AND "assistantId" IS NOT NULL AND
       "assistantIdentity" ->> 'name' IS DISTINCT FROM 'Accepted identity') OR
     (SELECT "defaultAssistantId" FROM "UserSettings" WHERE id = 'av2-settings') IS NOT NULL OR
     EXISTS (SELECT 1 FROM "AssistantPublication" WHERE "featuredOrder" IS NOT NULL) THEN
    RAISE EXCEPTION 'assistants_v2_bindings_not_adopted';
  END IF;

  -- Previous-release writers omit every new column and stay valid.
  INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "providerModelId", "systemPrompt", "developerPrompt", "searchPlan", "updatedAt")
  VALUES ('av2-legacy-writer', 'av2-owner', 'Legacy writer', ${avatar}, 'av2-model', 'Legacy', 'Legacy developer',
    '{"mode":"all_selected","optionIds":[]}', now());
  IF NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id = 'av2-legacy-writer'
      AND "controlsPolicy" = 'adjustable' AND "mcpMode" = 'off' AND "modelPolicy" = 'fixed') THEN
    RAISE EXCEPTION 'assistants_v2_defaults_incoherent';
  END IF;

  SELECT version INTO fence FROM "AssistantDefinition" WHERE id = 'av2-merge';
  SELECT coalesce(max(sequence), 0) INTO event_cursor FROM "ProjectEvent";
  UPDATE "AssistantDefinition" SET name = 'Future merge' WHERE id = 'av2-merge';
  IF (SELECT version FROM "AssistantDefinition" WHERE id = 'av2-merge') <= fence OR
     NOT EXISTS (SELECT 1 FROM "ProjectEvent" WHERE sequence > event_cursor AND "projectId" = 'av2-project'
       AND "eventType" = 'assistant_definition_changed') THEN
    RAISE EXCEPTION 'assistants_v2_live_edit_lost_fence';
  END IF;

  BEGIN UPDATE "AssistantDefinition" SET "providerModelId" = NULL WHERE id = 'av2-exact';
    RAISE EXCEPTION 'fixed_model_inherit_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "controlsPolicy" = 'fixed' WHERE id = 'av2-merge';
    RAISE EXCEPTION 'fixed_empty_controls_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "searchPlan" = '{"mode":"inherit"}' WHERE id = 'av2-merge';
    RAISE EXCEPTION 'fixed_search_inherit_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "knowledgeSelection" = '{"mode":"inherit"}' WHERE id = 'av2-merge';
    RAISE EXCEPTION 'fixed_knowledge_inherit_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "mcpMode" = 'inherit' WHERE id = 'av2-merge';
    RAISE EXCEPTION 'fixed_tools_inherit_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "mcpMode" = 'exact' WHERE id = 'av2-merge';
    RAISE EXCEPTION 'empty_exact_tools_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "mcpMode" = 'off' WHERE id = 'av2-exact';
    RAISE EXCEPTION 'off_tools_with_servers_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "answerRules" = repeat('a', 4001) WHERE id = 'av2-merge';
    RAISE EXCEPTION 'oversized_answer_rules_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "systemPrompt" = repeat('s', 48001) WHERE id = 'av2-merge';
    RAISE EXCEPTION 'oversized_system_prompt_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantDefinition" SET "starterPrompts" = ARRAY['1','2','3','4','5','6','7'] WHERE id = 'av2-merge';
    RAISE EXCEPTION 'seven_starters_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE "AssistantDefinition" SET "modelPolicy" = 'adjustable', "providerModelId" = NULL,
    "searchPolicy" = 'adjustable', "searchPlan" = '{"mode":"inherit"}',
    "toolsPolicy" = 'adjustable', "mcpMode" = 'inherit',
    "knowledgePolicy" = 'adjustable', "knowledgeSelection" = '{"mode":"inherit"}',
    "starterPrompts" = ARRAY['1','2','3','4','5','6'], "answerRules" = repeat('a', 4000),
    "systemPrompt" = repeat('s', 48000)
  WHERE id = 'av2-blank';

  BEGIN UPDATE "Chat" SET "assistantOverrides" = '[]' WHERE id = 'av2-chat-plain';
    RAISE EXCEPTION 'non_object_overrides_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE "Chat" SET "assistantOverrides" = '{"search":{"mode":"off"}}' WHERE id = 'av2-chat-plain';

  UPDATE "AssistantPublication" SET "featuredOrder" = 0 WHERE id = 'av2-merge-installation';
  BEGIN UPDATE "AssistantPublication" SET "featuredOrder" = 1 WHERE id = 'av2-merge-group';
    RAISE EXCEPTION 'group_featured_order_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantPublication" SET "featuredOrder" = -1 WHERE id = 'av2-merge-installation';
    RAISE EXCEPTION 'negative_featured_order_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO "AssistantPublication" (id, "assistantId", scope, "featuredOrder", "updatedAt")
    VALUES ('av2-long-installation', 'av2-long', 'installation', 0, now());
    RAISE EXCEPTION 'duplicate_featured_order_allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;

  INSERT INTO "AssistantListingRequest" (id, "assistantId", "requestedByUserId", "definitionVersion")
  SELECT 'av2-request', id, "ownerUserId", version FROM "AssistantDefinition" WHERE id = 'av2-merge';
  BEGIN INSERT INTO "AssistantListingRequest" (id, "assistantId", "requestedByUserId", "definitionVersion")
    VALUES ('av2-request-twin', 'av2-merge', 'av2-owner', 1);
    RAISE EXCEPTION 'second_pending_listing_allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO "AssistantListingRequest" (id, "assistantId", "requestedByUserId", "definitionVersion")
    VALUES ('av2-request-foreign', 'av2-long', 'av2-other', 1);
    RAISE EXCEPTION 'non_owner_listing_allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN UPDATE "AssistantListingRequest" SET state = 'approved' WHERE id = 'av2-request';
    RAISE EXCEPTION 'unreviewed_approval_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE "AssistantListingRequest" SET state = 'approved', "reviewedAt" = now(), "reviewedByUserId" = 'av2-other'
  WHERE id = 'av2-request';
  BEGIN UPDATE "AssistantListingRequest" SET "reviewNote" = 'Late note' WHERE id = 'av2-request';
    RAISE EXCEPTION 'decided_listing_rewritten'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "AssistantListingRequest" SET "definitionVersion" = "definitionVersion" + 1 WHERE id = 'av2-request';
    RAISE EXCEPTION 'listing_version_rewritten'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE "AssistantListingRequest" SET "reviewedByUserId" = NULL WHERE id = 'av2-request';
  INSERT INTO "AssistantListingRequest" (id, "assistantId", "requestedByUserId", "definitionVersion") VALUES
   ('av2-request-next', 'av2-merge', 'av2-owner', 1), ('av2-request-exact', 'av2-exact', 'av2-owner', 5);

  BEGIN UPDATE "ModelRun" SET "assistantIdentity" = '{"name":"Replacement","avatar":{}}' WHERE id = 'av2-run-personal-2';
    RAISE EXCEPTION 'accepted_identity_rewrite_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "ModelRun" SET "assistantId" = 'av2-merge' WHERE id = 'av2-run-personal-2';
    RAISE EXCEPTION 'accepted_assistant_rewrite_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "ModelRun" SET "assistantId" = NULL WHERE id = 'av2-run-personal-2';
    RAISE EXCEPTION 'live_assistant_detach_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE "ModelRun" SET "assistantId" = NULL, "assistantIdentity" = NULL WHERE id = 'av2-run-personal-2';
    RAISE EXCEPTION 'accepted_identity_erased'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM "AssistantDefinition" WHERE id = 'av2-merge';
    RAISE EXCEPTION 'published_assistant_deleted'; EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;

  UPDATE "UserSettings" SET "defaultAssistantId" = 'av2-exact' WHERE id = 'av2-settings';
  INSERT INTO "AssistantPin" ("userId", "assistantId") VALUES ('av2-other', 'av2-exact');
  SELECT jsonb_object_agg(id, "assistantIdentity") INTO detached FROM "ModelRun" WHERE "assistantId" = 'av2-exact';
  DELETE FROM "AssistantDefinition" WHERE id = 'av2-exact';
  IF (SELECT jsonb_object_agg(id, "assistantIdentity") FROM "ModelRun" WHERE id IN ('av2-run-personal-2', 'av2-run-project-unbound'))
       IS DISTINCT FROM detached OR
     jsonb_typeof(detached -> 'av2-run-personal-2') <> 'object' OR
     EXISTS (SELECT 1 FROM "ModelRun" WHERE id IN ('av2-run-personal-2', 'av2-run-project-unbound') AND "assistantId" IS NOT NULL) OR
     (SELECT "assistantId" FROM "Chat" WHERE id = 'av2-chat-personal') IS NOT NULL OR
     (SELECT "updatedAt" FROM "Chat" WHERE id = 'av2-chat-personal') <> timestamp '2026-01-02 00:00:00' OR
     (SELECT "defaultAssistantId" FROM "UserSettings" WHERE id = 'av2-settings') IS NOT NULL OR
     EXISTS (SELECT 1 FROM "AssistantListingRequest" WHERE id = 'av2-request-exact') OR
     EXISTS (SELECT 1 FROM "AssistantPin" WHERE "assistantId" = 'av2-exact') THEN
    RAISE EXCEPTION 'assistant_delete_rewrote_or_kept_references';
  END IF;

  IF (SELECT count(*) FROM pg_constraint AS c
      WHERE c.conname IN ('MemoryRecallChunk_assistant_fkey', 'MemoryRecallRound_assistant_fkey', 'ChatMemoryDigest_assistant_fkey')
        AND c.confdeltype = 'n'
        AND c.confdelsetcols = ARRAY[(SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = c.conrelid AND a.attname = 'sourceAssistantId')]::int2[]) <> 3 OR
     (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('MemoryScope_assistant_fkey', 'AssistantPublication_assistantId_fkey',
        'ProjectAssistantBinding_assistantId_fkey') AND confdeltype = 'r') <> 3 OR
     (SELECT confdeltype FROM pg_constraint WHERE conname = 'ModelRun_assistantId_fkey') <> 'n' THEN
    RAISE EXCEPTION 'assistant_delete_references_not_adopted';
  END IF;
END;
$$;
`;
