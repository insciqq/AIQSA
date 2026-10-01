-- Personal remote MCP ownership and per-user tool selection.
ALTER TABLE "McpServer" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "selectedToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "McpUserServer" ADD COLUMN "toolSelectionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredInventory" JSONB;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredRevisionId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredOAuthConnectionId" TEXT;

CREATE INDEX "McpServer_ownerUserId_enabled_archivedAt_idx"
  ON "McpServer"("ownerUserId", "enabled", "archivedAt");

ALTER TABLE "McpServer"
  ADD CONSTRAINT "McpServer_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpServer" ADD COLUMN "connectorKey" TEXT;
CREATE INDEX "McpServer_ownerUserId_connectorKey_idx"
  ON "McpServer"("ownerUserId", "connectorKey");
