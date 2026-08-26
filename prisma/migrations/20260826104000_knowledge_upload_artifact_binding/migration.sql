ALTER TABLE "KnowledgeUploadItem"
  ADD COLUMN "sourceArtifactId" TEXT;

CREATE INDEX "KnowledgeUploadItem_source_artifact_idx"
  ON "KnowledgeUploadItem"("sourceVersionId", "sourceArtifactId");

ALTER TABLE "KnowledgeUploadItem"
  ADD CONSTRAINT "KnowledgeUploadItem_sourceVersionId_sourceArtifactId_fkey"
  FOREIGN KEY ("sourceVersionId", "sourceArtifactId")
  REFERENCES "KnowledgeSourceIndexArtifact"("sourceVersionId", "id")
  ON DELETE SET NULL ("sourceArtifactId")
  ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeUploadItem"
  ADD CONSTRAINT "KnowledgeUploadItem_source_artifact_shape_check" CHECK (
    "sourceArtifactId" IS NULL OR "state" = 'PROCESSING'
  ) NOT VALID;

ALTER TABLE "KnowledgeUploadItem"
  VALIDATE CONSTRAINT "KnowledgeUploadItem_source_artifact_shape_check";
