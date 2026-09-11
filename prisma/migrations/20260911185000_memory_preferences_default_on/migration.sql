BEGIN;

-- Drain creation and the owner-before-settings locks used by Memory writers.
-- Defaults, pause cutoffs and revision fences become visible atomically, even
-- during the previous release's short overlap with migration deployment.
LOCK TABLE "User" IN EXCLUSIVE MODE;
ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "synthesisEnabled" SET DEFAULT true,
  ALTER COLUMN "synthesisEnabledAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "synthesisPolicyVersion" SET DEFAULT 'memory-synthesis-policy-v3',
  ALTER COLUMN "decayEnabled" SET DEFAULT true,
  ALTER COLUMN "decayPolicyVersion" SET DEFAULT 'memory-decay-v1';

-- The existing User insert trigger and bootstrap upsert use column defaults.
-- This one-time operator-authorized transition includes previous opt-outs.
-- Future user choices are never repaired by login, bootstrap or another deploy.
DO $$
DECLARE
  cutoff timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
  settings record;
  shadow_id text;
BEGIN
  FOR settings IN
    SELECT s.* FROM "UserMemorySettings" s
    JOIN "User" owner ON owner.id = s."userId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "MemoryDeletionOutbox" obligation
      WHERE obligation."userId" = s."userId" AND (
        obligation.operation = 'ACCOUNT_MEMORY_DELETE'
        OR (obligation.operation = 'FORGET_PURGE'
          AND starts_with(obligation."targetType", 'ALL_REUSABLE@')
          AND obligation.state NOT IN ('SUCCEEDED', 'CANCELLED'))
      )
    ) AND (
      NOT (s."useMemoryFacts" AND s."referenceChatHistory" AND s."learnAutomatically"
        AND s."synthesisEnabled" AND s."decayEnabled")
      OR s."synthesisEnabledAt" IS NULL
      OR s."synthesisPolicyVersion" IS DISTINCT FROM 'memory-synthesis-policy-v3'
      OR s."decayPolicyVersion" IS DISTINCT FROM 'memory-decay-v1'
      OR EXISTS (SELECT 1 FROM "MemoryPauseInterval" pause
        WHERE pause."userId" = s."userId" AND pause."resumedAt" IS NULL)
    )
    ORDER BY s."userId" FOR UPDATE OF s
  LOOP
    UPDATE "UserMemorySettings" SET
      "useMemoryFacts" = true, "referenceChatHistory" = true, "learnAutomatically" = true,
      "synthesisEnabled" = true, "decayEnabled" = true,
      "synthesisEnabledAt" = COALESCE(settings."synthesisEnabledAt", cutoff),
      "synthesisPolicyVersion" = 'memory-synthesis-policy-v3',
      "decayPolicyVersion" = 'memory-decay-v1',
      "settingsRevision" = settings."settingsRevision" + 1,
      "memoryRevision" = settings."memoryRevision" + 1,
      "updatedAt" = cutoff
    WHERE "userId" = settings."userId";

    -- Preserve the excluded interval: paused messages do not become new input.
    UPDATE "MemoryPauseInterval" SET "resumedAt" = cutoff
    WHERE "userId" = settings."userId" AND "resumedAt" IS NULL;

    -- Content/generations are unchanged. An unused account may retain its lazy
    -- null index; an existing serving projection covers this preference change.
    UPDATE "MemoryIndexGeneration" SET
      "indexedThroughMemoryRevision" = settings."memoryRevision" + 1
    WHERE "userId" = settings."userId" AND id = settings."activeIndexGenerationId" AND state = 'ACTIVE';

    SELECT id INTO shadow_id FROM "MemoryIndexGeneration"
    WHERE "userId" = settings."userId" AND state IN ('BUILDING', 'CATCHING_UP', 'READY')
    ORDER BY generation DESC LIMIT 1;
    IF shadow_id IS NOT NULL THEN
      -- Match the ordinary visible-setting fence: only a completed local
      -- rebuild wakes. Cancelled/ambiguous provider work remains untouched.
      UPDATE "MemoryJob" SET state = 'QUEUED', "acceptedResultHash" = NULL,
        "attemptCount" = 0, "completedAt" = NULL, "errorCode" = NULL, "errorMessage" = NULL,
        "leaseExpiresAt" = NULL, "leaseToken" = NULL, "nextAttemptAt" = NULL,
        stage = NULL, "updatedAt" = cutoff
      WHERE "userId" = settings."userId" AND kind = 'REBUILD_INDEX' AND state = 'SUCCEEDED'
        AND (starts_with("idempotencyFingerprint", 'memory-shadow-rebuild-v2:r:' || shadow_id || ':')
          OR starts_with("idempotencyFingerprint", 'memory-shadow-rebuild-v2:e:' || shadow_id || ':'));
    END IF;
  END LOOP;
END $$;

COMMIT;
