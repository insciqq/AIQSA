ALTER TABLE "ModelPolicy"
  ADD COLUMN "mcpAutoDiscoveryTimeoutSeconds" BIGINT NOT NULL DEFAULT 60;

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_mcp_discovery_timeout_check"
  CHECK (
    "mcpAutoDiscoveryTimeoutSeconds" > 0
    AND "mcpAutoDiscoveryTimeoutSeconds" <= 120
  );
