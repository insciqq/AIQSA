/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const SKILLS_PROGRESSIVE_MIGRATION = "20260921043000_skill_progressive_delivery";

export const skillsProgressiveFixtureSql = `
BEGIN;
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES ('progressive-owner','Fixture owner','active',now());
INSERT INTO "UserSettings" (id,"userId","updatedAt") VALUES ('progressive-settings','progressive-owner',now());
INSERT INTO "ProviderConnection" (id,"displayName",family,"updatedAt") VALUES ('progressive-provider','Fixture provider','fake',now());
INSERT INTO "ProviderModel" (id,"connectionId",provider,"modelId","displayName",capabilities,"defaultParams","updatedAt")
VALUES ('progressive-model','progressive-provider','fake','fixture','Fixture model','{}','{}',now());
INSERT INTO "AssistantDefinition" (id,"ownerUserId",name,avatar,"providerModelId","systemPrompt","searchPlan","updatedAt")
VALUES ('progressive-assistant','progressive-owner','Fixture Assistant',
 '{"kind":"generated","recipeVersion":1,"paletteId":"ember","backgroundShape":"circle","foregroundShape":"ring","rotations":[0,0],"accents":[]}',
 'progressive-model','Fixture instructions','{"mode":"all_selected","optionIds":[]}',now());
INSERT INTO "SkillDefinition" (id,"ownerUserId","updatedAt")
SELECT 'progressive-' || value,'progressive-owner',now() FROM unnest(ARRAY['a','b','c','d','e']) AS value;
INSERT INTO "SkillRevision" (id,"skillId","revisionNumber",name,instructions)
SELECT id || '-r',id,1,CASE id WHEN 'progressive-a' THEN 'Same name' WHEN 'progressive-b' THEN 'Same-name'
 WHEN 'progressive-c' THEN 'Проверка' WHEN 'progressive-d' THEN repeat('A',80) ELSE 'Loaded workflow' END,'Fixture instructions'
FROM "SkillDefinition" WHERE id LIKE 'progressive-%';
UPDATE "SkillDefinition" SET "currentRevisionId"=id || '-r' WHERE id LIKE 'progressive-%';
INSERT INTO "AssistantSkill" ("assistantId","skillId",ordinal) VALUES ('progressive-assistant','progressive-a',0);
INSERT INTO "Chat" (id,"userId",title,"memoryMode","updatedAt") VALUES ('progressive-chat','progressive-owner','Fixture chat','EXCLUDED',now());
INSERT INTO "Message" (id,"chatId",role,content,status,"updatedAt") VALUES
 ('progressive-question','progressive-chat','user','{"blocks":[]}','complete',now()),
 ('progressive-answer-1','progressive-chat','assistant','{"blocks":[]}','complete',now()),
 ('progressive-answer-2','progressive-chat','assistant','{"blocks":[]}','complete',now());
UPDATE "Message" SET "parentMessageId"='progressive-question' WHERE id LIKE 'progressive-answer-%';
INSERT INTO "ModelRun" (id,"chatId","userId","userMessageId","assistantMessageId",provider,"modelId",status,"normalizedRequest","updatedAt")
SELECT 'progressive-run-' || value,'progressive-chat','progressive-owner','progressive-question','progressive-answer-' || value,'fake','fixture','complete',
 jsonb_build_object('skills',jsonb_build_array(
  jsonb_build_object('skillId','progressive-b','revisionId','progressive-b-r','name','Same-name'),
  jsonb_build_object('skillId','progressive-a','revisionId','progressive-a-r','name','Same name'),
  jsonb_build_object('skillId','progressive-c','revisionId','progressive-c-r','name','Проверка'),
  jsonb_build_object('skillId','progressive-d','revisionId','progressive-d-r','name',repeat('A',80)))),now()
FROM unnest(ARRAY['1','2']) AS value;
INSERT INTO "ModelRunSkillBinding" ("modelRunId","skillId","revisionId")
SELECT 'progressive-run-1',id,id || '-r' FROM "SkillDefinition" WHERE id IN ('progressive-a','progressive-b','progressive-c','progressive-d') ORDER BY id;
COMMIT;
`;

export const skillsProgressiveProofSql = `
DO $$ BEGIN
 IF aiqsa_skill_run_alias('İA K', ARRAY[]::text[]) <> 'i-a-k'
  OR aiqsa_skill_run_alias('same name', ARRAY['same-name','same-name-2']) <> 'same-name-3' THEN
  RAISE EXCEPTION 'progressive_alias_normalization_incorrect'; END IF;
 IF (SELECT "mode" FROM "AssistantSkill" WHERE "assistantId"='progressive-assistant') <> 'pinned'
  OR (SELECT "skillsMode" FROM "AssistantDefinition" WHERE id='progressive-assistant') <> 'auto'
  OR (SELECT "defaultSkillsMode" FROM "UserSettings" WHERE id='progressive-settings') <> 'auto'
  OR EXISTS(SELECT 1 FROM "UserSkillPreference" WHERE "userId"='progressive-owner') THEN
  RAISE EXCEPTION 'progressive_defaults_incorrect'; END IF;
 IF EXISTS(SELECT 1 FROM "ModelRunSkillBinding" WHERE "modelRunId"='progressive-run-1' AND
  (mode <> 'pinned' OR "modelRunToolCallId" IS NOT NULL OR alias <> CASE "skillId"
    WHEN 'progressive-a' THEN 'same-name-2' WHEN 'progressive-b' THEN 'same-name'
    WHEN 'progressive-c' THEN 'skill' ELSE repeat('a',64) END)) THEN
  RAISE EXCEPTION 'progressive_historical_alias_incorrect'; END IF;
 IF jsonb_typeof((SELECT "normalizedRequest"->'skills' FROM "ModelRun" WHERE id='progressive-run-1')) <> 'array'
  OR (SELECT name FROM "SkillRevision" WHERE id='progressive-d-r') <> repeat('A',80) THEN
  RAISE EXCEPTION 'progressive_history_rewritten'; END IF;
END $$;
-- Old writers insert in skill-id order; the accepted manifest has a different
-- order, which must still produce exactly the aliases used during backfill.
INSERT INTO "ModelRunSkillBinding" ("modelRunId","skillId","revisionId")
SELECT 'progressive-run-2',id,id || '-r' FROM "SkillDefinition" WHERE id IN ('progressive-a','progressive-b','progressive-c','progressive-d') ORDER BY id;
INSERT INTO "ModelRunToolCall" (id,"modelRunId","roundIndex",ordinal,"providerCallId","toolName",arguments,"updatedAt")
VALUES ('progressive-call','progressive-run-2',0,0,'fixture-call','load_skill','{}',now());
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "ModelRunSkillBinding" AS old JOIN "ModelRunSkillBinding" AS fresh ON fresh."skillId"=old."skillId"
   WHERE old."modelRunId"='progressive-run-1' AND fresh."modelRunId"='progressive-run-2' AND old.alias <> fresh.alias) THEN
  RAISE EXCEPTION 'progressive_old_writer_alias_incorrect'; END IF;
 BEGIN
  INSERT INTO "ModelRunSkillBinding" ("modelRunId","skillId","revisionId",mode,alias,"modelRunToolCallId")
  VALUES ('progressive-run-1','progressive-e','progressive-e-r','loaded','loaded-workflow','progressive-call');
  SET CONSTRAINTS "ModelRunSkillBinding_modelRunId_modelRunToolCallId_fkey" IMMEDIATE;
  RAISE EXCEPTION 'progressive_cross_run_call_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ModelRunSkillBinding" ("modelRunId","skillId","revisionId",mode,alias)
  VALUES ('progressive-run-1','progressive-e','progressive-e-r','loaded','loaded-workflow');
  RAISE EXCEPTION 'progressive_loaded_call_missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO "ModelRunSkillBinding" ("modelRunId","skillId","revisionId",mode,alias,"modelRunToolCallId")
VALUES ('progressive-run-2','progressive-e','progressive-e-r','loaded','loaded-workflow','progressive-call');
DELETE FROM "ModelRun" WHERE id='progressive-run-2';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "ModelRunSkillBinding" WHERE "modelRunId"='progressive-run-2')
  OR EXISTS(SELECT 1 FROM "ModelRunToolCall" WHERE "modelRunId"='progressive-run-2') THEN
  RAISE EXCEPTION 'progressive_run_cascade_failed'; END IF;
END $$;
`;
