-- Project v2 authority and replay primitives. Existing bindings remain
-- untouched; eligibility is opt-in for future Project additions/admission.
ALTER TABLE "ProviderModel"
  ADD COLUMN "availableInProjects" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SearchOption"
  ADD COLUMN "availableInProjects" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "McpServer"
  ADD COLUMN "availableInProjects" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProjectRunBinding"
  ADD COLUMN "sharedCredentialVersionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "ProjectSkillBinding" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectSkillBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectEvent" (
  "sequence" BIGSERIAL NOT NULL,
  "projectId" TEXT NOT NULL,
  "eventType" VARCHAR(64) NOT NULL,
  "entityType" VARCHAR(64),
  "entityId" VARCHAR(128),
  "entityRevision" INTEGER,
  "accessRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectEvent_pkey" PRIMARY KEY ("sequence")
);

CREATE UNIQUE INDEX "ProjectSkillBinding_projectId_skillId_key"
  ON "ProjectSkillBinding"("projectId", "skillId");
CREATE INDEX "ProjectSkillBinding_addedByUserId_idx"
  ON "ProjectSkillBinding"("addedByUserId");
CREATE INDEX "ProjectSkillBinding_skillId_idx"
  ON "ProjectSkillBinding"("skillId");
CREATE INDEX "ProjectEvent_projectId_sequence_idx"
  ON "ProjectEvent"("projectId", "sequence");
CREATE INDEX "ProjectEvent_createdAt_idx"
  ON "ProjectEvent"("createdAt");

ALTER TABLE "ProjectSkillBinding"
  ADD CONSTRAINT "ProjectSkillBinding_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectSkillBinding_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectSkillBinding_addedByUserId_fkey"
  FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProjectEvent"
  ADD CONSTRAINT "ProjectEvent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "aiqsa_prune_project_events"(target_project_id TEXT)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM "ProjectEvent"
  WHERE "projectId" = target_project_id
    AND "sequence" < COALESCE((
      SELECT "sequence" FROM "ProjectEvent"
      WHERE "projectId" = target_project_id
      ORDER BY "sequence" DESC
      OFFSET 9999 LIMIT 1
    ), 0);
$$;

-- Every Project audit mutation becomes a durable, content-free invalidation
-- event in the same transaction.  Delivery reconstructs safe projections from
-- authoritative rows; the event table never stores audit metadata or payloads.
CREATE OR REPLACE FUNCTION "aiqsa_project_audit_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_entity_type TEXT;
  target_entity_id TEXT;
  current_access_revision INTEGER;
BEGIN
  IF NEW."eventType" IN ('project_chat_created', 'project_chat_archived', 'project_chat_restored') THEN
    target_entity_type := 'chat';
    target_entity_id := NEW."metadata" ->> 'chatId';
  ELSIF NEW."eventType" IN ('project_folder_created', 'project_folder_updated', 'project_folder_deleted') THEN
    target_entity_type := 'folder';
    target_entity_id := NEW."metadata" ->> 'folderId';
  END IF;
  SELECT "accessRevision" INTO current_access_revision
  FROM "Project" WHERE "id" = NEW."projectId";
  INSERT INTO "ProjectEvent" (
    "projectId", "eventType", "entityType", "entityId", "accessRevision", "createdAt"
  ) VALUES (
    NEW."projectId",
    left(NEW."eventType", 64),
    target_entity_type,
    left(target_entity_id, 128),
    current_access_revision,
    NEW."createdAt"
  );
  PERFORM "aiqsa_prune_project_events"(NEW."projectId");
  PERFORM pg_notify('aiqsa_project_events', NEW."projectId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAuditEvent_to_ProjectEvent"
AFTER INSERT ON "ProjectAuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_audit_to_event"();

CREATE OR REPLACE FUNCTION "aiqsa_project_message_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_project_id TEXT;
BEGIN
  SELECT "projectId" INTO target_project_id FROM "Chat" WHERE "id" = NEW."chatId";
  IF target_project_id IS NOT NULL THEN
    INSERT INTO "ProjectEvent" ("projectId", "eventType", "entityType", "entityId", "createdAt")
    VALUES (
      target_project_id,
      CASE WHEN TG_OP = 'INSERT' AND NEW."role" = 'user' THEN 'message_created' ELSE 'message_changed' END,
      'message',
      NEW."id",
      NEW."updatedAt"
    );
    PERFORM "aiqsa_prune_project_events"(target_project_id);
    PERFORM pg_notify('aiqsa_project_events', target_project_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMessage_to_ProjectEvent"
AFTER INSERT OR UPDATE OF "content", "status", "errorMessage" ON "Message"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_message_to_event"();

CREATE OR REPLACE FUNCTION "aiqsa_project_run_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_project_id TEXT;
BEGIN
  SELECT "projectId" INTO target_project_id FROM "Chat" WHERE "id" = NEW."chatId";
  IF target_project_id IS NOT NULL THEN
    INSERT INTO "ProjectEvent" ("projectId", "eventType", "entityType", "entityId", "createdAt")
    VALUES (target_project_id, 'run_changed', 'run', NEW."id", NEW."updatedAt");
    PERFORM "aiqsa_prune_project_events"(target_project_id);
    PERFORM pg_notify('aiqsa_project_events', target_project_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRun_to_ProjectEvent"
AFTER INSERT OR UPDATE OF "status" ON "ModelRun"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_run_to_event"();

CREATE OR REPLACE FUNCTION "aiqsa_project_attachment_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."projectId" IS NOT NULL THEN
    INSERT INTO "ProjectEvent" ("projectId", "eventType", "entityType", "entityId", "createdAt")
    VALUES (NEW."projectId", 'attachment_changed', 'attachment', NEW."id", NEW."updatedAt");
    PERFORM "aiqsa_prune_project_events"(NEW."projectId");
    PERFORM pg_notify('aiqsa_project_events', NEW."projectId");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAttachment_to_ProjectEvent"
AFTER INSERT OR UPDATE OF "status" ON "Attachment"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_attachment_to_event"();
