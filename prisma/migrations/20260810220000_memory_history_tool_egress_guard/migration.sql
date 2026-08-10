-- Enable fact/history recall by default, then add bounded post-admission
-- history-search receipts and plaintext-free
-- external-tool/provider-request egress evidence. Settled destination/outcome
-- evidence is retained; only the private history-query/result derivative is
-- later scrubbed by Memory deletion obligations.
BEGIN;

ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "useMemoryFacts" SET DEFAULT true,
  ALTER COLUMN "referenceChatHistory" SET DEFAULT true;

-- Revision 2 deliberately enables both recall gates for every existing owner.
-- One revision advance invalidates stale run/settings snapshots without
-- enabling automatic fact learning.
UPDATE "UserMemorySettings"
SET
  "useMemoryFacts" = true,
  "referenceChatHistory" = true,
  "memoryRevision" = "memoryRevision" + 1,
  "settingsRevision" = "settingsRevision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT "useMemoryFacts" OR NOT "referenceChatHistory";

CREATE TYPE "MemoryHistoryRunState" AS ENUM (
  'RUNNING', 'COMPLETE', 'ERROR', 'CANCELLED'
);
CREATE TYPE "MemoryHistoryRunOutcome" AS ENUM (
  'RESULTS', 'EMPTY', 'DISABLED', 'DEGRADED', 'FAILED'
);
CREATE TYPE "MemoryReceiptRetentionState" AS ENUM ('RETAINED', 'SCRUBBED');
CREATE TYPE "MemoryToolEgressMode" AS ENUM ('PROVIDER_REQUEST', 'TOOL_CALL');
CREATE TYPE "MemoryToolEgressDispatchState" AS ENUM (
  'DISPATCHED', 'COMPLETED', 'BLOCKED', 'FAILED'
);

CREATE TABLE "MemoryHistoryRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "modelRunToolCallId" TEXT NOT NULL,
  "invocationOrdinal" INTEGER NOT NULL,
  "state" "MemoryHistoryRunState" NOT NULL DEFAULT 'RUNNING',
  "outcome" "MemoryHistoryRunOutcome",
  "query" VARCHAR(500),
  "queryHash" VARCHAR(128) NOT NULL,
  "privateRequest" JSONB NOT NULL,
  "indexingEvidence" JSONB NOT NULL DEFAULT '{}',
  "executionBindingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "results" JSONB,
  "providerResult" JSONB,
  "resultHash" VARCHAR(128),
  "resultCount" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "errorCode" VARCHAR(128),
  "retentionState" "MemoryReceiptRetentionState" NOT NULL DEFAULT 'RETAINED',
  "plaintextPurgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryHistoryRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryHistoryRun_userId_id_key"
  ON "MemoryHistoryRun"("userId", "id");
CREATE UNIQUE INDEX "MemoryHistoryRun_userId_modelRunId_id_key"
  ON "MemoryHistoryRun"("userId", "modelRunId", "id");
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunToolCallId_key"
  ON "MemoryHistoryRun"("modelRunToolCallId");
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunId_invocationOrdinal_key"
  ON "MemoryHistoryRun"("modelRunId", "invocationOrdinal");
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunId_modelRunToolCallId_key"
  ON "MemoryHistoryRun"("modelRunId", "modelRunToolCallId");
CREATE INDEX "MemoryHistoryRun_userId_createdAt_idx"
  ON "MemoryHistoryRun"("userId", "createdAt");
CREATE INDEX "MemoryHistoryRun_userId_retentionState_createdAt_idx"
  ON "MemoryHistoryRun"("userId", "retentionState", "createdAt");
CREATE INDEX "MemoryHistoryRun_modelRunId_state_idx"
  ON "MemoryHistoryRun"("modelRunId", "state");

ALTER TABLE "MemoryHistoryRun"
  ADD CONSTRAINT "MemoryHistoryRun_modelRun_fkey"
    FOREIGN KEY ("userId", "modelRunId")
    REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryHistoryRun_toolCall_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId")
    REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryHistoryRun_shape_check"
    CHECK (
      "invocationOrdinal" BETWEEN 1 AND 2
      AND "queryHash" ~ '^[a-f0-9]{64}$'
      AND pg_column_size("privateRequest") <= 16384
      AND pg_column_size("indexingEvidence") <= 16384
      AND cardinality("executionBindingIds") <= 8
      AND char_length(array_to_string("executionBindingIds", ',')) <= 4096
      AND array_to_string("executionBindingIds", ',') !~ '[[:cntrl:]]'
      AND ("results" IS NULL OR pg_column_size("results") <= 131072)
      AND ("providerResult" IS NULL OR pg_column_size("providerResult") <= 262144)
      AND ("resultHash" IS NULL OR "resultHash" ~ '^[a-f0-9]{64}$')
      AND "resultCount" BETWEEN 0 AND 20
      AND ("durationMs" IS NULL OR "durationMs" >= 0)
      AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9._-]{1,128}$')
      AND (
        (
          "retentionState" = 'RETAINED'
          AND "query" IS NOT NULL
          AND char_length("query") BETWEEN 1 AND 500
          AND "plaintextPurgedAt" IS NULL
        ) OR (
          "retentionState" = 'SCRUBBED'
          AND "query" IS NULL
          AND "privateRequest" = '{}'::jsonb
          AND "results" IS NULL
          AND "providerResult" IS NULL
          AND "plaintextPurgedAt" IS NOT NULL
        )
      )
      AND (
        (
          "state" = 'RUNNING'
          AND "outcome" IS NULL
          AND "completedAt" IS NULL
          AND "durationMs" IS NULL
          AND "errorCode" IS NULL
          AND "results" IS NULL
          AND "providerResult" IS NULL
          AND "resultHash" IS NULL
          AND "resultCount" = 0
        ) OR (
          "state" = 'COMPLETE'
          AND "outcome" IN ('RESULTS', 'EMPTY', 'DISABLED', 'DEGRADED')
          AND "completedAt" IS NOT NULL
          AND "durationMs" IS NOT NULL
          AND "errorCode" IS NULL
          AND (
            "retentionState" = 'SCRUBBED'
            OR ("results" IS NOT NULL AND "providerResult" IS NOT NULL AND "resultHash" IS NOT NULL)
          )
          AND (("outcome" = 'RESULTS') = ("resultCount" > 0))
        ) OR (
          "state" IN ('ERROR', 'CANCELLED')
          AND "outcome" = 'FAILED'
          AND "completedAt" IS NOT NULL
          AND "durationMs" IS NOT NULL
          AND "errorCode" IS NOT NULL
          AND (
            "retentionState" = 'SCRUBBED'
            OR ("providerResult" IS NOT NULL AND "resultHash" IS NOT NULL)
          )
        )
      )
    );

CREATE TABLE "MemoryToolEgressReceipt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "modelRunToolCallId" TEXT,
  "requestOrdinal" INTEGER NOT NULL,
  "mode" "MemoryToolEgressMode" NOT NULL,
  "destinationKind" VARCHAR(64) NOT NULL,
  "destinationFingerprint" VARCHAR(128) NOT NULL,
  "destinationSnapshot" JSONB NOT NULL,
  "requestEvidenceHash" VARCHAR(128) NOT NULL,
  "requestPreviewHash" VARCHAR(128),
  "dispatchState" "MemoryToolEgressDispatchState" NOT NULL DEFAULT 'DISPATCHED',
  "dispatchStartedAt" TIMESTAMP(3),
  "dispatchCompletedAt" TIMESTAMP(3),
  "errorCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryToolEgressReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryToolEgressReceipt_userId_id_key"
  ON "MemoryToolEgressReceipt"("userId", "id");
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_userId_modelRunId_id_key"
  ON "MemoryToolEgressReceipt"("userId", "modelRunId", "id");
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_modelRunId_requestOrdinal_key"
  ON "MemoryToolEgressReceipt"("modelRunId", "requestOrdinal");
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_modelRunId_modelRunToolCallId_key"
  ON "MemoryToolEgressReceipt"("modelRunId", "modelRunToolCallId");
CREATE INDEX "MemoryToolEgressReceipt_userId_dispatchState_createdAt_idx"
  ON "MemoryToolEgressReceipt"("userId", "dispatchState", "createdAt");
CREATE INDEX "MemoryToolEgressReceipt_modelRunId_mode_idx"
  ON "MemoryToolEgressReceipt"("modelRunId", "mode");

ALTER TABLE "MemoryToolEgressReceipt"
  ADD CONSTRAINT "MemoryToolEgressReceipt_modelRun_fkey"
    FOREIGN KEY ("userId", "modelRunId")
    REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryToolEgressReceipt_toolCall_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId")
    REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryToolEgressReceipt_shape_check"
    CHECK (
      "requestOrdinal" BETWEEN 1 AND 64
      AND "destinationKind" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "destinationFingerprint" ~ '^[a-f0-9]{64}$'
      AND "requestEvidenceHash" ~ '^[a-f0-9]{64}$'
      AND ("requestPreviewHash" IS NULL OR "requestPreviewHash" ~ '^[a-f0-9]{64}$')
      AND pg_column_size("destinationSnapshot") <= 32768
      AND jsonb_typeof("destinationSnapshot") IN ('object', 'array')
      AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9._-]{1,128}$')
      AND (
        ("mode" = 'PROVIDER_REQUEST' AND "modelRunToolCallId" IS NULL)
        OR ("mode" = 'TOOL_CALL' AND "modelRunToolCallId" IS NOT NULL)
      )
      AND (
        (
          "dispatchState" = 'DISPATCHED'
          AND "dispatchStartedAt" IS NOT NULL
          AND "dispatchCompletedAt" IS NULL
          AND "errorCode" IS NULL
        )
        OR (
          "dispatchState" = 'COMPLETED'
          AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2
          AND "errorCode" IS NULL
        )
        OR (
          "dispatchState" = 'BLOCKED'
          AND "dispatchStartedAt" IS NULL
          AND "dispatchCompletedAt" IS NOT NULL
          AND "errorCode" IS NOT NULL
        )
        OR (
          "dispatchState" = 'FAILED'
          AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2
          AND "errorCode" IS NOT NULL
        )
      )
      AND (
        "dispatchCompletedAt" IS NULL
        OR "dispatchStartedAt" IS NULL
        OR "dispatchCompletedAt" >= "dispatchStartedAt"
      )
    );

COMMIT;
