ALTER TABLE "KnowledgeAnswerPolicy"
    DROP CONSTRAINT "KnowledgeAnswerPolicy_ingestion_parallelism_check";

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_ingestion_parallelism_check"
    CHECK ("ingestionParallelism" BETWEEN 1 AND 64);
