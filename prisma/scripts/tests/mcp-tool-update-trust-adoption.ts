/** Every existing installation server becomes trusted at the upgrade (operator decision 2026-10-24); nothing else changes. */
export const MCP_TOOL_UPDATE_TRUST_MIGRATION = "20261024120000_mcp_tool_update_trust";
export const mcpToolUpdateTrustFixtureSql = `
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, "archivedAt", draft, "updatedAt")
VALUES ('mcp-trust-enabled', 'trust_enabled', 'Synthetic server', true, NULL, '{}'::jsonb, now()),
  ('mcp-trust-disabled', 'trust_disabled', 'Synthetic server', false, NULL, '{}'::jsonb, now()),
  ('mcp-trust-archived', 'trust_archived', 'Synthetic server', false, now(), '{}'::jsonb, now());
CREATE TABLE "_McpToolUpdateTrustFixture" AS SELECT id, to_jsonb(server) AS row FROM "McpServer" server WHERE id LIKE 'mcp-trust-%';
`;
export const mcpToolUpdateTrustProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "McpServer" server JOIN "_McpToolUpdateTrustFixture" f ON f.id = server.id
    WHERE server."autoApplyToolUpdates" AND NOT server."toolUpdateCheckPending" AND server."toolUpdateCheckRequestedAt" IS NULL
      AND f.row = to_jsonb(server) - 'autoApplyToolUpdates' - 'toolUpdateCheckPending' - 'toolUpdateCheckRequestedAt') <> 3
    THEN RAISE EXCEPTION 'mcp_tool_update_trust_not_applied_to_existing_servers'; END IF;
END $$;
DROP TABLE "_McpToolUpdateTrustFixture";
`;
