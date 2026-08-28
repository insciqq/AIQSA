ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v7';

DO $migration$
DECLARE
  function_definition text;
BEGIN
  function_definition := pg_get_functiondef(
    'aiqsa_memory_assert_recall_round_source(text,text)'::regprocedure
  );
  IF position('memory-history-incremental-v5' IN function_definition) > 0 THEN
    function_definition := replace(
      function_definition,
      '''memory-history-incremental-v5''',
      '''memory-history-incremental-v7'''
    );
    EXECUTE function_definition;
  ELSIF position('memory-history-incremental-v7' IN function_definition) = 0
    AND position('"pipelineVersion"' IN function_definition) > 0 THEN
    -- The stable-prefix guard intentionally has no checkpoint-pipeline
    -- dependency. Reject only an unexpected version-bound definition.
    RAISE EXCEPTION 'Memory recall-round source guard v7 extension failed';
  END IF;
END;
$migration$;

CREATE TABLE "MemoryToolEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "modelRunToolCallId" TEXT NOT NULL,
  "assistantMessageId" TEXT NOT NULL,
  "sourceFolderId" TEXT,
  "sourceAssistantId" TEXT,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "sourceCallUpdatedAtAtCreation" TIMESTAMP(3) NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "operation" VARCHAR(256) NOT NULL,
  "outcome" "MemoryToolEventOutcome" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "safeProjectedText" TEXT NOT NULL,
  "normalizedSafeSearchText" TEXT NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "structuredIdentifiers" JSONB NOT NULL DEFAULT '{}',
  "sourcePayloadHash" CHAR(64) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "evidenceRootHash" CHAR(64) NOT NULL,
  "projectionVersion" VARCHAR(64) NOT NULL,
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "redactionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryToolEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryToolEvent_shape_check" CHECK (
    "branchGeneration" >= 0
    AND "sourceRevisionAtCreation" >= 0
    AND char_length("toolName") BETWEEN 1 AND 128
    AND "toolName" !~ '[[:cntrl:]]'
    AND char_length("operation") BETWEEN 1 AND 256
    AND "operation" !~ '[[:cntrl:]]'
    AND char_length("safeProjectedText") BETWEEN 1 AND 2000
    AND char_length("normalizedSafeSearchText") BETWEEN 1 AND 4000
    AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
    AND jsonb_typeof("structuredIdentifiers") = 'object'
    AND pg_column_size("structuredIdentifiers") <= 4096
    AND "sourcePayloadHash" ~ '^[a-f0-9]{64}$'
    AND "contentHash" ~ '^[a-f0-9]{64}$'
    AND "evidenceRootHash" ~ '^[a-f0-9]{64}$'
    AND "projectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND cardinality("redactionReasonCodes") <= 16
    AND char_length(array_to_string("redactionReasonCodes", ',')) <= 1024
    AND array_to_string("redactionReasonCodes", ',') ~ '^[A-Za-z0-9._,-]*$'
    AND (
      "redactionState" = 'NOT_NEEDED'::"MemoryRedactionState"
        AND cardinality("redactionReasonCodes") = 0
      OR "redactionState" = 'REDACTED'::"MemoryRedactionState"
        AND cardinality("redactionReasonCodes") > 0
    )
    AND "safetyClass" IN (
      'NORMAL'::"MemoryDerivedSafetyClass",
      'SENSITIVE'::"MemoryDerivedSafetyClass"
    )
    AND (
      "state" = 'ACTIVE'::"MemoryHistoryItemState" AND "invalidatedAt" IS NULL
      OR "state" = 'INVALIDATED'::"MemoryHistoryItemState"
        AND "invalidatedAt" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "MemoryToolEvent_userId_id_key"
  ON "MemoryToolEvent"("userId", "id");
CREATE UNIQUE INDEX "MemoryToolEvent_userId_chatId_id_key"
  ON "MemoryToolEvent"("userId", "chatId", "id");
CREATE INDEX "MemoryToolEvent_userId_chatId_state_occurredAt_idx"
  ON "MemoryToolEvent"("userId", "chatId", "state", "occurredAt");
CREATE INDEX "MemoryToolEvent_userId_modelRunToolCallId_state_idx"
  ON "MemoryToolEvent"("userId", "modelRunToolCallId", "state");
CREATE INDEX "MemoryToolEvent_userId_evidenceRootHash_state_idx"
  ON "MemoryToolEvent"("userId", "evidenceRootHash", "state");
CREATE INDEX "MemoryToolEvent_chatId_assistantMessageId_idx"
  ON "MemoryToolEvent"("chatId", "assistantMessageId");
CREATE INDEX "MemoryToolEvent_modelRunId_modelRunToolCallId_idx"
  ON "MemoryToolEvent"("modelRunId", "modelRunToolCallId");
CREATE INDEX "ModelRunToolCall_updatedAt_id_idx"
  ON "ModelRunToolCall"("updatedAt", "id");
CREATE UNIQUE INDEX "MemoryToolEvent_active_call_key"
  ON "MemoryToolEvent"("userId", "modelRunToolCallId")
  WHERE "state" = 'ACTIVE'::"MemoryHistoryItemState";

ALTER TABLE "MemoryToolEvent"
  ADD CONSTRAINT "MemoryToolEvent_chat_fkey"
  FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryToolEvent_assistant_message_fkey"
  FOREIGN KEY ("chatId", "assistantMessageId")
  REFERENCES "Message"("chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryToolEvent_model_run_fkey"
  FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryToolEvent_tool_call_fkey"
  FOREIGN KEY ("modelRunId", "modelRunToolCallId")
  REFERENCES "ModelRunToolCall"("modelRunId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry" ADD COLUMN "toolEventId" TEXT;
ALTER TABLE "MemoryRetrievalAttemptItem" ADD COLUMN "toolEventId" TEXT;
ALTER TABLE "ModelRunMemoryItem" ADD COLUMN "toolEventId" TEXT;

CREATE INDEX "MemorySearchEntry_userId_toolEventId_idx"
  ON "MemorySearchEntry"("userId", "toolEventId");
CREATE UNIQUE INDEX "MemorySearchEntry_tool_event_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "toolEventId")
  WHERE "itemType" = 'TOOL_EVENT'::"MemorySearchItemType";
CREATE INDEX "MemoryRetrievalAttemptItem_user_tool_event_idx"
  ON "MemoryRetrievalAttemptItem"("userId", "toolEventId");
CREATE INDEX "ModelRunMemoryItem_user_tool_event_idx"
  ON "ModelRunMemoryItem"("userId", "toolEventId");
CREATE UNIQUE INDEX "ModelRunMemoryItem_binding_tool_event_key"
  ON "ModelRunMemoryItem"("userId", "bindingId", "toolEventId");

ALTER TABLE "MemorySearchEntry"
  ADD CONSTRAINT "MemorySearchEntry_tool_event_fkey"
  FOREIGN KEY ("userId", "toolEventId")
  REFERENCES "MemoryToolEvent"("userId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_tool_event_fkey"
  FOREIGN KEY ("userId", "toolEventId")
  REFERENCES "MemoryToolEvent"("userId", "id")
  ON UPDATE RESTRICT ON DELETE SET NULL ("toolEventId");
ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_tool_event_fkey"
  FOREIGN KEY ("userId", "toolEventId")
  REFERENCES "MemoryToolEvent"("userId", "id")
  ON UPDATE RESTRICT ON DELETE SET NULL ("toolEventId");

ALTER TABLE "MemorySearchEntry"
  DROP CONSTRAINT "MemorySearchEntry_shape_check",
  ADD CONSTRAINT "MemorySearchEntry_shape_check" CHECK (
    (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "factVersionId" IS NOT NULL
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND "recallRoundId" IS NOT NULL
      AND num_nonnulls(
        "factVersionId", "recallChunkId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      OR "itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
      AND num_nonnulls("recallRoundId", "recallRoundSegmentId") = 2
      AND num_nonnulls("factVersionId", "recallChunkId", "toolEventId") = 0
      OR "itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND "toolEventId" IS NOT NULL
      AND num_nonnulls(
        "factVersionId", "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
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
      AND "factVersionId" IS NOT NULL AND "exactItemId" = "factVersionId"
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      AND (
        num_nonnulls(
          "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
          "sourceRevisionSnapshot", "sourceContentHashSnapshot"
        ) IN (0, 4)
        OR num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot") = 2
          AND num_nonnulls("sourceRevisionSnapshot", "sourceContentHashSnapshot") = 0
      )
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL AND "exactItemId" = "recallChunkId"
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND "recallRoundId" IS NOT NULL AND "exactItemId" = "recallRoundId"
      AND num_nonnulls("factVersionId", "recallChunkId", "toolEventId") = 0
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND ("toolEventId" IS NULL OR "exactItemId" = "toolEventId")
      AND num_nonnulls(
        "factVersionId", "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
    )
    AND ("sourceBranchGenerationSnapshot" IS NULL
      OR "sourceBranchGenerationSnapshot" >= 0)
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

CREATE OR REPLACE FUNCTION public.aiqsa_memory_attempt_item_target_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."itemType" = 'TOOL_EVENT'
    AND NEW."toolEventId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Preparing Memory tool event requires its exact live target at insert';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."toolEventId" IS DISTINCT FROM OLD."toolEventId"
    AND NOT (OLD."toolEventId" IS NOT NULL AND NEW."toolEventId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Preparing Memory tool event target is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryRetrievalAttemptItem_target_guard"
BEFORE INSERT OR UPDATE ON "MemoryRetrievalAttemptItem"
FOR EACH ROW EXECUTE FUNCTION public.aiqsa_memory_attempt_item_target_guard();

ALTER TABLE "ModelRunMemoryItem"
  DROP CONSTRAINT "ModelRunMemoryItem_shape_check",
  ADD CONSTRAINT "ModelRunMemoryItem_shape_check" CHECK (
    "ordinal" >= 0
    AND char_length("exactItemId") BETWEEN 1 AND 256
    AND char_length("includedText") BETWEEN 1 AND 4000
    AND "finalScore" BETWEEN 0::double precision AND 1::double precision
    AND num_nonnulls(
      "factVersionId", "recallChunkId", "recallRoundId", "toolEventId"
    ) <= 1
    AND (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      AND ("factVersionId" IS NULL OR "exactItemId" = "factVersionId")
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId", "toolEventId"
      ) = 0
      AND ("recallChunkId" IS NULL OR "exactItemId" = "recallChunkId")
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND num_nonnulls("factVersionId", "recallChunkId", "toolEventId") = 0
      AND ("recallRoundId" IS NULL OR "exactItemId" = "recallRoundId")
      AND ("recallRoundId" IS NOT NULL OR "recallRoundSegmentId" IS NULL)
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND num_nonnulls(
        "factVersionId", "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      AND ("toolEventId" IS NULL OR "exactItemId" = "toolEventId")
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
    )
    AND ("sourceBranchGenerationSnapshot" IS NULL
      OR "sourceBranchGenerationSnapshot" >= 0)
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

CREATE OR REPLACE FUNCTION public.aiqsa_memory_model_run_item_target_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."itemType" = 'FACT_VERSION' AND NEW."factVersionId" IS NULL
    OR NEW."itemType" = 'RECALL_CHUNK' AND NEW."recallChunkId" IS NULL
    OR NEW."itemType" = 'RECALL_ROUND' AND NEW."recallRoundId" IS NULL
    OR NEW."itemType" = 'TOOL_EVENT' AND NEW."toolEventId" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item requires its exact live target at insert';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."exactItemId" IS DISTINCT FROM OLD."exactItemId"
    OR NEW."itemType" IS DISTINCT FROM OLD."itemType"
    OR NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot"
    OR NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM
      OLD."sourceBranchGenerationSnapshot"
    OR NEW."sourceRevisionSnapshot" IS DISTINCT FROM OLD."sourceRevisionSnapshot"
    OR NEW."sourceContentHashSnapshot" IS DISTINCT FROM OLD."sourceContentHashSnapshot"
    OR (NEW."factVersionId" IS DISTINCT FROM OLD."factVersionId"
      AND NOT (OLD."factVersionId" IS NOT NULL AND NEW."factVersionId" IS NULL))
    OR (NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId"
      AND NOT (OLD."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS NULL))
    OR (NEW."recallRoundId" IS DISTINCT FROM OLD."recallRoundId"
      AND NOT (OLD."recallRoundId" IS NOT NULL AND NEW."recallRoundId" IS NULL))
    OR (NEW."recallRoundSegmentId" IS DISTINCT FROM OLD."recallRoundSegmentId"
      AND NOT (OLD."recallRoundSegmentId" IS NOT NULL
        AND NEW."recallRoundSegmentId" IS NULL))
    OR (NEW."toolEventId" IS DISTINCT FROM OLD."toolEventId"
      AND NOT (OLD."toolEventId" IS NOT NULL AND NEW."toolEventId" IS NULL))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item identity and source generation are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_tool_event_source(
  p_user_id text,
  p_event_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryToolEvent" AS event
    LEFT JOIN "Chat" AS chat
      ON chat."userId" = event."userId" AND chat."id" = event."chatId"
    LEFT JOIN "ModelRun" AS run
      ON run."userId" = event."userId" AND run."id" = event."modelRunId"
    LEFT JOIN "ModelRunToolCall" AS call
      ON call."modelRunId" = event."modelRunId"
      AND call."id" = event."modelRunToolCallId"
    LEFT JOIN "Message" AS message
      ON message."chatId" = event."chatId"
      AND message."id" = event."assistantMessageId"
    LEFT JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = event."userId"
      AND checkpoint."chatId" = event."chatId"
    WHERE event."userId" = p_user_id AND event."id" = p_event_id
      AND event."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat."id" IS NULL OR chat."projectId" IS NOT NULL
        OR chat."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR chat."permanentDeletionAt" IS NOT NULL
        OR chat."memoryBranchGeneration" <> event."branchGeneration"
        OR chat."memorySourceRevision" <> event."sourceRevisionAtCreation"
        OR run."id" IS NULL OR run."chatId" <> event."chatId"
        OR run."assistantMessageId" IS DISTINCT FROM event."assistantMessageId"
        OR run."status" <> 'complete'::"ModelRunStatus"
        OR call."id" IS NULL
        OR call."state" NOT IN (
          'complete'::"ModelRunToolCallState", 'error'::"ModelRunToolCallState"
        )
        OR call."completedAt" IS DISTINCT FROM event."occurredAt"
        OR call."updatedAt" IS DISTINCT FROM event."sourceCallUpdatedAtAtCreation"
        OR message."id" IS NULL OR message."role" <> 'assistant'
        OR message."status" <> 'complete'::"MessageStatus"
        OR checkpoint."status" <> 'READY'::"MemoryHistoryCheckpointStatus"
        OR checkpoint."pipelineVersion" <> 'memory-history-incremental-v7'
        OR checkpoint."branchGeneration" <> event."branchGeneration"
        OR checkpoint."sourceRevision" <> event."sourceRevisionAtCreation"
        OR NOT EXISTS (
          SELECT 1 FROM "ChatMemoryCheckpointMessage" AS source_message
          WHERE source_message."userId" = event."userId"
            AND source_message."chatId" = event."chatId"
            AND source_message."messageId" = event."assistantMessageId"
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory tool event requires one current settled personal source';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_tool_event_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM public.aiqsa_memory_assert_tool_event_source(NEW."userId", NEW."id");
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER "MemoryToolEvent_source_guard"
AFTER INSERT OR UPDATE ON "MemoryToolEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.aiqsa_memory_tool_event_source_guard();
