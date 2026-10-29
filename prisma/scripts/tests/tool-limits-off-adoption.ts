/**
 * Per-answer tool limits are off for everyone (operator decision 2026-10-26),
 * limits an administrator typed included: the switch starts off, the saved
 * numbers and the policy revision stay as the previous release left them, and
 * an accepted run keeps the budgets frozen in its request.
 */
export const TOOL_LIMITS_OFF_MIGRATION = "20261026170000_tool_limits_off";

const runColumns = `id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt"`;

// An administrator's own limits and a run the previous release is still
// answering under them. Explicit columns keep the fixture valid when later
// migrations add columns.
export const toolLimitsOffFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('tool-limits-owner', 'Synthetic owner', 'active', now());
UPDATE "ModelPolicy" SET "maxToolCalls" = 37, "maxToolRounds" = 9, "maxMcpToolsPerDiscovery" = 11, version = 7,
  "updatedByUserId" = 'tool-limits-owner', "updatedAt" = TIMESTAMP '2026-10-01 00:00:00'
WHERE id = 'installation';
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('tool-limits-chat', 'tool-limits-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('tool-limits-question', 'tool-limits-chat', 'user', '{"blocks":[{"type":"text","text":"Synthetic question"}]}', now());
INSERT INTO "ModelRun" (${runColumns})
VALUES ('tool-limits-run', 'tool-limits-owner', 'tool-limits-chat', 'tool-limits-question', 'fake', 'fake-qsa', 'streaming',
  '{"toolBudgets":{"maxMcpToolsPerDiscovery":11,"maxToolCalls":37,"maxToolRounds":9}}', now());
CREATE TABLE "_ToolLimitsOffFixture" AS
SELECT to_jsonb(policy) AS policy, (SELECT to_jsonb(run) FROM "ModelRun" run WHERE run.id = 'tool-limits-run') AS run
FROM "ModelPolicy" policy WHERE policy.id = 'installation';
`;

export const toolLimitsOffProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" p CROSS JOIN "_ToolLimitsOffFixture" f
    WHERE p.id = 'installation' AND p."toolLimitsEnabled" = false
      AND p."maxToolCalls" = 37 AND p."maxToolRounds" = 9 AND p.version = 7
      AND (to_jsonb(p) - 'toolLimitsEnabled') = f.policy)
    THEN RAISE EXCEPTION 'tool_limits_off_changed_policy'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" run CROSS JOIN "_ToolLimitsOffFixture" f
    WHERE run.id = 'tool-limits-run' AND to_jsonb(run) - ARRAY['subagentThreadId', 'subagentTurnId'] = f.run)
    THEN RAISE EXCEPTION 'tool_limits_off_changed_accepted_run'; END IF;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'ModelPolicy' AND column_name = 'toolLimitsEnabled') IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'tool_limits_off_missing_for_new_policies'; END IF;
  -- Off keeps valid numbers: the limits turning the switch on applies.
  BEGIN
    UPDATE "ModelPolicy" SET "maxToolCalls" = 0 WHERE id = 'installation';
    RAISE EXCEPTION 'tool_limits_off_accepts_zero_limit';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ModelPolicy" SET "maxToolRounds" = NULL WHERE id = 'installation';
    RAISE EXCEPTION 'tool_limits_off_accepts_missing_limit';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  -- An administrator turns the limits back on after the upgrade.
  UPDATE "ModelPolicy" SET "toolLimitsEnabled" = true, version = version + 1 WHERE id = 'installation';
END $$;
`;

// The adoption ran once: a later administrator choice stays.
export const toolLimitsOffRepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy"
    WHERE id = 'installation' AND "toolLimitsEnabled" AND "maxToolCalls" = 37 AND "maxToolRounds" = 9 AND version = 8)
    THEN RAISE EXCEPTION 'tool_limits_off_repeated_after_operator_edit'; END IF;
END $$;
DROP TABLE "_ToolLimitsOffFixture";
`;
