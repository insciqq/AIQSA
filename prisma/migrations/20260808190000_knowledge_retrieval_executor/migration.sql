CREATE TYPE "KnowledgeRunOutcome" AS ENUM (
  'complete',
  'zero_above_threshold',
  'base_empty',
  'base_indexing',
  'embedding_model_unavailable'
);

-- The extra composite key lets the receipt prove that its owning tool call
-- belongs to the same run; provider call ids are not relational authority.
CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_id_key"
  ON "ModelRunToolCall"("modelRunId", "id");

CREATE TABLE "KnowledgeRun" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "modelRunToolCallId" TEXT NOT NULL,
  "invocationOrdinal" INTEGER NOT NULL,
  "query" VARCHAR(500) NOT NULL,
  "outcome" "KnowledgeRunOutcome" NOT NULL,
  "fusion" VARCHAR(32) NOT NULL,
  "candidateLimit" INTEGER NOT NULL,
  "resultLimit" INTEGER NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "baseEvidence" JSONB NOT NULL,
  "results" JSONB NOT NULL,
  "providerText" TEXT NOT NULL,
  "embeddingUsage" JSONB NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "failureCode" VARCHAR(128),
  "rerankerBinding" JSONB,
  "preRerankOrder" JSONB,
  "postRerankOrder" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeRun_query_check" CHECK (
    char_length(btrim("query")) BETWEEN 1 AND 500
    AND "query" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "KnowledgeRun_limits_check" CHECK (
    "fusion" = 'rrf_k60'
    AND "invocationOrdinal" BETWEEN 1 AND 3
    AND "candidateLimit" BETWEEN 1 AND 100
    AND "resultLimit" BETWEEN 1 AND 8
    AND "candidateLimit" >= "resultLimit"
    AND "candidateCount" >= 0
    AND "threshold" >= 0 AND "threshold" <= 1
    AND "durationMs" >= 0
  ),
  CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") BETWEEN 1 AND 3
    AND jsonb_typeof("results") = 'array'
    AND jsonb_array_length("results") <= 8
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 3
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ),
  CONSTRAINT "KnowledgeRun_outcome_shape_check" CHECK (
    ("outcome" = 'complete' AND jsonb_array_length("results") BETWEEN 1 AND 8)
    OR ("outcome" <> 'complete' AND jsonb_array_length("results") = 0)
  ),
  CONSTRAINT "KnowledgeRun_negative_outcome_check" CHECK (
    ("outcome" = 'base_empty' AND "candidateCount" = 0)
    OR ("outcome" = 'zero_above_threshold' AND "candidateCount" > 0)
    OR "outcome" NOT IN ('base_empty', 'zero_above_threshold')
  ),
  CONSTRAINT "KnowledgeRun_failure_code_check" CHECK (
    "failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,127}$'
  )
);

CREATE UNIQUE INDEX "KnowledgeRun_modelRunToolCallId_key"
  ON "KnowledgeRun"("modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeRun_modelRunId_modelRunToolCallId_key"
  ON "KnowledgeRun"("modelRunId", "modelRunToolCallId");
CREATE INDEX "KnowledgeRun_modelRunId_createdAt_idx"
  ON "KnowledgeRun"("modelRunId", "createdAt");

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_modelRunId_fkey"
  FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_toolCall_fkey"
  FOREIGN KEY ("modelRunId", "modelRunToolCallId")
  REFERENCES "ModelRunToolCall"("modelRunId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- Rollback guidance (destructive): stop run coordinators, back up PostgreSQL,
-- drop KnowledgeRun and its enum, then drop only the added composite tool-call
-- key. Never delete ModelRun/Knowledge evidence merely to imitate rollback.
