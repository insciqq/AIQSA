/** Synthetic pre-upgrade state; migration-contract owns the disposable database. */
export const RETIRE_DREAM_SYNTHESIS_STAGING_MIGRATION =
  "20261006130000_memory_retire_dream_synthesis_staging";

const closedStates = ["QUEUED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"] as const;
const job = (id: string, owner: string, state: string, pipeline = "memory-synthesis-v2") => {
  const leased = state === "CLAIMED";
  const terminal = state === "SUCCEEDED";
  return `('${id}', '${owner}', 'SYNTHESIZE_MEMORIES', '${state}', '${pipeline}', 0, 0, '${id}', ${leased ? 1 : 0},
    ${leased ? "'synthetic-lease'" : "NULL"}, ${leased ? "now() + interval '1 hour'" : "NULL"}, ${terminal ? "now()" : "NULL"})`;
};

export const retireDreamSynthesisStagingFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
  ('memory-dream-retire-active', 'Synthetic owner', 'active', now()),
  ('memory-dream-retire-disabled', 'Synthetic owner', 'disabled', now());
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion", "memoryGenerationSnapshot",
  "memoryRevisionSnapshot", "idempotencyFingerprint", "attemptCount", "leaseToken", "leaseExpiresAt", "completedAt")
VALUES
${[
  ...closedStates.map((state) => job(`memory-dream-retire-${state}`, "memory-dream-retire-active", state)),
  job("memory-dream-retire-disabled-queued", "memory-dream-retire-disabled", "QUEUED"),
  job("memory-dream-retire-claimed", "memory-dream-retire-active", "CLAIMED"),
  job("memory-dream-retire-applied", "memory-dream-retire-active", "SUCCEEDED"),
  job("memory-dream-retire-maintenance", "memory-dream-retire-active", "QUEUED", "memory-maintenance-v1")
].join(",\n")};
INSERT INTO "MemoryExecutionBinding" (id, "userId", "ownerType", "memoryJobId", "logicalRole", ordinal, state,
  "providerId", "destinationFingerprint", "policyVersion", "promptVersion", "schemaVersion", "pipelineVersion",
  "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash", "usageCompleteness", "createdAt", "startedAt",
  "completedAt", "recoverableUntil", "relationsDetachedAt")
VALUES ('memory-dream-retire-binding', 'memory-dream-retire-active', 'JOB', 'memory-dream-retire-applied',
  'MEMORY_SYNTHESIZE', 0, 'SUCCEEDED', 'openai_compatible', '${"d".repeat(64)}', 'memory-synthesis-policy-v6',
  'memory-synthesis-prompt-v9', 'memory-synthesis-schema-v4', 'memory-synthesis-v2', '{}', '${"c".repeat(64)}',
  '${"b".repeat(64)}', 'UNAVAILABLE', now() - interval '2 minutes', now() - interval '1 minute', now(), now(), now());
INSERT INTO "MemorySynthesisExecution" (id, "userId", "memoryJobId", "executionBindingId", "inputHash",
  "acceptedOutputHash", "sourceSetFingerprint", "sourceSnapshotHash", "acceptedOutput", "sourceBindings")
VALUES ('memory-dream-retire-staging', 'memory-dream-retire-active', 'memory-dream-retire-applied',
  'memory-dream-retire-binding', '${"c".repeat(64)}', '${"b".repeat(64)}', '${"e".repeat(64)}', '${"f".repeat(64)}',
  '{"patterns":[]}', '[]');
COMMIT;
`;

/** Pure checks, so the repeated deploy is proven by running it again. */
export const retireDreamSynthesisStagingProofSql = `
DO $proof$ BEGIN
  IF (SELECT count(*) FROM "MemoryJob" WHERE id IN (${[...closedStates.map((state) => `'memory-dream-retire-${state}'`),
    "'memory-dream-retire-disabled-queued'"].join(", ")})
    AND state = 'CANCELLED' AND "errorCode" = 'memory_synthesis_retired' AND "completedAt" IS NOT NULL
    AND "leaseToken" IS NULL AND "nextAttemptAt" IS NULL) <> ${closedStates.length + 1}
    THEN RAISE EXCEPTION 'retired_dream_jobs_not_closed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-dream-retire-claimed'
      AND state = 'CLAIMED' AND "leaseToken" = 'synthetic-lease' AND "errorCode" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-dream-retire-applied'
      AND state = 'SUCCEEDED' AND "errorCode" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-dream-retire-maintenance'
      AND state = 'QUEUED' AND "errorCode" IS NULL)
    THEN RAISE EXCEPTION 'retired_dream_migration_changed_other_jobs'; END IF;
  IF EXISTS (SELECT 1 FROM "MemorySynthesisExecution")
    THEN RAISE EXCEPTION 'retired_dream_staging_retained'; END IF;
  -- Accounting history stays, and the previous release's writers still find
  -- the table and its guard during Compose replacement.
  IF NOT EXISTS (SELECT 1 FROM "MemoryExecutionBinding" WHERE id = 'memory-dream-retire-binding' AND state = 'SUCCEEDED')
    THEN RAISE EXCEPTION 'retired_dream_binding_not_preserved'; END IF;
  IF to_regclass('public."MemorySynthesisExecution"') IS NULL
    OR to_regprocedure('aiqsa_memory_synthesis_execution_guard()') IS NULL
    THEN RAISE EXCEPTION 'retired_dream_staging_dropped_early'; END IF;
END $proof$;
`;
