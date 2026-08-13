-- Add the discrete Core Memory decision carried by automatic extraction and
-- make automatic learning the default for newly provisioned settings. Existing
-- user choices are preserved; explicit/pinned facts qualify for Core by their
-- existing authority fields and do not need a lossy data rewrite.
BEGIN;

CREATE TYPE "MemoryCoreSalience" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NONE');

ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "learnAutomatically" SET DEFAULT true;

ALTER TABLE "MemoryHistoryRun"
  ALTER COLUMN "query" TYPE varchar(2000);

ALTER TABLE "MemoryCandidate"
  ADD COLUMN "proposedCoreEligible" BOOLEAN,
  ADD COLUMN "proposedCoreSalience" "MemoryCoreSalience";

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "coreEligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "coreSalience" "MemoryCoreSalience" NOT NULL DEFAULT 'NONE';

ALTER TABLE "MemoryCandidate"
  DROP CONSTRAINT "MemoryCandidate_shape_check",
  ADD CONSTRAINT "MemoryCandidate_shape_check"
    CHECK (
      "id" ~ '^[a-f0-9]{64}$'
      AND "branchGeneration" >= 0
      AND "sourceRevision" >= 0
      AND "sourceHash" ~ '^[a-f0-9]{64}$'
      AND "sourceProjectionHash" ~ '^[a-f0-9]{64}$'
      AND "sourceProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "pipelineVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Za-z0-9._-]{1,64}$')
      AND (
        "contentPurgedAt" IS NULL
        OR (
          "state" IN ('PROMOTED', 'REJECTED', 'STALE')
          AND num_nonnulls(
            "proposedCanonicalKey", "proposedDisplayText", "proposedValue",
            "proposedCategory", "proposedModality", "proposedScope",
            "proposedValidFrom", "proposedValidTo", "rawTemporalExpression",
            "sourceTimezone", "temporalResolverVersion",
            "temporalResolutionEvidence", "proposedDirectness",
            "proposedSensitivity", "proposedCoreEligible",
            "proposedCoreSalience", "languageCode", "importance", "confidence",
            "negated"
          ) = 0
        )
      )
      AND (
        "contentPurgedAt" IS NOT NULL
        OR (
          num_nonnulls(
            "proposedCanonicalKey", "proposedDisplayText", "proposedValue",
            "proposedCategory", "proposedModality", "proposedScope",
            "sourceTimezone", "proposedDirectness", "proposedSensitivity",
            "languageCode", "importance", "confidence", "negated"
          ) = 13
          AND char_length("proposedCanonicalKey") BETWEEN 1 AND 256
          AND "proposedCanonicalKey" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'
          AND char_length("proposedDisplayText") BETWEEN 1 AND 2000
          AND char_length("proposedCategory") BETWEEN 1 AND 64
          AND "proposedCategory" ~ '^[A-Za-z0-9._-]{1,64}$'
          AND pg_column_size("proposedValue") <= 8192
          AND jsonb_typeof("proposedScope") = 'object'
          AND pg_column_size("proposedScope") <= 2048
          AND "proposedScope" ? 'type'
          AND "proposedScope" ? 'target_id'
          AND ("proposedScope" ->> 'type') IN (
            'GLOBAL_USER', 'FOLDER', 'ASSISTANT', 'CHAT'
          )
          AND ("proposedScope" - ARRAY['type', 'target_id']::text[]) = '{}'::jsonb
          AND (
            (
              "proposedScope" ->> 'type' = 'GLOBAL_USER'
              AND COALESCE("proposedScope" ->> 'target_id', '') = ''
            ) OR (
              "proposedScope" ->> 'type' <> 'GLOBAL_USER'
              AND char_length(COALESCE("proposedScope" ->> 'target_id', ''))
                BETWEEN 1 AND 256
              AND COALESCE("proposedScope" ->> 'target_id', '') !~ '\\s'
            )
          )
          AND (
            "proposedValidFrom" IS NULL OR "proposedValidTo" IS NULL
            OR "proposedValidTo" >= "proposedValidFrom"
          )
          AND (
            "rawTemporalExpression" IS NULL
            OR char_length("rawTemporalExpression") BETWEEN 1 AND 512
          )
          AND "sourceTimezone" ~ '^[A-Za-z0-9_+./-]{1,64}$'
          AND (
            num_nonnulls(
              "temporalResolverVersion", "temporalResolutionEvidence"
            ) = 0
            OR (
              num_nonnulls(
                "temporalResolverVersion", "temporalResolutionEvidence"
              ) = 2
              AND "temporalResolverVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
              AND jsonb_typeof("temporalResolutionEvidence") = 'object'
              AND pg_column_size("temporalResolutionEvidence") <= 4096
            )
          )
          AND "proposedDirectness" IN ('DIRECT', 'PARAPHRASED')
          AND "proposedSensitivity" = 'NORMAL'
          AND char_length("languageCode") BETWEEN 2 AND 35
          AND "languageCode" !~ '[[:cntrl:][:space:]]'
          AND "importance" BETWEEN 0 AND 1
          AND "confidence" BETWEEN 0 AND 1
          AND (
            "pipelineVersion" <> 'memory-fact-extraction-v2'
            OR (
              num_nonnulls(
                "proposedCoreEligible", "proposedCoreSalience"
              ) = 2
              AND (
                ("proposedCoreEligible" AND "proposedCoreSalience" <> 'NONE')
                OR (
                  NOT "proposedCoreEligible"
                  AND "proposedCoreSalience" = 'NONE'
                )
              )
            )
          )
        )
      )
      AND (
        (
          "state" = 'PENDING' AND "reasonCode" IS NULL
          AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL
          AND "contentPurgedAt" IS NULL
        ) OR (
          "state" = 'DEFERRED' AND "reasonCode" IS NOT NULL
          AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL
          AND "contentPurgedAt" IS NULL
        ) OR (
          "state" = 'PROMOTED' AND "resolvedAt" IS NOT NULL
          AND "resolvedFactId" IS NOT NULL
        ) OR (
          "state" IN ('REJECTED', 'STALE') AND "reasonCode" IS NOT NULL
          AND "resolvedAt" IS NOT NULL AND "resolvedFactId" IS NULL
        )
      )
    );

-- The normal v2 path uses one consolidator and writes an applied decision
-- directly. Legacy v1/v2 verifier jobs remain valid only so queued historical
-- work can settle without weakening exact execution authority.
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
      AND job."pipelineVersion" IN (
        'memory-fact-consolidation-v1',
        'memory-fact-consolidation-v2'
      )
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
