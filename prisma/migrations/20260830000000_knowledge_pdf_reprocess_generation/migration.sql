ALTER TABLE "KnowledgeSourceIndexArtifact"
ADD COLUMN "processingGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "KnowledgePdfProcessingAttempt"
ADD COLUMN "processingGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "KnowledgeSourceIndexArtifact"
ADD CONSTRAINT "KnowledgeSourceIndexArtifact_processing_generation_check"
CHECK ("processingGeneration" >= 0);

ALTER TABLE "KnowledgePdfProcessingAttempt"
ADD CONSTRAINT "KnowledgePdfProcessingAttempt_processing_generation_check"
CHECK ("processingGeneration" >= 0);

DROP INDEX "KnowledgePdfProcessingAttempt_sourceArtifactId_batchIndex_key";

CREATE UNIQUE INDEX "KnowledgePdfAttempt_artifact_generation_batch_key"
ON "KnowledgePdfProcessingAttempt"("sourceArtifactId", "processingGeneration", "batchIndex");
