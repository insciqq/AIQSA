-- Installation MCP servers are internal and trusted (operator decision
-- 2026-10-24): when a runtime sees that a server's tools changed, the
-- application runs Test & Save itself. Every existing server is trusted at
-- the upgrade and new servers default to it; the switch stays per server.
-- A runtime marks the request and the activation coordinator consumes it; the
-- listing hash and request time keep one changed listing from asking twice.
-- Previous writers omit the columns and get the defaults.
ALTER TABLE "McpServer"
  ADD COLUMN "autoApplyToolUpdates" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "toolUpdateCheckPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "toolUpdateCheckHash" TEXT,
  ADD COLUMN "toolUpdateCheckRequestedAt" TIMESTAMP(3);
