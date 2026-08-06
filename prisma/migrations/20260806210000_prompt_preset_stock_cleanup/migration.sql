-- Fail-closed automatic cleanup of the provisioned "Helpful Assistant" prompt
-- preset stock data before the Prompt Library concept is removed.
--
-- Compatibility preflight: the operator confirmed that no user-created prompt
-- presets exist; the only expected rows are the exact provisioned signature
-- below (one row per user). Any other row aborts this deployment inside the
-- migration transaction without deleting or mutating anything, and requires
-- operator investigation instead of silent data loss.
--
-- Process drain: the supported single-host Compose topology stops the previous
-- app container before the one-shot migrate-bootstrap role runs, so no old
-- application process can recreate or read presets while this executes.
--
-- Idempotent: an empty "PromptPreset" table passes the preflight vacuously and
-- every statement below becomes a no-op.
--
-- Rollback guidance: this migration deletes only rows proven to match the
-- code-provisioned signature; the equivalent baseline behavior moves into
-- server-owned standard-chat admission, so no data restore is required. If the
-- preflight aborts, resolve the unexpected rows manually and redeploy.
DO $$
DECLARE
  multi_preset_owner_count integer;
  unexpected_row_count integer;
BEGIN
  SELECT COUNT(*) INTO multi_preset_owner_count
  FROM (
    SELECT "userId"
    FROM "PromptPreset"
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  ) AS owners_with_multiple_presets;

  IF multi_preset_owner_count > 0 THEN
    RAISE EXCEPTION
      'prompt_preset_stock_cleanup_blocked: % owner(s) hold more than one PromptPreset row; deployment aborted without mutation. Investigate the rows manually before redeploying.',
      multi_preset_owner_count;
  END IF;

  SELECT COUNT(*) INTO unexpected_row_count
  FROM "PromptPreset"
  WHERE NOT (
    "name" = 'Helpful Assistant'
    AND "systemPrompt" = 'You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.'
    AND "developerPrompt" IS NULL
    AND "isDefault" = true
  );

  IF unexpected_row_count > 0 THEN
    RAISE EXCEPTION
      'prompt_preset_stock_cleanup_blocked: % PromptPreset row(s) do not match the provisioned Helpful Assistant signature; deployment aborted without mutation. Investigate the rows manually before redeploying.',
      unexpected_row_count;
  END IF;

  UPDATE "UserSettings" SET "defaultPromptPresetId" = NULL WHERE "defaultPromptPresetId" IS NOT NULL;
  UPDATE "Chat" SET "defaultPromptPresetId" = NULL WHERE "defaultPromptPresetId" IS NOT NULL;
  UPDATE "Message" SET "promptPresetId" = NULL WHERE "promptPresetId" IS NOT NULL;
  DELETE FROM "PromptPreset";
END $$;
