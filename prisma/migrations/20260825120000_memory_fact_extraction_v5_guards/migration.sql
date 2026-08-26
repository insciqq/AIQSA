-- Keep the database-owned extraction/recovery fences aligned with the v5
-- pipeline introduced by the corrective extraction decoder and prompt.

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
    AND job."pipelineVersion" IN (
      'memory-fact-extraction-vnext-v3',
      'memory-fact-extraction-vnext-v4',
      'memory-fact-extraction-vnext-v5'
    )
    AND job."sourceMessageId" = NEW."sourceMessageId"
    AND binding."id" = NEW."executionBindingId"
    AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
    AND binding."logicalRole" = 'MEMORY_FACT_EXTRACT'
    AND binding."pipelineVersion" = job."pipelineVersion"
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

CREATE OR REPLACE FUNCTION aiqsa_memory_auxiliary_semantic_call_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Completed Memory auxiliary semantic call is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."id", NEW."userId", NEW."sourceMessageId", NEW."ownerJobId",
    NEW."purpose", NEW."createdAt"
  ) IS DISTINCT FROM (
    OLD."id", OLD."userId", OLD."sourceMessageId", OLD."ownerJobId",
    OLD."purpose", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Memory auxiliary semantic call identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."purpose" = 'FACT_EXTRACTION_ADJUDICATION' THEN
    PERFORM 1
    FROM "MemoryJob" AS job
    WHERE job."userId" = NEW."userId"
      AND job."id" = NEW."ownerJobId"
      AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
      AND job."pipelineVersion" IN (
        'memory-fact-extraction-vnext-v4',
        'memory-fact-extraction-vnext-v5'
      )
      AND job."sourceMessageId" = NEW."sourceMessageId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Memory semantic adjudication owner is invalid'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."completedAt" IS NOT NULL THEN
      PERFORM 1
      FROM "MemoryExecutionBinding" AS binding
      WHERE binding."userId" = NEW."userId"
        AND binding."id" = NEW."executionId"
        AND binding."memoryJobId" = NEW."ownerJobId"
        AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
        AND binding."logicalRole" = 'MEMORY_FACT_EXTRACT'
        AND binding."pipelineVersion" = 'memory-semantic-adjudication-v1'
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
        RAISE EXCEPTION 'Memory semantic adjudication receipt is invalid'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_fact_extraction_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."logicalRole" = 'MEMORY_FACT_EXTRACT'
    AND NEW."pipelineVersion" IN (
      'memory-fact-extraction-vnext-v3',
      'memory-fact-extraction-vnext-v4',
      'memory-fact-extraction-vnext-v5'
    )
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
      RAISE EXCEPTION 'Succeeded Memory extraction binding lacks staged result'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."logicalRole" = 'MEMORY_FACT_EXTRACT'
    AND NEW."pipelineVersion" = 'memory-semantic-adjudication-v1'
    AND NEW."state" = 'SUCCEEDED'::"MemoryExecutionState"
    AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM NEW."state") THEN
    PERFORM 1
    FROM "MemoryAuxiliarySemanticCall" AS auxiliary
    WHERE auxiliary."userId" = NEW."userId"
      AND auxiliary."ownerJobId" = NEW."memoryJobId"
      AND auxiliary."purpose" = 'FACT_EXTRACTION_ADJUDICATION'
      AND auxiliary."executionId" = NEW."id"
      AND auxiliary."inputHash" = NEW."inputHash"
      AND auxiliary."acceptedOutputHash" = NEW."acceptedOutputHash"
      AND auxiliary."completedAt" IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Succeeded semantic adjudication lacks durable result'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

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
       'memory-fact-extraction-vnext-v3',
       'memory-fact-extraction-vnext-v4',
       'memory-fact-extraction-vnext-v5'
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
