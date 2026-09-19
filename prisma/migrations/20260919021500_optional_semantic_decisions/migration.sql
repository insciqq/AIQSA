ALTER TYPE "ProviderModelClass" ADD VALUE 'decision';

ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "decisionProviderModelId" TEXT,
  ADD COLUMN "decisionConfiguredAt" TIMESTAMP(3),
  ADD COLUMN "decisionFeaturesJson" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_decisionProviderModelId_fkey"
  FOREIGN KEY ("decisionProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_decision_features_object"
  CHECK (jsonb_typeof("decisionFeaturesJson") = 'object');
CREATE INDEX "SystemModelPolicy_decisionProviderModelId_idx" ON "SystemModelPolicy"("decisionProviderModelId");
