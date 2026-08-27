ALTER TABLE "MemoryIndexGeneration"
  ADD COLUMN "roundProjectionVersion" VARCHAR(64),
  ADD COLUMN "contextualKeyPolicyVersion" VARCHAR(64);

ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v5';

-- Standalone conversational groups change the safe history projection, not
-- only the new round table. Extend the installed digest source guard to the
-- exact v5 projection without copying its database-owned invariant body.
DO $migration$
DECLARE
  function_definition text;
BEGIN
  function_definition := pg_get_functiondef(
    'aiqsa_memory_assert_digest_sources(text)'::regprocedure
  );
  function_definition := replace(
    function_definition,
    '''memory-history-source-projection-v4''',
    '''memory-history-source-projection-v5'''
  );
  IF position('memory-history-source-projection-v5' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Memory digest source guard v5 extension failed';
  END IF;
  EXECUTE function_definition;
END;
$migration$;

ALTER TABLE "MemoryRecallChunk"
  ADD COLUMN "evidenceRootHash" CHAR(64),
  ADD CONSTRAINT "MemoryRecallChunk_evidence_root_check" CHECK (
    "evidenceRootHash" IS NULL OR "evidenceRootHash" ~ '^[a-f0-9]{64}$'
  );
CREATE INDEX "MemoryRecallChunk_userId_evidenceRootHash_state_idx"
  ON "MemoryRecallChunk"("userId", "evidenceRootHash", "state");

CREATE TABLE "MemoryRecallRound" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "parentChunkId" TEXT NOT NULL,
  "sourceFolderId" TEXT,
  "sourceAssistantId" TEXT,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "roundOrdinal" INTEGER NOT NULL,
  "groupKind" VARCHAR(32) NOT NULL,
  "evidenceRootHash" CHAR(64) NOT NULL,
  "contentHash" VARCHAR(128) NOT NULL,
  "rawSafeText" TEXT NOT NULL,
  "contextualNarrativeText" TEXT NOT NULL,
  "contextualSearchText" TEXT NOT NULL,
  "contextualSearchHash" CHAR(64) NOT NULL,
  "contextualKeyState" VARCHAR(32) NOT NULL,
  "contextualKeyPolicyVersion" VARCHAR(64) NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "occurredFrom" TIMESTAMP(3) NOT NULL,
  "occurredTo" TIMESTAMP(3) NOT NULL,
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "projectionVersion" VARCHAR(64) NOT NULL,
  "sourceProjectionVersion" VARCHAR(64) NOT NULL,
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "redactionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryRecallRound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryRecallRound_shape_check" CHECK (
    "branchGeneration" >= 0
    AND "sourceRevisionAtCreation" >= 0
    AND "roundOrdinal" >= 0
    AND "groupKind" IN ('TURN', 'STANDALONE', 'TOOL_EVENT')
    AND "evidenceRootHash" ~ '^[a-f0-9]{64}$'
    AND "contentHash" ~ '^[a-f0-9]{64}$'
    AND char_length("rawSafeText") BETWEEN 1 AND 200000
    AND char_length("contextualNarrativeText") BETWEEN 1 AND 200000
    AND char_length("contextualSearchText") BETWEEN 1 AND 4000
    AND "contextualSearchHash" ~ '^[a-f0-9]{64}$'
    AND "contextualKeyState" IN ('GENERATED', 'RAW_FALLBACK')
    AND "contextualKeyPolicyVersion" ~ '^[A-Za-z0-9._:-]{1,64}$'
    AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
    AND "occurredTo" >= "occurredFrom"
    AND "projectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
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
      ("state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NULL
        AND "safetyClass" IN (
          'NORMAL'::"MemoryDerivedSafetyClass",
          'SENSITIVE'::"MemoryDerivedSafetyClass"
        )
        AND "redactionState" <> 'EXCLUDED'::"MemoryRedactionState")
      OR ("state" = 'SUPPRESSED'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NULL
        AND "safetyClass" = 'SECRET_TAINTED'::"MemoryDerivedSafetyClass"
        AND "redactionState" = 'EXCLUDED'::"MemoryRedactionState")
      OR ("state" = 'INVALIDATED'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX "MemoryRecallRound_userId_id_key"
  ON "MemoryRecallRound"("userId", "id");
CREATE UNIQUE INDEX "MemoryRecallRound_userId_chatId_id_key"
  ON "MemoryRecallRound"("userId", "chatId", "id");
CREATE UNIQUE INDEX "MemoryRecallRound_source_identity_key"
  ON "MemoryRecallRound"(
    "userId", "id", "chatId", "branchGeneration",
    "sourceRevisionAtCreation", "contentHash"
  );
CREATE UNIQUE INDEX "MemoryRecallRound_source_ordinal_key"
  ON "MemoryRecallRound"(
    "userId", "chatId", "branchGeneration", "sourceRevisionAtCreation",
    "projectionVersion", "sourceProjectionVersion", "roundOrdinal"
  );
CREATE INDEX "MemoryRecallRound_userId_chatId_state_branchGeneration_sour_idx"
  ON "MemoryRecallRound"(
    "userId", "chatId", "state", "branchGeneration", "sourceRevisionAtCreation"
  );
CREATE INDEX "MemoryRecallRound_userId_parentChunkId_state_idx"
  ON "MemoryRecallRound"("userId", "parentChunkId", "state");
CREATE INDEX "MemoryRecallRound_userId_evidenceRootHash_state_idx"
  ON "MemoryRecallRound"("userId", "evidenceRootHash", "state");
CREATE INDEX "MemoryRecallRound_userId_occurredFrom_occurredTo_idx"
  ON "MemoryRecallRound"("userId", "occurredFrom", "occurredTo");

CREATE TABLE "MemoryRecallRoundMessage" (
  "userId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "safeTextHash" VARCHAR(128) NOT NULL,
  "sourceMessageContentHash" VARCHAR(128) NOT NULL,
  "sourceMessageUpdatedAt" TIMESTAMP(3) NOT NULL,
  "sourceStartOffset" INTEGER NOT NULL,
  "sourceEndOffset" INTEGER NOT NULL,
  "roundStartOffset" INTEGER NOT NULL,
  "roundEndOffset" INTEGER NOT NULL,
  CONSTRAINT "MemoryRecallRoundMessage_pkey" PRIMARY KEY ("roundId", "messageId"),
  CONSTRAINT "MemoryRecallRoundMessage_shape_check" CHECK (
    "ordinal" >= 0
    AND "role" IN ('user', 'assistant', 'tool')
    AND "safeTextHash" ~ '^[a-f0-9]{64}$'
    AND "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
    AND "sourceStartOffset" >= 0
    AND "sourceEndOffset" > "sourceStartOffset"
    AND "roundStartOffset" >= 0
    AND "roundEndOffset" > "roundStartOffset"
    AND "sourceEndOffset" - "sourceStartOffset" =
      "roundEndOffset" - "roundStartOffset"
  )
);
CREATE UNIQUE INDEX "MemoryRecallRoundMessage_roundId_ordinal_key"
  ON "MemoryRecallRoundMessage"("roundId", "ordinal");
CREATE INDEX "MemoryRecallRoundMessage_userId_chatId_messageId_idx"
  ON "MemoryRecallRoundMessage"("userId", "chatId", "messageId");

ALTER TABLE "MemoryRecallRound"
  ADD CONSTRAINT "MemoryRecallRound_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryRecallRound_chat_fkey"
  FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "MemoryRecallRound_parent_chunk_fkey"
  FOREIGN KEY ("userId", "chatId", "parentChunkId")
  REFERENCES "MemoryRecallChunk"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryRecallRound_folder_fkey"
  FOREIGN KEY ("userId", "sourceFolderId")
  REFERENCES "Folder"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "MemoryRecallRound_assistant_fkey"
  FOREIGN KEY ("userId", "sourceAssistantId")
  REFERENCES "AssistantDefinition"("ownerUserId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRecallRoundMessage"
  ADD CONSTRAINT "MemoryRecallRoundMessage_round_fkey"
  FOREIGN KEY ("userId", "chatId", "roundId")
  REFERENCES "MemoryRecallRound"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryRecallRoundMessage_message_fkey"
  FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemorySearchEntry" ADD COLUMN "recallRoundId" TEXT;
ALTER TABLE "MemoryRetrievalAttemptItem" ADD COLUMN "recallRoundId" TEXT;
ALTER TABLE "ModelRunMemoryItem" ADD COLUMN "recallRoundId" TEXT;
ALTER TABLE "MemoryFeedback" ADD COLUMN "recallRoundId" TEXT;

CREATE INDEX "MemorySearchEntry_userId_recallRoundId_idx"
  ON "MemorySearchEntry"("userId", "recallRoundId");
CREATE UNIQUE INDEX "MemorySearchEntry_recall_round_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "recallRoundId")
  WHERE "itemType" = 'RECALL_ROUND'::"MemorySearchItemType";
CREATE INDEX "MemoryRetrievalAttemptItem_userId_recallRoundId_idx"
  ON "MemoryRetrievalAttemptItem"("userId", "recallRoundId");
CREATE INDEX "ModelRunMemoryItem_userId_recallRoundId_idx"
  ON "ModelRunMemoryItem"("userId", "recallRoundId");
CREATE INDEX "MemoryFeedback_userId_recallRoundId_createdAt_idx"
  ON "MemoryFeedback"("userId", "recallRoundId", "createdAt");

ALTER TABLE "MemorySearchEntry"
  ADD CONSTRAINT "MemorySearchEntry_recall_round_fkey"
  FOREIGN KEY ("userId", "recallRoundId")
  REFERENCES "MemoryRecallRound"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_recall_round_fkey"
  FOREIGN KEY (
    "userId", "recallRoundId", "sourceChatIdSnapshot",
    "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot",
    "sourceContentHashSnapshot"
  ) REFERENCES "MemoryRecallRound"(
    "userId", "id", "chatId", "branchGeneration",
    "sourceRevisionAtCreation", "contentHash"
  ) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_recall_round_fkey"
  FOREIGN KEY (
    "userId", "recallRoundId", "sourceChatIdSnapshot",
    "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot",
    "sourceContentHashSnapshot"
  ) REFERENCES "MemoryRecallRound"(
    "userId", "id", "chatId", "branchGeneration",
    "sourceRevisionAtCreation", "contentHash"
  ) ON UPDATE RESTRICT ON DELETE SET NULL ("recallRoundId");
ALTER TABLE "MemoryFeedback"
  ADD CONSTRAINT "MemoryFeedback_recall_round_fkey"
  FOREIGN KEY ("userId", "recallRoundId")
  REFERENCES "MemoryRecallRound"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryIndexGeneration"
  DROP CONSTRAINT "MemoryIndexGeneration_configuration_check",
  ADD CONSTRAINT "MemoryIndexGeneration_configuration_check" CHECK (
    "generation" >= 0
    AND "targetMemoryRevision" >= 0
    AND "indexedThroughMemoryRevision" >= 0
    AND ("sourceIndexGenerationId" IS NULL OR "sourceIndexGenerationId" <> "id")
    AND (
      num_nonnulls("roundProjectionVersion", "contextualKeyPolicyVersion") = 0
      OR num_nonnulls("roundProjectionVersion", "contextualKeyPolicyVersion") = 2
        AND "roundProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
        AND "contextualKeyPolicyVersion" ~ '^[A-Za-z0-9._:-]{1,64}$'
    )
    AND (
      "indexMode" = 'LEXICAL_ONLY'::"MemoryIndexMode"
      AND num_nonnulls(
        "embeddingConnectionId", "embeddingProviderModelId",
        "embeddingConfigurationFingerprint", "embeddingDimension",
        "vectorSpaceFingerprint"
      ) = 0
      OR "indexMode" = 'HYBRID'::"MemoryIndexMode"
      AND num_nonnulls(
        "embeddingConnectionId", "embeddingProviderModelId",
        "embeddingConfigurationFingerprint", "embeddingDimension",
        "vectorSpaceFingerprint"
      ) = 5
      AND "embeddingDimension" BETWEEN 1 AND 4096
    )
    AND (
      "state" IN (
        'BUILDING'::"MemoryIndexGenerationState",
        'CATCHING_UP'::"MemoryIndexGenerationState"
      ) AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 0
      OR "state" = 'READY'::"MemoryIndexGenerationState"
      AND "readyAt" IS NOT NULL
      AND num_nonnulls("activatedAt", "supersededAt") = 0
      OR "state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL
      AND "supersededAt" IS NULL
      OR "state" = 'SUPERSEDED'::"MemoryIndexGenerationState"
      AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 3
      OR "state" IN (
        'FAILED'::"MemoryIndexGenerationState",
        'CANCELLED'::"MemoryIndexGenerationState"
      ) AND "activatedAt" IS NULL AND "supersededAt" IS NULL
    )
  );

ALTER TABLE "MemorySearchEntry"
  DROP CONSTRAINT "MemorySearchEntry_shape_check",
  ADD CONSTRAINT "MemorySearchEntry_shape_check" CHECK (
    (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "factVersionId" IS NOT NULL
      AND num_nonnulls("recallChunkId", "recallRoundId") = 0
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND num_nonnulls("factVersionId", "recallRoundId") = 0
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND "recallRoundId" IS NOT NULL
      AND num_nonnulls("factVersionId", "recallChunkId") = 0
    )
    AND char_length("normalizedSearchText") BETWEEN 1 AND 4000
    AND (
      "embeddingState" IN (
        'NOT_APPLICABLE'::"MemoryEmbeddingState",
        'PENDING'::"MemoryEmbeddingState",
        'FAILED'::"MemoryEmbeddingState"
      ) AND num_nonnulls("embedding", "embeddingDimension") = 0
      OR "embeddingState" = 'READY'::"MemoryEmbeddingState"
      AND num_nonnulls("embedding", "embeddingDimension") = 2
    )
  );

ALTER TABLE "MemoryRetrievalAttemptItem"
  DROP CONSTRAINT "MemoryRetrievalAttemptItem_shape_check",
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_shape_check" CHECK (
    "ordinal" >= 0
    AND char_length("exactItemId") BETWEEN 1 AND 256
    AND char_length("exactSafeText") BETWEEN 1 AND 4000
    AND (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "factVersionId" IS NOT NULL
      AND "exactItemId" = "factVersionId"
      AND num_nonnulls("recallChunkId", "recallRoundId") = 0
      AND (
        num_nonnulls(
          "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
          "sourceRevisionSnapshot", "sourceContentHashSnapshot"
        ) IN (0, 4)
        OR num_nonnulls(
          "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot"
        ) = 2
        AND num_nonnulls(
          "sourceRevisionSnapshot", "sourceContentHashSnapshot"
        ) = 0
      )
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND "exactItemId" = "recallChunkId"
      AND num_nonnulls("factVersionId", "recallRoundId") = 0
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND "recallRoundId" IS NOT NULL
      AND "exactItemId" = "recallRoundId"
      AND num_nonnulls("factVersionId", "recallChunkId") = 0
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
    )
    AND (
      "sourceBranchGenerationSnapshot" IS NULL
      OR "sourceBranchGenerationSnapshot" >= 0
    )
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

ALTER TABLE "ModelRunMemoryItem"
  DROP CONSTRAINT "ModelRunMemoryItem_shape_check",
  ADD CONSTRAINT "ModelRunMemoryItem_shape_check" CHECK (
    "ordinal" >= 0
    AND char_length("exactItemId") BETWEEN 1 AND 256
    AND char_length("includedText") BETWEEN 1 AND 4000
    AND "finalScore" BETWEEN 0::double precision AND 1::double precision
    AND num_nonnulls("factVersionId", "recallChunkId", "recallRoundId") <= 1
    AND (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND num_nonnulls("recallChunkId", "recallRoundId") = 0
      AND ("factVersionId" IS NULL OR "exactItemId" = "factVersionId")
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND num_nonnulls("factVersionId", "recallRoundId") = 0
      AND ("recallChunkId" IS NULL OR "exactItemId" = "recallChunkId")
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND num_nonnulls("factVersionId", "recallChunkId") = 0
      AND ("recallRoundId" IS NULL OR "exactItemId" = "recallRoundId")
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
    )
    AND (
      "sourceBranchGenerationSnapshot" IS NULL
      OR "sourceBranchGenerationSnapshot" >= 0
    )
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

ALTER TABLE "MemoryFeedback"
  DROP CONSTRAINT "MemoryFeedback_shape_check",
  ADD CONSTRAINT "MemoryFeedback_shape_check" CHECK (
    "idempotencyFingerprint" ~ '^[a-f0-9]{64}$'
    AND char_length("requestId") BETWEEN 1 AND 256
    AND (
      "comment" IS NULL
      OR char_length("comment") BETWEEN 1 AND 1000 AND btrim("comment") <> ''
    )
    AND (
      "contentPurgedAt" IS NULL
      AND "purgeReason" IS NULL
      AND "memoryEventId" IS NOT NULL
      AND (
        "targetKind" = 'FACT_VERSION'::"MemoryFeedbackTargetKind"
        AND num_nonnulls("memoryFactId", "memoryFactVersionId") = 2
        AND num_nonnulls("recallChunkId", "recallRoundId") = 0
        OR "targetKind" = 'RECALL_CHUNK'::"MemoryFeedbackTargetKind"
        AND "recallChunkId" IS NOT NULL
        AND num_nonnulls("memoryFactId", "memoryFactVersionId", "recallRoundId") = 0
        OR "targetKind" = 'RECALL_ROUND'::"MemoryFeedbackTargetKind"
        AND "recallRoundId" IS NOT NULL
        AND num_nonnulls("memoryFactId", "memoryFactVersionId", "recallChunkId") = 0
      )
      AND (
        num_nonnulls(
          "modelRunId", "modelRunMemoryItemId", "modelRunToolCallId"
        ) = 0
        OR "modelRunId" IS NOT NULL
        AND num_nonnulls("modelRunMemoryItemId", "modelRunToolCallId") = 1
      )
      AND (
        "feedbackType" = 'RETRACT'::"MemoryFeedbackType"
        AND "retractsFeedbackId" IS NOT NULL AND "comment" IS NULL
        OR "feedbackType" <> 'RETRACT'::"MemoryFeedbackType"
        AND "retractsFeedbackId" IS NULL
      )
      OR "contentPurgedAt" IS NOT NULL
      AND "purgeReason" ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND num_nonnulls(
        "memoryFactId", "memoryFactVersionId", "recallChunkId", "recallRoundId",
        "modelRunId", "modelRunMemoryItemId", "modelRunToolCallId",
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "comment",
        "retractsFeedbackId", "memoryEventId"
      ) = 0
    )
  );

CREATE OR REPLACE FUNCTION public.aiqsa_memory_generation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF (
    NEW."userId", NEW."generation", NEW."indexMode", NEW."sourceIndexGenerationId",
    NEW."targetMemoryRevision", NEW."embeddingConnectionId",
    NEW."embeddingProviderModelId", NEW."embeddingConfigurationFingerprint",
    NEW."embeddingDimension", NEW."vectorSpaceFingerprint", NEW."languageProfile",
    NEW."normalizationVersion", NEW."chunkingVersion",
    NEW."roundProjectionVersion", NEW."contextualKeyPolicyVersion",
    NEW."retrievalPipelineVersion"
  ) IS DISTINCT FROM (
    OLD."userId", OLD."generation", OLD."indexMode", OLD."sourceIndexGenerationId",
    OLD."targetMemoryRevision", OLD."embeddingConnectionId",
    OLD."embeddingProviderModelId", OLD."embeddingConfigurationFingerprint",
    OLD."embeddingDimension", OLD."vectorSpaceFingerprint", OLD."languageProfile",
    OLD."normalizationVersion", OLD."chunkingVersion",
    OLD."roundProjectionVersion", OLD."contextualKeyPolicyVersion",
    OLD."retrievalPipelineVersion"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory index generation configuration is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_model_run_item_target_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."itemType" = 'FACT_VERSION' AND NEW."factVersionId" IS NULL
    OR NEW."itemType" = 'RECALL_CHUNK' AND NEW."recallChunkId" IS NULL
    OR NEW."itemType" = 'RECALL_ROUND' AND NEW."recallRoundId" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item requires its exact live target at insert';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."exactItemId" IS DISTINCT FROM OLD."exactItemId"
    OR NEW."itemType" IS DISTINCT FROM OLD."itemType"
    OR NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot"
    OR NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM OLD."sourceBranchGenerationSnapshot"
    OR NEW."sourceRevisionSnapshot" IS DISTINCT FROM OLD."sourceRevisionSnapshot"
    OR NEW."sourceContentHashSnapshot" IS DISTINCT FROM OLD."sourceContentHashSnapshot"
    OR (NEW."factVersionId" IS DISTINCT FROM OLD."factVersionId"
      AND NOT (OLD."factVersionId" IS NOT NULL AND NEW."factVersionId" IS NULL))
    OR (NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId"
      AND NOT (OLD."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS NULL))
    OR (NEW."recallRoundId" IS DISTINCT FROM OLD."recallRoundId"
      AND NOT (OLD."recallRoundId" IS NOT NULL AND NEW."recallRoundId" IS NULL))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item identity and source generation are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_feedback_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."idempotencyFingerprint" IS DISTINCT FROM OLD."idempotencyFingerprint"
    OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
    OR NEW."feedbackType" IS DISTINCT FROM OLD."feedbackType"
    OR NEW."targetKind" IS DISTINCT FROM OLD."targetKind"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR OLD."contentPurgedAt" IS NOT NULL
    OR NEW."contentPurgedAt" IS NULL
    OR OLD."purgeReason" IS NOT NULL
    OR NEW."purgeReason" IS NULL
    OR (NEW."memoryFactId" IS NOT NULL AND NEW."memoryFactId" IS DISTINCT FROM OLD."memoryFactId")
    OR (NEW."memoryFactVersionId" IS NOT NULL AND NEW."memoryFactVersionId" IS DISTINCT FROM OLD."memoryFactVersionId")
    OR (NEW."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId")
    OR (NEW."recallRoundId" IS NOT NULL AND NEW."recallRoundId" IS DISTINCT FROM OLD."recallRoundId")
    OR (NEW."modelRunId" IS NOT NULL AND NEW."modelRunId" IS DISTINCT FROM OLD."modelRunId")
    OR (NEW."modelRunMemoryItemId" IS NOT NULL AND NEW."modelRunMemoryItemId" IS DISTINCT FROM OLD."modelRunMemoryItemId")
    OR (NEW."modelRunToolCallId" IS NOT NULL AND NEW."modelRunToolCallId" IS DISTINCT FROM OLD."modelRunToolCallId")
    OR (NEW."sourceChatIdSnapshot" IS NOT NULL AND NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot")
    OR (NEW."sourceBranchGenerationSnapshot" IS NOT NULL AND NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM OLD."sourceBranchGenerationSnapshot")
    OR (NEW."comment" IS NOT NULL AND NEW."comment" IS DISTINCT FROM OLD."comment")
    OR (NEW."retractsFeedbackId" IS NOT NULL AND NEW."retractsFeedbackId" IS DISTINCT FROM OLD."retractsFeedbackId")
    OR (NEW."memoryEventId" IS NOT NULL AND NEW."memoryEventId" IS DISTINCT FROM OLD."memoryEventId")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback is append-only except for one-way purge';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_feedback_target_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  feedback_event "MemoryEvent"%ROWTYPE;
  target_item "ModelRunMemoryItem"%ROWTYPE;
  retracted "MemoryFeedback"%ROWTYPE;
BEGIN
  IF NEW."contentPurgedAt" IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO feedback_event FROM "MemoryEvent"
  WHERE "userId" = NEW."userId" AND "id" = NEW."memoryEventId";
  IF NOT FOUND
    OR feedback_event."operation" <> 'USER_FEEDBACK'
    OR feedback_event."actorType" <> 'USER'
    OR feedback_event."actorUserId" IS DISTINCT FROM NEW."userId"
    OR feedback_event."metadata" ->> 'schemaVersion' IS DISTINCT FROM 'memory-feedback-event-v1'
    OR feedback_event."metadata" ->> 'feedbackId' IS DISTINCT FROM NEW."id"
    OR feedback_event."metadata" ->> 'feedbackType' IS DISTINCT FROM NEW."feedbackType"::text
    OR (NEW."targetKind" = 'FACT_VERSION' AND (
      feedback_event."factId" IS DISTINCT FROM NEW."memoryFactId"
      OR feedback_event."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
    ))
    OR (NEW."targetKind" <> 'FACT_VERSION'
      AND num_nonnulls(feedback_event."factId", feedback_event."factVersionId") <> 0)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback event must match its immutable signal';
  END IF;
  IF NEW."modelRunMemoryItemId" IS NOT NULL THEN
    SELECT * INTO target_item FROM "ModelRunMemoryItem"
    WHERE "userId" = NEW."userId" AND "id" = NEW."modelRunMemoryItemId";
    IF NOT FOUND
      OR target_item."bindingId" NOT IN (
        SELECT binding."id" FROM "ModelRunMemoryBinding" AS binding
        WHERE binding."userId" = NEW."userId"
          AND binding."modelRunId" = NEW."modelRunId"
      )
      OR (NEW."targetKind" = 'FACT_VERSION'
        AND target_item."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId")
      OR (NEW."targetKind" = 'RECALL_CHUNK'
        AND target_item."recallChunkId" IS DISTINCT FROM NEW."recallChunkId")
      OR (NEW."targetKind" = 'RECALL_ROUND'
        AND target_item."recallRoundId" IS DISTINCT FROM NEW."recallRoundId")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback run item must match its same-owner target';
    END IF;
  END IF;
  IF NEW."modelRunToolCallId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ModelRunToolCall" AS tool_call
    WHERE tool_call."modelRunId" = NEW."modelRunId"
      AND tool_call."id" = NEW."modelRunToolCallId"
      AND tool_call."toolName" = 'mark_memory_incorrect'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback tool provenance must name mark_memory_incorrect';
  END IF;
  IF NEW."feedbackType" = 'RETRACT' THEN
    SELECT * INTO retracted FROM "MemoryFeedback"
    WHERE "userId" = NEW."userId" AND "id" = NEW."retractsFeedbackId";
    IF NOT FOUND
      OR retracted."feedbackType" = 'RETRACT'
      OR retracted."contentPurgedAt" IS NOT NULL
      OR retracted."targetKind" IS DISTINCT FROM NEW."targetKind"
      OR retracted."memoryFactId" IS DISTINCT FROM NEW."memoryFactId"
      OR retracted."memoryFactVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
      OR retracted."recallChunkId" IS DISTINCT FROM NEW."recallChunkId"
      OR retracted."recallRoundId" IS DISTINCT FROM NEW."recallRoundId"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback retraction must match one live same-owner signal';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_recall_round_source(
  p_user_id text,
  p_chat_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  chat_row "Chat"%ROWTYPE;
  checkpoint_row "ChatMemoryCheckpoint"%ROWTYPE;
  current_leaf_in_pause boolean := FALSE;
BEGIN
  SELECT * INTO chat_row FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO checkpoint_row FROM "ChatMemoryCheckpoint"
  WHERE "userId" = p_user_id AND "chatId" = p_chat_id;
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
    SELECT 1 FROM "MemoryRecallRound" AS round
    WHERE round."userId" = p_user_id AND round."chatId" = p_chat_id
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR round."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR checkpoint_row."chatId" IS NULL
        OR checkpoint_row."status" <> 'READY'::"MemoryHistoryCheckpointStatus"
        OR checkpoint_row."pipelineVersion" <> 'memory-history-incremental-v5'
        OR checkpoint_row."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR checkpoint_row."lastIndexedMessageId" IS DISTINCT FROM
          checkpoint_row."activeLeafMessageId"
        OR ((checkpoint_row."sourceRevision" <> chat_row."memorySourceRevision"
          OR checkpoint_row."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId")
          AND NOT current_leaf_in_pause)
        OR NOT EXISTS (
          SELECT 1 FROM "MemoryRecallChunk" AS parent
          WHERE parent."userId" = round."userId"
            AND parent."chatId" = round."chatId"
            AND parent."id" = round."parentChunkId"
            AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
        )
        OR NOT EXISTS (
          SELECT 1 FROM "MemoryRecallRoundMessage" AS source_map
          WHERE source_map."userId" = round."userId"
            AND source_map."chatId" = round."chatId"
            AND source_map."roundId" = round."id"
        )
        OR EXISTS (
          SELECT 1 FROM "MemoryRecallRoundMessage" AS source_map
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
              OR source_message."updatedAt" <> source_map."sourceMessageUpdatedAt"
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
                SELECT 1 FROM active_path WHERE active_path."id" = source_map."messageId"
              )
            )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory recall round must match the current eligible chat source';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_recall_round_source_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_source(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_source(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_source(NEW."userId", NEW."chatId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_source(OLD."userId", OLD."chatId");
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "MemoryRecallRound_permanent_chat_write_guard"
  BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryRecallRound"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();
CREATE CONSTRAINT TRIGGER "MemoryRecallRound_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallRound"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallRoundMessage_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallRoundMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();
CREATE CONSTRAINT TRIGGER "Chat_recall_round_source_guard"
  AFTER INSERT OR UPDATE ON "Chat"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();
CREATE CONSTRAINT TRIGGER "ChatMemoryCheckpoint_recall_round_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryCheckpoint"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();
CREATE CONSTRAINT TRIGGER "ChatMemoryCheckpointMessage_recall_round_source_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryCheckpointMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallChunk_round_source_guard"
  AFTER DELETE OR UPDATE ON "MemoryRecallChunk"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_source_trigger();

CREATE OR REPLACE FUNCTION public.aiqsa_memory_operational_counters_valid(
  p_counters JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT p_counters IS NULL OR (
    jsonb_typeof(p_counters) = 'object'
    AND pg_column_size(p_counters) <= 4096
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_counters) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY[
        'digestFullRebuild',
        'digestIncremental',
        'digestNoop',
        'digestSegmentsProcessed',
        'digestSourceChunksProcessed',
        'contextualProviderRequests',
        'contextualRoundsFallback',
        'contextualRoundsGenerated',
        'embeddingBatchItems',
        'embeddingFailedItems',
        'embeddingProviderRequests',
        'embeddingSettledItems',
        'embeddingStaleItems',
        'historyChunksBuilt',
        'historyChunksReplaced',
        'historyChunksReused',
        'historyMessageContentRowsLoaded',
        'historyMessagesProjected',
        'historyModelRunRowsLoaded',
        'historyPathMetadataRowsRead',
        'historyRoundsBuilt',
        'historyRoundsReplaced',
        'historyRoundsReused'
      ]::TEXT[])
        OR jsonb_typeof(entry.value) <> 'number'
        OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$'
        OR (entry.value #>> '{}')::NUMERIC > 2147483647
    )
  );
$function$;
