-- History v3 stores exact immutable message identities on every source map.
-- Existing chunks are rebuildable derived state and cannot prove this stronger
-- identity, so fence them from admission and let the ordinary backfill replace
-- them without touching source chats.
DELETE FROM "MemorySearchEntry"
WHERE "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType";

UPDATE "MemoryRecallChunk"
SET "state" = 'INVALIDATED'::"MemoryHistoryItemState",
    "invalidatedAt" = COALESCE("invalidatedAt", CURRENT_TIMESTAMP)
WHERE "state" <> 'INVALIDATED'::"MemoryHistoryItemState";

UPDATE "ChatMemoryCheckpoint"
SET "pipelineVersion" = 'memory-history-incremental-v1',
    "status" = 'STALE'::"MemoryHistoryCheckpointStatus",
    "lastSucceededAt" = NULL,
    "lastErrorCode" = 'memory_history_pipeline_upgrade',
    "updatedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion" SET DEFAULT 'memory-history-incremental-v1';

ALTER TABLE "MemoryRecallChunkMessage"
  ADD COLUMN "safeTextHash" VARCHAR(128),
  ADD COLUMN "sourceMessageContentHash" VARCHAR(128),
  ADD COLUMN "sourceMessageUpdatedAt" TIMESTAMP(3);

UPDATE "MemoryRecallChunkMessage" AS source_map
SET "safeTextHash" = repeat('0', 64),
    "sourceMessageContentHash" = repeat('0', 64),
    "sourceMessageUpdatedAt" = source_message."updatedAt"
FROM "Message" AS source_message
WHERE source_message."chatId" = source_map."chatId"
  AND source_message."id" = source_map."messageId";

ALTER TABLE "MemoryRecallChunkMessage"
  ALTER COLUMN "safeTextHash" SET NOT NULL,
  ALTER COLUMN "sourceMessageContentHash" SET NOT NULL,
  ALTER COLUMN "sourceMessageUpdatedAt" SET NOT NULL;

ALTER TABLE "MemoryRecallChunkMessage"
  ADD CONSTRAINT "MemoryRecallChunkMessage_v3_identity_check" CHECK (
    char_length("safeTextHash") = 64
    AND "safeTextHash" ~ '^[a-f0-9]{64}$'
    AND char_length("sourceMessageContentHash") = 64
    AND "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE "MemoryRecallChunk"
  DROP CONSTRAINT "MemoryRecallChunk_shape_check";

ALTER TABLE "MemoryRecallChunk"
  ADD CONSTRAINT "MemoryRecallChunk_shape_check" CHECK (
    "branchGeneration" >= 0
    AND "sourceRevisionAtCreation" >= 0
    AND "chunkOrdinal" >= 0
    AND char_length("contentHash") BETWEEN 16 AND 128
    AND char_length("safeProjectedText") BETWEEN 1 AND 4000
    AND char_length("normalizedSafeSearchText") BETWEEN 1 AND 4000
    AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
    AND "occurredTo" >= "occurredFrom"
    AND "chunkingVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND "sourceProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND cardinality("redactionReasonCodes") <= 16
    AND char_length(array_to_string("redactionReasonCodes", ',')) <= 1024
    AND array_to_string("redactionReasonCodes", ',') ~ '^[A-Za-z0-9._,-]*$'
    AND (
      ("redactionState" = 'NOT_NEEDED'::"MemoryRedactionState"
        AND cardinality("redactionReasonCodes") = 0)
      OR ("redactionState" = 'REDACTED'::"MemoryRedactionState"
        AND cardinality("redactionReasonCodes") > 0)
      OR "redactionState" = 'EXCLUDED'::"MemoryRedactionState"
    )
    AND (
      (
        "state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NULL
        AND "safetyClass" IN (
          'NORMAL'::"MemoryDerivedSafetyClass",
          'SENSITIVE'::"MemoryDerivedSafetyClass"
        )
        AND "redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      )
      OR (
        "state" = 'SUPPRESSED'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NULL
        AND "safetyClass" = 'SECRET_TAINTED'::"MemoryDerivedSafetyClass"
        AND "redactionState" = 'EXCLUDED'::"MemoryRedactionState"
      )
      OR (
        "state" = 'INVALIDATED'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NOT NULL
      )
    )
  );

CREATE TABLE "ChatMemoryCheckpointMessage" (
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "sourceMessageCreatedAt" TIMESTAMP(3) NOT NULL,
  "sourceMessageUpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatMemoryCheckpointMessage_pkey"
    PRIMARY KEY ("userId", "chatId", "messageId"),
  CONSTRAINT "ChatMemoryCheckpointMessage_shape_check" CHECK (
    "ordinal" >= 0
    AND "sourceMessageUpdatedAt" >= "sourceMessageCreatedAt"
  )
);

CREATE UNIQUE INDEX "ChatMemoryCheckpointMessage_user_chat_ordinal_key"
  ON "ChatMemoryCheckpointMessage"("userId", "chatId", "ordinal");
CREATE INDEX "ChatMemoryCheckpointMessage_chat_message_idx"
  ON "ChatMemoryCheckpointMessage"("chatId", "messageId");

ALTER TABLE "ChatMemoryCheckpointMessage"
  ADD CONSTRAINT "ChatMemoryCheckpointMessage_checkpoint_fkey"
  FOREIGN KEY ("userId", "chatId")
  REFERENCES "ChatMemoryCheckpoint"("userId", "chatId")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryCheckpointMessage"
  ADD CONSTRAINT "ChatMemoryCheckpointMessage_message_fkey"
  FOREIGN KEY ("chatId", "messageId")
  REFERENCES "Message"("chatId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE "ChatMemoryDigest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "anchorChunkId" TEXT NOT NULL,
  "sourceFolderId" TEXT,
  "sourceAssistantId" TEXT,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "activeLeafMessageId" TEXT NOT NULL,
  "sourceContentHash" VARCHAR(128) NOT NULL,
  "contentHash" VARCHAR(128) NOT NULL,
  "summary" VARCHAR(2000) NOT NULL,
  "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "decisions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "openLoops" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "safeDigestText" TEXT NOT NULL,
  "normalizedSafeSearchText" TEXT NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "occurredFrom" TIMESTAMP(3) NOT NULL,
  "occurredTo" TIMESTAMP(3) NOT NULL,
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "pipelineVersion" VARCHAR(64) NOT NULL,
  "sourceProjectionVersion" VARCHAR(64) NOT NULL,
  "safetyPolicyVersion" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),
  CONSTRAINT "ChatMemoryDigest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatMemoryDigest_shape_check" CHECK (
    "branchGeneration" >= 0
    AND "sourceRevisionAtCreation" >= 0
    AND char_length("sourceContentHash") = 64
    AND "sourceContentHash" ~ '^[a-f0-9]{64}$'
    AND char_length("contentHash") = 64
    AND "contentHash" ~ '^[a-f0-9]{64}$'
    AND char_length("summary") BETWEEN 1 AND 2000
    AND cardinality("topics") <= 12
    AND cardinality("decisions") <= 12
    AND cardinality("openLoops") <= 12
    AND char_length(array_to_string("topics", '')) <= 3072
    AND char_length(array_to_string("decisions", '')) <= 3072
    AND char_length(array_to_string("openLoops", '')) <= 3072
    AND char_length("safeDigestText") BETWEEN 1 AND 4000
    AND char_length("normalizedSafeSearchText") BETWEEN 1 AND 4000
    AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
    AND "occurredTo" >= "occurredFrom"
    AND "pipelineVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND "sourceProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND char_length("safetyPolicyVersion") BETWEEN 1 AND 256
    AND "safetyPolicyVersion" ~ '^[A-Za-z0-9._:-]+$'
    AND "safetyClass" IN (
      'NORMAL'::"MemoryDerivedSafetyClass",
      'SENSITIVE'::"MemoryDerivedSafetyClass"
    )
    AND "redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
    AND (
      ("state" = 'ACTIVE'::"MemoryHistoryItemState" AND "invalidatedAt" IS NULL)
      OR
      ("state" = 'INVALIDATED'::"MemoryHistoryItemState" AND "invalidatedAt" IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX "ChatMemoryDigest_userId_id_key"
  ON "ChatMemoryDigest"("userId", "id");
CREATE UNIQUE INDEX "ChatMemoryDigest_userId_chatId_id_key"
  ON "ChatMemoryDigest"("userId", "chatId", "id");
CREATE UNIQUE INDEX "ChatMemoryDigest_one_active_idx"
  ON "ChatMemoryDigest"("userId", "chatId")
  WHERE "state" = 'ACTIVE'::"MemoryHistoryItemState";
CREATE INDEX "ChatMemoryDigest_user_chat_state_updated_idx"
  ON "ChatMemoryDigest"("userId", "chatId", "state", "updatedAt");
CREATE INDEX "ChatMemoryDigest_user_occurred_idx"
  ON "ChatMemoryDigest"("userId", "occurredTo", "id");
CREATE INDEX "ChatMemoryDigest_user_folder_state_idx"
  ON "ChatMemoryDigest"("userId", "sourceFolderId", "state");
CREATE INDEX "ChatMemoryDigest_user_assistant_state_idx"
  ON "ChatMemoryDigest"("userId", "sourceAssistantId", "state");

ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_user_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_chat_fkey" FOREIGN KEY ("userId", "chatId")
  REFERENCES "Chat"("userId", "id") ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_anchor_fkey"
  FOREIGN KEY ("userId", "chatId", "anchorChunkId")
  REFERENCES "MemoryRecallChunk"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_leaf_fkey"
  FOREIGN KEY ("chatId", "activeLeafMessageId")
  REFERENCES "Message"("chatId", "id") ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_folder_fkey"
  FOREIGN KEY ("userId", "sourceFolderId")
  REFERENCES "Folder"("userId", "id") ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE "ChatMemoryDigest"
  ADD CONSTRAINT "ChatMemoryDigest_assistant_fkey"
  FOREIGN KEY ("userId", "sourceAssistantId")
  REFERENCES "AssistantDefinition"("ownerUserId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE "ChatMemoryDigestChunk" (
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "digestId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "ChatMemoryDigestChunk_pkey" PRIMARY KEY ("digestId", "chunkId"),
  CONSTRAINT "ChatMemoryDigestChunk_shape_check" CHECK ("ordinal" >= 0)
);
CREATE UNIQUE INDEX "ChatMemoryDigestChunk_digest_ordinal_key"
  ON "ChatMemoryDigestChunk"("digestId", "ordinal");
CREATE INDEX "ChatMemoryDigestChunk_user_chat_chunk_idx"
  ON "ChatMemoryDigestChunk"("userId", "chatId", "chunkId");
ALTER TABLE "ChatMemoryDigestChunk"
  ADD CONSTRAINT "ChatMemoryDigestChunk_digest_fkey"
  FOREIGN KEY ("userId", "chatId", "digestId")
  REFERENCES "ChatMemoryDigest"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigestChunk"
  ADD CONSTRAINT "ChatMemoryDigestChunk_chunk_fkey"
  FOREIGN KEY ("userId", "chatId", "chunkId")
  REFERENCES "MemoryRecallChunk"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

CREATE TABLE "ChatMemoryDigestMessage" (
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "digestId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "sourceMessageContentHash" VARCHAR(128) NOT NULL,
  "sourceMessageUpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatMemoryDigestMessage_pkey" PRIMARY KEY ("digestId", "messageId"),
  CONSTRAINT "ChatMemoryDigestMessage_shape_check" CHECK (
    "ordinal" >= 0
    AND char_length("sourceMessageContentHash") = 64
    AND "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX "ChatMemoryDigestMessage_digest_ordinal_key"
  ON "ChatMemoryDigestMessage"("digestId", "ordinal");
CREATE INDEX "ChatMemoryDigestMessage_user_chat_message_idx"
  ON "ChatMemoryDigestMessage"("userId", "chatId", "messageId");
ALTER TABLE "ChatMemoryDigestMessage"
  ADD CONSTRAINT "ChatMemoryDigestMessage_digest_fkey"
  FOREIGN KEY ("userId", "chatId", "digestId")
  REFERENCES "ChatMemoryDigest"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "ChatMemoryDigestMessage"
  ADD CONSTRAINT "ChatMemoryDigestMessage_message_fkey"
  FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

-- Active stable chunks are authorized by exact current-path message maps, not
-- by the broad source revision at which the reusable chunk was first created.
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
  SELECT * INTO chat_row FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1 FROM "Message" AS paused_leaf
    INNER JOIN "MemoryPauseInterval" AS pause_interval
      ON pause_interval."userId" = chat_row."userId"
      AND pause_interval."scope" IN (
        'MASTER'::"MemoryPauseScope", 'SEARCH_HISTORY'::"MemoryPauseScope"
      )
      AND paused_leaf."createdAt" >= pause_interval."pausedAt"
      AND (pause_interval."resumedAt" IS NULL
        OR paused_leaf."createdAt" <= pause_interval."resumedAt")
    WHERE paused_leaf."chatId" = chat_row."id"
      AND paused_leaf."id" = chat_row."activeLeafMessageId"
  ) INTO current_leaf_in_pause;

  IF EXISTS (
    SELECT 1 FROM "MemoryRecallChunk" AS chunk
    WHERE chunk."userId" = p_user_id AND chunk."chatId" = p_chat_id
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR chunk."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR (chunk."chunkingVersion" <> 'memory-history-chunking-v3'
          AND (chunk."branchGeneration" <> chat_row."memoryBranchGeneration"
            OR chunk."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"))
        OR (chunk."chunkingVersion" = 'memory-history-chunking-v3' AND (
          NOT EXISTS (
            SELECT 1 FROM "MemoryRecallChunkMessage" AS required_source_map
            WHERE required_source_map."userId" = chunk."userId"
              AND required_source_map."chunkId" = chunk."id"
          )
          OR EXISTS (
            SELECT 1 FROM "MemoryRecallChunkMessage" AS source_map
            LEFT JOIN "Message" AS source_message
              ON source_message."chatId" = source_map."chatId"
              AND source_message."id" = source_map."messageId"
            WHERE source_map."userId" = chunk."userId"
              AND source_map."chunkId" = chunk."id"
              AND (
                source_message."id" IS NULL
                OR source_message."updatedAt" <>
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
                  SELECT 1 FROM active_path
                  WHERE active_path."id" = source_map."messageId"
                )
              )
          )
        ))
      )
  ) OR EXISTS (
    SELECT 1 FROM "ChatMemoryCheckpoint" AS checkpoint
    WHERE checkpoint."userId" = p_user_id AND checkpoint."chatId" = p_chat_id
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR checkpoint."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR ((checkpoint."sourceRevision" <> chat_row."memorySourceRevision"
          OR checkpoint."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId")
          AND NOT current_leaf_in_pause)
      )
  ) OR EXISTS (
    SELECT 1 FROM "ChatMemoryDigest" AS digest
    WHERE digest."userId" = p_user_id AND digest."chatId" = p_chat_id
      AND digest."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR digest."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR ((digest."branchGeneration" <> chat_row."memoryBranchGeneration"
          OR digest."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
          OR digest."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId")
          AND NOT current_leaf_in_pause)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory history must match the current eligible chat source';
  END IF;
END;
$function$;

CREATE TRIGGER "ChatMemoryDigest_permanent_chat_write_guard"
  BEFORE INSERT OR UPDATE OF "chatId" ON "ChatMemoryDigest"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();
CREATE CONSTRAINT TRIGGER "ChatMemoryDigest_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryDigest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_history_source_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallChunkMessage_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallChunkMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_history_source_trigger();

-- An ACTIVE digest is useful only while it remains a bounded, exact projection
-- of current classified-safe chunks. Keep this cross-row set invariant in the
-- database because deletion workers and raw-SQL maintenance also mutate these
-- aggregates.
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

  IF chunk_count NOT BETWEEN 1 AND 24
    OR message_count NOT BETWEEN 1 AND 512
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

CREATE OR REPLACE FUNCTION public.aiqsa_memory_digest_row_source_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM aiqsa_memory_assert_digest_sources(
    CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_digest_map_source_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM aiqsa_memory_assert_digest_sources(
    CASE WHEN TG_OP = 'DELETE' THEN OLD."digestId" ELSE NEW."digestId" END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER "ChatMemoryDigest_exact_sources_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryDigest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_row_source_trigger();
CREATE CONSTRAINT TRIGGER "ChatMemoryDigestChunk_exact_sources_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryDigestChunk"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_map_source_trigger();
CREATE CONSTRAINT TRIGGER "ChatMemoryDigestMessage_exact_sources_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryDigestMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_map_source_trigger();
