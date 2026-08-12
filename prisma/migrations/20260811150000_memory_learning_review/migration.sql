-- Private user feedback is an append-only signal. It may later inform bounded
-- learning policy, but it never grants fact-transition authority by itself.
BEGIN;

CREATE TYPE "MemoryFeedbackType" AS ENUM (
  'CORRECT', 'INCORRECT', 'NOT_USEFUL', 'WRONG_SCOPE',
  'OUTDATED', 'TOO_SENSITIVE', 'RETRACT'
);

CREATE TYPE "MemoryFeedbackTargetKind" AS ENUM (
  'FACT_VERSION', 'EPISODE', 'RECALL_CHUNK'
);

CREATE TABLE "MemoryFeedback" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyFingerprint" VARCHAR(128) NOT NULL,
  "requestId" VARCHAR(256) NOT NULL,
  "feedbackType" "MemoryFeedbackType" NOT NULL,
  "targetKind" "MemoryFeedbackTargetKind" NOT NULL,
  "memoryFactId" TEXT,
  "memoryFactVersionId" TEXT,
  "episodeId" TEXT,
  "recallChunkId" TEXT,
  "modelRunId" TEXT,
  "modelRunMemoryItemId" TEXT,
  "modelRunToolCallId" TEXT,
  "sourceChatIdSnapshot" TEXT,
  "sourceBranchGenerationSnapshot" INTEGER,
  "comment" VARCHAR(1000),
  "retractsFeedbackId" TEXT,
  "memoryEventId" TEXT,
  "contentPurgedAt" TIMESTAMP(3),
  "purgeReason" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryFeedback_userId_id_key"
  ON "MemoryFeedback"("userId", "id");
CREATE UNIQUE INDEX "MemoryFeedback_userId_idempotencyFingerprint_key"
  ON "MemoryFeedback"("userId", "idempotencyFingerprint");
CREATE UNIQUE INDEX "MemoryFeedback_userId_retractsFeedbackId_key"
  ON "MemoryFeedback"("userId", "retractsFeedbackId");
CREATE INDEX "MemoryFeedback_userId_memoryFactId_memoryFactVersionId_createdAt_idx"
  ON "MemoryFeedback"("userId", "memoryFactId", "memoryFactVersionId", "createdAt");
CREATE INDEX "MemoryFeedback_userId_episodeId_createdAt_idx"
  ON "MemoryFeedback"("userId", "episodeId", "createdAt");
CREATE INDEX "MemoryFeedback_userId_recallChunkId_createdAt_idx"
  ON "MemoryFeedback"("userId", "recallChunkId", "createdAt");
CREATE INDEX "MemoryFeedback_userId_modelRunId_modelRunMemoryItemId_idx"
  ON "MemoryFeedback"("userId", "modelRunId", "modelRunMemoryItemId");
CREATE INDEX "MemoryFeedback_userId_modelRunId_modelRunToolCallId_idx"
  ON "MemoryFeedback"("userId", "modelRunId", "modelRunToolCallId");
CREATE INDEX "MemoryFeedback_userId_sourceChatIdSnapshot_createdAt_idx"
  ON "MemoryFeedback"("userId", "sourceChatIdSnapshot", "createdAt");

ALTER TABLE "MemoryFeedback"
  ADD CONSTRAINT "MemoryFeedback_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_fact_fkey"
    FOREIGN KEY ("userId", "memoryFactId")
    REFERENCES "MemoryFact"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_version_fkey"
    FOREIGN KEY ("userId", "memoryFactId", "memoryFactVersionId")
    REFERENCES "MemoryFactVersion"("userId", "factId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_episode_fkey"
    FOREIGN KEY ("userId", "episodeId")
    REFERENCES "MemoryEpisode"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_recall_chunk_fkey"
    FOREIGN KEY ("userId", "recallChunkId")
    REFERENCES "MemoryRecallChunk"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_run_fkey"
    FOREIGN KEY ("userId", "modelRunId")
    REFERENCES "ModelRun"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_run_item_fkey"
    FOREIGN KEY ("userId", "modelRunMemoryItemId")
    REFERENCES "ModelRunMemoryItem"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_run_tool_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId")
    REFERENCES "ModelRunToolCall"("modelRunId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_retracts_fkey"
    FOREIGN KEY ("userId", "retractsFeedbackId")
    REFERENCES "MemoryFeedback"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_event_fkey"
    FOREIGN KEY ("userId", "memoryEventId")
    REFERENCES "MemoryEvent"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFeedback_shape_check"
    CHECK (
      "idempotencyFingerprint" ~ '^[a-f0-9]{64}$'
      AND char_length("requestId") BETWEEN 1 AND 256
      AND ("comment" IS NULL OR (
        char_length("comment") BETWEEN 1 AND 1000
        AND btrim("comment") <> ''
      ))
      AND (
        (
          "contentPurgedAt" IS NULL
          AND "purgeReason" IS NULL
          AND "memoryEventId" IS NOT NULL
          AND (
            (
              "targetKind" = 'FACT_VERSION'
              AND num_nonnulls("memoryFactId", "memoryFactVersionId") = 2
              AND num_nonnulls("episodeId", "recallChunkId") = 0
            ) OR (
              "targetKind" = 'EPISODE'
              AND "episodeId" IS NOT NULL
              AND num_nonnulls("memoryFactId", "memoryFactVersionId", "recallChunkId") = 0
            ) OR (
              "targetKind" = 'RECALL_CHUNK'
              AND "recallChunkId" IS NOT NULL
              AND num_nonnulls("memoryFactId", "memoryFactVersionId", "episodeId") = 0
            )
          )
          AND (
            num_nonnulls("modelRunId", "modelRunMemoryItemId", "modelRunToolCallId") = 0
            OR (
              "modelRunId" IS NOT NULL
              AND num_nonnulls("modelRunMemoryItemId", "modelRunToolCallId") = 1
            )
          )
          AND (
            ("feedbackType" = 'RETRACT' AND "retractsFeedbackId" IS NOT NULL AND "comment" IS NULL)
            OR ("feedbackType" <> 'RETRACT' AND "retractsFeedbackId" IS NULL)
          )
        ) OR (
          "contentPurgedAt" IS NOT NULL
          AND "purgeReason" ~ '^[a-z][a-z0-9._-]{0,63}$'
          AND num_nonnulls(
            "memoryFactId", "memoryFactVersionId", "episodeId", "recallChunkId",
            "modelRunId", "modelRunMemoryItemId", "modelRunToolCallId",
            "sourceChatIdSnapshot",
            "sourceBranchGenerationSnapshot",
            "comment", "retractsFeedbackId", "memoryEventId"
          ) = 0
        )
      )
    );

CREATE FUNCTION aiqsa_memory_feedback_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_feedback_guard$
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
    OR (NEW."episodeId" IS NOT NULL AND NEW."episodeId" IS DISTINCT FROM OLD."episodeId")
    OR (NEW."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId")
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
END
$memory_feedback_guard$;

CREATE TRIGGER "MemoryFeedback_append_only_guard"
BEFORE UPDATE ON "MemoryFeedback"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_feedback_guard();

CREATE FUNCTION aiqsa_memory_feedback_target_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_feedback_target_guard$
DECLARE
  feedback_event "MemoryEvent"%ROWTYPE;
  target_item "ModelRunMemoryItem"%ROWTYPE;
  retracted "MemoryFeedback"%ROWTYPE;
BEGIN
  IF NEW."contentPurgedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO feedback_event
  FROM "MemoryEvent"
  WHERE "userId" = NEW."userId" AND "id" = NEW."memoryEventId";
  IF NOT FOUND
    OR feedback_event."operation" <> 'USER_FEEDBACK'
    OR feedback_event."actorType" <> 'USER'
    OR feedback_event."actorUserId" IS DISTINCT FROM NEW."userId"
    OR feedback_event."metadata" ->> 'schemaVersion' IS DISTINCT FROM
      'memory-feedback-event-v1'
    OR feedback_event."metadata" ->> 'feedbackId' IS DISTINCT FROM NEW."id"
    OR feedback_event."metadata" ->> 'feedbackType' IS DISTINCT FROM
      NEW."feedbackType"::text
    OR (
      NEW."targetKind" = 'FACT_VERSION'
      AND (
        feedback_event."factId" IS DISTINCT FROM NEW."memoryFactId"
        OR feedback_event."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
      )
    )
    OR (
      NEW."targetKind" <> 'FACT_VERSION'
      AND num_nonnulls(feedback_event."factId", feedback_event."factVersionId") <> 0
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback event must match its immutable signal';
  END IF;

  IF NEW."modelRunMemoryItemId" IS NOT NULL THEN
    SELECT * INTO target_item
    FROM "ModelRunMemoryItem"
    WHERE "userId" = NEW."userId" AND "id" = NEW."modelRunMemoryItemId";
    IF NOT FOUND
      OR target_item."bindingId" NOT IN (
        SELECT binding."id" FROM "ModelRunMemoryBinding" AS binding
        WHERE binding."userId" = NEW."userId" AND binding."modelRunId" = NEW."modelRunId"
      )
      OR (NEW."targetKind" = 'FACT_VERSION' AND target_item."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId")
      OR (NEW."targetKind" = 'EPISODE' AND target_item."episodeId" IS DISTINCT FROM NEW."episodeId")
      OR (NEW."targetKind" = 'RECALL_CHUNK' AND target_item."recallChunkId" IS DISTINCT FROM NEW."recallChunkId")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback run item must match its same-owner target';
    END IF;
  END IF;

  IF NEW."modelRunToolCallId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ModelRunToolCall" AS tool_call
    WHERE tool_call."modelRunId" = NEW."modelRunId"
      AND tool_call."id" = NEW."modelRunToolCallId"
      AND tool_call."toolName" = 'mark_memory_incorrect'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback tool provenance must name mark_memory_incorrect';
  END IF;

  IF NEW."feedbackType" = 'RETRACT' THEN
    SELECT * INTO retracted
    FROM "MemoryFeedback"
    WHERE "userId" = NEW."userId" AND "id" = NEW."retractsFeedbackId";
    IF NOT FOUND
      OR retracted."feedbackType" = 'RETRACT'
      OR retracted."contentPurgedAt" IS NOT NULL
      OR retracted."targetKind" IS DISTINCT FROM NEW."targetKind"
      OR retracted."memoryFactId" IS DISTINCT FROM NEW."memoryFactId"
      OR retracted."memoryFactVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
      OR retracted."episodeId" IS DISTINCT FROM NEW."episodeId"
      OR retracted."recallChunkId" IS DISTINCT FROM NEW."recallChunkId"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback retraction must match one live same-owner signal';
    END IF;
  END IF;
  RETURN NEW;
END
$memory_feedback_target_guard$;

CREATE TRIGGER "MemoryFeedback_target_guard"
BEFORE INSERT ON "MemoryFeedback"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_feedback_target_guard();

COMMIT;
