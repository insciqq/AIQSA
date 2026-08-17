-- Provider artifacts and durable tool checkpoints must advance the Project
-- outbox independently of answer-text/status updates so reconnect can rebuild
-- Sources, safe tool activity, and other persisted run output.
CREATE OR REPLACE FUNCTION "aiqsa_project_run_output_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_project_id TEXT;
BEGIN
  SELECT chat."projectId" INTO target_project_id
  FROM "ModelRun" AS run
  JOIN "Chat" AS chat ON chat."id" = run."chatId"
  WHERE run."id" = NEW."modelRunId";
  IF target_project_id IS NOT NULL THEN
    INSERT INTO "ProjectEvent" (
      "projectId", "eventType", "entityType", "entityId", "createdAt"
    ) VALUES (
      target_project_id,
      'run_output_changed',
      'run',
      NEW."modelRunId",
      NEW."createdAt"
    );
    PERFORM "aiqsa_prune_project_events"(target_project_id);
    PERFORM pg_notify('aiqsa_project_events', target_project_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRunOutput_to_ProjectEvent"
AFTER INSERT ON "ModelRunEvent"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_run_output_to_event"();

CREATE OR REPLACE FUNCTION "aiqsa_project_run_tool_to_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_project_id TEXT;
BEGIN
  SELECT chat."projectId" INTO target_project_id
  FROM "ModelRun" AS run
  JOIN "Chat" AS chat ON chat."id" = run."chatId"
  WHERE run."id" = NEW."modelRunId";
  IF target_project_id IS NOT NULL THEN
    INSERT INTO "ProjectEvent" (
      "projectId", "eventType", "entityType", "entityId", "createdAt"
    ) VALUES (
      target_project_id,
      'run_tool_changed',
      'run',
      NEW."modelRunId",
      NEW."updatedAt"
    );
    PERFORM "aiqsa_prune_project_events"(target_project_id);
    PERFORM pg_notify('aiqsa_project_events', target_project_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRunTool_to_ProjectEvent"
AFTER INSERT OR UPDATE OF "state", "result" ON "ModelRunToolCall"
FOR EACH ROW
EXECUTE FUNCTION "aiqsa_project_run_tool_to_event"();
