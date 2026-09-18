-- Existing title jobs keep their accepted 64-token / 8-second request.
ALTER TABLE "ChatTitleGeneration"
  ADD COLUMN "maxOutputTokens" INTEGER,
  ADD COLUMN "responseTimeoutMs" INTEGER,
  ADD COLUMN "dispatchDeadlineAt" TIMESTAMP(3);

ALTER TABLE "ChatTitleGeneration" ADD CONSTRAINT "ChatTitleGeneration_runtime_budget_check"
  CHECK (("maxOutputTokens" IS NULL AND "responseTimeoutMs" IS NULL)
    OR ("maxOutputTokens" IS NOT NULL AND "responseTimeoutMs" IS NOT NULL
      AND "maxOutputTokens" >= 16 AND "responseTimeoutMs" > 0));
-- Null means the System Model response timeout for future admission.
ALTER TABLE "ModelPolicy" ALTER COLUMN "mcpAutoDiscoveryTimeoutSeconds" DROP NOT NULL,
  ALTER COLUMN "mcpAutoDiscoveryTimeoutSeconds" DROP DEFAULT;
ALTER TABLE "ModelPolicy" DROP CONSTRAINT "ModelPolicy_mcp_discovery_timeout_check";
ALTER TABLE "ModelPolicy" ADD CONSTRAINT "ModelPolicy_mcp_discovery_timeout_check"
  CHECK ("mcpAutoDiscoveryTimeoutSeconds" IS NULL OR
    "mcpAutoDiscoveryTimeoutSeconds" BETWEEN 1 AND 2147483);
UPDATE "ModelPolicy" SET "mcpAutoDiscoveryTimeoutSeconds" = NULL, "version" = "version" + 1
WHERE "mcpAutoDiscoveryTimeoutSeconds" = 60 AND "updatedByUserId" IS NULL AND "version" <= 2;
