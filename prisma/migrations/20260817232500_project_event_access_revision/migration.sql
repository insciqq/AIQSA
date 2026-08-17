-- Reinstall the audit outbox trigger body for databases that applied the
-- Project v2 migration while access-revision delivery was still incomplete.
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
