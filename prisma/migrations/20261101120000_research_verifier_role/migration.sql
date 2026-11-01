-- The research verifier role (operator decision 2026-11-01): nullable, so an unset role keeps
-- the visible main-model fallback and the previous release's writers stay safe during the upgrade.
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "researchVerifierProviderModelId" TEXT,
  ADD COLUMN "researchVerifierReasoningEffort" VARCHAR(32);
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_research_verifier_effort_check" CHECK (
  "researchVerifierReasoningEffort" IS NULL OR "researchVerifierProviderModelId" IS NOT NULL AND length("researchVerifierReasoningEffort") BETWEEN 1 AND 32
    AND btrim("researchVerifierReasoningEffort") = "researchVerifierReasoningEffort" AND "researchVerifierReasoningEffort" !~ '[[:cntrl:]]'
);
CREATE INDEX "SystemModelPolicy_researchVerifierProviderModelId_idx" ON "SystemModelPolicy"("researchVerifierProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_researchVerifierProviderModelId_fkey"
  FOREIGN KEY ("researchVerifierProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
