export const UTILITY_RUNTIME_BUDGET_MIGRATION = "20260918213000_utility_runtime_budgets";

export const utilityRuntimeBudgetFixtures = [
  { timeout: 60, administrator: false, version: 1, expected: "IS NULL", nextVersion: 2 },
  { timeout: 60, administrator: false, version: 2, expected: "IS NULL", nextVersion: 3 },
  { timeout: 60, administrator: true, version: 4, expected: "= 60", nextVersion: 4 },
  { timeout: 90, administrator: false, version: 4, expected: "= 90", nextVersion: 4 },
  { timeout: 60, administrator: false, version: 4, expected: "= 60", nextVersion: 4 }
].map(({ timeout, administrator, version, expected, nextVersion }) => ({
  fixture: `
    INSERT INTO "User" (id, "displayName", status, "updatedAt")
      VALUES ('utility-budget-admin', 'Fixture administrator', 'active', now());
    UPDATE "ModelPolicy" SET version = ${version}, "mcpAutoDiscoveryTimeoutSeconds" = ${timeout},
      "updatedByUserId" = ${administrator ? "'utility-budget-admin'" : "NULL"} WHERE id = 'installation';
  `,
  proof: `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" WHERE id = 'installation'
      AND "mcpAutoDiscoveryTimeoutSeconds" ${expected} AND version = ${nextVersion})
    THEN RAISE EXCEPTION 'utility_budget_adoption_or_operator_preservation_failed'; END IF;
  END $$;
  BEGIN;
    UPDATE "ModelPolicy" SET "mcpAutoDiscoveryTimeoutSeconds" = 7200 WHERE id = 'installation';
  ROLLBACK;`
}));
