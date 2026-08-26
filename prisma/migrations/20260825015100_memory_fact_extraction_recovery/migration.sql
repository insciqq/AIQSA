-- Corrective vNext: accepted extraction packets are recoverable before
-- semantic apply, and every packet ordinal has a content-free durable outcome.

CREATE TYPE "MemoryFactExtractionCandidateOutcome" AS ENUM (
  'PENDING',
  'APPLIED',
  'REPLAY',
  'REINFORCED',
  'MERGED',
  'SUPERSEDED',
  'REJECTED',
  'STALE',
  'RETRYABLE_FAILED'
);

CREATE TABLE "MemoryFactExtractionExecution" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryJobId" TEXT NOT NULL,
  "executionBindingId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "sourceMessageContentHash" VARCHAR(128) NOT NULL,
  "inputHash" VARCHAR(128) NOT NULL,
  "acceptedOutputHash" VARCHAR(128) NOT NULL,
  "acceptedOutput" JSONB,
  "contextBindings" JSONB,
  "recoverableUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryFactExtractionExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryFactExtractionCandidateReceipt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "extractionExecutionId" TEXT NOT NULL,
  "candidateOrdinal" INTEGER NOT NULL,
  "candidateFingerprint" VARCHAR(128) NOT NULL,
  "outcome" "MemoryFactExtractionCandidateOutcome" NOT NULL DEFAULT 'PENDING',
  "reasonCode" VARCHAR(64),
  "resultingFactId" TEXT,
  "resultingFactVersionId" TEXT,
  "resultingEvidenceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryFactExtractionCandidateReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryFactExtractionExecution_userId_id_key"
  ON "MemoryFactExtractionExecution"("userId", "id");
CREATE UNIQUE INDEX "MemoryFactExtractionExecution_userId_memoryJobId_key"
  ON "MemoryFactExtractionExecution"("userId", "memoryJobId");
CREATE UNIQUE INDEX "MemoryFactExtractionExecution_userId_executionBindingId_key"
  ON "MemoryFactExtractionExecution"("userId", "executionBindingId");
CREATE INDEX "MemoryFactExtractionExecution_userId_appliedAt_recoverableU_idx"
  ON "MemoryFactExtractionExecution"("userId", "appliedAt", "recoverableUntil");
CREATE INDEX "MemoryFactExtractionExecution_userId_sourceMessageId_applie_idx"
  ON "MemoryFactExtractionExecution"("userId", "sourceMessageId", "appliedAt");

CREATE UNIQUE INDEX "MemoryFactExtractionCandidateReceipt_userId_id_key"
  ON "MemoryFactExtractionCandidateReceipt"("userId", "id");
CREATE UNIQUE INDEX "MemoryFactExtractReceipt_user_execution_ordinal_key"
  ON "MemoryFactExtractionCandidateReceipt"(
    "userId", "extractionExecutionId", "candidateOrdinal"
  );
CREATE UNIQUE INDEX "MemoryFactExtractReceipt_user_execution_fingerprint_key"
  ON "MemoryFactExtractionCandidateReceipt"(
    "userId", "extractionExecutionId", "candidateFingerprint"
  );
CREATE INDEX "MemoryFactExtractionCandidateReceipt_userId_outcome_updated_idx"
  ON "MemoryFactExtractionCandidateReceipt"("userId", "outcome", "updatedAt");

ALTER TABLE "MemoryFactExtractionExecution"
  ADD CONSTRAINT "MemoryFactExtractionExecution_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactExtractionExecution"
  ADD CONSTRAINT "MemoryFactExtractionExecution_job_fkey"
  FOREIGN KEY ("userId", "memoryJobId")
  REFERENCES "MemoryJob"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactExtractionExecution"
  ADD CONSTRAINT "MemoryFactExtractionExecution_binding_fkey"
  FOREIGN KEY ("userId", "executionBindingId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFactExtractionCandidateReceipt"
  ADD CONSTRAINT "MemoryFactExtractionCandidateReceipt_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactExtractionCandidateReceipt"
  ADD CONSTRAINT "MemoryFactExtractionCandidateReceipt_execution_fkey"
  FOREIGN KEY ("userId", "extractionExecutionId")
  REFERENCES "MemoryFactExtractionExecution"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactExtractionExecution"
  ADD CONSTRAINT "MemoryFactExtractionExecution_shape_check" CHECK (
    "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
    AND "inputHash" ~ '^[a-f0-9]{64}$'
    AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    AND "recoverableUntil" >= "createdAt"
    AND (
      (
        "appliedAt" IS NULL
        AND "acceptedOutput" IS NOT NULL
        AND "contextBindings" IS NOT NULL
        AND jsonb_typeof("acceptedOutput") = 'object'
        AND jsonb_typeof("contextBindings") = 'array'
      )
      OR (
        "appliedAt" IS NOT NULL
        AND "appliedAt" >= "createdAt"
        AND "acceptedOutput" IS NULL
        AND "contextBindings" IS NULL
      )
    )
  );

ALTER TABLE "MemoryFactExtractionCandidateReceipt"
  ADD CONSTRAINT "MemoryFactExtractionCandidateReceipt_shape_check" CHECK (
    "candidateOrdinal" BETWEEN 0 AND 7
    AND "candidateFingerprint" ~ '^[a-f0-9]{64}$'
    AND ("reasonCode" IS NULL OR
      "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$')
    AND (
      (
        "outcome" = 'PENDING'::"MemoryFactExtractionCandidateOutcome"
        AND "reasonCode" IS NULL
        AND "resultingFactId" IS NULL
        AND "resultingFactVersionId" IS NULL
        AND "resultingEvidenceId" IS NULL
      )
      OR (
        "outcome" = ANY (ARRAY[
          'APPLIED', 'REPLAY', 'REINFORCED', 'MERGED', 'SUPERSEDED'
        ]::"MemoryFactExtractionCandidateOutcome"[])
        AND "reasonCode" IS NULL
        AND "resultingFactId" IS NOT NULL
        AND "resultingFactVersionId" IS NOT NULL
        AND "resultingEvidenceId" IS NOT NULL
      )
      OR (
        "outcome" = ANY (ARRAY[
          'REJECTED', 'STALE', 'RETRYABLE_FAILED'
        ]::"MemoryFactExtractionCandidateOutcome"[])
        AND "reasonCode" IS NOT NULL
        AND "resultingFactId" IS NULL
        AND "resultingFactVersionId" IS NULL
        AND "resultingEvidenceId" IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_fact_extraction_execution_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id", NEW."userId", NEW."memoryJobId", NEW."executionBindingId",
    NEW."sourceMessageId", NEW."sourceMessageContentHash", NEW."inputHash",
    NEW."acceptedOutputHash", NEW."recoverableUntil", NEW."createdAt"
  ) IS DISTINCT FROM (
    OLD."id", OLD."userId", OLD."memoryJobId", OLD."executionBindingId",
    OLD."sourceMessageId", OLD."sourceMessageContentHash", OLD."inputHash",
    OLD."acceptedOutputHash", OLD."recoverableUntil", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Memory fact extraction execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."appliedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Applied Memory fact extraction execution is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."appliedAt" IS NULL AND (
    NEW."acceptedOutput", NEW."contextBindings"
  ) IS DISTINCT FROM (
    OLD."acceptedOutput", OLD."contextBindings"
  ) THEN
    RAISE EXCEPTION 'Pending Memory fact extraction output is immutable'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM "MemoryJob" AS job
  INNER JOIN "MemoryExecutionBinding" AS binding
    ON binding."userId" = job."userId"
   AND binding."memoryJobId" = job."id"
  WHERE job."userId" = NEW."userId"
    AND job."id" = NEW."memoryJobId"
    AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
    AND job."pipelineVersion" = 'memory-fact-extraction-vnext-v3'
    AND job."sourceMessageId" = NEW."sourceMessageId"
    AND binding."id" = NEW."executionBindingId"
    AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
    AND binding."logicalRole" = 'MEMORY_FACT_EXTRACT'
    AND binding."pipelineVersion" = 'memory-fact-extraction-vnext-v3'
    AND binding."inputHash" = NEW."inputHash"
    AND (
      (
        binding."state" = 'RUNNING'::"MemoryExecutionState"
        AND binding."acceptedOutputHash" IS NULL
      )
      OR (
        binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
        AND binding."acceptedOutputHash" = NEW."acceptedOutputHash"
      )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory fact extraction execution receipt is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactExtractionExecution_guard"
BEFORE INSERT OR UPDATE ON "MemoryFactExtractionExecution"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_fact_extraction_execution_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_fact_extraction_candidate_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id", NEW."userId", NEW."extractionExecutionId",
    NEW."candidateOrdinal", NEW."candidateFingerprint", NEW."createdAt"
  ) IS DISTINCT FROM (
    OLD."id", OLD."userId", OLD."extractionExecutionId",
    OLD."candidateOrdinal", OLD."candidateFingerprint", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Memory fact extraction candidate identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND
    OLD."outcome" <> 'PENDING'::"MemoryFactExtractionCandidateOutcome" THEN
    RAISE EXCEPTION 'Terminal Memory fact extraction candidate is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactExtractionCandidateReceipt_guard"
BEFORE UPDATE ON "MemoryFactExtractionCandidateReceipt"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_fact_extraction_candidate_guard();

-- A v3 extraction binding cannot expose SUCCEEDED without the staged packet
-- needed for provider-free recovery. The trigger is transition-only so older
-- archaeology remains readable.
CREATE OR REPLACE FUNCTION aiqsa_memory_fact_extraction_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."logicalRole" = 'MEMORY_FACT_EXTRACT'
    AND NEW."pipelineVersion" = 'memory-fact-extraction-vnext-v3'
    AND NEW."state" = 'SUCCEEDED'::"MemoryExecutionState"
    AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM NEW."state") THEN
    PERFORM 1
    FROM "MemoryFactExtractionExecution" AS execution
    WHERE execution."userId" = NEW."userId"
      AND execution."executionBindingId" = NEW."id"
      AND execution."memoryJobId" = NEW."memoryJobId"
      AND execution."inputHash" = NEW."inputHash"
      AND execution."acceptedOutputHash" = NEW."acceptedOutputHash"
      AND execution."appliedAt" IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Succeeded Memory fact extraction binding lacks staging'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryExecutionBinding_fact_extraction_guard"
BEFORE INSERT OR UPDATE ON "MemoryExecutionBinding"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_fact_extraction_binding_guard();

-- Keep the canonical source-message guard current with the v3 producer. A
-- versioned execution row cannot compensate for admitting an ungrounded job.
CREATE OR REPLACE FUNCTION aiqsa_memory_job_source_message_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."sourceMessageId" IS NOT NULL
     AND NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId" THEN
    RAISE EXCEPTION 'MemoryJob.sourceMessageId is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."targetFactVersionId" IS NOT NULL
     AND NEW."targetFactVersionId" IS DISTINCT FROM OLD."targetFactVersionId" THEN
    RAISE EXCEPTION 'MemoryJob.targetFactVersionId is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
     AND NEW."pipelineVersion" IN (
       'memory-fact-extraction-vnext-v1',
       'memory-fact-extraction-vnext-v2',
       'memory-fact-extraction-vnext-v3'
     ) THEN
    IF NEW."sourceMessageId" IS NULL
       OR btrim(NEW."sourceMessageId") = ''
       OR char_length(NEW."sourceMessageId") > 256 THEN
      RAISE EXCEPTION 'MemoryJob.sourceMessageId is required for vNext EXTRACT_FACTS'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."kind" IN (
       'EXTRACT_FACTS'::"MemoryJobKind",
       'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
     )
     AND NEW."sourceMessageId" IS NOT NULL THEN
    PERFORM 1
    FROM "Message" AS message
    INNER JOIN "Chat" AS chat ON chat."id" = message."chatId"
    WHERE message."id" = NEW."sourceMessageId"
      AND message."chatId" = NEW."chatId"
      AND message."role" = 'user'
      AND message."status" = 'complete'::"MessageStatus"
      AND chat."userId" = NEW."userId"
      AND chat."projectId" IS NULL
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."permanentDeletionAt" IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MemoryJob.sourceMessageId must reference an exact settled direct USER message'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
