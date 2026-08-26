ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v2';

ALTER TABLE "ChatMemoryDigest"
  ADD COLUMN "sourceFingerprint" VARCHAR(64),
  ADD COLUMN "inputFingerprint" VARCHAR(64),
  ADD COLUMN "rebuildPolicyVersion" VARCHAR(64),
  ADD COLUMN "updateMode" VARCHAR(32),
  ADD COLUMN "incrementalDepth" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_incremental_depth_check"
  CHECK ("incrementalDepth" BETWEEN 0 AND 31),
  ADD CONSTRAINT "ChatMemoryDigest_v2_metadata_check"
  CHECK (
    "pipelineVersion" <> 'memory-chat-digest-v2'
    OR (
      "sourceFingerprint" IS NOT NULL
      AND "sourceFingerprint" ~ '^[a-f0-9]{64}$'
      AND "inputFingerprint" IS NOT NULL
      AND "inputFingerprint" ~ '^[a-f0-9]{64}$'
      AND "rebuildPolicyVersion" IS NOT NULL
      AND "rebuildPolicyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "updateMode" IS NOT NULL
      AND "updateMode" IN ('FULL_REBUILD', 'INCREMENTAL', 'REBOUND', 'UNCHANGED')
    )
  );

-- Digest provider inputs remain bounded, while exact authority maps cover the
-- complete bounded history index (at most 512 chunks / 8,192 messages).
CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_digest_sources(
  p_digest_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  digest_row "ChatMemoryDigest"%ROWTYPE;
  chunk_count integer;
  message_count integer;
BEGIN
  SELECT * INTO digest_row
  FROM "ChatMemoryDigest"
  WHERE "id" = p_digest_id;
  IF NOT FOUND OR digest_row."state" <> 'ACTIVE'::"MemoryHistoryItemState" THEN
    RETURN;
  END IF;

  SELECT count(*) INTO chunk_count
  FROM "ChatMemoryDigestChunk"
  WHERE "digestId" = digest_row."id";
  SELECT count(*) INTO message_count
  FROM "ChatMemoryDigestMessage"
  WHERE "digestId" = digest_row."id";

  IF chunk_count NOT BETWEEN 1 AND 512
    OR message_count NOT BETWEEN 1 AND 8192
    OR NOT EXISTS (
      SELECT 1 FROM "ChatMemoryDigestChunk" AS anchor_source
      WHERE anchor_source."digestId" = digest_row."id"
        AND anchor_source."chunkId" = digest_row."anchorChunkId"
        AND anchor_source."ordinal" = chunk_count - 1
    )
    OR EXISTS (
      SELECT 1 FROM "ChatMemoryDigestChunk" AS source_chunk
      WHERE source_chunk."digestId" = digest_row."id"
      GROUP BY source_chunk."digestId"
      HAVING min(source_chunk."ordinal") <> 0
        OR max(source_chunk."ordinal") <> count(*) - 1
    )
    OR EXISTS (
      SELECT 1 FROM "ChatMemoryDigestMessage" AS source_message
      WHERE source_message."digestId" = digest_row."id"
      GROUP BY source_message."digestId"
      HAVING min(source_message."ordinal") <> 0
        OR max(source_message."ordinal") <> count(*) - 1
    )
    OR EXISTS (
      SELECT 1
      FROM "ChatMemoryDigestChunk" AS digest_source
      LEFT JOIN "MemoryRecallChunk" AS source_chunk
        ON source_chunk."userId" = digest_source."userId"
        AND source_chunk."chatId" = digest_source."chatId"
        AND source_chunk."id" = digest_source."chunkId"
      WHERE digest_source."digestId" = digest_row."id"
        AND (
          source_chunk."id" IS NULL
          OR source_chunk."state" <> 'ACTIVE'::"MemoryHistoryItemState"
          OR source_chunk."chunkingVersion" <> 'memory-history-chunking-v3'
          OR source_chunk."sourceProjectionVersion" <>
            'memory-history-source-projection-v2'
          OR source_chunk."safetyClass" NOT IN (
            'NORMAL'::"MemoryDerivedSafetyClass",
            'SENSITIVE'::"MemoryDerivedSafetyClass"
          )
          OR source_chunk."redactionState" = 'EXCLUDED'::"MemoryRedactionState"
          OR NOT EXISTS (
            SELECT 1 FROM "MemoryRecallChunkMessage" AS source_chunk_message
            WHERE source_chunk_message."chunkId" = source_chunk."id"
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "ChatMemoryDigestMessage" AS digest_source_message
      LEFT JOIN "Message" AS source_message
        ON source_message."chatId" = digest_source_message."chatId"
        AND source_message."id" = digest_source_message."messageId"
      WHERE digest_source_message."digestId" = digest_row."id"
        AND (
          source_message."id" IS NULL
          OR source_message."updatedAt" <>
            digest_source_message."sourceMessageUpdatedAt"
          OR NOT EXISTS (
            WITH RECURSIVE active_path AS (
              SELECT message."id", message."parentMessageId"
              FROM "Message" AS message
              WHERE message."chatId" = digest_row."chatId"
                AND message."id" = digest_row."activeLeafMessageId"
              UNION ALL
              SELECT parent."id", parent."parentMessageId"
              FROM active_path AS child
              INNER JOIN "Message" AS parent
                ON parent."chatId" = digest_row."chatId"
                AND parent."id" = child."parentMessageId"
            )
            SELECT 1 FROM active_path
            WHERE active_path."id" = digest_source_message."messageId"
          )
          OR NOT EXISTS (
            SELECT 1
            FROM "ChatMemoryDigestChunk" AS digest_source_chunk
            INNER JOIN "MemoryRecallChunkMessage" AS source_chunk_message
              ON source_chunk_message."chunkId" = digest_source_chunk."chunkId"
              AND source_chunk_message."messageId" =
                digest_source_message."messageId"
            WHERE digest_source_chunk."digestId" = digest_row."id"
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "ChatMemoryDigestChunk" AS digest_source_chunk
      INNER JOIN "MemoryRecallChunkMessage" AS source_chunk_message
        ON source_chunk_message."chunkId" = digest_source_chunk."chunkId"
      WHERE digest_source_chunk."digestId" = digest_row."id"
        AND NOT EXISTS (
          SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_source_message
          WHERE digest_source_message."digestId" = digest_row."id"
            AND digest_source_message."messageId" = source_chunk_message."messageId"
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Chat Memory digest requires bounded exact current sources';
  END IF;
END;
$function$;
