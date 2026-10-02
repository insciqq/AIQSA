-- Local MCP workloads are gone; the current release no longer writes this token.
-- Expand only: previous-release writers still insert it during Compose replacement.
ALTER TABLE "McpActivationJob" ALTER COLUMN "workloadToken" DROP NOT NULL;
