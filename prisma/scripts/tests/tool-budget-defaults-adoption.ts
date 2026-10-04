export const TOOL_BUDGET_DEFAULTS_MIGRATION = "20260928180000_increase_default_tool_budgets";

export const toolBudgetDefaultsFixtures = [
  { calls: 20, rounds: 8, expectedCalls: 80, expectedRounds: 32 },
  { calls: 37, rounds: 9, expectedCalls: 37, expectedRounds: 9 },
  { calls: 37, rounds: 8, expectedCalls: 37, expectedRounds: 32 },
  { calls: 20, rounds: 9, expectedCalls: 80, expectedRounds: 9 }
].map(({ calls, rounds, expectedCalls, expectedRounds }) => {
  const changed = calls !== expectedCalls || rounds !== expectedRounds;
  return {
    fixture: `
      INSERT INTO "User" (id, "displayName", status, "updatedAt")
      VALUES ('tool-budget-owner', 'Synthetic owner', 'active', now());
      UPDATE "ModelPolicy" SET "maxToolCalls" = ${calls}, "maxToolRounds" = ${rounds},
        "memoryAdmissionTimeoutSeconds" = 45, "maxMcpToolsPerDiscovery" = 11,
        "mcpAutoDiscoveryTimeoutSeconds" = 70, "mcpAutoDiscoveryMaxOutputTokens" = 4096,
        "toolObservationPolicy" = 'off', version = 7, "updatedByUserId" = 'tool-budget-owner',
        "updatedAt" = TIMESTAMP '2026-09-01 00:00:00'
      WHERE id = 'installation';
      INSERT INTO "Chat" (id, "userId", title, "updatedAt")
      VALUES ('tool-budget-chat', 'tool-budget-owner', 'Synthetic chat', now());
      INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
      VALUES ('tool-budget-question', 'tool-budget-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
        ('tool-budget-answer', 'tool-budget-chat', 'assistant', 'streaming', '{"text":""}', 'tool-budget-question', now());
      INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider,
        "modelId", status, "normalizedRequest", "updatedAt")
      VALUES ('tool-budget-run', 'tool-budget-chat', 'tool-budget-owner', 'tool-budget-question',
        'tool-budget-answer', 'fake', 'synthetic-model', 'streaming',
        '{"toolBudgets":{"maxToolCalls":20,"maxToolRounds":8}}', now());
      CREATE TABLE "_ToolBudgetDefaultsFixture" AS
      SELECT to_jsonb(p) AS policy, to_jsonb(r) AS run,
        (SELECT to_jsonb(a) FROM "AgentPolicy" a WHERE a.id = 'installation') AS agent
      FROM "ModelPolicy" p CROSS JOIN "ModelRun" r
      WHERE p.id = 'installation' AND r.id = 'tool-budget-run';
    `,
    // The subsequent Memory search policy migration intentionally resets its
    // timeout and advances this same installation revision once more.
    proof: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" p JOIN "_ToolBudgetDefaultsFixture" f ON true
          WHERE p.id = 'installation' AND p."maxToolCalls" = ${expectedCalls}
            AND p."maxToolRounds" = ${expectedRounds} AND p.version = ${changed ? 9 : 8}
            AND p."memorySearchTimeoutSeconds" = 30
            AND p."updatedAt" > (f.policy->>'updatedAt')::timestamp
            AND (to_jsonb(p) - ARRAY['maxToolCalls', 'maxToolRounds', 'version', 'updatedAt', 'memoryAdmissionTimeoutSeconds', 'memorySearchTimeoutSeconds']) =
              (f.policy - ARRAY['maxToolCalls', 'maxToolRounds', 'version', 'updatedAt', 'memoryAdmissionTimeoutSeconds', 'memorySearchTimeoutSeconds']))
          THEN RAISE EXCEPTION 'tool_budget_defaults_adoption_or_policy_preservation_failed'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "ModelRun" r JOIN "_ToolBudgetDefaultsFixture" f
          ON f.run = to_jsonb(r) - ARRAY['scheduledTaskId', 'scheduledOccurrenceId', 'scheduledTaskGeneration', 'scheduledOutcome']
          WHERE r.id = 'tool-budget-run')
          THEN RAISE EXCEPTION 'tool_budget_defaults_changed_accepted_run'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "AgentPolicy" a JOIN "_ToolBudgetDefaultsFixture" f ON f.agent = to_jsonb(a)
          WHERE a.id = 'installation')
          THEN RAISE EXCEPTION 'tool_budget_defaults_changed_agent_policy'; END IF;
        IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'ModelPolicy' AND column_name = 'maxToolCalls') IS DISTINCT FROM '80'
          OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'ModelPolicy' AND column_name = 'maxToolRounds') IS DISTINCT FROM '32'
          THEN RAISE EXCEPTION 'tool_budget_defaults_missing_for_new_policies'; END IF;
      END $$;
      -- An operator may deliberately restore the old values after this one-time adoption.
      UPDATE "ModelPolicy" SET "maxToolCalls" = 20, "maxToolRounds" = 8, version = version + 1,
        "updatedAt" = now() WHERE id = 'installation';
      UPDATE "_ToolBudgetDefaultsFixture" SET policy =
        (SELECT to_jsonb(p) FROM "ModelPolicy" p WHERE p.id = 'installation');
    `,
    repeatProof: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" p JOIN "_ToolBudgetDefaultsFixture" f ON f.policy = to_jsonb(p)
          WHERE p.id = 'installation' AND p."maxToolCalls" = 20 AND p."maxToolRounds" = 8)
          THEN RAISE EXCEPTION 'tool_budget_defaults_repeated_after_operator_edit'; END IF;
      END $$;
    `
  };
});
