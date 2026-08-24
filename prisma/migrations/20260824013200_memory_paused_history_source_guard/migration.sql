-- A history checkpoint intentionally trails the active leaf while master or
-- Search history is paused. Keep the database invariant aligned with the
-- authoritative retrieval predicate: branch/folder identity remains exact,
-- while source revision and leaf may trail only for a leaf created inside a
-- recorded pause interval.

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_history_source(
  p_user_id text,
  p_chat_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  chat_row "Chat"%ROWTYPE;
  current_leaf_in_pause boolean := FALSE;
BEGIN
  SELECT * INTO chat_row
  FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "Message" AS paused_leaf
    INNER JOIN "MemoryPauseInterval" AS pause_interval
      ON pause_interval."userId" = chat_row."userId"
      AND pause_interval."scope" IN (
        'MASTER'::"MemoryPauseScope",
        'SEARCH_HISTORY'::"MemoryPauseScope"
      )
      AND paused_leaf."createdAt" >= pause_interval."pausedAt"
      AND (
        pause_interval."resumedAt" IS NULL
        OR paused_leaf."createdAt" <= pause_interval."resumedAt"
      )
    WHERE paused_leaf."chatId" = chat_row."id"
      AND paused_leaf."id" = chat_row."activeLeafMessageId"
  ) INTO current_leaf_in_pause;

  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallChunk" AS chunk
    WHERE chunk."userId" = p_user_id
      AND chunk."chatId" = p_chat_id
      AND chunk."state" = 'ACTIVE'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR chunk."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR chunk."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR (
          chunk."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
          AND NOT current_leaf_in_pause
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM "ChatMemoryCheckpoint" AS checkpoint
    WHERE checkpoint."userId" = p_user_id
      AND checkpoint."chatId" = p_chat_id
      AND checkpoint."status" = 'READY'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR checkpoint."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR (
          (
            checkpoint."sourceRevision" <> chat_row."memorySourceRevision"
            OR checkpoint."activeLeafMessageId" IS DISTINCT FROM
              chat_row."activeLeafMessageId"
          )
          AND NOT current_leaf_in_pause
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory history must match the current eligible chat source generation';
  END IF;
END;
$function$;
