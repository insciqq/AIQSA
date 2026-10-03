export const RETIRE_LOCAL_MCP_ACTIVATION_STAGES_MIGRATION = "20261003201500_retire_local_mcp_activation_stages";

const storedStateSql = `SELECT jsonb_build_object(
  'servers', (SELECT jsonb_agg(to_jsonb(server) ORDER BY id) FROM "McpServer" AS server),
  'jobs', (SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM "McpActivationJob" AS job)
)`;

// Every row survives; only a retired stage becomes queued.
const expectedStateSql = `SELECT jsonb_build_object(
  'servers', (SELECT jsonb_agg(to_jsonb(server) ORDER BY id) FROM "McpServer" AS server),
  'jobs', (SELECT jsonb_agg(to_jsonb(job) || CASE
      WHEN job.stage::text IN ('resolving', 'preparing_runtime') THEN '{"stage":"queued"}'::jsonb
      ELSE '{}'::jsonb END ORDER BY id) FROM "McpActivationJob" AS job)
)`;

// The database as the remove-local-MCP release leaves it: a job it queued
// without a token, a token from the release before it, and jobs an older
// release left in the retired stages, leased or not, on a live or archived server.
export const retireLocalMcpActivationStagesFixtureSql = `
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, draft, "archivedAt", "updatedAt")
SELECT 'mcp-retired-stage-' || name, 'retired_stage_' || name, 'Synthetic server', true,
  '{"source":{"kind":"remote","url":"https://mcp.example.test/mcp"},"transport":"streamable_http"}'::jsonb,
  CASE WHEN name = 'archived' THEN now() END, now()
FROM (VALUES ('queued'), ('old_writer'), ('resolving'), ('preparing'), ('archived'), ('ready'), ('failed'),
  ('new'), ('previous')) AS fixture(name);
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", stage, "leaseId",
  "workloadToken", "startedAt", "completedAt", "errorCode", "updatedAt")
VALUES
  ('mcp-retired-stage-job-queued', 'mcp-retired-stage-queued', 'synthetic-hash', 0, 'queued', NULL,
    NULL, NULL, NULL, NULL, now()),
  ('mcp-retired-stage-job-old_writer', 'mcp-retired-stage-old_writer', 'synthetic-hash', 1, 'connecting',
    'synthetic-lease-old', 'synthetic-token-old', now(), NULL, NULL, now()),
  ('mcp-retired-stage-job-resolving', 'mcp-retired-stage-resolving', 'synthetic-hash', 0, 'resolving',
    'synthetic-lease-resolving', 'synthetic-token-resolving', now() - interval '2 days', NULL, NULL,
    now() - interval '2 days'),
  ('mcp-retired-stage-job-preparing', 'mcp-retired-stage-preparing', 'synthetic-hash', 0, 'preparing_runtime',
    NULL, NULL, NULL, NULL, NULL, now() - interval '1 day'),
  ('mcp-retired-stage-job-archived', 'mcp-retired-stage-archived', 'synthetic-hash', 0, 'preparing_runtime',
    'synthetic-lease-archived', 'synthetic-token-archived', now(), NULL, NULL, now()),
  ('mcp-retired-stage-job-ready', 'mcp-retired-stage-ready', 'synthetic-hash', 0, 'ready',
    NULL, 'synthetic-token-ready', now(), now(), NULL, now()),
  ('mcp-retired-stage-job-failed', 'mcp-retired-stage-failed', 'synthetic-hash', 0, 'failed',
    NULL, NULL, now(), now(), 'mcp_activation_failed', now());
CREATE TABLE "McpRetiredStageAdoptionFixture" (phase text PRIMARY KEY, snapshot jsonb NOT NULL);
INSERT INTO "McpRetiredStageAdoptionFixture" VALUES ('expected', (${expectedStateSql}));
`;

export const retireLocalMcpActivationStagesProofSql = `
DO $$ BEGIN
  IF (${storedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpRetiredStageAdoptionFixture" WHERE phase = 'expected') THEN
    RAISE EXCEPTION 'mcp_retired_stage_rows_not_preserved';
  END IF;
END $$;

-- This release queues activation without a token at the default stage.
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "updatedAt")
VALUES ('mcp-retired-stage-job-new', 'mcp-retired-stage-new', 'synthetic-new-hash', 0, now());
-- The previous release still names a token during Compose replacement.
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "workloadToken", "updatedAt")
VALUES ('mcp-retired-stage-job-previous', 'mcp-retired-stage-previous', 'synthetic-previous-hash', 0,
  'synthetic-token-previous', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "McpActivationJob" WHERE id = 'mcp-retired-stage-job-new'
    AND stage = 'queued' AND "workloadToken" IS NULL) THEN
    RAISE EXCEPTION 'mcp_activation_job_without_token_not_stored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "McpActivationJob" WHERE id = 'mcp-retired-stage-job-previous'
    AND stage = 'queued' AND "workloadToken" = 'synthetic-token-previous') THEN
    RAISE EXCEPTION 'mcp_activation_job_with_token_not_stored';
  END IF;
END $$;
INSERT INTO "McpRetiredStageAdoptionFixture" VALUES ('after', (${storedStateSql}));
`;

export const retireLocalMcpActivationStagesRepeatProofSql = `
DO $$ BEGIN
  IF (${storedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpRetiredStageAdoptionFixture" WHERE phase = 'after') THEN
    RAISE EXCEPTION 'mcp_retired_stage_redeploy_changed_rows';
  END IF;
END $$;
`;
