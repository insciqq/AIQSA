/** Synthetic v0.3.3 settings rows; migration-contract owns the disposable database. */
export const DROP_RETIRED_MEMORY_SYNTHESIS_COLUMNS_MIGRATION =
  "20261005100000_drop_retired_memory_synthesis_columns";

const retiredColumns = ["synthesisEnabled", "synthesisEnabledAt", "synthesisPolicyVersion", "lastSynthesisAt"]
  .map((column) => `'${column}'`).join(", ");

// Rows as the previous release leaves them: database defaults (synthesis on,
// never run), a run synthesis beside changed live settings, and the off shape a
// reset or account fence of an older release wrote. Explicit columns keep the
// fixture valid when later migrations add columns.
export const dropRetiredMemorySynthesisColumnsFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-synthesis-drop-default', 'Synthetic owner', 'active', now()),
  ('memory-synthesis-drop-ran', 'Synthetic owner', 'active', now()),
  ('memory-synthesis-drop-off', 'Synthetic owner', 'disabled', now());
UPDATE "UserMemorySettings" SET "lastSynthesisAt" = "synthesisEnabledAt" + interval '1 day',
  "referenceChatHistory" = false, "decayEnabled" = false, "memoryGeneration" = 3, "memoryRevision" = 9,
  "memoryConsentRevision" = 2, "settingsRevision" = 4, "acceptedUtilityEgressFingerprint" = 'synthetic-egress',
  "acceptedUtilityPolicyVersion" = 'synthetic-utility-policy-v1', "acceptedUtilityEgressAt" = '2026-10-01T00:00:00Z',
  "maintenanceCursor" = 'synthetic-cursor', "maintenanceScannedAt" = '2026-10-02T00:00:00Z',
  "explicitEquivalenceSweepVersion" = 'synthetic-sweep-v1', "updatedAt" = '2026-10-03T00:00:00Z'
WHERE "userId" = 'memory-synthesis-drop-ran';
UPDATE "UserMemorySettings" SET "synthesisEnabled" = false, "synthesisEnabledAt" = NULL,
  "synthesisPolicyVersion" = NULL, "lastSynthesisAt" = NULL, "useMemoryFacts" = false,
  "learnAutomatically" = false, "decayEnabled" = false, "decayPolicyVersion" = NULL
WHERE "userId" = 'memory-synthesis-drop-off';
CREATE TABLE "MemorySynthesisDropAdoptionFixture" AS
SELECT "userId", to_jsonb(settings) - ARRAY[${retiredColumns}] AS snapshot
FROM "UserMemorySettings" AS settings WHERE "userId" LIKE 'memory-synthesis-drop-%';
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy.
 * Containment keeps every other recorded column exact while tolerating
 * columns a later migration adds. */
export const dropRetiredMemorySynthesisColumnsProofSql = `
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM "MemorySynthesisDropAdoptionFixture") <> 3
    OR (SELECT count(*) FROM "MemorySynthesisDropAdoptionFixture" AS original
      JOIN "UserMemorySettings" AS settings USING ("userId")
      WHERE to_jsonb(settings) @> original.snapshot) <> 3
  THEN RAISE EXCEPTION 'memory_settings_rows_not_preserved'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
    AND table_name = 'UserMemorySettings' AND column_name IN (${retiredColumns}))
  THEN RAISE EXCEPTION 'memory_synthesis_columns_retained'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'UserMemorySettings_synthesisEnabled_lastSynthesisAt_userId_idx')
  THEN RAISE EXCEPTION 'memory_synthesis_index_retained'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserMemorySettings_synthesis_shape_check')
  THEN RAISE EXCEPTION 'memory_synthesis_check_retained'; END IF;
END $$;
-- A new owner still receives the live defaults from the account trigger.
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-synthesis-drop-new', 'Synthetic owner', 'active', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-synthesis-drop-new'
    AND "useMemoryFacts" AND "referenceChatHistory" AND "learnAutomatically" AND "decayEnabled"
    AND "decayPolicyVersion" = 'memory-decay-v1' AND "settingsRevision" = 0)
  THEN RAISE EXCEPTION 'memory_default_settings_not_created'; END IF;
END $$;
ROLLBACK;
`;
