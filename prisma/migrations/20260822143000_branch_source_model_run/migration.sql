ALTER TABLE "Message"
ADD COLUMN "branchSourceModelRunId" TEXT;

CREATE INDEX "Message_branchSourceModelRunId_idx"
ON "Message"("branchSourceModelRunId");

ALTER TABLE "Message"
ADD CONSTRAINT "Message_branchSourceModelRunId_fkey"
FOREIGN KEY ("branchSourceModelRunId") REFERENCES "ModelRun"("id")
ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "Message"
ADD CONSTRAINT "Message_branchSourceModelRun_role_check"
CHECK ("branchSourceModelRunId" IS NULL OR role = 'assistant'::text);

CREATE FUNCTION "enforce_branch_source_model_run_tenant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination_user_id TEXT;
  destination_project_id TEXT;
  source_user_id TEXT;
  source_project_id TEXT;
BEGIN
  IF NEW."branchSourceModelRunId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT destination_chat."userId", destination_chat."projectId"
  INTO destination_user_id, destination_project_id
  FROM "Chat" AS destination_chat
  WHERE destination_chat.id = NEW."chatId";

  SELECT source_chat."userId", source_chat."projectId"
  INTO source_user_id, source_project_id
  FROM "ModelRun" AS source_run
  INNER JOIN "Chat" AS source_chat ON source_chat.id = source_run."chatId"
  WHERE source_run.id = NEW."branchSourceModelRunId";

  IF NOT (
    destination_user_id IS NOT NULL
    AND destination_project_id IS NULL
    AND source_user_id = destination_user_id
    AND source_project_id IS NULL
  ) AND NOT (
    destination_user_id IS NULL
    AND destination_project_id IS NOT NULL
    AND source_user_id IS NULL
    AND source_project_id = destination_project_id
  ) THEN
    RAISE EXCEPTION 'branch source model run tenant mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "Message_branchSourceModelRun_tenant_trigger"
AFTER INSERT OR UPDATE OF "chatId", "branchSourceModelRunId" ON "Message"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_branch_source_model_run_tenant"();
