-- Knowledge run admission: immutable, ordered base/generation/vector/provider
-- evidence accepted atomically with a ModelRun.
CREATE TABLE "KnowledgeRunBinding" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "baseContentRevision" INTEGER NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "indexedContentRevision" INTEGER NOT NULL,
  "vectorSpaceFingerprint" CHAR(64) NOT NULL,
  "targetDimension" INTEGER NOT NULL,
  "embeddingConnectionId" TEXT NOT NULL,
  "embeddingProviderModelId" TEXT NOT NULL,
  "embeddingCredentialId" TEXT NOT NULL,
  "embeddingCredentialVersionId" TEXT NOT NULL,
  "embeddingCredentialSource" "ProviderCredentialSource" NOT NULL,
  "embeddingExecutionSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeRunBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeRunBinding_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 2),
  CONSTRAINT "KnowledgeRunBinding_base_revision_check" CHECK ("baseContentRevision" >= 0),
  CONSTRAINT "KnowledgeRunBinding_indexed_revision_check" CHECK ("indexedContentRevision" >= 0),
  CONSTRAINT "KnowledgeRunBinding_fingerprint_check"
    CHECK ("vectorSpaceFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "KnowledgeRunBinding_dimension_check" CHECK ("targetDimension" IN (1024, 1536)),
  CONSTRAINT "KnowledgeRunBinding_snapshot_check"
    CHECK (jsonb_typeof("embeddingExecutionSnapshot") = 'object')
);

CREATE UNIQUE INDEX "KnowledgeRunBinding_modelRunId_ordinal_key"
  ON "KnowledgeRunBinding"("modelRunId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeRunBinding_modelRunId_knowledgeBaseId_key"
  ON "KnowledgeRunBinding"("modelRunId", "knowledgeBaseId");
CREATE INDEX "KnowledgeRunBinding_knowledgeBaseId_indexGenerationId_idx"
  ON "KnowledgeRunBinding"("knowledgeBaseId", "indexGenerationId");
CREATE INDEX "KnowledgeRunBinding_embedding_model_idx"
  ON "KnowledgeRunBinding"("embeddingConnectionId", "embeddingProviderModelId");
CREATE INDEX "KnowledgeRunBinding_credential_version_idx"
  ON "KnowledgeRunBinding"("embeddingCredentialId", "embeddingCredentialVersionId");

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_modelRunId_fkey"
  FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_generation_fkey"
  FOREIGN KEY ("knowledgeBaseId", "indexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_embeddingModel_fkey"
  FOREIGN KEY ("embeddingConnectionId", "embeddingProviderModelId")
  REFERENCES "ProviderModel"("connectionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_credential_fkey"
  FOREIGN KEY ("embeddingConnectionId", "embeddingCredentialId")
  REFERENCES "ProviderCredential"("connectionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_credentialVersion_fkey"
  FOREIGN KEY ("embeddingCredentialId", "embeddingCredentialVersionId")
  REFERENCES "ProviderCredentialVersion"("credentialId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Rollback is destructive: stop app/workers, back up Postgres, then drop this
-- table. Accepted Knowledge evidence cannot be reconstructed from mutable base
-- pointers or current embedding-provider configuration.
