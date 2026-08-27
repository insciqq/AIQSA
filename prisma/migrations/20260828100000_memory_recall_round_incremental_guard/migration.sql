-- Recall rounds follow the same checkpoint-first incremental authority as
-- their parent chunks. A normal append makes the checkpoint PENDING while
-- exact stable-prefix maps remain reusable but non-retrievable. Keep those
-- rows valid through that bounded transition; READY/current-pipeline checks
-- remain mandatory in every retrieval and rebuild consumer.

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_recall_round_source(
  p_user_id text,
  p_chat_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  chat_row "Chat"%ROWTYPE;
  checkpoint_row "ChatMemoryCheckpoint"%ROWTYPE;
BEGIN
  SELECT * INTO chat_row
  FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO checkpoint_row
  FROM "ChatMemoryCheckpoint"
  WHERE "userId" = p_user_id AND "chatId" = p_chat_id;

  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallRound" AS round
    WHERE round."userId" = p_user_id
      AND round."chatId" = p_chat_id
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR round."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR checkpoint_row."chatId" IS NULL
        OR checkpoint_row."branchGeneration" <>
          chat_row."memoryBranchGeneration"
        OR NOT EXISTS (
          SELECT 1
          FROM "MemoryRecallChunk" AS parent
          WHERE parent."userId" = round."userId"
            AND parent."chatId" = round."chatId"
            AND parent."id" = round."parentChunkId"
            AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "MemoryRecallRoundMessage" AS source_map
          WHERE source_map."userId" = round."userId"
            AND source_map."chatId" = round."chatId"
            AND source_map."roundId" = round."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryRecallRoundMessage" AS source_map
          LEFT JOIN "Message" AS source_message
            ON source_message."chatId" = source_map."chatId"
            AND source_message."id" = source_map."messageId"
          LEFT JOIN "ChatMemoryCheckpointMessage" AS checkpoint_message
            ON checkpoint_message."userId" = source_map."userId"
            AND checkpoint_message."chatId" = source_map."chatId"
            AND checkpoint_message."messageId" = source_map."messageId"
          WHERE source_map."userId" = round."userId"
            AND source_map."chatId" = round."chatId"
            AND source_map."roundId" = round."id"
            AND (
              source_message."id" IS NULL
              OR source_message."updatedAt" <>
                source_map."sourceMessageUpdatedAt"
              OR checkpoint_message."messageId" IS NULL
              OR checkpoint_message."sourceMessageUpdatedAt" <>
                source_map."sourceMessageUpdatedAt"
              OR NOT EXISTS (
                WITH RECURSIVE active_path AS (
                  SELECT message."id", message."parentMessageId"
                  FROM "Message" AS message
                  WHERE message."chatId" = chat_row."id"
                    AND message."id" = chat_row."activeLeafMessageId"
                  UNION ALL
                  SELECT parent."id", parent."parentMessageId"
                  FROM active_path AS child
                  INNER JOIN "Message" AS parent
                    ON parent."chatId" = chat_row."id"
                    AND parent."id" = child."parentMessageId"
                )
                SELECT 1
                FROM active_path
                WHERE active_path."id" = source_map."messageId"
              )
            )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory recall round must match the retained chat source maps';
  END IF;
END;
$function$;
