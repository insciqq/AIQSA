/** Synthetic predecessor rows; migration-contract owns the disposable database. */
export const MEMORY_CONFIGURATION_WAIT_MIGRATION = "20260911010000_memory_configuration_wait_state";

export const memoryConfigurationAdoptionFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-configuration-owner', 'Fixture owner', 'active', now());
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion",
  "memoryGenerationSnapshot", "memoryRevisionSnapshot", "idempotencyFingerprint",
  "errorCode", "leaseToken", "leaseExpiresAt", "completedAt", "updatedAt")
SELECT 'memory-configuration-' || state, 'memory-configuration-owner', 'EMBED_ITEMS',
  state::"MemoryJobState", 'adoption-fixture-v1', 0, 0, 'memory-configuration-' || state,
  CASE WHEN state = 'WAITING_FOR_EGRESS_CONSENT' THEN 'memory_execution_egress_consent_required' END,
  CASE WHEN state = 'CLAIMED' THEN 'fixture-lease' END,
  CASE WHEN state = 'CLAIMED' THEN now() END,
  CASE WHEN state IN ('SUCCEEDED', 'TERMINAL_FAILED') THEN now() END, now()
FROM unnest(ARRAY['WAITING_FOR_EGRESS_CONSENT', 'CLAIMED', 'SUCCEEDED', 'TERMINAL_FAILED']) AS state;
CREATE TABLE "MemoryConfigurationAdoptionFixture" AS
SELECT id, to_jsonb(job) AS snapshot FROM "MemoryJob" AS job WHERE "userId" = 'memory-configuration-owner';
`;

export const memoryConfigurationAdoptionProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "MemoryConfigurationAdoptionFixture" AS original
      JOIN "MemoryJob" AS job USING (id) WHERE original.snapshot = to_jsonb(job)) <> 4 THEN
    RAISE EXCEPTION 'memory_wait_migration_changed_existing_work';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings" WHERE "userId" = 'memory-configuration-owner'
      AND "useMemoryFacts" AND "referenceChatHistory" AND "learnAutomatically"
      AND "acceptedUtilityEgressAt" IS NULL AND "acceptedUtilityEgressFingerprint" IS NULL
      AND "acceptedUtilityPolicyVersion" IS NULL AND "memoryConsentRevision" = 0) THEN
    RAISE EXCEPTION 'memory_wait_migration_fabricated_acceptance_or_disabled_defaults';
  END IF;
END $$;
UPDATE "MemoryJob" SET state = 'WAITING_FOR_CONFIGURATION', "errorCode" = 'memory_execution_target_unavailable'
WHERE id = 'memory-configuration-WAITING_FOR_EGRESS_CONSENT';
DO $$ BEGIN
  BEGIN
    UPDATE "MemoryJob" SET "leaseToken" = 'invalid-lease', "leaseExpiresAt" = now()
    WHERE id = 'memory-configuration-WAITING_FOR_EGRESS_CONSENT';
    RAISE EXCEPTION 'memory_wait_shape_accepted_a_lease';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryJob" SET "nextAttemptAt" = now()
    WHERE id = 'memory-configuration-WAITING_FOR_EGRESS_CONSENT';
    RAISE EXCEPTION 'memory_wait_shape_accepted_scheduled_retry';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DROP TABLE "MemoryConfigurationAdoptionFixture";
`;
