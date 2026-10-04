-- Contract the activation storage of the removed local MCP sources. Since
-- 20261003201500_retire_local_mcp_activation_stages (v0.3.2) no release reads
-- or writes "workloadToken" or the resolving/preparing_runtime stages, so the
-- previous-release writer during Compose replacement never touches them.

-- Guard: a job left in a retired stage restarts from the beginning, as the
-- worker already restarts a reclaimed stale lease; it revalidates the draft
-- before it connects. Leases and timestamps stay, so lease staleness is
-- unchanged. The type conversion below would reject such a row.
UPDATE "McpActivationJob" SET "stage" = 'queued'
WHERE "stage" IN ('resolving', 'preparing_runtime');

DROP INDEX "McpActivationJob_workloadToken_key";
ALTER TABLE "McpActivationJob" DROP COLUMN "workloadToken";

-- PostgreSQL cannot drop enum values: recreate the type. The terminal-fields
-- check and the column default name the type, so they are rebuilt against the
-- new one; the stage index is rebuilt by the column conversion.
ALTER TABLE "McpActivationJob" DROP CONSTRAINT "McpActivationJob_terminal_fields_check";
ALTER TYPE "McpActivationStage" RENAME TO "McpActivationStage_retired";
CREATE TYPE "McpActivationStage" AS ENUM ('queued', 'connecting', 'discovering_tools', 'publishing', 'ready', 'failed');
ALTER TABLE "McpActivationJob" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "McpActivationJob" ALTER COLUMN "stage" TYPE "McpActivationStage"
  USING ("stage"::text::"McpActivationStage");
ALTER TABLE "McpActivationJob" ALTER COLUMN "stage" SET DEFAULT 'queued';
DROP TYPE "McpActivationStage_retired";
ALTER TABLE "McpActivationJob" ADD CONSTRAINT "McpActivationJob_terminal_fields_check" CHECK (
  stage = 'failed'::"McpActivationStage" AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL
  OR stage = 'ready'::"McpActivationStage" AND "completedAt" IS NOT NULL AND "errorCode" IS NULL
  OR (stage <> ALL (ARRAY['ready'::"McpActivationStage", 'failed'::"McpActivationStage"]))
    AND "completedAt" IS NULL AND "errorCode" IS NULL
);
