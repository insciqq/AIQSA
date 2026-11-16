/** Synthetic v0.4.35 Telegram link; migration-contract owns the disposable database. */
export const DROP_TELEGRAM_LINK_RETIRED_SETTINGS_MIGRATION = "20261116120000_drop_telegram_link_retired_settings";

const retiredColumns = ["workspaceEnabled", "agentEnabled"].map((column) => `'${column}'`).join(", ");

// A link as an earlier release left it: both retired switches on, beside
// settings the link keeps. Explicit columns keep the fixture valid when later
// migrations add columns.
export const dropTelegramLinkRetiredSettingsFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('telegram-link-drop-owner', 'Synthetic owner', 'active', now());
INSERT INTO "TelegramLink" (id, "userId", "botId", "telegramUserId", "telegramChatId", "telegramUsername", "displayName",
  "selectedModelId", "selectedProvider", "searchEnabled", "workspaceEnabled", "agentEnabled", "linkedAt", "lastSeenAt")
VALUES ('telegram-link-drop-link', 'telegram-link-drop-owner', 900000001, 900000002, 900000002, 'synthetic_member',
  'Synthetic member', 'synthetic-model', 'synthetic-provider', false, true, true,
  '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z');
CREATE TABLE "TelegramLinkDropAdoptionFixture" AS
SELECT id, to_jsonb(link) - ARRAY[${retiredColumns}] AS snapshot
FROM "TelegramLink" AS link WHERE id = 'telegram-link-drop-link';
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy.
 * Containment keeps every other recorded column exact while tolerating
 * columns a later migration adds. */
export const dropTelegramLinkRetiredSettingsProofSql = `
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
    AND table_name = 'TelegramLink' AND column_name IN (${retiredColumns}))
  THEN RAISE EXCEPTION 'telegram_link_retired_settings_retained'; END IF;
  IF (SELECT count(*) FROM "TelegramLinkDropAdoptionFixture" AS original
      JOIN "TelegramLink" AS link USING (id) WHERE to_jsonb(link) @> original.snapshot) <> 1
  THEN RAISE EXCEPTION 'telegram_link_row_not_preserved'; END IF;
  -- Stored button rows still name the retired toggles.
  IF (SELECT count(*) FROM pg_enum AS value JOIN pg_type AS type ON type.oid = value.enumtypid
      WHERE type.typname = 'TelegramCallbackKind' AND value.enumlabel IN ('toggle_workspace', 'toggle_agent')) <> 2
  THEN RAISE EXCEPTION 'telegram_retired_toggle_kinds_dropped'; END IF;
END $$;
-- The previous release (v0.4.35) names the columns of every link query
-- (TELEGRAM_LINK_RECORD_SELECT), so its link, refresh and read statements
-- keep working while Compose replaces its containers.
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('telegram-link-drop-previous-writer', 'Synthetic owner', 'active', now());
INSERT INTO "TelegramLink" (id, "userId", "botId", "telegramUserId", "telegramChatId", "telegramUsername", "displayName",
  "linkedAt", "lastSeenAt")
VALUES ('telegram-link-drop-previous-writer', 'telegram-link-drop-previous-writer', 900000001, 900000003, 900000003,
  NULL, 'Synthetic member', now(), now())
RETURNING id, "userId", "botId", "telegramUserId", "telegramChatId", "telegramUsername", "displayName", "currentChatId",
  "pendingAssistantId", "selectedModelId", "selectedProvider", "searchEnabled", "linkedAt", "lastSeenAt";
UPDATE "TelegramLink" SET "lastSeenAt" = now(), "displayName" = 'Synthetic member again'
WHERE id = 'telegram-link-drop-link'
RETURNING id, "userId", "botId", "telegramUserId", "telegramChatId", "telegramUsername", "displayName", "currentChatId",
  "pendingAssistantId", "selectedModelId", "selectedProvider", "searchEnabled", "linkedAt", "lastSeenAt";
DO $$ BEGIN
  IF (SELECT count(*) FROM "TelegramLink" WHERE id LIKE 'telegram-link-drop-%' AND "searchEnabled" IS NOT NULL) <> 2
  THEN RAISE EXCEPTION 'telegram_link_previous_writer_failed'; END IF;
END $$;
ROLLBACK;
`;
