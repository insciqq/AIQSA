ALTER TABLE "AssistantRevision"
  ADD COLUMN "knowledgeSelection" JSONB NOT NULL
  DEFAULT '{"baseIds":[],"mode":"none","sourceIds":[],"version":1}'::jsonb;

UPDATE "AssistantRevision"
SET "knowledgeSelection" = CASE
  WHEN cardinality("knowledgeBaseIds") = 0 THEN
    '{"baseIds":[],"mode":"none","sourceIds":[],"version":1}'::jsonb
  ELSE jsonb_build_object(
    'baseIds', to_jsonb("knowledgeBaseIds"),
    'mode', 'explicit',
    'sourceIds', '[]'::jsonb,
    'version', 1
  )
END;

ALTER TABLE "AssistantRevision"
  DROP COLUMN "knowledgeBaseIds";

ALTER TABLE "KnowledgeRunBinding"
  ADD COLUMN "includeWholeBase" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "selectedSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TYPE "KnowledgeRunOutcome" ADD VALUE IF NOT EXISTS 'budget_exhausted';

ALTER TABLE "KnowledgeRun"
  ADD COLUMN "operation" VARCHAR(32) NOT NULL DEFAULT 'search',
  ADD COLUMN "budgetEvidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "stopReason" VARCHAR(64);

CREATE TABLE "KnowledgeRunScope" (
  "modelRunId" TEXT NOT NULL,
  "selection" JSONB NOT NULL,
  "resolvedBaseCount" INTEGER NOT NULL,
  "resolvedSourceCount" INTEGER NOT NULL,
  "exclusions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "budgetPolicy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeRunScope_pkey" PRIMARY KEY ("modelRunId"),
  CONSTRAINT "KnowledgeRunScope_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "KnowledgeRunScope_resolved_counts_check"
    CHECK ("resolvedBaseCount" >= 0 AND "resolvedSourceCount" >= 0)
);
