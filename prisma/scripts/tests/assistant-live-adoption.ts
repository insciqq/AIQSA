/** Disposable predecessor fixtures for the live Assistant forward migration.
 * The migration contract owns database creation, acknowledgement, and cleanup. */
export const ASSISTANT_LIVE_MIGRATION = "20260905055000_live_assistant_definitions";

export const assistantLiveAdoptionFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('assistant-adoption-owner', 'Fixture owner', 'active', now());
INSERT INTO "Group" (id, name, "updatedAt") VALUES ('assistant-adoption-group', 'Fixture group', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('assistant-adoption-provider', 'Fixture provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "capabilities", "defaultParams", "updatedAt")
VALUES ('assistant-adoption-model', 'assistant-adoption-provider', 'fake', 'fixture', 'Fixture model', '{}', '{}', now());
INSERT INTO "AssistantDefinition" (id, "ownerUserId", version, "updatedAt")
VALUES ('assistant-adoption-definition', 'assistant-adoption-owner', 2, now());
INSERT INTO "AssistantRevision" (id, "assistantId", "revisionNumber", name, avatar, "providerModelId", "systemPrompt", "searchPlan")
VALUES
 ('assistant-adoption-old', 'assistant-adoption-definition', 1, 'Historical identity',
  '{"kind":"generated","recipeVersion":1,"paletteId":"ember","backgroundShape":"circle","foregroundShape":"ring","rotations":[0,0],"accents":[]}',
  'assistant-adoption-model', 'Historical instructions', '{"mode":"all_selected","optionIds":[]}'),
 ('assistant-adoption-current', 'assistant-adoption-definition', 2, 'Current identity',
  '{"kind":"generated","recipeVersion":1,"paletteId":"ocean","backgroundShape":"square","foregroundShape":"diamond","rotations":[1,2],"accents":[0]}',
  'assistant-adoption-model', 'Current instructions', '{"mode":"all_selected","optionIds":[]}');
UPDATE "AssistantDefinition" SET "currentRevisionId" = 'assistant-adoption-current' WHERE id = 'assistant-adoption-definition';
INSERT INTO "SkillDefinition" (id, "ownerUserId", "updatedAt") VALUES
 ('assistant-adoption-skill-old', 'assistant-adoption-owner', now()),
 ('assistant-adoption-skill-current', 'assistant-adoption-owner', now());
INSERT INTO "SkillRevision" (id, "skillId", "revisionNumber", name, instructions) VALUES
 ('assistant-adoption-skill-old-r', 'assistant-adoption-skill-old', 1, 'Old skill', 'Old skill text'),
 ('assistant-adoption-skill-current-r', 'assistant-adoption-skill-current', 1, 'Current skill', 'Current skill text');
UPDATE "SkillDefinition" SET "currentRevisionId" = id || '-r' WHERE id LIKE 'assistant-adoption-skill-%';
INSERT INTO "AssistantRevisionSkill" ("assistantRevisionId", "skillId", ordinal) VALUES
 ('assistant-adoption-old', 'assistant-adoption-skill-old', 0),
 ('assistant-adoption-current', 'assistant-adoption-skill-current', 0),
 ('assistant-adoption-current', 'assistant-adoption-skill-old', 1);
INSERT INTO "AssistantPublication" (id, "assistantId", "revisionId", scope, "groupId", "updatedAt") VALUES
 ('assistant-adoption-group-grant', 'assistant-adoption-definition', 'assistant-adoption-old', 'group', 'assistant-adoption-group', now()),
 ('assistant-adoption-installation-grant', 'assistant-adoption-definition', 'assistant-adoption-old', 'installation', NULL, now());
INSERT INTO "Project" (id, name, "createdByDisplayName", "updatedAt") VALUES
 ('assistant-adoption-project', 'Fixture Project', 'Fixture owner', now());
INSERT INTO "ProjectGrant" (id, "projectId", "userId", role, "updatedAt") VALUES
 ('assistant-adoption-project-owner', 'assistant-adoption-project', 'assistant-adoption-owner', 'OWNER', now());
INSERT INTO "ProjectAssistantBinding" (id, "projectId", "assistantId", "revisionId") VALUES
 ('assistant-adoption-project-grant', 'assistant-adoption-project', 'assistant-adoption-definition', 'assistant-adoption-old');
INSERT INTO "Chat" (id, "userId", title, "memoryMode", "updatedAt") VALUES
 ('assistant-adoption-chat', 'assistant-adoption-owner', 'Fixture chat', 'EXCLUDED', now());
INSERT INTO "Message" (id, "chatId", role, content, status, "updatedAt") VALUES
 ('assistant-adoption-question', 'assistant-adoption-chat', 'user', '{"blocks":[{"type":"text","text":"Fixture question"}]}', 'complete', now()),
 ('assistant-adoption-answer', 'assistant-adoption-chat', 'assistant', '{"blocks":[{"type":"text","text":"Historical answer"}]}', 'complete', now());
UPDATE "Message" SET "parentMessageId" = 'assistant-adoption-question' WHERE id = 'assistant-adoption-answer';
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", "assistantId", "assistantRevisionId", provider, "modelId", status, "normalizedRequest", "updatedAt") VALUES
 ('assistant-adoption-run', 'assistant-adoption-chat', 'assistant-adoption-owner', 'assistant-adoption-question', 'assistant-adoption-answer',
 'assistant-adoption-definition', 'assistant-adoption-old', 'fake', 'fixture', 'complete',
 '{"prompt":{"system":"Historical instructions"},"context":{"messages":[]},"params":{"temperature":0.3}}', now());
INSERT INTO "Message" (id, "chatId", "parentMessageId", role, content, status, "updatedAt") VALUES
 ('assistant-adoption-pdf-answer', 'assistant-adoption-chat', 'assistant-adoption-question', 'assistant', '{"blocks":[]}', 'error', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", "assistantId", "assistantRevisionId", provider, "modelId", status, "normalizedRequest", "updatedAt") VALUES
 ('assistant-adoption-pdf-run', 'assistant-adoption-chat', 'assistant-adoption-owner', 'assistant-adoption-question', 'assistant-adoption-pdf-answer',
 'assistant-adoption-definition', 'assistant-adoption-old', 'fake', 'fixture', 'error',
 '{"prompt":{"system":"Historical instructions"},"context":{"messages":[]},"params":{"temperature":0.3}}', now());
INSERT INTO "ChatPdfRunPreparation" ("modelRunId", "admissionKey", state, snapshot, "updatedAt") VALUES
 ('assistant-adoption-pdf-run', repeat('a',64), 'failed',
 '{"version":1,"prepared":{"assistant":{"assistantId":"assistant-adoption-definition","revisionId":"assistant-adoption-old"},"skillBindings":[{"skillId":"assistant-adoption-skill-old","revisionId":"assistant-adoption-skill-old-r"},{"skillId":"assistant-adoption-skill-current","revisionId":"assistant-adoption-skill-current-r"}],"normalizedRequest":{"prompt":{"system":"Historical instructions"}}}}', now());
UPDATE "Chat" SET "activeLeafMessageId" = 'assistant-adoption-answer' WHERE id = 'assistant-adoption-chat';
COMMIT;
`;

export const assistantLiveAdoptionProofSql = `
DO $$
DECLARE original_request JSONB; original_identity JSONB; fence INTEGER; event_cursor BIGINT;
BEGIN
  IF to_regclass('"AssistantRevision"') IS NOT NULL OR to_regclass('"AssistantRevisionSkill"') IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete_assistant_storage_survived';
  END IF;
  IF (SELECT name FROM "AssistantDefinition" WHERE id = 'assistant-adoption-definition') <> 'Current identity' OR
     (SELECT "systemPrompt" FROM "AssistantDefinition" WHERE id = 'assistant-adoption-definition') <> 'Current instructions' THEN
    RAISE EXCEPTION 'current_definition_not_adopted';
  END IF;
  IF (SELECT array_agg("skillId" ORDER BY ordinal) FROM "AssistantSkill" WHERE "assistantId" = 'assistant-adoption-definition') IS DISTINCT FROM
     ARRAY['assistant-adoption-skill-current','assistant-adoption-skill-old'] THEN
    RAISE EXCEPTION 'current_ordered_skills_not_adopted';
  END IF;
  IF (SELECT count(*) FROM "AssistantPublication" WHERE "assistantId" = 'assistant-adoption-definition') <> 2 OR
     (SELECT count(*) FROM "ProjectAssistantBinding" WHERE "assistantId" = 'assistant-adoption-definition') <> 1 OR
     (SELECT count(*) FROM "ProjectModelBinding" WHERE "projectId" = 'assistant-adoption-project') <> 0 OR
     (SELECT count(*) FROM "ProjectSkillBinding" WHERE "projectId" = 'assistant-adoption-project') <> 0 OR
     (SELECT count(*) FROM "SkillPublication" WHERE "skillId" LIKE 'assistant-adoption-skill-%') <> 0 THEN
    RAISE EXCEPTION 'publication_adoption_changed_authority';
  END IF;
  SELECT "normalizedRequest", "assistantIdentity" INTO original_request, original_identity
    FROM "ModelRun" WHERE id = 'assistant-adoption-run';
  IF original_identity ->> 'name' <> 'Historical identity' OR
     original_identity #>> '{avatar,paletteId}' <> 'ember' OR
     original_request #>> '{prompt,system}' <> 'Historical instructions' OR
     original_request #>> '{params,temperature}' <> '0.3' OR
     (SELECT content #>> '{blocks,0,text}' FROM "Message" WHERE id = 'assistant-adoption-answer') <> 'Historical answer' THEN
    RAISE EXCEPTION 'accepted_history_changed';
  END IF;
  IF (SELECT snapshot #>> '{prepared,assistant,identity,name}' FROM "ChatPdfRunPreparation") <> 'Historical identity' OR
     (SELECT snapshot #> '{prepared,manualSkillIds}' FROM "ChatPdfRunPreparation") IS DISTINCT FROM '["assistant-adoption-skill-current"]'::jsonb OR
     (SELECT snapshot #>> '{prepared,normalizedRequest,prompt,system}' FROM "ChatPdfRunPreparation") <> 'Historical instructions' THEN
    RAISE EXCEPTION 'pending_pdf_accepted_setup_not_adopted';
  END IF;
  SELECT version INTO fence FROM "AssistantDefinition" WHERE id = 'assistant-adoption-definition';
  SELECT coalesce(max(sequence), 0) INTO event_cursor FROM "ProjectEvent";
  UPDATE "AssistantDefinition" SET name = 'Future identity', "systemPrompt" = 'Future instructions'
    WHERE id = 'assistant-adoption-definition';
  IF (SELECT version FROM "AssistantDefinition" WHERE id = 'assistant-adoption-definition') <= fence OR
     NOT EXISTS (SELECT 1 FROM "ProjectEvent" WHERE sequence > event_cursor AND "projectId" = 'assistant-adoption-project'
       AND "eventType" = 'assistant_definition_changed' AND "entityId" IS NULL AND "entityType" IS NULL) OR
     (SELECT "assistantIdentity" FROM "ModelRun" WHERE id = 'assistant-adoption-run') IS DISTINCT FROM original_identity OR
     (SELECT "normalizedRequest" FROM "ModelRun" WHERE id = 'assistant-adoption-run') IS DISTINCT FROM original_request THEN
    RAISE EXCEPTION 'live_edit_rewrote_history_or_lost_invalidation';
  END IF;
  BEGIN
    UPDATE "ModelRun" SET "assistantIdentity" = '{"name":"Replacement","avatar":{}}' WHERE id = 'assistant-adoption-run';
    RAISE EXCEPTION 'accepted_identity_rewrite_allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
`;
