/** Synthetic predecessor rows in the migration runner's owned disposable DB. */
export const MEMORY_DEFAULTS_MIGRATION = "20260911185000_memory_preferences_default_on";

const resetStates = ["PENDING", "RUNNING", "RETRY_WAIT", "BLOCKED_REQUIRES_ADMIN", "SUCCEEDED", "CANCELLED"];
const cases = ["all-off", "mixed", "manual", "paused", "enabled", "inactive",
  ...resetStates.map((state) => `reset-${state}`), ...resetStates.map((state) => `delete-${state}`)];
const resumed = ["all-off", "mixed", "manual", "paused", "inactive", "reset-SUCCEEDED", "reset-CANCELLED"];
const names = (values: readonly string[]) => values.map((name) => `'memory-defaults-${name}'`).join(", ");
const activeIndex = "a09a9118-5000-4000-8000-000000000001";
const shadowIndex = "a09a9118-5000-4000-8000-000000000002";
const deletionStateFields = (state: string) => [
  state === "RUNNING" ? "'synthetic-lease'" : "NULL",
  state === "RUNNING" ? "now() + interval '1 minute'" : "NULL",
  state === "SUCCEEDED" || state === "CANCELLED" ? "now()" : "NULL",
  state === "SUCCEEDED" ? "now()" : "NULL",
  state === "CANCELLED" ? "'synthetic_cancelled'" : "NULL"
].join(", ");

export const memoryDefaultsAdoptionFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
${cases.map((name) => `('memory-defaults-${name}', 'Synthetic Memory defaults', '${name === "inactive" ? "disabled" : "active"}', now())`).join(",\n")};
UPDATE "UserMemorySettings" SET "useMemoryFacts" = false, "referenceChatHistory" = false,
  "learnAutomatically" = false, "synthesisEnabled" = false, "decayEnabled" = false,
  "memoryGeneration" = 4, "memoryRevision" = 11, "settingsRevision" = 7,
  "updatedAt" = '2026-09-01T00:00:00Z'
WHERE "userId" IN (${names(cases)});
UPDATE "UserMemorySettings" SET "synthesisEnabledAt" = '2026-09-01T00:00:00Z',
  "synthesisPolicyVersion" = 'memory-synthesis-policy-v3', "lastSynthesisAt" = '2026-09-02T00:00:00Z',
  "decayPolicyVersion" = 'memory-decay-v1'
WHERE "userId" IN (${names(["mixed", "manual", "enabled"])});
UPDATE "UserMemorySettings" SET "useMemoryFacts" = true, "learnAutomatically" = true,
  "synthesisEnabled" = true, "decayEnabled" = true
WHERE "userId" IN (${names(["mixed", "enabled"])});
UPDATE "UserMemorySettings" SET "referenceChatHistory" = true WHERE "userId" = 'memory-defaults-enabled';
INSERT INTO "MemoryPauseInterval" (id, "userId", scope, "pausedAt", "memoryGeneration")
SELECT 'memory-defaults-pause-' || scope, 'memory-defaults-paused', scope::"MemoryPauseScope", '2026-09-03T00:00:00Z', 4
FROM unnest(ARRAY['MASTER', 'SEARCH_HISTORY', 'AUTOMATIC_LEARNING']) scope;
INSERT INTO "MemoryDeletionOutbox" (id, "userId", operation, "targetType", "targetId", "memoryGeneration", state,
  "leaseToken", "leaseExpiresAt", "completedAt", "lastAuditAt", "errorCode")
VALUES ${resetStates.flatMap((state) => [
  `('memory-defaults-reset-${state}', 'memory-defaults-reset-${state}', 'FORGET_PURGE', 'ALL_REUSABLE@fixture', 'synthetic-barrier', 4, '${state}', ${deletionStateFields(state)})`,
  `('memory-defaults-delete-${state}', 'memory-defaults-delete-${state}', 'ACCOUNT_MEMORY_DELETE', 'USER', 'memory-defaults-delete-${state}', 4, '${state}', ${deletionStateFields(state)})`
]).join(",\n")};
INSERT INTO "MemoryIndexGeneration" (id, "userId", generation, state, "indexMode", "targetMemoryRevision",
  "indexedThroughMemoryRevision", "languageProfile", "normalizationVersion", "chunkingVersion", "retrievalPipelineVersion", "readyAt", "activatedAt")
VALUES ('${activeIndex}', 'memory-defaults-paused', 0, 'ACTIVE', 'LEXICAL_ONLY', 11, 11, 'fixture', 'fixture', 'fixture', 'fixture', now(), now()),
  ('${shadowIndex}', 'memory-defaults-paused', 1, 'BUILDING', 'LEXICAL_ONLY', 11, 10, 'fixture', 'fixture', 'fixture', 'fixture', NULL, NULL);
UPDATE "UserMemorySettings" SET "activeIndexGenerationId" = '${activeIndex}' WHERE "userId" = 'memory-defaults-paused';
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion", "memoryGenerationSnapshot", "memoryRevisionSnapshot",
  "idempotencyFingerprint", "attemptCount", "completedAt", "acceptedResultHash")
VALUES ('memory-defaults-rebuild', 'memory-defaults-paused', 'REBUILD_INDEX', 'SUCCEEDED', 'memory-shadow-rebuild-v2', 4, 11,
  'memory-shadow-rebuild-v2:r:${shadowIndex}:${"a".repeat(64)}', 1, now(), '${"b".repeat(64)}'),
  ('memory-defaults-cancelled', 'memory-defaults-paused', 'SYNTHESIZE_MEMORIES', 'CANCELLED', 'fixture', 4, 11,
  'memory-defaults-cancelled', 1, now(), NULL);
COMMIT;
`;

export const memoryDefaultsAdoptionProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "UserMemorySettings" WHERE "userId" IN (${names(resumed)})
    AND "useMemoryFacts" AND "referenceChatHistory" AND "learnAutomatically" AND "synthesisEnabled" AND "decayEnabled"
    AND "synthesisEnabledAt" IS NOT NULL AND "synthesisPolicyVersion" = 'memory-synthesis-policy-v3'
    AND "decayPolicyVersion" = 'memory-decay-v1' AND "memoryGeneration" = 4
    AND "memoryRevision" = 12 AND "settingsRevision" = 8) <> ${resumed.length}
    THEN RAISE EXCEPTION 'memory_existing_preferences_not_resumed'; END IF;
  IF EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" IN (${names(cases.filter((name) => !resumed.includes(name) && name !== "enabled"))})
    AND ("useMemoryFacts" OR "referenceChatHistory" OR "learnAutomatically" OR "synthesisEnabled" OR "decayEnabled"
      OR "memoryGeneration" <> 4 OR "memoryRevision" <> 11 OR "settingsRevision" <> 7 OR "synthesisEnabledAt" IS NOT NULL))
    THEN RAISE EXCEPTION 'memory_destructive_work_reactivated'; END IF;
  IF EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" IN (${names(["mixed", "manual", "enabled"])})
    AND ("synthesisEnabledAt" <> '2026-09-01T00:00:00Z' OR "lastSynthesisAt" <> '2026-09-02T00:00:00Z'))
    THEN RAISE EXCEPTION 'memory_prior_synthesis_progress_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-defaults-enabled'
    AND "memoryGeneration" = 4 AND "memoryRevision" = 11 AND "settingsRevision" = 7 AND "updatedAt" = '2026-09-01T00:00:00Z')
    THEN RAISE EXCEPTION 'memory_already_enabled_reset'; END IF;
  IF (SELECT count(*) FROM "MemoryPauseInterval" pause JOIN "UserMemorySettings" s ON s."userId" = pause."userId"
    WHERE pause."userId" = 'memory-defaults-paused' AND pause."resumedAt" = s."updatedAt"
      AND pause."pausedAt" = '2026-09-03T00:00:00Z' AND pause."memoryGeneration" = 4) <> 3
    THEN RAISE EXCEPTION 'memory_pause_interval_not_preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-defaults-all-off'
    AND "synthesisEnabledAt" = "updatedAt" AND "synthesisEnabledAt" > '2026-09-03T00:00:00Z' AND "lastSynthesisAt" IS NULL)
    THEN RAISE EXCEPTION 'memory_first_enable_backfilled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "MemoryIndexGeneration" WHERE id = '${activeIndex}' AND "indexedThroughMemoryRevision" = 12 AND generation = 0)
    OR NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-defaults-rebuild' AND state = 'QUEUED' AND "acceptedResultHash" IS NULL AND "attemptCount" = 0)
    OR NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-defaults-cancelled' AND state = 'CANCELLED' AND "attemptCount" = 1)
    THEN RAISE EXCEPTION 'memory_resume_index_or_job_fence_invalid'; END IF;
  IF (SELECT status FROM "User" WHERE id = 'memory-defaults-inactive') <> 'disabled'
    THEN RAISE EXCEPTION 'memory_preference_changed_account_authority'; END IF;
END $$;
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('memory-defaults-new', 'Synthetic new owner', 'active', now());
-- Missing-row adoption uses exactly the same DB defaults, within the deferred owner guard.
DELETE FROM "UserMemorySettings" WHERE "userId" = 'memory-defaults-new';
INSERT INTO "UserMemorySettings" ("userId") VALUES ('memory-defaults-new') ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-defaults-new'
    AND "useMemoryFacts" AND "referenceChatHistory" AND "learnAutomatically" AND "synthesisEnabled" AND "decayEnabled"
    AND "synthesisEnabledAt" = "createdAt" AND "synthesisPolicyVersion" = 'memory-synthesis-policy-v3'
    AND "decayPolicyVersion" = 'memory-decay-v1' AND "lastSynthesisAt" IS NULL AND "settingsRevision" = 0)
    THEN RAISE EXCEPTION 'memory_new_defaults_invalid'; END IF;
END $$;
UPDATE "UserMemorySettings" SET "useMemoryFacts" = false, "referenceChatHistory" = false, "learnAutomatically" = false,
  "synthesisEnabled" = false, "decayEnabled" = false, "settingsRevision" = "settingsRevision" + 1
WHERE "userId" = 'memory-defaults-all-off';
COMMIT;
`;

export const memoryDefaultsRepeatProofSql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-defaults-all-off'
    AND NOT "useMemoryFacts" AND NOT "referenceChatHistory" AND NOT "learnAutomatically"
    AND NOT "synthesisEnabled" AND NOT "decayEnabled" AND "settingsRevision" = 9)
    THEN RAISE EXCEPTION 'memory_later_opt_out_overwritten'; END IF;
END $$;`;
