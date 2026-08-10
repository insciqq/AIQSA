-- Add the authoritative Phase 4 history aggregates and extend the unified
-- Memory search/staging targets without making history recall feature-live.
BEGIN;

-- Recreate the shared target enum transactionally so all dependent checks can
-- use the new values in this migration without a commit gap.
ALTER TABLE "MemorySearchEntry"
  DROP CONSTRAINT "MemorySearchEntry_shape_check";
ALTER TABLE "MemoryRetrievalAttemptItem"
  DROP CONSTRAINT "MemoryRetrievalAttemptItem_shape_check";
ALTER TABLE "ModelRunMemoryItem"
  DROP CONSTRAINT "ModelRunMemoryItem_shape_check";
DROP INDEX "MemorySearchEntry_userId_indexGenerationId_itemType_factVer_key";

ALTER TYPE "MemorySearchItemType" RENAME TO "MemorySearchItemType_pre_history";
CREATE TYPE "MemorySearchItemType" AS ENUM ('FACT_VERSION', 'EPISODE', 'RECALL_CHUNK');
ALTER TABLE "MemorySearchEntry"
  ALTER COLUMN "itemType" TYPE "MemorySearchItemType"
  USING ("itemType"::text::"MemorySearchItemType");
ALTER TABLE "MemoryRetrievalAttemptItem"
  ALTER COLUMN "itemType" TYPE "MemorySearchItemType"
  USING ("itemType"::text::"MemorySearchItemType");
ALTER TABLE "ModelRunMemoryItem"
  ALTER COLUMN "itemType" TYPE "MemorySearchItemType"
  USING ("itemType"::text::"MemorySearchItemType");
DROP TYPE "MemorySearchItemType_pre_history";

CREATE TYPE "MemoryHistoryCheckpointStatus" AS ENUM (
  'PENDING', 'INDEXING', 'READY', 'STALE', 'FAILED'
);
CREATE TYPE "MemoryHistoryItemState" AS ENUM ('ACTIVE', 'INVALIDATED', 'SUPPRESSED');
CREATE TYPE "MemoryDerivedSafetyClass" AS ENUM (
  'NORMAL', 'SENSITIVE', 'HIGHLY_SENSITIVE', 'SECRET_TAINTED'
);
CREATE TYPE "MemoryRedactionState" AS ENUM ('NOT_NEEDED', 'REDACTED', 'EXCLUDED');

CREATE TABLE "ChatMemoryCheckpoint" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "activeLeafMessageId" TEXT NOT NULL,
  "sourceContentHash" VARCHAR(128) NOT NULL,
  "lastIndexedMessageId" TEXT,
  "lastDreamedMessageId" TEXT,
  "status" "MemoryHistoryCheckpointStatus" NOT NULL DEFAULT 'PENDING',
  "lastSucceededAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatMemoryCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryRecallChunk" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "sourceFolderId" TEXT,
  "sourceAssistantId" TEXT,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "chunkOrdinal" INTEGER NOT NULL,
  "contentHash" VARCHAR(128) NOT NULL,
  "safeProjectedText" TEXT NOT NULL,
  "normalizedSafeSearchText" TEXT NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "occurredFrom" TIMESTAMP(3) NOT NULL,
  "occurredTo" TIMESTAMP(3) NOT NULL,
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "chunkingVersion" VARCHAR(64) NOT NULL,
  "sourceProjectionVersion" VARCHAR(64) NOT NULL,
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "redactionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryRecallChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryRecallChunkMessage" (
  "userId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "startOffset" INTEGER,
  "endOffset" INTEGER,

  CONSTRAINT "MemoryRecallChunkMessage_pkey" PRIMARY KEY ("chunkId", "messageId")
);

CREATE TABLE "MemoryEpisode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "sourceFolderId" TEXT,
  "sourceAssistantId" TEXT,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "safeSummary" TEXT NOT NULL,
  "normalizedSafeSearchText" TEXT NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "keywords" JSONB NOT NULL DEFAULT '[]',
  "entities" JSONB NOT NULL DEFAULT '[]',
  "occurredFrom" TIMESTAMP(3),
  "occurredTo" TIMESTAMP(3),
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "extractorRole" VARCHAR(64) NOT NULL,
  "createdByExecutionId" TEXT NOT NULL,
  "pipelineVersion" VARCHAR(64) NOT NULL,
  "sourceHash" VARCHAR(128) NOT NULL,
  "sourceProjectionVersion" VARCHAR(64) NOT NULL,
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "redactionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryEpisode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryEpisodeMessage" (
  "userId" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,

  CONSTRAINT "MemoryEpisodeMessage_pkey" PRIMARY KEY ("episodeId", "messageId")
);

ALTER TABLE "MemorySearchEntry"
  ALTER COLUMN "factVersionId" DROP NOT NULL,
  ADD COLUMN "episodeId" TEXT,
  ADD COLUMN "recallChunkId" TEXT;

ALTER TABLE "MemoryRetrievalAttemptItem"
  ALTER COLUMN "factVersionId" DROP NOT NULL,
  ADD COLUMN "episodeId" TEXT,
  ADD COLUMN "recallChunkId" TEXT,
  ADD COLUMN "sourceChatIdSnapshot" TEXT,
  ADD COLUMN "sourceBranchGenerationSnapshot" INTEGER,
  ADD COLUMN "sourceRevisionSnapshot" INTEGER,
  ADD COLUMN "sourceContentHashSnapshot" VARCHAR(128);

ALTER TABLE "ModelRunMemoryItem"
  ADD COLUMN "exactItemId" TEXT,
  ADD COLUMN "episodeId" TEXT,
  ADD COLUMN "recallChunkId" TEXT,
  ADD COLUMN "sourceBranchGenerationSnapshot" INTEGER,
  ADD COLUMN "sourceRevisionSnapshot" INTEGER,
  ADD COLUMN "sourceContentHashSnapshot" VARCHAR(128);

-- Older accepted fact receipts may already have detached their live version
-- relation. Preserve that honest absence with a stable non-authoritative marker
-- instead of inventing the forgotten target identity.
UPDATE "ModelRunMemoryItem"
SET "exactItemId" = COALESCE("factVersionId", 'legacy-detached:' || "id");
ALTER TABLE "ModelRunMemoryItem" ALTER COLUMN "exactItemId" SET NOT NULL;

CREATE UNIQUE INDEX "ChatMemoryCheckpoint_userId_id_key"
  ON "ChatMemoryCheckpoint"("userId", "id");
CREATE UNIQUE INDEX "ChatMemoryCheckpoint_userId_chatId_key"
  ON "ChatMemoryCheckpoint"("userId", "chatId");
CREATE INDEX "ChatMemoryCheckpoint_userId_status_updatedAt_idx"
  ON "ChatMemoryCheckpoint"("userId", "status", "updatedAt");
CREATE INDEX "ChatMemoryCheckpoint_chatId_activeLeafMessageId_idx"
  ON "ChatMemoryCheckpoint"("chatId", "activeLeafMessageId");
CREATE INDEX "ChatMemoryCheckpoint_chatId_lastIndexedMessageId_idx"
  ON "ChatMemoryCheckpoint"("chatId", "lastIndexedMessageId");
CREATE INDEX "ChatMemoryCheckpoint_chatId_lastDreamedMessageId_idx"
  ON "ChatMemoryCheckpoint"("chatId", "lastDreamedMessageId");

CREATE UNIQUE INDEX "MemoryRecallChunk_userId_id_key"
  ON "MemoryRecallChunk"("userId", "id");
CREATE UNIQUE INDEX "MemoryRecallChunk_userId_chatId_id_key"
  ON "MemoryRecallChunk"("userId", "chatId", "id");
CREATE UNIQUE INDEX "MemoryRecallChunk_source_identity_key"
  ON "MemoryRecallChunk"(
    "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash"
  );
CREATE UNIQUE INDEX "MemoryRecallChunk_source_ordinal_key"
  ON "MemoryRecallChunk"(
    "userId", "chatId", "branchGeneration", "sourceRevisionAtCreation",
    "chunkingVersion", "sourceProjectionVersion", "chunkOrdinal"
  );
CREATE INDEX "MemoryRecallChunk_userId_chatId_state_source_idx"
  ON "MemoryRecallChunk"(
    "userId", "chatId", "state", "branchGeneration", "sourceRevisionAtCreation"
  );
CREATE INDEX "MemoryRecallChunk_userId_sourceFolderId_state_idx"
  ON "MemoryRecallChunk"("userId", "sourceFolderId", "state");
CREATE INDEX "MemoryRecallChunk_userId_sourceAssistantId_state_idx"
  ON "MemoryRecallChunk"("userId", "sourceAssistantId", "state");
CREATE INDEX "MemoryRecallChunk_userId_occurredFrom_occurredTo_idx"
  ON "MemoryRecallChunk"("userId", "occurredFrom", "occurredTo");

CREATE UNIQUE INDEX "MemoryRecallChunkMessage_chunkId_ordinal_key"
  ON "MemoryRecallChunkMessage"("chunkId", "ordinal");
CREATE INDEX "MemoryRecallChunkMessage_userId_chatId_messageId_idx"
  ON "MemoryRecallChunkMessage"("userId", "chatId", "messageId");

CREATE UNIQUE INDEX "MemoryEpisode_userId_id_key"
  ON "MemoryEpisode"("userId", "id");
CREATE UNIQUE INDEX "MemoryEpisode_userId_chatId_id_key"
  ON "MemoryEpisode"("userId", "chatId", "id");
CREATE UNIQUE INDEX "MemoryEpisode_source_identity_key"
  ON "MemoryEpisode"(
    "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "sourceHash"
  );
CREATE UNIQUE INDEX "MemoryEpisode_one_active_source_idx"
  ON "MemoryEpisode"(
    "userId", "chatId", "branchGeneration", "sourceRevisionAtCreation",
    "sourceHash", "pipelineVersion", "sourceProjectionVersion"
  ) WHERE "state" = 'ACTIVE';
CREATE INDEX "MemoryEpisode_userId_chatId_state_source_idx"
  ON "MemoryEpisode"(
    "userId", "chatId", "state", "branchGeneration", "sourceRevisionAtCreation"
  );
CREATE INDEX "MemoryEpisode_userId_sourceFolderId_state_idx"
  ON "MemoryEpisode"("userId", "sourceFolderId", "state");
CREATE INDEX "MemoryEpisode_userId_sourceAssistantId_state_idx"
  ON "MemoryEpisode"("userId", "sourceAssistantId", "state");
CREATE INDEX "MemoryEpisode_userId_createdByExecutionId_idx"
  ON "MemoryEpisode"("userId", "createdByExecutionId");
CREATE INDEX "MemoryEpisode_userId_occurredFrom_occurredTo_idx"
  ON "MemoryEpisode"("userId", "occurredFrom", "occurredTo");

CREATE UNIQUE INDEX "MemoryEpisodeMessage_episodeId_ordinal_key"
  ON "MemoryEpisodeMessage"("episodeId", "ordinal");
CREATE INDEX "MemoryEpisodeMessage_userId_chatId_messageId_idx"
  ON "MemoryEpisodeMessage"("userId", "chatId", "messageId");

CREATE INDEX "MemorySearchEntry_userId_episodeId_idx"
  ON "MemorySearchEntry"("userId", "episodeId");
CREATE INDEX "MemorySearchEntry_userId_recallChunkId_idx"
  ON "MemorySearchEntry"("userId", "recallChunkId");
CREATE UNIQUE INDEX "MemorySearchEntry_fact_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "factVersionId")
  WHERE "itemType" = 'FACT_VERSION';
CREATE UNIQUE INDEX "MemorySearchEntry_episode_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "episodeId")
  WHERE "itemType" = 'EPISODE';
CREATE UNIQUE INDEX "MemorySearchEntry_recall_chunk_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "recallChunkId")
  WHERE "itemType" = 'RECALL_CHUNK';

CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_target_key"
  ON "MemoryRetrievalAttemptItem"("userId", "attemptId", "itemType", "exactItemId");
CREATE INDEX "MemoryRetrievalAttemptItem_userId_episodeId_idx"
  ON "MemoryRetrievalAttemptItem"("userId", "episodeId");
CREATE INDEX "MemoryRetrievalAttemptItem_userId_recallChunkId_idx"
  ON "MemoryRetrievalAttemptItem"("userId", "recallChunkId");

CREATE INDEX "ModelRunMemoryItem_userId_episodeId_idx"
  ON "ModelRunMemoryItem"("userId", "episodeId");
CREATE INDEX "ModelRunMemoryItem_userId_recallChunkId_idx"
  ON "ModelRunMemoryItem"("userId", "recallChunkId");

ALTER TABLE "ChatMemoryCheckpoint"
  ADD CONSTRAINT "ChatMemoryCheckpoint_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_active_leaf_fkey"
    FOREIGN KEY ("chatId", "activeLeafMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_last_indexed_message_fkey"
    FOREIGN KEY ("chatId", "lastIndexedMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_last_dreamed_message_fkey"
    FOREIGN KEY ("chatId", "lastDreamedMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_shape_check"
    CHECK (
      "branchGeneration" >= 0
      AND "sourceRevision" >= 0
      AND char_length("sourceContentHash") BETWEEN 16 AND 128
      AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Za-z0-9._-]{1,64}$')
      AND ("status" <> 'READY' OR ("lastSucceededAt" IS NOT NULL AND "lastErrorCode" IS NULL))
      AND ("status" <> 'FAILED' OR "lastErrorCode" IS NOT NULL)
    );

ALTER TABLE "MemoryRecallChunk"
  ADD CONSTRAINT "MemoryRecallChunk_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunk_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunk_folder_fkey"
    FOREIGN KEY ("userId", "sourceFolderId") REFERENCES "Folder"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunk_assistant_fkey"
    FOREIGN KEY ("userId", "sourceAssistantId") REFERENCES "AssistantDefinition"("ownerUserId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunk_shape_check"
    CHECK (
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
      AND "safetyClass" <> 'SECRET_TAINTED'
      AND "redactionState" <> 'EXCLUDED'
      AND cardinality("redactionReasonCodes") <= 16
      AND char_length(array_to_string("redactionReasonCodes", ',')) <= 1024
      AND array_to_string("redactionReasonCodes", ',') ~ '^[A-Za-z0-9._,-]*$'
      AND (
        ("redactionState" = 'NOT_NEEDED' AND cardinality("redactionReasonCodes") = 0)
        OR ("redactionState" = 'REDACTED' AND cardinality("redactionReasonCodes") > 0)
      )
      AND (
        ("state" = 'ACTIVE' AND "invalidatedAt" IS NULL)
        OR ("state" IN ('INVALIDATED', 'SUPPRESSED') AND "invalidatedAt" IS NOT NULL)
      )
    );

ALTER TABLE "MemoryRecallChunkMessage"
  ADD CONSTRAINT "MemoryRecallChunkMessage_chunk_fkey"
    FOREIGN KEY ("userId", "chatId", "chunkId")
    REFERENCES "MemoryRecallChunk"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunkMessage_message_fkey"
    FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRecallChunkMessage_shape_check"
    CHECK (
      "ordinal" >= 0
      AND "role" IN ('user', 'assistant')
      AND (
        num_nonnulls("startOffset", "endOffset") = 0
        OR (
          num_nonnulls("startOffset", "endOffset") = 2
          AND "startOffset" >= 0
          AND "endOffset" > "startOffset"
        )
      )
    );

ALTER TABLE "MemoryEpisode"
  ADD CONSTRAINT "MemoryEpisode_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisode_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisode_folder_fkey"
    FOREIGN KEY ("userId", "sourceFolderId") REFERENCES "Folder"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisode_assistant_fkey"
    FOREIGN KEY ("userId", "sourceAssistantId") REFERENCES "AssistantDefinition"("ownerUserId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisode_execution_fkey"
    FOREIGN KEY ("userId", "createdByExecutionId") REFERENCES "MemoryExecutionBinding"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisode_shape_check"
    CHECK (
      "branchGeneration" >= 0
      AND "sourceRevisionAtCreation" >= 0
      AND char_length("safeSummary") BETWEEN 1 AND 4000
      AND char_length("normalizedSafeSearchText") BETWEEN 1 AND 4000
      AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
      AND CASE WHEN jsonb_typeof("keywords") = 'array'
        THEN jsonb_array_length("keywords") <= 32 AND pg_column_size("keywords") <= 4096
        ELSE false END
      AND CASE WHEN jsonb_typeof("entities") = 'array'
        THEN jsonb_array_length("entities") <= 64 AND pg_column_size("entities") <= 8192
        ELSE false END
      AND (
        num_nonnulls("occurredFrom", "occurredTo") = 0
        OR (num_nonnulls("occurredFrom", "occurredTo") = 2 AND "occurredTo" >= "occurredFrom")
      )
      AND "extractorRole" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "pipelineVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND char_length("sourceHash") BETWEEN 16 AND 128
      AND "sourceProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "safetyClass" <> 'SECRET_TAINTED'
      AND "redactionState" <> 'EXCLUDED'
      AND cardinality("redactionReasonCodes") <= 16
      AND char_length(array_to_string("redactionReasonCodes", ',')) <= 1024
      AND array_to_string("redactionReasonCodes", ',') ~ '^[A-Za-z0-9._,-]*$'
      AND (
        ("redactionState" = 'NOT_NEEDED' AND cardinality("redactionReasonCodes") = 0)
        OR ("redactionState" = 'REDACTED' AND cardinality("redactionReasonCodes") > 0)
      )
      AND (
        ("state" = 'ACTIVE' AND "invalidatedAt" IS NULL)
        OR ("state" IN ('INVALIDATED', 'SUPPRESSED') AND "invalidatedAt" IS NOT NULL)
      )
    );

ALTER TABLE "MemoryEpisodeMessage"
  ADD CONSTRAINT "MemoryEpisodeMessage_episode_fkey"
    FOREIGN KEY ("userId", "chatId", "episodeId")
    REFERENCES "MemoryEpisode"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisodeMessage_message_fkey"
    FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEpisodeMessage_shape_check"
    CHECK ("ordinal" >= 0);

ALTER TABLE "MemorySearchEntry"
  ADD CONSTRAINT "MemorySearchEntry_episode_fkey"
    FOREIGN KEY ("userId", "episodeId") REFERENCES "MemoryEpisode"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySearchEntry_recall_chunk_fkey"
    FOREIGN KEY ("userId", "recallChunkId") REFERENCES "MemoryRecallChunk"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySearchEntry_shape_check"
    CHECK (
      (
        ("itemType" = 'FACT_VERSION' AND "factVersionId" IS NOT NULL AND num_nonnulls("episodeId", "recallChunkId") = 0)
        OR ("itemType" = 'EPISODE' AND "episodeId" IS NOT NULL AND num_nonnulls("factVersionId", "recallChunkId") = 0)
        OR ("itemType" = 'RECALL_CHUNK' AND "recallChunkId" IS NOT NULL AND num_nonnulls("factVersionId", "episodeId") = 0)
      )
      AND char_length("safeSearchText") BETWEEN 1 AND 4000
      AND char_length("safeSearchTextYoNormalized") BETWEEN 1 AND 4000
      AND (
        ("embeddingState" IN ('NOT_APPLICABLE', 'PENDING', 'FAILED') AND num_nonnulls("embedding", "embeddingDimension") = 0)
        OR ("embeddingState" = 'READY' AND num_nonnulls("embedding", "embeddingDimension") = 2)
      )
    );

ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_episode_fkey"
    FOREIGN KEY (
      "userId", "episodeId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
      "sourceRevisionSnapshot", "sourceContentHashSnapshot"
    ) REFERENCES "MemoryEpisode"(
      "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "sourceHash"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_recall_chunk_fkey"
    FOREIGN KEY (
      "userId", "recallChunkId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
      "sourceRevisionSnapshot", "sourceContentHashSnapshot"
    ) REFERENCES "MemoryRecallChunk"(
      "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_shape_check"
    CHECK (
      "ordinal" >= 0
      AND char_length("exactItemId") BETWEEN 1 AND 256
      AND char_length("exactSafeText") BETWEEN 1 AND 4000
      AND (
        (
          "itemType" = 'FACT_VERSION'
          AND "factVersionId" IS NOT NULL
          AND "exactItemId" = "factVersionId"
          AND num_nonnulls("episodeId", "recallChunkId") = 0
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) IN (0, 4)
        )
        OR (
          "itemType" = 'EPISODE'
          AND "episodeId" IS NOT NULL
          AND "exactItemId" = "episodeId"
          AND num_nonnulls("factVersionId", "recallChunkId") = 0
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
        OR (
          "itemType" = 'RECALL_CHUNK'
          AND "recallChunkId" IS NOT NULL
          AND "exactItemId" = "recallChunkId"
          AND num_nonnulls("factVersionId", "episodeId") = 0
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
      )
      AND ("sourceBranchGenerationSnapshot" IS NULL OR "sourceBranchGenerationSnapshot" >= 0)
      AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
    );

ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_episode_fkey"
    FOREIGN KEY (
      "userId", "episodeId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
      "sourceRevisionSnapshot", "sourceContentHashSnapshot"
    ) REFERENCES "MemoryEpisode"(
      "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "sourceHash"
    ) ON DELETE SET NULL ("episodeId") ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryItem_recall_chunk_fkey"
    FOREIGN KEY (
      "userId", "recallChunkId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
      "sourceRevisionSnapshot", "sourceContentHashSnapshot"
    ) REFERENCES "MemoryRecallChunk"(
      "userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash"
    ) ON DELETE SET NULL ("recallChunkId") ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryItem_shape_check"
    CHECK (
      "ordinal" >= 0
      AND char_length("exactItemId") BETWEEN 1 AND 256
      AND char_length("includedText") BETWEEN 1 AND 4000
      AND "finalScore" BETWEEN 0 AND 1
      AND num_nonnulls("factVersionId", "episodeId", "recallChunkId") <= 1
      AND (
        (
          "itemType" = 'FACT_VERSION'
          AND num_nonnulls("episodeId", "recallChunkId") = 0
          AND ("factVersionId" IS NULL OR "exactItemId" = "factVersionId")
        )
        OR (
          "itemType" = 'EPISODE'
          AND num_nonnulls("factVersionId", "recallChunkId") = 0
          AND ("episodeId" IS NULL OR "exactItemId" = "episodeId")
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
        OR (
          "itemType" = 'RECALL_CHUNK'
          AND num_nonnulls("factVersionId", "episodeId") = 0
          AND ("recallChunkId" IS NULL OR "exactItemId" = "recallChunkId")
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
      )
      AND ("sourceBranchGenerationSnapshot" IS NULL OR "sourceBranchGenerationSnapshot" >= 0)
      AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
    );

-- Phase 4 makes episode evidence and source-episode suppressions real typed
-- relations instead of feature-dark nullable placeholders.
ALTER TABLE "MemoryEvidence"
  DROP CONSTRAINT "MemoryEvidence_source_shape_check",
  ADD CONSTRAINT "MemoryEvidence_episode_fkey"
    FOREIGN KEY ("userId", "chatId", "episodeId")
    REFERENCES "MemoryEpisode"("userId", "chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_source_shape_check"
    CHECK (
      char_length("safeExcerpt") BETWEEN 1 AND 2000
      AND (
        (
          "sourceType" = 'MESSAGE'
          AND num_nonnulls("chatId", "messageId", "branchGeneration") = 3
          AND "episodeId" IS NULL AND "memoryEventId" IS NULL
        )
        OR (
          "sourceType" = 'EXPLICIT_ACTION'
          AND "memoryEventId" IS NOT NULL
          AND num_nonnulls("chatId", "messageId", "episodeId", "branchGeneration") = 0
        )
        OR (
          "sourceType" = 'EPISODE'
          AND num_nonnulls("chatId", "episodeId", "branchGeneration") = 3
          AND "messageId" IS NULL AND "memoryEventId" IS NULL
        )
      )
    );
CREATE UNIQUE INDEX "MemoryEvidence_episode_identity_idx"
  ON "MemoryEvidence"(
    "userId", "factVersionId", "stance", "chatId", "episodeId", "sourceProjectionVersion"
  ) WHERE "sourceType" = 'EPISODE';

ALTER TABLE "MemorySuppression"
  DROP CONSTRAINT "MemorySuppression_shape_check",
  ADD CONSTRAINT "MemorySuppression_episode_fkey"
    FOREIGN KEY ("userId", "sourceChatId", "sourceEpisodeId")
    REFERENCES "MemoryEpisode"("userId", "chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySuppression_shape_check"
    CHECK (
      "deletionGeneration" >= 0
      AND "fingerprintKeyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND ("canonicalKeyHash" IS NULL OR "canonicalKeyHash" ~ '^[A-Za-z0-9_-]{43}$')
      AND ("normalizedValueHash" IS NULL OR "normalizedValueHash" ~ '^[A-Za-z0-9_-]{43}$')
      AND (
        ("scope" = 'FACT' AND "canonicalKeyHash" IS NOT NULL AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'VALUE' AND "normalizedValueHash" IS NOT NULL AND num_nonnulls("canonicalKeyHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'SOURCE_MESSAGE' AND num_nonnulls("sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 3 AND "sourceEpisodeId" IS NULL)
        OR ("scope" = 'SOURCE_EPISODE' AND num_nonnulls("sourceChatId", "sourceEpisodeId", "sourceBranchGeneration") = 3 AND "sourceMessageId" IS NULL)
        OR ("scope" = 'CATEGORY' AND "canonicalKeyHash" IS NOT NULL AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'ALL' AND num_nonnulls("canonicalKeyHash", "normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
      )
    );

CREATE FUNCTION aiqsa_memory_assert_history_source(p_user_id text, p_chat_id text)
RETURNS void LANGUAGE plpgsql AS $memory_history_source$
DECLARE
  chat_row "Chat"%ROWTYPE;
BEGIN
  SELECT * INTO chat_row
  FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallChunk" AS chunk
    WHERE chunk."userId" = p_user_id
      AND chunk."chatId" = p_chat_id
      AND chunk."state" = 'ACTIVE'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR chunk."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR chunk."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
        OR chunk."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
      )
  ) OR EXISTS (
    SELECT 1
    FROM "MemoryEpisode" AS episode
    WHERE episode."userId" = p_user_id
      AND episode."chatId" = p_chat_id
      AND episode."state" = 'ACTIVE'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR episode."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR episode."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
        OR episode."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
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
        OR checkpoint."sourceRevision" <> chat_row."memorySourceRevision"
        OR checkpoint."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory history must match the current eligible chat source generation';
  END IF;
END
$memory_history_source$;

CREATE FUNCTION aiqsa_memory_history_source_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_history_source_trigger$
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."id") IS DISTINCT FROM (NEW."userId", NEW."id") THEN
      PERFORM aiqsa_memory_assert_history_source(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source(NEW."userId", NEW."chatId");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."chatId") IS DISTINCT FROM (NEW."userId", NEW."chatId") THEN
      PERFORM aiqsa_memory_assert_history_source(OLD."userId", OLD."chatId");
    END IF;
  END IF;
  RETURN NULL;
END
$memory_history_source_trigger$;

CREATE CONSTRAINT TRIGGER "Chat_memory_history_source_guard"
AFTER INSERT OR UPDATE ON "Chat"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_history_source_trigger();
CREATE CONSTRAINT TRIGGER "ChatMemoryCheckpoint_source_guard"
AFTER INSERT OR UPDATE OR DELETE ON "ChatMemoryCheckpoint"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_history_source_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallChunk_source_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryRecallChunk"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_history_source_trigger();
CREATE CONSTRAINT TRIGGER "MemoryEpisode_source_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryEpisode"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_history_source_trigger();

CREATE FUNCTION aiqsa_memory_model_run_item_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $memory_model_run_item_target_guard$
BEGIN
  IF TG_OP = 'INSERT' AND (
    (NEW."itemType" = 'FACT_VERSION' AND NEW."factVersionId" IS NULL)
    OR (NEW."itemType" = 'EPISODE' AND NEW."episodeId" IS NULL)
    OR (NEW."itemType" = 'RECALL_CHUNK' AND NEW."recallChunkId" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item requires its exact live target at insert';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."exactItemId" IS DISTINCT FROM OLD."exactItemId"
       OR NEW."itemType" IS DISTINCT FROM OLD."itemType"
       OR NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot"
       OR NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM OLD."sourceBranchGenerationSnapshot"
       OR NEW."sourceRevisionSnapshot" IS DISTINCT FROM OLD."sourceRevisionSnapshot"
       OR NEW."sourceContentHashSnapshot" IS DISTINCT FROM OLD."sourceContentHashSnapshot"
       OR (NEW."factVersionId" IS DISTINCT FROM OLD."factVersionId"
           AND NOT (OLD."factVersionId" IS NOT NULL AND NEW."factVersionId" IS NULL))
       OR (NEW."episodeId" IS DISTINCT FROM OLD."episodeId"
           AND NOT (OLD."episodeId" IS NOT NULL AND NEW."episodeId" IS NULL))
       OR (NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId"
           AND NOT (OLD."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accepted Memory item identity and source generation are immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$memory_model_run_item_target_guard$;

CREATE TRIGGER "ModelRunMemoryItem_target_guard"
BEFORE INSERT OR UPDATE ON "ModelRunMemoryItem"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_model_run_item_target_guard();

-- The supported release profile has only the qualified 1024- and
-- 1536-dimensional vector spaces. Every READY row is routed to exactly one
-- partial expression index; lexical rows remain independent of these indexes.
CREATE INDEX "MemorySearchEntry_embedding_1024_hnsw_idx"
  ON "MemorySearchEntry"
  USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "embeddingState" = 'READY' AND "embeddingDimension" = 1024;
CREATE INDEX "MemorySearchEntry_embedding_1536_hnsw_idx"
  ON "MemorySearchEntry"
  USING hnsw (("embedding"::vector(1536)) vector_cosine_ops)
  WHERE "embeddingState" = 'READY' AND "embeddingDimension" = 1536;

-- Rollback guidance: stop app/Memory writers; remove the two HNSW indexes,
-- history triggers/functions, episode suppression/evidence relations, typed
-- target columns/constraints, and history tables in dependency order. Recreate
-- MemorySearchItemType with FACT_VERSION only after proving no Phase 4 target
-- remains. Never coerce a history target into a fact target.

COMMIT;
