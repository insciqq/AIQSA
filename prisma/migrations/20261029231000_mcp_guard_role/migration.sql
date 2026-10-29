ALTER TYPE "UsagePurpose" ADD VALUE 'mcp_guard';
ALTER TYPE "ProviderRunRole" ADD VALUE 'mcp_guard';

ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "mcpGuardProviderModelId" TEXT,
  ADD COLUMN "mcpGuardReasoningEffort" VARCHAR(32);
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_mcp_guard_effort_check" CHECK (
  "mcpGuardReasoningEffort" IS NULL OR "mcpGuardProviderModelId" IS NOT NULL AND length("mcpGuardReasoningEffort") BETWEEN 1 AND 32
    AND btrim("mcpGuardReasoningEffort") = "mcpGuardReasoningEffort" AND "mcpGuardReasoningEffort" !~ '[[:cntrl:]]'
);
CREATE INDEX "SystemModelPolicy_mcpGuardProviderModelId_idx" ON "SystemModelPolicy"("mcpGuardProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_mcpGuardProviderModelId_fkey"
  FOREIGN KEY ("mcpGuardProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "McpToolApproval"
  ADD COLUMN "guardDecision" VARCHAR(8),
  ADD COLUMN "guardReason" VARCHAR(320);
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_guard_check" CHECK (
  ("guardDecision" IS NULL AND "guardReason" IS NULL) OR
  ("guardDecision" IS NOT NULL AND "guardDecision" IN ('allow', 'ask') AND "guardReason" IS NOT NULL AND length("guardReason") BETWEEN 1 AND 320
    AND ("guardDecision" <> 'allow' OR "decision" IS NULL))
);

-- New enum labels cannot be used as enum constants until the migration commits.
-- Preserve the preceding sub-agent migration's reported-cost allowance too.
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_cost_reported_answer_check";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_cost_reported_answer_check"
  CHECK (NOT "costReported" OR "purpose"::text IN ('chat_answer', 'subagent', 'mcp_guard'));
