-- Adopt the current definition before removing the obsolete revision domain.
-- Existing publications become live grants; they never mint dependency access.
BEGIN;

ALTER TABLE "AssistantDefinition"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "category" TEXT,
  ADD COLUMN "avatar" JSONB,
  ADD COLUMN "providerModelId" TEXT,
  ADD COLUMN "systemPrompt" TEXT,
  ADD COLUMN "developerPrompt" TEXT,
  ADD COLUMN "runControls" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "searchPlan" JSONB,
  ADD COLUMN "mcpServerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "knowledgeSelection" JSONB NOT NULL DEFAULT '{"baseIds":[],"mode":"none","sourceIds":[],"version":1}',
  ADD COLUMN "starterPrompts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "AssistantDefinition" d SET
  "name" = r."name", "description" = r."description", "category" = r."category",
  "avatar" = r."avatar", "providerModelId" = r."providerModelId",
  "systemPrompt" = r."systemPrompt", "developerPrompt" = r."developerPrompt",
  "runControls" = r."runControls", "searchPlan" = r."searchPlan",
  "mcpServerIds" = r."mcpServerIds", "knowledgeSelection" = r."knowledgeSelection",
  "starterPrompts" = r."starterPrompts"
FROM "AssistantRevision" r WHERE r."assistantId" = d."id" AND r."id" = d."currentRevisionId";

-- A missing current definition is corrupt state; do not invent executable content.
ALTER TABLE "AssistantDefinition"
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "avatar" SET NOT NULL,
  ALTER COLUMN "providerModelId" SET NOT NULL,
  ALTER COLUMN "systemPrompt" SET NOT NULL,
  ALTER COLUMN "searchPlan" SET NOT NULL,
  ADD CONSTRAINT "AssistantDefinition_providerModelId_fkey" FOREIGN KEY ("providerModelId")
    REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantDefinition_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "AssistantDefinition_description_check" CHECK (char_length("description") <= 400),
  ADD CONSTRAINT "AssistantDefinition_category_check" CHECK ("category" IS NULL OR char_length("category") BETWEEN 1 AND 40),
  ADD CONSTRAINT "AssistantDefinition_system_prompt_check" CHECK (char_length("systemPrompt") <= 32000),
  ADD CONSTRAINT "AssistantDefinition_developer_prompt_check" CHECK ("developerPrompt" IS NULL OR char_length("developerPrompt") <= 16000),
  ADD CONSTRAINT "AssistantDefinition_mcp_server_ids_check" CHECK (cardinality("mcpServerIds") <= 16),
  ADD CONSTRAINT "AssistantDefinition_starter_prompts_check" CHECK (cardinality("starterPrompts") <= 4);
CREATE INDEX "AssistantDefinition_providerModelId_idx" ON "AssistantDefinition"("providerModelId");

CREATE TABLE "AssistantSkill" (
  "assistantId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  CONSTRAINT "AssistantSkill_pkey" PRIMARY KEY ("assistantId", "skillId"),
  CONSTRAINT "AssistantSkill_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "AssistantSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AssistantSkill_assistantId_ordinal_key" ON "AssistantSkill"("assistantId", "ordinal");
CREATE INDEX "AssistantSkill_skillId_idx" ON "AssistantSkill"("skillId");
INSERT INTO "AssistantSkill" ("assistantId", "skillId", "ordinal")
SELECT d."id", link."skillId", link."ordinal" FROM "AssistantDefinition" d
JOIN "AssistantRevisionSkill" link ON link."assistantRevisionId" = d."currentRevisionId";

ALTER TABLE "ModelRun" ADD COLUMN "assistantIdentity" JSONB;
UPDATE "ModelRun" run SET "assistantIdentity" = jsonb_build_object('name', r."name", 'avatar', r."avatar")
FROM "AssistantRevision" r
WHERE r."assistantId" = run."assistantId" AND r."id" = run."assistantRevisionId";

-- Pending PDF continuations retain accepted execution. Replace only their
-- display/provenance pair, using the historical run rather than live content.
ALTER TABLE "ChatPdfRunPreparation" DISABLE TRIGGER "ChatPdfRunPreparation_guard";
UPDATE "ChatPdfRunPreparation" pdf SET "snapshot" = jsonb_set(pdf."snapshot", '{prepared,assistant}',
  jsonb_build_object('assistantId', run."assistantId", 'identity', run."assistantIdentity", 'definitionVersion', d."version"))
FROM "ModelRun" run JOIN "AssistantDefinition" d ON d."id" = run."assistantId"
WHERE pdf."modelRunId" = run."id" AND pdf."snapshot" #> '{prepared,assistant}' IS NOT NULL;
-- Separate explicit user Skill choices from the historical Assistant links so
-- a future PDF retry cannot silently retain Skills removed from the definition.
UPDATE "ChatPdfRunPreparation" pdf SET "snapshot" = jsonb_set(pdf."snapshot", '{prepared,manualSkillIds}', (
  SELECT coalesce(jsonb_agg(binding ->> 'skillId' ORDER BY ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(coalesce(pdf."snapshot" #> '{prepared,skillBindings}', '[]'::jsonb))
    WITH ORDINALITY AS bindings(binding, ordinal)
  WHERE NOT EXISTS (SELECT 1 FROM "AssistantRevisionSkill" link
    WHERE link."assistantRevisionId" = run."assistantRevisionId" AND link."skillId" = binding ->> 'skillId')
)) FROM "ModelRun" run
WHERE pdf."modelRunId" = run."id" AND run."assistantId" IS NOT NULL;
-- Finish deferred run/PDF owner and preparation checks before changing triggers or columns.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "ChatPdfRunPreparation" ENABLE TRIGGER "ChatPdfRunPreparation_guard";

ALTER TABLE "ModelRun"
  DROP CONSTRAINT "ModelRun_assistant_pair_check",
  DROP CONSTRAINT "ModelRun_assistantRevision_fkey",
  DROP COLUMN "assistantRevisionId",
  ADD CONSTRAINT "ModelRun_assistantId_fkey" FOREIGN KEY ("assistantId")
    REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRun_assistant_identity_check" CHECK (
    ("assistantId" IS NULL AND "assistantIdentity" IS NULL) OR
    ("assistantId" IS NOT NULL AND "assistantIdentity" IS NOT NULL AND
      jsonb_typeof("assistantIdentity") = 'object' AND
      "assistantIdentity" ?& ARRAY['name','avatar'] AND
      "assistantIdentity" - ARRAY['name','avatar'] = '{}'::jsonb AND
      jsonb_typeof("assistantIdentity" -> 'name') = 'string' AND
      char_length("assistantIdentity" ->> 'name') BETWEEN 1 AND 80 AND
      jsonb_typeof("assistantIdentity" -> 'avatar') = 'object' AND
      octet_length("assistantIdentity"::text) <= 2048)
  );
CREATE INDEX "ModelRun_assistantId_idx" ON "ModelRun"("assistantId");
ALTER TABLE "AssistantPublication" DROP CONSTRAINT "AssistantPublication_revision_fkey", DROP COLUMN "revisionId";
ALTER TABLE "ProjectAssistantBinding" DROP CONSTRAINT "ProjectAssistantBinding_assistantId_revisionId_fkey", DROP COLUMN "revisionId";
CREATE INDEX "ProjectAssistantBinding_assistantId_idx" ON "ProjectAssistantBinding"("assistantId");
ALTER TABLE "AssistantDefinition" DROP CONSTRAINT "AssistantDefinition_currentRevision_fkey", DROP COLUMN "currentRevisionId";
DROP TABLE "AssistantRevisionSkill";
DROP TABLE "AssistantRevision";

CREATE FUNCTION aiqsa_assistant_run_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assistantId" IS DISTINCT FROM OLD."assistantId" OR
     NEW."assistantIdentity" IS DISTINCT FROM OLD."assistantIdentity" THEN
    RAISE EXCEPTION 'accepted_assistant_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ModelRun_assistant_identity_immutable"
BEFORE UPDATE OF "assistantId", "assistantIdentity" ON "ModelRun"
FOR EACH ROW EXECUTE FUNCTION aiqsa_assistant_run_identity_immutable();

-- Every writer, including dependency deletion, advances the same optimistic
-- fence. No copied execution profile or hidden historical revision is stored.
CREATE FUNCTION aiqsa_assistant_definition_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['version','updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['version','updatedAt']) THEN
    NEW."version" := greatest(NEW."version", OLD."version" + 1);
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AssistantDefinition_version"
BEFORE UPDATE ON "AssistantDefinition" FOR EACH ROW EXECUTE FUNCTION aiqsa_assistant_definition_version();

CREATE FUNCTION aiqsa_assistant_skill_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id TEXT;
BEGIN
  -- Sorted parent locks make a moved link atomic for both definitions.
  FOR target_id IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD."assistantId" END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW."assistantId" END
  ]) id WHERE id IS NOT NULL ORDER BY id LOOP
    UPDATE "AssistantDefinition" SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = target_id;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "AssistantSkill_version"
BEFORE INSERT OR UPDATE OR DELETE ON "AssistantSkill" FOR EACH ROW EXECUTE FUNCTION aiqsa_assistant_skill_version();

-- Definition changes invalidate Project availability without touching grants,
-- policy, defaults, or placing private labels/content in the durable outbox.
CREATE FUNCTION aiqsa_assistant_project_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_project_id TEXT;
BEGIN
  IF NEW."version" IS NOT DISTINCT FROM OLD."version" THEN RETURN NEW; END IF;
  FOR target_project_id IN SELECT "projectId" FROM "ProjectAssistantBinding"
    WHERE "assistantId" = NEW."id" ORDER BY "projectId" LOOP
    INSERT INTO "ProjectEvent" ("projectId", "eventType")
      VALUES (target_project_id, 'assistant_definition_changed');
    PERFORM "aiqsa_prune_project_events"(target_project_id);
    PERFORM pg_notify('aiqsa_project_events', target_project_id);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AssistantDefinition_project_invalidation"
AFTER UPDATE ON "AssistantDefinition" FOR EACH ROW EXECUTE FUNCTION aiqsa_assistant_project_invalidation();

COMMIT;
