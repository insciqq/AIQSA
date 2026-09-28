-- Assistants v2 storage. Existing definitions keep today's behaviour: every row
-- stays fixed, an empty Search plan becomes explicit Off, the MCP mode follows
-- the stored list, and the retired developer prompt joins the system prompt.
-- Deleting a definition later detaches history instead of rewriting it.
BEGIN;

CREATE TYPE "AssistantRowPolicy" AS ENUM ('fixed', 'adjustable');
CREATE TYPE "AssistantMcpMode" AS ENUM ('inherit', 'off', 'exact');
CREATE TYPE "AssistantListingRequestState" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn', 'superseded');

-- Column defaults describe a row written without the new columns: concrete
-- values, no MCP servers, and adjustable controls because an empty control set
-- is never fixed.
ALTER TABLE "AssistantDefinition"
  ADD COLUMN "modelPolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "controlsPolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'adjustable',
  ADD COLUMN "searchPolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "toolsPolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "knowledgePolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "skillsPolicy" "AssistantRowPolicy" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "mcpMode" "AssistantMcpMode" NOT NULL DEFAULT 'off',
  ADD COLUMN "answerRules" TEXT,
  ALTER COLUMN "providerModelId" DROP NOT NULL,
  DROP CONSTRAINT "AssistantDefinition_system_prompt_check",
  ADD CONSTRAINT "AssistantDefinition_system_prompt_check" CHECK (char_length("systemPrompt") <= 48000);

-- The meaning of each definition is unchanged, so neither the optimistic
-- version fence nor Project invalidation may observe this rewrite.
ALTER TABLE "AssistantDefinition" DISABLE TRIGGER "AssistantDefinition_version";
ALTER TABLE "AssistantDefinition" DISABLE TRIGGER "AssistantDefinition_project_invalidation";
-- An empty plan admits no Search source in either mode. Admission used the
-- developer prompt only when it had visible text; the separator shrinks only
-- when both prompts were at their old limits, so no instruction is lost.
UPDATE "AssistantDefinition" SET
  "controlsPolicy" = CASE WHEN jsonb_typeof("runControls") = 'object' AND "runControls" <> '{}'::jsonb
    THEN 'fixed'::"AssistantRowPolicy" ELSE 'adjustable'::"AssistantRowPolicy" END,
  "mcpMode" = CASE WHEN cardinality("mcpServerIds") > 0
    THEN 'exact'::"AssistantMcpMode" ELSE 'off'::"AssistantMcpMode" END,
  "searchPlan" = CASE WHEN "searchPlan" -> 'optionIds' = '[]'::jsonb
    THEN '{"mode":"off"}'::jsonb ELSE "searchPlan" END,
  "systemPrompt" = CASE
    WHEN "developerPrompt" IS NULL OR "developerPrompt" !~ '\S' THEN "systemPrompt"
    WHEN "systemPrompt" !~ '\S' THEN "developerPrompt"
    ELSE "systemPrompt"
      || left(E'\n\n', greatest(0, 48000 - char_length("systemPrompt") - char_length("developerPrompt")))
      || "developerPrompt"
  END,
  "developerPrompt" = NULL;
ALTER TABLE "AssistantDefinition" ENABLE TRIGGER "AssistantDefinition_version";
ALTER TABLE "AssistantDefinition" ENABLE TRIGGER "AssistantDefinition_project_invalidation";

-- Inherit is a delegation, never a fixed value; Off and None remain concrete.
ALTER TABLE "AssistantDefinition"
  DROP CONSTRAINT "AssistantDefinition_starter_prompts_check",
  ADD CONSTRAINT "AssistantDefinition_starter_prompts_check" CHECK (cardinality("starterPrompts") <= 6),
  ADD CONSTRAINT "AssistantDefinition_answer_rules_check" CHECK ("answerRules" IS NULL OR char_length("answerRules") <= 4000),
  ADD CONSTRAINT "AssistantDefinition_model_policy_check" CHECK ("modelPolicy" = 'adjustable' OR "providerModelId" IS NOT NULL),
  ADD CONSTRAINT "AssistantDefinition_controls_policy_check" CHECK (
    "controlsPolicy" = 'adjustable' OR (jsonb_typeof("runControls") = 'object' AND "runControls" <> '{}'::jsonb)),
  ADD CONSTRAINT "AssistantDefinition_search_policy_check" CHECK (
    "searchPolicy" = 'adjustable' OR "searchPlan" ->> 'mode' IS DISTINCT FROM 'inherit'),
  ADD CONSTRAINT "AssistantDefinition_mcp_mode_check" CHECK (
    ("mcpMode" = 'exact' AND cardinality("mcpServerIds") >= 1) OR
    ("mcpMode" IN ('off', 'inherit') AND cardinality("mcpServerIds") = 0)),
  ADD CONSTRAINT "AssistantDefinition_tools_policy_check" CHECK ("toolsPolicy" = 'adjustable' OR "mcpMode" <> 'inherit'),
  ADD CONSTRAINT "AssistantDefinition_knowledge_policy_check" CHECK (
    "knowledgePolicy" = 'adjustable' OR "knowledgeSelection" ->> 'mode' IS DISTINCT FROM 'inherit');

ALTER TABLE "UserSettings"
  ADD COLUMN "defaultAssistantId" TEXT,
  ADD CONSTRAINT "UserSettings_defaultAssistantId_fkey" FOREIGN KEY ("defaultAssistantId")
    REFERENCES "AssistantDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "UserSettings_defaultAssistantId_idx" ON "UserSettings"("defaultAssistantId");

ALTER TABLE "AssistantPublication"
  ADD COLUMN "featuredOrder" INTEGER,
  ADD CONSTRAINT "AssistantPublication_featured_order_check" CHECK (
    "featuredOrder" IS NULL OR ("scope" = 'installation' AND "featuredOrder" >= 0));
CREATE UNIQUE INDEX "AssistantPublication_featured_order_key" ON "AssistantPublication"("featuredOrder")
  WHERE "scope" = 'installation' AND "featuredOrder" IS NOT NULL;

-- Listing asks for an installation audience of one exact definition version;
-- deleting the definition removes its requests.
CREATE TABLE "AssistantListingRequest" (
  "id" TEXT NOT NULL,
  "assistantId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "state" "AssistantListingRequestState" NOT NULL DEFAULT 'pending',
  "definitionVersion" INTEGER NOT NULL,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantListingRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantListingRequest_requestedByUserId_assistantId_fkey" FOREIGN KEY ("requestedByUserId", "assistantId")
    REFERENCES "AssistantDefinition"("ownerUserId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "AssistantListingRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AssistantListingRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AssistantListingRequest_definition_version_check" CHECK ("definitionVersion" >= 1),
  CONSTRAINT "AssistantListingRequest_review_check" CHECK (
    ("state" IN ('approved', 'rejected') AND "reviewedAt" IS NOT NULL)
    OR ("state" IN ('pending', 'withdrawn', 'superseded') AND "reviewedAt" IS NULL
      AND "reviewedByUserId" IS NULL AND "reviewNote" IS NULL)),
  CONSTRAINT "AssistantListingRequest_note_check" CHECK (char_length("reviewNote") <= 4000)
);
CREATE UNIQUE INDEX "AssistantListingRequest_pending_assistant_key" ON "AssistantListingRequest"("assistantId") WHERE "state" = 'pending';
CREATE INDEX "AssistantListingRequest_state_createdAt_id_idx" ON "AssistantListingRequest"("state", "createdAt", "id");
CREATE INDEX "AssistantListingRequest_assistantId_createdAt_id_idx" ON "AssistantListingRequest"("assistantId", "createdAt", "id");
CREATE INDEX "AssistantListingRequest_requestedByUserId_idx" ON "AssistantListingRequest"("requestedByUserId");
CREATE INDEX "AssistantListingRequest_reviewedByUserId_idx" ON "AssistantListingRequest"("reviewedByUserId");

CREATE FUNCTION aiqsa_assistant_listing_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."assistantId", NEW."requestedByUserId", NEW."definitionVersion", NEW."createdAt")
      IS DISTINCT FROM (OLD."id", OLD."assistantId", OLD."requestedByUserId", OLD."definitionVersion", OLD."createdAt")
    OR (OLD."state" <> 'pending' AND (
      (to_jsonb(NEW) - 'reviewedByUserId') IS DISTINCT FROM (to_jsonb(OLD) - 'reviewedByUserId')
      OR (NEW."reviewedByUserId" IS NOT NULL AND NEW."reviewedByUserId" IS DISTINCT FROM OLD."reviewedByUserId"))) THEN
    RAISE EXCEPTION 'assistant_listing_request_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AssistantListingRequest_guard" BEFORE UPDATE ON "AssistantListingRequest"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_assistant_listing_request_guard();

ALTER TABLE "Chat"
  ADD COLUMN "assistantId" TEXT,
  ADD COLUMN "assistantOverrides" JSONB,
  ADD CONSTRAINT "Chat_assistantId_fkey" FOREIGN KEY ("assistantId")
    REFERENCES "AssistantDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Chat_assistant_overrides_check" CHECK (
    "assistantOverrides" IS NULL OR jsonb_typeof("assistantOverrides") = 'object');
CREATE INDEX "Chat_userId_assistantId_updatedAt_idx" ON "Chat"("userId", "assistantId", "updatedAt");

-- A chat continues with the Assistant of its latest Assistant run while that
-- definition is live; a Project chat only while the Project still binds it.
-- Chats awaiting permanent deletion stay untouched, and so does updatedAt.
UPDATE "Chat" AS chat SET "assistantId" = latest."assistantId"
FROM (
  SELECT DISTINCT ON (run."chatId") run."chatId", run."assistantId"
  FROM "ModelRun" AS run
  WHERE run."assistantId" IS NOT NULL
  ORDER BY run."chatId", run."createdAt" DESC, run."id" DESC
) AS latest
JOIN "AssistantDefinition" AS definition
  ON definition."id" = latest."assistantId" AND definition."archivedAt" IS NULL
WHERE chat."id" = latest."chatId"
  AND chat."permanentDeletionAt" IS NULL
  AND (chat."projectId" IS NULL OR EXISTS (
    SELECT 1 FROM "ProjectAssistantBinding" AS binding
    WHERE binding."projectId" = chat."projectId" AND binding."assistantId" = latest."assistantId"));
-- Finish the deferred chat ownership and Memory source checks before more DDL.
SET CONSTRAINTS ALL IMMEDIATE;

-- Hard delete detaches accepted runs but keeps their name/avatar snapshot.
ALTER TABLE "ModelRun"
  DROP CONSTRAINT "ModelRun_assistantId_fkey",
  ADD CONSTRAINT "ModelRun_assistantId_fkey" FOREIGN KEY ("assistantId")
    REFERENCES "AssistantDefinition"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  DROP CONSTRAINT "ModelRun_assistant_identity_check",
  ADD CONSTRAINT "ModelRun_assistant_identity_check" CHECK (
    ("assistantId" IS NULL AND "assistantIdentity" IS NULL) OR
    ("assistantIdentity" IS NOT NULL AND
      jsonb_typeof("assistantIdentity") = 'object' AND
      "assistantIdentity" ?& ARRAY['name','avatar'] AND
      "assistantIdentity" - ARRAY['name','avatar'] = '{}'::jsonb AND
      jsonb_typeof("assistantIdentity" -> 'name') = 'string' AND
      char_length("assistantIdentity" ->> 'name') BETWEEN 1 AND 80 AND
      jsonb_typeof("assistantIdentity" -> 'avatar') = 'object' AND
      octet_length("assistantIdentity"::text) <= 2048)
  );

-- The only accepted change is the detach performed while deleting the
-- definition; a live definition keeps every accepted run.
CREATE OR REPLACE FUNCTION aiqsa_assistant_run_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assistantIdentity" IS DISTINCT FROM OLD."assistantIdentity" OR (
    NEW."assistantId" IS DISTINCT FROM OLD."assistantId" AND NOT (
      NEW."assistantId" IS NULL AND
      NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE "id" = OLD."assistantId"))) THEN
    RAISE EXCEPTION 'accepted_assistant_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Memory history keeps its owner and content; only the Assistant attribution
-- disappears with the definition. MemoryScope stays restrictive: deletion
-- orphans the scope first.
ALTER TABLE "MemoryRecallChunk"
  DROP CONSTRAINT "MemoryRecallChunk_assistant_fkey",
  ADD CONSTRAINT "MemoryRecallChunk_assistant_fkey" FOREIGN KEY ("userId", "sourceAssistantId")
    REFERENCES "AssistantDefinition"("ownerUserId", "id") ON UPDATE RESTRICT ON DELETE SET NULL ("sourceAssistantId");
ALTER TABLE "MemoryRecallRound"
  DROP CONSTRAINT "MemoryRecallRound_assistant_fkey",
  ADD CONSTRAINT "MemoryRecallRound_assistant_fkey" FOREIGN KEY ("userId", "sourceAssistantId")
    REFERENCES "AssistantDefinition"("ownerUserId", "id") ON UPDATE RESTRICT ON DELETE SET NULL ("sourceAssistantId");
ALTER TABLE "ChatMemoryDigest"
  DROP CONSTRAINT "ChatMemoryDigest_assistant_fkey",
  ADD CONSTRAINT "ChatMemoryDigest_assistant_fkey" FOREIGN KEY ("userId", "sourceAssistantId")
    REFERENCES "AssistantDefinition"("ownerUserId", "id") ON UPDATE RESTRICT ON DELETE SET NULL ("sourceAssistantId");

COMMIT;
