ALTER TABLE "KnowledgeIndexGeneration"
  ADD COLUMN "targetSourceRevision" INTEGER;

ALTER TABLE "KnowledgeIndexGeneration"
  ADD CONSTRAINT "KnowledgeIndexGeneration_target_source_revision_check"
  CHECK ("targetSourceRevision" IS NULL OR "targetSourceRevision" >= 0);

CREATE INDEX "KnowledgeIndexGeneration_profile_status_idx"
  ON "KnowledgeIndexGeneration"("profileRevisionId", "status");
