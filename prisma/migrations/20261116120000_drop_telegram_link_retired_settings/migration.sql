-- Contract the retired settings of a Telegram link: the Workspace switch
-- (operator decision 2026-11-16: every Telegram turn asks for the Workspace as
-- the web chat does) and the Codex Agent switch (operator decision 2026-10-23).
-- Nothing reads or writes either value, and since the release that retired
-- the Workspace switch link queries name their columns, so that release's
-- writer during Compose replacement never touches them. Every other column
-- of every link is unchanged; the retired callback kinds stay in their enum
-- because stored button rows still name them.
ALTER TABLE "TelegramLink"
  DROP COLUMN "workspaceEnabled",
  DROP COLUMN "agentEnabled";
