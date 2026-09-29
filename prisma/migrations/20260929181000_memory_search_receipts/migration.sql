-- Native read-only Memory search reuses the private MemoryHistoryRun receipt.
-- Keep the old receipt shape for accepted runs while admitting at most three
-- bounded native calls, including a degraded result that still carries evidence.
ALTER TABLE "MemoryHistoryRun"
  ADD COLUMN "receiptVersion" VARCHAR(32);

ALTER TABLE "MemoryHistoryRun"
  DROP CONSTRAINT "MemoryHistoryRun_shape_check";

ALTER TABLE "MemoryHistoryRun"
  ADD CONSTRAINT "MemoryHistoryRun_shape_check" CHECK (
    ("receiptVersion" IS NULL OR "receiptVersion" = 'memory-search-v1')
    AND "queryHash" ~ '^[a-f0-9]{64}$'
    AND pg_column_size("privateRequest") <= 16384
    AND pg_column_size("indexingEvidence") <= 16384
    AND ("providerResult" IS NULL OR pg_column_size("providerResult") <= 262144)
    AND ("resultHash" IS NULL OR "resultHash" ~ '^[a-f0-9]{64}$')
    AND ("durationMs" IS NULL OR "durationMs" >= 0)
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9._-]{1,128}$')
    AND array_to_string("executionBindingIds", ',') !~ '[[:cntrl:]]'
    AND (
      ("receiptVersion" IS NOT NULL AND "receiptVersion" = 'memory-search-v1'
      AND ("retentionState" = 'SCRUBBED' OR
        "privateRequest" ->> 'version' IS NOT DISTINCT FROM 'memory-search-v1')
      AND "invocationOrdinal" BETWEEN 1 AND 3
      AND "resultCount" BETWEEN 0 AND 30
      AND "executionBindingIds" IS NOT NULL
      AND cardinality("executionBindingIds") <= 32
      AND char_length(array_to_string("executionBindingIds", ',')) <= 16384
      AND (results IS NULL OR pg_column_size(results) <= 524288)
      AND ("retentionState" = 'RETAINED' AND query IS NOT NULL
        AND char_length(query) BETWEEN 1 AND 2000 AND "plaintextPurgedAt" IS NULL
        OR "retentionState" = 'SCRUBBED' AND query IS NULL
        AND "privateRequest" = '{}'::jsonb AND results IS NULL
        AND "providerResult" IS NULL AND "plaintextPurgedAt" IS NOT NULL)
      AND ("retentionState" = 'SCRUBBED' OR
        state <> 'COMPLETE' OR
        results ->> 'version' IS NOT DISTINCT FROM 'memory-search-v1')
      AND (
        state = 'RUNNING' AND outcome IS NULL AND "completedAt" IS NULL
          AND "durationMs" IS NULL AND "errorCode" IS NULL AND results IS NULL
          AND "providerResult" IS NULL AND "resultHash" IS NULL AND "resultCount" = 0
        OR state = 'COMPLETE' AND outcome IN ('RESULTS', 'EMPTY', 'DEGRADED')
          AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL
          AND "errorCode" IS NULL
          AND ("retentionState" = 'SCRUBBED' OR results IS NOT NULL
            AND "providerResult" IS NOT NULL AND "resultHash" IS NOT NULL)
          AND ("retentionState" = 'SCRUBBED' OR
            CASE WHEN jsonb_typeof(results -> 'results') = 'array'
              THEN jsonb_array_length(results -> 'results') = "resultCount"
              ELSE false END)
          AND (outcome = 'RESULTS' AND "resultCount" > 0
            OR outcome = 'EMPTY' AND "resultCount" = 0
            OR outcome = 'DEGRADED')
        OR state IN ('ERROR', 'CANCELLED') AND outcome = 'FAILED'
          AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL
          AND "errorCode" IS NOT NULL
          AND ("retentionState" = 'SCRUBBED' OR "providerResult" IS NOT NULL
            AND "resultHash" IS NOT NULL)
      ))
      OR ("receiptVersion" IS NULL
        AND "invocationOrdinal" BETWEEN 1 AND 2
      AND "resultCount" BETWEEN 0 AND 20
      AND cardinality("executionBindingIds") <= 8
      AND char_length(array_to_string("executionBindingIds", ',')) <= 4096
      AND (results IS NULL OR pg_column_size(results) <= 131072)
      AND ("retentionState" = 'RETAINED' AND query IS NOT NULL
        AND char_length(query) BETWEEN 1 AND 500 AND "plaintextPurgedAt" IS NULL
        OR "retentionState" = 'SCRUBBED' AND query IS NULL
        AND "privateRequest" = '{}'::jsonb AND results IS NULL
        AND "providerResult" IS NULL AND "plaintextPurgedAt" IS NOT NULL)
      AND (
        state = 'RUNNING' AND outcome IS NULL AND "completedAt" IS NULL
          AND "durationMs" IS NULL AND "errorCode" IS NULL AND results IS NULL
          AND "providerResult" IS NULL AND "resultHash" IS NULL AND "resultCount" = 0
        OR state = 'COMPLETE' AND outcome IN ('RESULTS', 'EMPTY', 'DISABLED', 'DEGRADED')
          AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL
          AND "errorCode" IS NULL
          AND ("retentionState" = 'SCRUBBED' OR results IS NOT NULL
            AND "providerResult" IS NOT NULL AND "resultHash" IS NOT NULL)
          AND (outcome = 'RESULTS') = ("resultCount" > 0)
        OR state IN ('ERROR', 'CANCELLED') AND outcome = 'FAILED'
          AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL
          AND "errorCode" IS NOT NULL
          AND ("retentionState" = 'SCRUBBED' OR "providerResult" IS NOT NULL
            AND "resultHash" IS NOT NULL)
      )
    ))
  );

-- A source action may cite native search only after exact retained evidence was
-- delivered on the same owner's settled tool call. Historical tool feedback
-- keeps its original provenance rule.
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
      AND (
        tool_call."toolName" = 'mark_memory_incorrect'
        OR tool_call."toolName" = 'memory_search'
          AND tool_call."state" = 'complete'
          AND EXISTS (
            SELECT 1 FROM "MemoryHistoryRun" AS receipt
            WHERE receipt."userId" = NEW."userId"
              AND receipt."modelRunId" = NEW."modelRunId"
              AND receipt."modelRunToolCallId" = NEW."modelRunToolCallId"
              AND receipt."receiptVersion" = 'memory-search-v1'
              AND receipt."state" = 'COMPLETE'
              AND receipt."retentionState" = 'RETAINED'
              AND receipt."plaintextPurgedAt" IS NULL
              AND receipt."indexingEvidence" ->> 'delivered' = 'true'
              AND receipt."results" ->> 'version' = 'memory-search-v1'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(receipt."results" -> 'results') = 'array'
                    THEN receipt."results" -> 'results' ELSE '[]'::jsonb END
                ) AS evidence(item)
                WHERE CASE NEW."targetKind"
                  WHEN 'FACT_VERSION' THEN
                    evidence.item ->> 'itemType' = 'FACT_VERSION'
                    AND evidence.item ->> 'factVersionId' = NEW."memoryFactVersionId"
                    AND evidence.item ->> 'exactItemId' = NEW."memoryFactVersionId"
                    AND EXISTS (
                      SELECT 1 FROM "MemoryFactVersion" AS version
                      WHERE version."userId" = NEW."userId"
                        AND version."id" = NEW."memoryFactVersionId"
                        AND version."factId" = NEW."memoryFactId"
                    )
                  WHEN 'RECALL_CHUNK' THEN
                    evidence.item ->> 'itemType' = 'RECALL_CHUNK'
                    AND evidence.item ->> 'recallChunkId' = NEW."recallChunkId"
                    AND evidence.item ->> 'exactItemId' = NEW."recallChunkId"
                  WHEN 'RECALL_ROUND' THEN
                    evidence.item ->> 'itemType' = 'RECALL_ROUND'
                    AND evidence.item ->> 'recallRoundId' = NEW."recallRoundId"
                    AND evidence.item ->> 'exactItemId' = NEW."recallRoundId"
                  ELSE false END
              )
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback tool provenance lacks delivered target evidence';
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
