-- Keep exact direct-user source admission active after the vNext extractor
-- contract advances to v2. The historical v1 contract remains guarded for
-- recovery of already queued work.

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

  IF NEW."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
     AND NEW."pipelineVersion" IN (
       'memory-fact-extraction-vnext-v1',
       'memory-fact-extraction-vnext-v2'
     ) THEN
    IF NEW."sourceMessageId" IS NULL
       OR btrim(NEW."sourceMessageId") = ''
       OR char_length(NEW."sourceMessageId") > 256 THEN
      RAISE EXCEPTION 'MemoryJob.sourceMessageId is required for vNext EXTRACT_FACTS'
        USING ERRCODE = '23514';
    END IF;

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
