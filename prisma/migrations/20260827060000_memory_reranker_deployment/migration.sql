ALTER TYPE "ProviderModelClass" ADD VALUE IF NOT EXISTS 'reranker';

ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "rerankerProviderModelId" TEXT;

CREATE INDEX "SystemModelPolicy_rerankerProviderModelId_idx"
  ON "SystemModelPolicy"("rerankerProviderModelId");

ALTER TABLE "SystemModelPolicy"
  ADD CONSTRAINT "SystemModelPolicy_rerankerProviderModelId_fkey"
  FOREIGN KEY ("rerankerProviderModelId") REFERENCES "ProviderModel"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
