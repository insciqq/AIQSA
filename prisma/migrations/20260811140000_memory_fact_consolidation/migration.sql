-- Persist only bounded, server-decoded consolidation decisions. Provider
-- reasoning is never stored and no decision can authorize a fact transition
-- without its exact candidate, job, and succeeded execution binding.
BEGIN;

CREATE TYPE "MemoryConsolidationOperation" AS ENUM (
  'ADD', 'REINFORCE', 'SUPERSEDE', 'CONFLICT', 'EXPIRE', 'NOOP', 'DEFER'
);

CREATE TYPE "MemoryCandidateDecisionState" AS ENUM (
  'PENDING_VERIFICATION', 'APPLIED', 'REJECTED', 'STALE'
);

CREATE TABLE "MemoryCandidateDecision" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "consolidationJobId" TEXT NOT NULL,
  "consolidationExecutionId" TEXT NOT NULL,
  "operation" "MemoryConsolidationOperation" NOT NULL,
  "targetFactId" TEXT,
  "targetVersionId" TEXT,
  "effectiveFrom" TIMESTAMP(3),
  "reasonCode" VARCHAR(64) NOT NULL,
  "requiresVerification" BOOLEAN NOT NULL,
  "state" "MemoryCandidateDecisionState" NOT NULL,
  "relatedSnapshotHash" VARCHAR(64) NOT NULL,
  "consolidationInputHash" VARCHAR(64) NOT NULL,
  "consolidationOutputHash" VARCHAR(64) NOT NULL,
  "verificationJobId" TEXT,
  "verificationInputHash" VARCHAR(64),
  "verificationExecutionId" TEXT,
  "verificationOutputHash" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryCandidateDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryCandidateDecision_userId_id_key"
  ON "MemoryCandidateDecision"("userId", "id");
CREATE UNIQUE INDEX "MemoryCandidateDecision_userId_candidateId_key"
  ON "MemoryCandidateDecision"("userId", "candidateId");
CREATE INDEX "MemoryCandidateDecision_userId_state_createdAt_idx"
  ON "MemoryCandidateDecision"("userId", "state", "createdAt");
CREATE INDEX "MemoryCandidateDecision_userId_consolidationJobId_idx"
  ON "MemoryCandidateDecision"("userId", "consolidationJobId");
CREATE INDEX "MemoryCandidateDecision_userId_verificationJobId_idx"
  ON "MemoryCandidateDecision"("userId", "verificationJobId");
CREATE INDEX "MemoryCandidateDecision_userId_targetFactId_targetVersionId_idx"
  ON "MemoryCandidateDecision"("userId", "targetFactId", "targetVersionId");

ALTER TABLE "MemoryCandidateDecision"
  ADD CONSTRAINT "MemoryCandidateDecision_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_candidate_fkey"
    FOREIGN KEY ("userId", "candidateId")
    REFERENCES "MemoryCandidate"("userId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_consolidation_job_fkey"
    FOREIGN KEY ("userId", "consolidationJobId")
    REFERENCES "MemoryJob"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_consolidation_execution_fkey"
    FOREIGN KEY ("userId", "consolidationExecutionId")
    REFERENCES "MemoryExecutionBinding"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_verification_job_fkey"
    FOREIGN KEY ("userId", "verificationJobId")
    REFERENCES "MemoryJob"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_verification_execution_fkey"
    FOREIGN KEY ("userId", "verificationExecutionId")
    REFERENCES "MemoryExecutionBinding"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_target_fact_fkey"
    FOREIGN KEY ("userId", "targetFactId")
    REFERENCES "MemoryFact"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_target_version_fkey"
    FOREIGN KEY ("userId", "targetFactId", "targetVersionId")
    REFERENCES "MemoryFactVersion"("userId", "factId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateDecision_shape_check"
    CHECK (
      "id" ~ '^[a-f0-9]{64}$'
      AND "relatedSnapshotHash" ~ '^[a-f0-9]{64}$'
      AND "consolidationInputHash" ~ '^[a-f0-9]{64}$'
      AND "consolidationOutputHash" ~ '^[a-f0-9]{64}$'
      AND ("verificationInputHash" IS NULL OR "verificationInputHash" ~ '^[a-f0-9]{64}$')
      AND ("verificationOutputHash" IS NULL OR "verificationOutputHash" ~ '^[a-f0-9]{64}$')
      AND "reasonCode" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND (
        (
          "operation" IN ('ADD', 'NOOP', 'DEFER')
          AND num_nonnulls("targetFactId", "targetVersionId") = 0
        ) OR (
          "operation" IN ('REINFORCE', 'SUPERSEDE', 'CONFLICT', 'EXPIRE')
          AND num_nonnulls("targetFactId", "targetVersionId") = 2
        )
      )
      AND ("operation" = 'SUPERSEDE' OR "effectiveFrom" IS NULL)
      AND (
        "requiresVerification" = (
          num_nonnulls("verificationJobId", "verificationInputHash") = 2
        )
      )
      AND num_nonnulls("verificationExecutionId", "verificationOutputHash") IN (0, 2)
      AND (
        (
          "state" = 'PENDING_VERIFICATION'
          AND "requiresVerification"
          AND "resolvedAt" IS NULL
          AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 0
        ) OR (
          "state" = 'APPLIED'
          AND "resolvedAt" IS NOT NULL
          AND (
            (NOT "requiresVerification" AND num_nonnulls(
              "verificationJobId", "verificationInputHash",
              "verificationExecutionId", "verificationOutputHash"
            ) = 0)
            OR ("requiresVerification" AND num_nonnulls(
              "verificationExecutionId", "verificationOutputHash"
            ) = 2)
          )
        ) OR (
          "state" = 'REJECTED'
          AND "requiresVerification"
          AND "resolvedAt" IS NOT NULL
          AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 2
        ) OR (
          "state" = 'STALE' AND "resolvedAt" IS NOT NULL
        )
      )
    );

CREATE FUNCTION aiqsa_memory_candidate_decision_authority_trigger()
RETURNS trigger LANGUAGE plpgsql AS $memory_candidate_decision_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "MemoryJob" AS job
      ON job."userId" = candidate."userId"
      AND job."id" = NEW."consolidationJobId"
    INNER JOIN "MemoryExecutionBinding" AS execution
      ON execution."userId" = job."userId"
      AND execution."memoryJobId" = job."id"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND job."kind" = 'CONSOLIDATE_CANDIDATE'
      AND job."pipelineVersion" = 'memory-fact-consolidation-v1'
      AND job."idempotencyFingerprint" LIKE
        ('consolidate-candidate:' || candidate."id" || ':%')
      AND job."chatId" = candidate."chatId"
      AND job."branchGeneration" = candidate."branchGeneration"
      AND job."sourceRevision" = candidate."sourceRevision"
      AND job."sourceHash" = candidate."sourceHash"
      AND execution."id" = NEW."consolidationExecutionId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_CONSOLIDATE'
      AND execution."state" = 'SUCCEEDED'
      AND execution."inputHash" = NEW."consolidationInputHash"
      AND execution."acceptedOutputHash" = NEW."consolidationOutputHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact consolidation authority';
  END IF;

  IF NEW."verificationJobId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "MemoryJob" AS job
      ON job."userId" = candidate."userId"
      AND job."id" = NEW."verificationJobId"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND job."kind" = 'VERIFY_CANDIDATE'
      AND job."pipelineVersion" = 'memory-fact-verification-v1'
      AND job."idempotencyFingerprint" = ('verify-candidate:' || NEW."id")
      AND job."chatId" = candidate."chatId"
      AND job."branchGeneration" = candidate."branchGeneration"
      AND job."sourceRevision" = candidate."sourceRevision"
      AND job."sourceHash" = candidate."sourceHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact verification job authority';
  END IF;

  IF NEW."verificationExecutionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryExecutionBinding" AS execution
    WHERE execution."userId" = NEW."userId"
      AND execution."id" = NEW."verificationExecutionId"
      AND execution."memoryJobId" = NEW."verificationJobId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_VERIFY'
      AND execution."state" = 'SUCCEEDED'
      AND execution."inputHash" = NEW."verificationInputHash"
      AND execution."acceptedOutputHash" = NEW."verificationOutputHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact verification authority';
  END IF;
  RETURN NEW;
END
$memory_candidate_decision_authority$;

CREATE TRIGGER "MemoryCandidateDecision_authority_trigger"
BEFORE INSERT OR UPDATE ON "MemoryCandidateDecision"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_decision_authority_trigger();

CREATE FUNCTION aiqsa_memory_candidate_decision_immutable_trigger()
RETURNS trigger LANGUAGE plpgsql AS $memory_candidate_decision_immutable$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."candidateId" IS DISTINCT FROM OLD."candidateId"
    OR NEW."consolidationJobId" IS DISTINCT FROM OLD."consolidationJobId"
    OR NEW."consolidationExecutionId" IS DISTINCT FROM OLD."consolidationExecutionId"
    OR NEW."operation" IS DISTINCT FROM OLD."operation"
    OR NEW."targetFactId" IS DISTINCT FROM OLD."targetFactId"
    OR NEW."targetVersionId" IS DISTINCT FROM OLD."targetVersionId"
    OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
    OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
    OR NEW."requiresVerification" IS DISTINCT FROM OLD."requiresVerification"
    OR NEW."relatedSnapshotHash" IS DISTINCT FROM OLD."relatedSnapshotHash"
    OR NEW."consolidationInputHash" IS DISTINCT FROM OLD."consolidationInputHash"
    OR NEW."consolidationOutputHash" IS DISTINCT FROM OLD."consolidationOutputHash"
    OR NEW."verificationJobId" IS DISTINCT FROM OLD."verificationJobId"
    OR NEW."verificationInputHash" IS DISTINCT FROM OLD."verificationInputHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision authority is immutable';
  END IF;
  RETURN NEW;
END
$memory_candidate_decision_immutable$;

CREATE TRIGGER "MemoryCandidateDecision_immutable_trigger"
BEFORE UPDATE ON "MemoryCandidateDecision"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_decision_immutable_trigger();

COMMIT;
