-- Per-user chat defaults applied when a new chat starts (Settings › Chat
-- defaults) and the composer keyboard preference. The MCP mode mirrors the
-- run selection vocabulary; the knowledge plan stores the same selection
-- document as Folder.defaultKnowledgePlan.
ALTER TABLE "UserSettings"
  ADD COLUMN "defaultKnowledgePlan" JSONB,
  ADD COLUMN "defaultMcpMode" TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN "sendWithEnter" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "UserSettings"
  ADD CONSTRAINT "UserSettings_defaultMcpMode_check"
    CHECK ("defaultMcpMode" IN ('auto', 'load_all', 'off'));
