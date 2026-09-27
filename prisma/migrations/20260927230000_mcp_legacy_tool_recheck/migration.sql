-- Existing enabled servers get one automatic Test & Save after the upgrade.
-- The application filters name-only evidence and atomically queues its durable
-- activation job. No upstream calls or fabricated validation evidence in DDL.
ALTER TABLE "McpServer" ADD COLUMN "legacyToolRecheckPending" BOOLEAN NOT NULL DEFAULT false;

UPDATE "McpServer"
SET "legacyToolRecheckPending" = true
WHERE "enabled" = true
  AND "archivedAt" IS NULL
  AND "activeRevisionId" IS NOT NULL;

-- A previous-version writer may edit a server before the new process drains
-- the marker. Do not apply the upgrade check to that newly edited state.
CREATE FUNCTION "cancel_mcp_legacy_tool_recheck_on_edit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."legacyToolRecheckPending" = true AND NEW."legacyToolRecheckPending" = true AND (
    NEW."draft" IS DISTINCT FROM OLD."draft"
    OR NEW."activeRevisionId" IS DISTINCT FROM OLD."activeRevisionId"
    OR NEW."sharedConfigVersion" IS DISTINCT FROM OLD."sharedConfigVersion"
    OR NEW."enabled" IS DISTINCT FROM OLD."enabled"
    OR NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt"
  ) THEN
    NEW."legacyToolRecheckPending" := false;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "McpServer_cancel_legacy_tool_recheck_on_edit"
BEFORE UPDATE ON "McpServer" FOR EACH ROW
EXECUTE FUNCTION "cancel_mcp_legacy_tool_recheck_on_edit"();
