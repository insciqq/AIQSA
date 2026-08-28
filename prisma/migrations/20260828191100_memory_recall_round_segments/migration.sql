ALTER TABLE "MemoryIndexGeneration"
  ADD COLUMN "roundSegmentProjectionVersion" VARCHAR(64);

CREATE TABLE "MemoryRecallRoundSegment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "evidenceRootHash" CHAR(64) NOT NULL,
  "segmentOrdinal" INTEGER NOT NULL,
  "position" VARCHAR(16) NOT NULL,
  "rawStartOffsetUtf16" INTEGER NOT NULL,
  "rawEndOffsetUtf16" INTEGER NOT NULL,
  "rawSafeText" TEXT NOT NULL,
  "rawSafeTextHash" CHAR(64) NOT NULL,
  "contextualNarrativeText" TEXT NOT NULL,
  "contextualSearchText" TEXT NOT NULL,
  "contextualSearchHash" CHAR(64) NOT NULL,
  "contextualKeyState" VARCHAR(32) NOT NULL,
  "supportingRoundIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "occurredFrom" TIMESTAMP(3) NOT NULL,
  "occurredTo" TIMESTAMP(3) NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "approxTokens" INTEGER NOT NULL,
  "projectionVersion" VARCHAR(64) NOT NULL,
  "contextualKeyPolicyVersion" VARCHAR(64) NOT NULL,
  "sourceRevisionAtCreation" INTEGER NOT NULL,
  "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
  "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "redactionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryRecallRoundSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryRecallRoundSegment_shape_check" CHECK (
    "evidenceRootHash" ~ '^[a-f0-9]{64}$'
    AND "segmentOrdinal" BETWEEN 0 AND 79
    AND "position" IN ('SINGLE', 'PREFIX', 'MIDDLE', 'SUFFIX')
    AND "rawStartOffsetUtf16" >= 0
    AND "rawEndOffsetUtf16" > "rawStartOffsetUtf16"
    AND "rawEndOffsetUtf16" - "rawStartOffsetUtf16" <= 4000
    AND char_length("rawSafeText") BETWEEN 1 AND 4000
    AND char_length("rawSafeText") <=
      "rawEndOffsetUtf16" - "rawStartOffsetUtf16"
    AND "rawSafeTextHash" ~ '^[a-f0-9]{64}$'
    AND char_length("contextualNarrativeText") <= 1000
    AND char_length("contextualSearchText") BETWEEN 1 AND 4000
    AND "contextualSearchHash" ~ '^[a-f0-9]{64}$'
    AND "contextualKeyState" IN ('GENERATED', 'RAW_FALLBACK')
    AND cardinality("supportingRoundIds") <= 2
    AND char_length(array_to_string("supportingRoundIds", ',')) <= 129
    AND array_position("supportingRoundIds", NULL) IS NULL
    AND array_to_string("supportingRoundIds", ',') ~
      '^([a-f0-9]{64}(,[a-f0-9]{64})?)?$'
    AND "occurredTo" >= "occurredFrom"
    AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
    AND "approxTokens" BETWEEN 1 AND 200000
    AND "projectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
    AND "contextualKeyPolicyVersion" ~ '^[A-Za-z0-9._:-]{1,64}$'
    AND "sourceRevisionAtCreation" >= 0
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

CREATE UNIQUE INDEX "MemoryRecallRoundSegment_userId_id_key"
  ON "MemoryRecallRoundSegment"("userId", "id");
CREATE UNIQUE INDEX "MemoryRecallRoundSegment_userId_id_roundId_key"
  ON "MemoryRecallRoundSegment"("userId", "id", "roundId");
CREATE UNIQUE INDEX "MemoryRecallRoundSegment_user_chat_round_id_key"
  ON "MemoryRecallRoundSegment"("userId", "chatId", "roundId", "id");
CREATE UNIQUE INDEX "MemoryRecallRoundSegment_source_ordinal_key"
  ON "MemoryRecallRoundSegment"(
    "userId", "roundId", "projectionVersion", "segmentOrdinal"
  );
CREATE INDEX "MemoryRecallRoundSegment_user_chat_state_revision_idx"
  ON "MemoryRecallRoundSegment"(
    "userId", "chatId", "state", "sourceRevisionAtCreation"
  );
CREATE INDEX "MemoryRecallRoundSegment_user_round_state_ordinal_idx"
  ON "MemoryRecallRoundSegment"("userId", "roundId", "state", "segmentOrdinal");
CREATE INDEX "MemoryRecallRoundSegment_user_evidence_root_state_idx"
  ON "MemoryRecallRoundSegment"("userId", "evidenceRootHash", "state");

CREATE TABLE "MemoryRecallRoundSegmentMessage" (
  "userId" TEXT NOT NULL,
  "segmentId" TEXT NOT NULL,
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
  "segmentStartOffset" INTEGER NOT NULL,
  "segmentEndOffset" INTEGER NOT NULL,
  CONSTRAINT "MemoryRecallRoundSegmentMessage_pkey"
    PRIMARY KEY ("segmentId", "messageId"),
  CONSTRAINT "MemoryRecallRoundSegmentMessage_shape_check" CHECK (
    "ordinal" >= 0
    AND "role" IN ('user', 'assistant', 'tool')
    AND "safeTextHash" ~ '^[a-f0-9]{64}$'
    AND "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
    AND "sourceStartOffset" >= 0
    AND "sourceEndOffset" > "sourceStartOffset"
    AND "segmentStartOffset" >= 0
    AND "segmentEndOffset" > "segmentStartOffset"
    AND "sourceEndOffset" - "sourceStartOffset" =
      "segmentEndOffset" - "segmentStartOffset"
  )
);
CREATE UNIQUE INDEX "MemoryRecallRoundSegmentMessage_segment_ordinal_key"
  ON "MemoryRecallRoundSegmentMessage"("segmentId", "ordinal");
CREATE INDEX "MemoryRecallRoundSegmentMessage_user_chat_message_idx"
  ON "MemoryRecallRoundSegmentMessage"("userId", "chatId", "messageId");
CREATE INDEX "MemoryRecallRoundSegmentMessage_user_round_segment_idx"
  ON "MemoryRecallRoundSegmentMessage"("userId", "roundId", "segmentId");
CREATE UNIQUE INDEX "MemoryRecallRoundMessage_user_chat_round_message_key"
  ON "MemoryRecallRoundMessage"("userId", "chatId", "roundId", "messageId");

ALTER TABLE "MemoryRecallRoundSegment"
  ADD CONSTRAINT "MemoryRecallRoundSegment_round_fkey"
  FOREIGN KEY ("userId", "chatId", "roundId")
  REFERENCES "MemoryRecallRound"("userId", "chatId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRecallRoundSegmentMessage"
  ADD CONSTRAINT "MemoryRecallRoundSegmentMessage_segment_fkey"
  FOREIGN KEY ("userId", "chatId", "roundId", "segmentId")
  REFERENCES "MemoryRecallRoundSegment"("userId", "chatId", "roundId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryRecallRoundSegmentMessage_round_message_fkey"
  FOREIGN KEY ("userId", "chatId", "roundId", "messageId")
  REFERENCES "MemoryRecallRoundMessage"("userId", "chatId", "roundId", "messageId")
  ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry"
  ADD COLUMN "recallRoundSegmentId" TEXT;
ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD COLUMN "recallRoundSegmentId" TEXT;
ALTER TABLE "ModelRunMemoryItem"
  ADD COLUMN "recallRoundSegmentId" TEXT;

CREATE INDEX "MemorySearchEntry_userId_recallRoundSegmentId_idx"
  ON "MemorySearchEntry"("userId", "recallRoundSegmentId");
CREATE UNIQUE INDEX "MemorySearchEntry_recall_round_segment_target_key"
  ON "MemorySearchEntry"("userId", "indexGenerationId", "recallRoundSegmentId")
  WHERE "itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType";
CREATE INDEX "MemoryRetrievalAttemptItem_user_segment_idx"
  ON "MemoryRetrievalAttemptItem"("userId", "recallRoundSegmentId");
CREATE INDEX "ModelRunMemoryItem_user_segment_idx"
  ON "ModelRunMemoryItem"("userId", "recallRoundSegmentId");

ALTER TABLE "MemorySearchEntry"
  ADD CONSTRAINT "MemorySearchEntry_recall_round_segment_fkey"
  FOREIGN KEY ("userId", "recallRoundSegmentId", "recallRoundId")
  REFERENCES "MemoryRecallRoundSegment"("userId", "id", "roundId")
  ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_recall_round_segment_fkey"
  FOREIGN KEY ("userId", "recallRoundSegmentId", "recallRoundId")
  REFERENCES "MemoryRecallRoundSegment"("userId", "id", "roundId")
  ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_recall_round_segment_fkey"
  FOREIGN KEY ("userId", "recallRoundSegmentId", "recallRoundId")
  REFERENCES "MemoryRecallRoundSegment"("userId", "id", "roundId")
  ON UPDATE RESTRICT ON DELETE SET NULL ("recallRoundSegmentId");

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
      "roundSegmentProjectionVersion" IS NULL
      OR num_nonnulls("roundProjectionVersion", "contextualKeyPolicyVersion") = 2
        AND "roundSegmentProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
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
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND "recallRoundId" IS NOT NULL
      AND num_nonnulls(
        "factVersionId", "recallChunkId", "recallRoundSegmentId"
      ) = 0
      OR "itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
      AND num_nonnulls("recallRoundId", "recallRoundSegmentId") = 2
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
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
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
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
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

CREATE OR REPLACE FUNCTION public.aiqsa_memory_generation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF (
    NEW."userId", NEW."generation", NEW."indexMode", NEW."sourceIndexGenerationId",
    NEW."targetMemoryRevision", NEW."embeddingConnectionId",
    NEW."embeddingProviderModelId", NEW."embeddingConfigurationFingerprint",
    NEW."embeddingDimension", NEW."vectorSpaceFingerprint", NEW."languageProfile",
    NEW."normalizationVersion", NEW."chunkingVersion",
    NEW."roundProjectionVersion", NEW."roundSegmentProjectionVersion",
    NEW."contextualKeyPolicyVersion", NEW."retrievalPipelineVersion"
  ) IS DISTINCT FROM (
    OLD."userId", OLD."generation", OLD."indexMode", OLD."sourceIndexGenerationId",
    OLD."targetMemoryRevision", OLD."embeddingConnectionId",
    OLD."embeddingProviderModelId", OLD."embeddingConfigurationFingerprint",
    OLD."embeddingDimension", OLD."vectorSpaceFingerprint", OLD."languageProfile",
    OLD."normalizationVersion", OLD."chunkingVersion",
    OLD."roundProjectionVersion", OLD."roundSegmentProjectionVersion",
    OLD."contextualKeyPolicyVersion", OLD."retrievalPipelineVersion"
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
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item identity and source generation are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_recall_round_segment(
  p_user_id text,
  p_round_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallRoundSegment" AS segment
    LEFT JOIN "MemoryRecallRound" AS round
      ON round."userId" = segment."userId"
      AND round."chatId" = segment."chatId"
      AND round."id" = segment."roundId"
    WHERE segment."userId" = p_user_id
      AND segment."roundId" = p_round_id
      AND segment."state" IN (
        'ACTIVE'::"MemoryHistoryItemState",
        'SUPPRESSED'::"MemoryHistoryItemState"
      )
      AND (
        round."id" IS NULL
        OR round."state" IS DISTINCT FROM segment."state"
        OR round."evidenceRootHash" IS DISTINCT FROM segment."evidenceRootHash"
        OR round."sourceRevisionAtCreation" IS DISTINCT FROM
          segment."sourceRevisionAtCreation"
        OR round."contextualKeyPolicyVersion" IS DISTINCT FROM
          segment."contextualKeyPolicyVersion"
        OR round."safetyClass" IS DISTINCT FROM segment."safetyClass"
        OR round."redactionState" IS DISTINCT FROM segment."redactionState"
        OR round."redactionReasonCodes" IS DISTINCT FROM
          segment."redactionReasonCodes"
        OR NOT EXISTS (
          SELECT 1 FROM "MemoryRecallRoundSegmentMessage" AS source_map
          WHERE source_map."userId" = segment."userId"
            AND source_map."roundId" = segment."roundId"
            AND source_map."segmentId" = segment."id"
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Published Memory recall round segment must match its parent and source map';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_recall_round_segment_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryRecallRound' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_segment(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_segment(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_segment(NEW."userId", NEW."roundId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_segment(OLD."userId", OLD."roundId");
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "MemoryRecallRound_segment_guard"
  AFTER DELETE OR UPDATE ON "MemoryRecallRound"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_segment_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallRoundSegment_parent_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallRoundSegment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_segment_trigger();
CREATE CONSTRAINT TRIGGER "MemoryRecallRoundSegmentMessage_parent_guard"
  AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallRoundSegmentMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_recall_round_segment_trigger();

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
        'historyRoundSegmentsBuilt',
        'historyRoundSegmentsReplaced',
        'historyRoundSegmentsReused',
        'historyRoundsBuilt',
        'historyRoundsReplaced',
        'historyRoundsReused',
        'contextualFallbackDuplicateStatement',
        'contextualFallbackEmptyStatements',
        'contextualFallbackHandleMismatch',
        'contextualFallbackNotEligible',
        'contextualFallbackProviderOutputInvalid',
        'contextualFallbackProviderUnavailable',
        'contextualFallbackSafetyRedactedOrRejected',
        'contextualFallbackSearchTextBudgetExceeded',
        'contextualFallbackSourceRefInvalid',
        'contextualFallbackStatementCountInvalid',
        'contextualFallbackStatementTooLong',
        'contextualFallbackUnsupportedDate',
        'contextualFallbackUnsupportedEntity',
        'contextualFallbackUnsupportedNumber',
        'contextualFallbackUnsupportedToken',
        'contextualFallbackEn',
        'contextualFallbackMixed',
        'contextualFallbackOther',
        'contextualFallbackRu',
        'contextualFallbackUnd',
        'contextualGeneratedEn',
        'contextualGeneratedMixed',
        'contextualGeneratedOther',
        'contextualGeneratedRu',
        'contextualGeneratedUnd',
        'synthesisClusterCount',
        'synthesisEligibleSourceCount',
        'synthesisEmptyOutputCount',
        'synthesisProposalCount'
      ]::TEXT[])
        OR jsonb_typeof(entry.value) <> 'number'
        OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$'
        OR (entry.value #>> '{}')::NUMERIC > 2147483647
    )
  );
$function$;

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
      AND num_nonnulls(
        "recallChunkId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      AND ("factVersionId" IS NULL OR "exactItemId" = "factVersionId")
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND num_nonnulls(
        "factVersionId", "recallRoundId", "recallRoundSegmentId"
      ) = 0
      AND ("recallChunkId" IS NULL OR "exactItemId" = "recallChunkId")
      AND num_nonnulls(
        "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot"
      ) = 4
      OR "itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND num_nonnulls("factVersionId", "recallChunkId") = 0
      AND ("recallRoundId" IS NULL OR "exactItemId" = "recallRoundId")
      AND ("recallRoundId" IS NOT NULL OR "recallRoundSegmentId" IS NULL)
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
