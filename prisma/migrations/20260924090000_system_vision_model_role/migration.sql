-- One-time adoption of the page-image assignment; future writes are independent.
-- Keep the policy version and all accepted PDF snapshots unchanged.
BEGIN;
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "visionProviderModelId" TEXT,
  ADD COLUMN "visionReasoningEffort" VARCHAR(32);
CREATE INDEX "SystemModelPolicy_visionProviderModelId_idx" ON "SystemModelPolicy"("visionProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_visionProviderModelId_fkey"
  FOREIGN KEY ("visionProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_visionReasoning_shape" CHECK (
  "visionReasoningEffort" IS NULL OR "visionProviderModelId" IS NOT NULL AND length("visionReasoningEffort") BETWEEN 1 AND 32
    AND btrim("visionReasoningEffort") = "visionReasoningEffort" AND "visionReasoningEffort" !~ '[[:cntrl:]]'
);
UPDATE "SystemModelPolicy" SET
  "visionProviderModelId" = "chatPdfProviderModelId",
  "visionReasoningEffort" = CASE WHEN "chatPdfProviderModelId" IS NULL THEN NULL ELSE "chatPdfReasoningEffort" END;
COMMIT;
