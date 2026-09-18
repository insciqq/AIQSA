export const MCP_MODEL_OUTPUT_BUDGET_MIGRATION = "20260918190000_mcp_model_output_budget";

export const mcpModelOutputBudgetFixtures = [
  // The subsequent utility-timeout adoption advances the untouched policy once more.
  { allowance: 8192, administrator: false, savedVersion: 1, expected: "IS NULL", version: 3 },
  { allowance: 8192, administrator: true, savedVersion: 3, expected: "= 8192", version: 3 },
  { allowance: 4096, administrator: false, savedVersion: 3, expected: "= 4096", version: 3 },
  // Deleting an administrator clears the FK, not the history of an explicit save.
  { allowance: 8192, administrator: false, savedVersion: 3, expected: "= 8192", version: 3 }
].map(({ allowance, administrator, savedVersion, expected, version }) => ({
  fixture: `
    INSERT INTO "User" (id, "displayName", status, "updatedAt")
    VALUES ('mcp-budget-admin', 'Fixture administrator', 'active', now());
    UPDATE "ModelPolicy" SET version = ${savedVersion}, "mcpAutoDiscoveryMaxOutputTokens" = ${allowance},
      "updatedByUserId" = ${administrator ? "'mcp-budget-admin'" : "NULL"} WHERE id = 'installation';
  `,
  proof: `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" WHERE id = 'installation'
      AND "mcpAutoDiscoveryMaxOutputTokens" ${expected} AND version = ${version})
    THEN RAISE EXCEPTION 'mcp_budget_adoption_or_operator_preservation_failed'; END IF;
  END $$;`
}));
