-- Prior visible assistant messages may resolve bounded extraction context, but
-- they never become MemoryEvidence. Revalidate the same visible-run ownership
-- and active-path provenance used by the safe source projection.
CREATE OR REPLACE FUNCTION aiqsa_memory_message_dependency_valid(
  p_user_id TEXT,
  p_message_id TEXT,
  p_message_updated_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "Message" AS dependency_message
    INNER JOIN "Chat" AS dependency_chat
      ON dependency_chat."id" = dependency_message."chatId"
      AND dependency_chat."userId" = p_user_id
      AND dependency_chat."projectId" IS NULL
      AND dependency_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND dependency_chat."permanentDeletionAt" IS NULL
    WHERE dependency_message."id" = p_message_id
      AND dependency_message."role" IN ('user', 'assistant')
      AND dependency_message."status" = 'complete'::"MessageStatus"
      AND dependency_message."updatedAt" = p_message_updated_at
      AND (
        dependency_message."role" = 'user'
        OR (
          dependency_message."role" = 'assistant'
          AND 1 = (
            SELECT COUNT(*)
            FROM "ModelRun" AS any_context_run
            WHERE any_context_run."userId" = p_user_id
              AND any_context_run."chatId" = dependency_message."chatId"
              AND any_context_run."assistantMessageId" = dependency_message."id"
          )
          AND EXISTS (
            SELECT 1
            FROM "ModelRun" AS context_run
            LEFT JOIN "AssistantDefinition" AS owned_assistant
              ON owned_assistant."id" = context_run."assistantId"
              AND owned_assistant."ownerUserId" = p_user_id
              AND owned_assistant."archivedAt" IS NULL
            WHERE context_run."userId" = p_user_id
              AND context_run."chatId" = dependency_message."chatId"
              AND context_run."assistantMessageId" = dependency_message."id"
              AND context_run."userMessageId" = dependency_message."parentMessageId"
              AND context_run."status" = 'complete'::"ModelRunStatus"
              AND (
                context_run."assistantId" IS NULL
                OR owned_assistant."id" IS NOT NULL
              )
          )
        )
      )
      AND EXISTS (
        WITH RECURSIVE active_path AS (
          SELECT
            leaf."id",
            leaf."parentMessageId",
            ARRAY[leaf."id"]::TEXT[] AS visited,
            FALSE AS cycle
          FROM "Message" AS leaf
          WHERE leaf."chatId" = dependency_chat."id"
            AND leaf."id" = dependency_chat."activeLeafMessageId"

          UNION ALL

          SELECT
            parent."id",
            parent."parentMessageId",
            child.visited || parent."id",
            parent."id" = ANY(child.visited)
          FROM active_path AS child
          INNER JOIN "Message" AS parent
            ON parent."chatId" = dependency_chat."id"
            AND parent."id" = child."parentMessageId"
          WHERE NOT child.cycle
        )
        SELECT 1 FROM active_path
        WHERE active_path."id" = dependency_message."id"
          AND NOT active_path.cycle
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        WHERE suppression."userId" = p_user_id
          AND suppression."scope" IN (
            'ALL'::"MemorySuppressionScope",
            'SOURCE_MESSAGE'::"MemorySuppressionScope"
          )
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              suppression."sourceChatId" = dependency_message."chatId"
              AND suppression."sourceMessageId" = dependency_message."id"
            )
          )
          AND (
            suppression."expiresAt" IS NULL
            OR suppression."expiresAt" > CURRENT_TIMESTAMP
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = p_user_id
          AND barrier."kind" IN (
            'AUTOMATIC_FACTS'::"MemorySourceBarrierKind",
            'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND barrier."explicitOverrideAllowed" = FALSE
          AND dependency_message."createdAt" <= barrier."sourceCreatedAtCutoff"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryPauseInterval" AS pause_interval
        WHERE pause_interval."userId" = p_user_id
          AND pause_interval."scope" IN (
            'MASTER'::"MemoryPauseScope",
            'AUTOMATIC_LEARNING'::"MemoryPauseScope"
          )
          AND dependency_message."createdAt" >= pause_interval."pausedAt"
          AND (
            pause_interval."resumedAt" IS NULL
            OR dependency_message."createdAt" <= pause_interval."resumedAt"
          )
      )
  );
$function$;

-- Admit the exact v7 extraction pipeline everywhere the database already
-- enforces immutable execution, binding, auxiliary-call, and job-source
-- ownership for vNext extraction.
DO $migration$
DECLARE
  function_identity regprocedure;
  function_definition text;
BEGIN
  FOREACH function_identity IN ARRAY ARRAY[
    'aiqsa_memory_fact_extraction_execution_guard()'::regprocedure,
    'aiqsa_memory_auxiliary_semantic_call_guard()'::regprocedure,
    'aiqsa_memory_fact_extraction_binding_guard()'::regprocedure,
    'aiqsa_memory_job_source_message_guard()'::regprocedure
  ]
  LOOP
    function_definition := pg_get_functiondef(function_identity);
    IF position('memory-fact-extraction-vnext-v7' IN function_definition) = 0 THEN
      function_definition := replace(
        function_definition,
        '''memory-fact-extraction-vnext-v6''',
        '''memory-fact-extraction-vnext-v6'', ''memory-fact-extraction-vnext-v7'''
      );
      IF position('memory-fact-extraction-vnext-v7' IN function_definition) = 0 THEN
        RAISE EXCEPTION 'Memory extraction guard v7 extension failed for %',
          function_identity;
      END IF;
      EXECUTE function_definition;
    END IF;
  END LOOP;
END;
$migration$;
