/** Synthetic predecessor rows in the migration runner's disposable database. */
export const WORKSPACE_USER_DEFAULT_MIGRATION = "20260915160000_workspace_user_default_on";

export const workspaceUserDefaultFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
  ('workspace-default-off', 'Synthetic defaults', 'active', now()),
  ('workspace-default-on', 'Synthetic defaults', 'active', now()),
  ('workspace-default-disabled', 'Synthetic defaults', 'disabled', now()),
  ('workspace-default-no-settings', 'Synthetic defaults', 'active', now());
INSERT INTO "UserSettings" (id, "userId", "defaultWorkspaceEnabled", "sendWithEnter", "updatedAt") VALUES
  ('workspace-default-off-settings', 'workspace-default-off', false, false, '2026-09-01T00:00:00Z'),
  ('workspace-default-on-settings', 'workspace-default-on', true, true, '2026-09-01T00:00:00Z'),
  ('workspace-default-disabled-settings', 'workspace-default-disabled', false, true, '2026-09-01T00:00:00Z');
INSERT INTO "Chat" (id, "userId", title, "workspaceEnabled", "updatedAt") VALUES
  ('workspace-default-off-chat', 'workspace-default-off', 'Synthetic off chat', false, now()),
  ('workspace-default-on-chat', 'workspace-default-on', 'Synthetic on chat', true, now());
`;

export const workspaceUserDefaultProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "UserSettings" WHERE "userId" IN
    ('workspace-default-off', 'workspace-default-on', 'workspace-default-disabled') AND "defaultWorkspaceEnabled") <> 3
    THEN RAISE EXCEPTION 'workspace_existing_defaults_not_enabled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'workspace-default-off'
    AND NOT "sendWithEnter" AND "updatedAt" = '2026-09-01T00:00:00Z')
    THEN RAISE EXCEPTION 'workspace_unrelated_preferences_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = 'workspace-default-disabled' AND status = 'disabled')
    THEN RAISE EXCEPTION 'workspace_account_status_changed'; END IF;
  IF EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'workspace-default-no-settings')
    THEN RAISE EXCEPTION 'workspace_unrequested_settings_provisioned'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'workspace-default-off-chat' AND NOT "workspaceEnabled")
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'workspace-default-on-chat' AND "workspaceEnabled")
    THEN RAISE EXCEPTION 'workspace_existing_chat_changed'; END IF;
END $$;
INSERT INTO "UserSettings" (id, "userId", "updatedAt")
  VALUES ('workspace-default-later-settings', 'workspace-default-no-settings', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'workspace-default-no-settings' AND "defaultWorkspaceEnabled")
    THEN RAISE EXCEPTION 'workspace_new_default_not_enabled'; END IF;
END $$;
UPDATE "UserSettings" SET "defaultWorkspaceEnabled" = false WHERE "userId" = 'workspace-default-off';
`;

export const workspaceUserDefaultRepeatProofSql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'workspace-default-off' AND NOT "defaultWorkspaceEnabled")
    THEN RAISE EXCEPTION 'workspace_later_opt_out_overwritten'; END IF;
END $$;`;
