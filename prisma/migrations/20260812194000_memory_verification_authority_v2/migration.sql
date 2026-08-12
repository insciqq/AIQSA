-- Keep the database authority fence aligned with the current fact-verification
-- pipeline while preserving exact authority for an in-flight v1 execution.
BEGIN;

DO $memory_verification_authority_prerequisite$
BEGIN
  IF to_regprocedure('aiqsa_memory_candidate_decision_authority_trigger()') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Memory candidate decision authority trigger prerequisite is missing';
  END IF;
END
$memory_verification_authority_prerequisite$;

CREATE OR REPLACE FUNCTION aiqsa_memory_candidate_decision_authority_trigger()
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
      AND job."pipelineVersion" IN (
        'memory-fact-verification-v1',
        'memory-fact-verification-v2'
      )
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

COMMIT;
