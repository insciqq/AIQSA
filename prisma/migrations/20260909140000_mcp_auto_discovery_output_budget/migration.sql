ALTER TABLE "ModelPolicy"
  ADD COLUMN "mcpAutoDiscoveryMaxOutputTokens" BIGINT NOT NULL DEFAULT 8192;

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_mcp_discovery_output_tokens_check"
  CHECK ("mcpAutoDiscoveryMaxOutputTokens" BETWEEN 1024 AND 65536);
