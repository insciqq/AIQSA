/** Synthetic predecessor rows; migration-contract owns the disposable database. */
export const MEMORY_WORKER_RECOVERY_MIGRATION = "20260917010000_memory_worker_recovery";

export const memoryWorkerRecoveryFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-worker-recovery-owner', 'Fixture owner', 'active', now());
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion", "attemptCount",
  "memoryGenerationSnapshot", "memoryRevisionSnapshot", "idempotencyFingerprint",
  "errorCode", "leaseToken", "leaseExpiresAt", "completedAt", "updatedAt")
SELECT 'memory-worker-recovery-' || state, 'memory-worker-recovery-owner', 'EMBED_ITEMS',
  state::"MemoryJobState", 'adoption-fixture-v1', 2, 0, 0, 'memory-worker-recovery-' || state,
  CASE WHEN state = 'TERMINAL_FAILED' THEN 'memory_job_commit_timeout' END,
  CASE WHEN state = 'CLAIMED' THEN 'fixture-lease' END,
  CASE WHEN state = 'CLAIMED' THEN now() + interval '1 minute' END,
  CASE WHEN state IN ('SUCCEEDED', 'TERMINAL_FAILED') THEN now() - interval '1 minute' END, now()
FROM unnest(ARRAY['CLAIMED', 'SUCCEEDED', 'TERMINAL_FAILED']) AS state;
INSERT INTO "MemoryWorkerHeartbeat" (id, "instanceId", "startedAt", "lastSeenAt")
VALUES ('installation', 'predecessor-worker', now() - interval '1 minute', now());
CREATE TABLE "MemoryWorkerRecoveryFixture" AS
SELECT id, to_jsonb(job) AS snapshot FROM "MemoryJob" AS job WHERE "userId" = 'memory-worker-recovery-owner';
`;

export const memoryWorkerRecoveryProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "MemoryWorkerRecoveryFixture" AS original
      JOIN "MemoryJob" AS job USING (id)
      WHERE original.snapshot = to_jsonb(job) - ARRAY['progressAt', 'recoveryCount', 'lastRecoveryAt', 'recoveryErrorCode']
        AND job."recoveryCount" = 0 AND job."lastRecoveryAt" IS NULL AND job."recoveryErrorCode" IS NULL
        AND job."progressAt" IS NOT DISTINCT FROM job."completedAt") <> 3 THEN
    RAISE EXCEPTION 'memory_worker_recovery_changed_predecessor_work';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "MemoryWorkerHeartbeat" WHERE id = 'installation'
      AND "instanceId" = 'predecessor-worker' AND ready) THEN
    RAISE EXCEPTION 'memory_worker_recovery_predecessor_heartbeat_invalid';
  END IF;
  BEGIN
    UPDATE "MemoryJob" SET "recoveryCount" = 1 WHERE id = 'memory-worker-recovery-TERMINAL_FAILED';
    RAISE EXCEPTION 'memory_worker_recovery_accepted_missing_evidence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
UPDATE "MemoryJob" SET state = 'QUEUED', "completedAt" = NULL, "recoveryCount" = 1,
  "lastRecoveryAt" = now(), "recoveryErrorCode" = "errorCode"
WHERE id = 'memory-worker-recovery-TERMINAL_FAILED';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryJob" WHERE id = 'memory-worker-recovery-TERMINAL_FAILED'
      AND state = 'QUEUED' AND "attemptCount" = 2 AND "recoveryErrorCode" = 'memory_job_commit_timeout') THEN
    RAISE EXCEPTION 'memory_worker_recovery_lost_failure_history';
  END IF;
END $$;
DROP TABLE "MemoryWorkerRecoveryFixture";
`;
