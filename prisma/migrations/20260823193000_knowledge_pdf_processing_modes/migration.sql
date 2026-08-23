CREATE TYPE "KnowledgePdfProcessingMode" AS ENUM (
  'local',
  'system_model_direct_pdf',
  'system_model_vision'
);

CREATE TYPE "KnowledgePdfProcessingAttemptState" AS ENUM (
  'reserved',
  'dispatched',
  'settled',
  'ambiguous'
);

ALTER TABLE "KnowledgeIndexProfileRevision"
  ADD COLUMN "pdfProcessingMode" "KnowledgePdfProcessingMode" NOT NULL DEFAULT 'local',
  ADD COLUMN "pdfParserProfileVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pdfSystemModelPolicyVersion" INTEGER,
  ADD COLUMN "pdfSystemModelSnapshot" JSONB;

CREATE TABLE "KnowledgePdfProcessingAttempt" (
  "id" TEXT NOT NULL,
  "sourceArtifactId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "batchIndex" INTEGER NOT NULL,
  "mode" "KnowledgePdfProcessingMode" NOT NULL,
  "pageStart" INTEGER NOT NULL,
  "pageEnd" INTEGER NOT NULL,
  "requestDigest" CHAR(64) NOT NULL,
  "state" "KnowledgePdfProcessingAttemptState" NOT NULL DEFAULT 'reserved',
  "resultText" TEXT,
  "resultChecksum" CHAR(64),
  "usage" JSONB,
  "dispatchedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgePdfProcessingAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgePdfAttempt_source_artifact_fkey"
    FOREIGN KEY ("sourceVersionId", "sourceArtifactId")
    REFERENCES "KnowledgeSourceIndexArtifact"("sourceVersionId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "KnowledgePdfProcessingAttempt_batch_bounds_check"
    CHECK ("batchIndex" >= 0 AND "pageStart" >= 1 AND "pageEnd" >= "pageStart"),
  CONSTRAINT "KnowledgePdfProcessingAttempt_result_pair_check"
    CHECK (("resultText" IS NULL) = ("resultChecksum" IS NULL)),
  CONSTRAINT "KnowledgePdfProcessingAttempt_result_state_check"
    CHECK ("state" = 'settled' OR "resultText" IS NULL)
);

CREATE UNIQUE INDEX "KnowledgePdfProcessingAttempt_sourceArtifactId_batchIndex_key"
  ON "KnowledgePdfProcessingAttempt"("sourceArtifactId", "batchIndex");
CREATE INDEX "KnowledgePdfAttempt_source_artifact_idx"
  ON "KnowledgePdfProcessingAttempt"("sourceVersionId", "sourceArtifactId");
CREATE INDEX "KnowledgePdfProcessingAttempt_state_updatedAt_idx"
  ON "KnowledgePdfProcessingAttempt"("state", "updatedAt");

ALTER TABLE "UsageEvent"
  ADD COLUMN "knowledgePdfProcessingAttemptId" TEXT;

CREATE UNIQUE INDEX "UsageEvent_knowledgePdfProcessingAttemptId_key"
  ON "UsageEvent"("knowledgePdfProcessingAttemptId");

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledgePdfProcessingAttemptId_fkey"
  FOREIGN KEY ("knowledgePdfProcessingAttemptId")
  REFERENCES "KnowledgePdfProcessingAttempt"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
