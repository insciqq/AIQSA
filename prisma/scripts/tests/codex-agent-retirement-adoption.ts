/** Synthetic v0.4.3 state; migration-contract owns the disposable database. */
export const CODEX_AGENT_RETIREMENT_MIGRATION = "20261025090000_codex_agent_retirement";

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const retiredTables = quoted(["AgentRunBinding", "AgentProviderAttempt", "AgentMcpTool", "AgentPolicy"]);

// One row in each retired table, as releases before the Agent's removal left
// them; replica mode skips the keys to the run they name.
export const codexAgentRetirementFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "AgentRunBinding" ("modelRunId", configuration, "compatibilityHash", "updatedAt")
VALUES ('codex-agent-retirement-run', '{"mcpMode":"auto"}'::jsonb, repeat('a', 64), now());
INSERT INTO "AgentProviderAttempt" (id, "modelRunId", "providerBindingKey", "reservedTokens")
VALUES ('codex-agent-retirement-attempt', 'codex-agent-retirement-run', 'answer', 0);
INSERT INTO "AgentMcpTool" ("modelRunId", "toolId", version, snapshot)
VALUES ('codex-agent-retirement-run', 'mcp_synthetic_tool', repeat('b', 64), '{}'::jsonb);
UPDATE "AgentPolicy" SET "limitsEnabled" = true, version = version + 1 WHERE id = 'installation';
COMMIT;
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const codexAgentRetirementProofSql = `
BEGIN;
DO $proof$ BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[${retiredTables}]) AS retired(name)
      WHERE to_regclass(format('%I', retired.name)) IS NOT NULL)
  THEN RAISE EXCEPTION 'retired_agent_storage_retained'; END IF;
  IF to_regtype('"AgentAttemptState"') IS NOT NULL THEN RAISE EXCEPTION 'retired_agent_attempt_state_retained'; END IF;
  -- Old approval cards and Telegram buttons still name these values.
  IF NOT EXISTS (SELECT 1 FROM pg_enum AS value JOIN pg_type AS type ON type.oid = value.enumtypid
      WHERE type.typname = 'McpToolApprovalSource' AND value.enumlabel = 'agent')
  THEN RAISE EXCEPTION 'agent_approval_source_dropped'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum AS value JOIN pg_type AS type ON type.oid = value.enumtypid
      WHERE type.typname = 'TelegramCallbackKind' AND value.enumlabel = 'toggle_agent')
  THEN RAISE EXCEPTION 'agent_telegram_toggle_dropped'; END IF;
  -- The previous release still selects this column while Compose replaces it.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'TelegramLink' AND column_name = 'agentEnabled')
  THEN RAISE EXCEPTION 'telegram_agent_column_dropped_early'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = current_schema() AND routine.prosrc ~ '(AgentRunBinding|AgentProviderAttempt|AgentMcpTool|AgentPolicy)')
  THEN RAISE EXCEPTION 'retired_agent_storage_still_read'; END IF;
END $proof$;
ROLLBACK;
`;
