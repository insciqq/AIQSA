ALTER TABLE "KnowledgeAnswerPolicy"
    ADD COLUMN "ingestionParallelism" INTEGER NOT NULL DEFAULT 8;

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_ingestion_parallelism_check"
    CHECK ("ingestionParallelism" BETWEEN 1 AND 16);
