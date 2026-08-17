ALTER TABLE "ModelPolicy"
  ADD COLUMN "maxMcpToolsPerDiscovery" BIGINT NOT NULL DEFAULT 10;

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_mcp_discovery_limit_check"
  CHECK (
    "maxMcpToolsPerDiscovery" > 0
    AND "maxMcpToolsPerDiscovery" <= 128
  );
