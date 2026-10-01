-- Personal remote MCP ownership and per-user tool switch-offs.
ALTER TABLE "McpServer" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "userDisabledToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
  CONSTRAINT "McpUserServer_userDisabledToolNames_check" CHECK (cardinality("userDisabledToolNames") <= 1024);
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredInventory" JSONB;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredRevisionId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredOAuthConnectionId" TEXT;

CREATE INDEX "McpServer_ownerUserId_enabled_archivedAt_idx"
  ON "McpServer"("ownerUserId", "enabled", "archivedAt");

ALTER TABLE "McpServer"
  ADD CONSTRAINT "McpServer_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
