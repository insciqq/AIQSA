/** Synthetic v0.3.3 activation jobs; migration-contract owns the disposable database. */
export const DROP_RETIRED_MCP_ACTIVATION_STORAGE_MIGRATION =
  "20261005100100_drop_retired_mcp_activation_storage";

const jobCount = 9;

// A job in every live stage, leased or not, with and without a token an older
// release wrote, plus jobs an older writer left in a retired stage, one on an
// archived server. Explicit columns keep the fixture valid when later
// migrations add columns.
export const dropRetiredMcpActivationStorageFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('mcp-activation-drop-validator', 'Synthetic validator', 'active', now());
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, draft, "archivedAt", "updatedAt")
SELECT 'mcp-activation-drop-' || name, 'activation_drop_' || name, 'Synthetic server', true,
  '{"source":{"kind":"remote","url":"https://mcp.example.test/mcp"},"transport":"streamable_http"}'::jsonb,
  CASE WHEN name = 'archived' THEN now() END, now()
FROM (VALUES ('queued'), ('connecting'), ('discovering'), ('publishing'), ('ready'), ('failed'),
  ('resolving'), ('preparing'), ('archived'), ('new')) AS fixture(name);
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "validationUserId", stage,
  "errorCode", issues, "leaseId", "workloadToken", "requestedAt", "startedAt", "completedAt", "updatedAt")
VALUES
  ('mcp-activation-drop-job-queued', 'mcp-activation-drop-queued', 'synthetic-hash', 0, NULL, 'queued',
    NULL, NULL, NULL, NULL, now(), NULL, NULL, now()),
  ('mcp-activation-drop-job-connecting', 'mcp-activation-drop-connecting', 'synthetic-hash', 2,
    'mcp-activation-drop-validator', 'connecting', NULL, NULL, 'synthetic-lease-connecting',
    'synthetic-token-connecting', now() - interval '1 hour', now() - interval '1 hour', NULL, now() - interval '1 hour'),
  ('mcp-activation-drop-job-discovering', 'mcp-activation-drop-discovering', 'synthetic-hash', 0, NULL,
    'discovering_tools', NULL, NULL, 'synthetic-lease-discovering', NULL, now(), now(), NULL, now()),
  ('mcp-activation-drop-job-publishing', 'mcp-activation-drop-publishing', 'synthetic-hash', 1, NULL,
    'publishing', NULL, NULL, 'synthetic-lease-publishing', 'synthetic-token-publishing', now(), now(), NULL, now()),
  ('mcp-activation-drop-job-ready', 'mcp-activation-drop-ready', 'synthetic-hash', 0, NULL, 'ready',
    NULL, NULL, NULL, 'synthetic-token-ready', now(), now(), now(), now()),
  ('mcp-activation-drop-job-failed', 'mcp-activation-drop-failed', 'synthetic-hash', 0, NULL, 'failed',
    'mcp_activation_failed', '[{"code":"synthetic_issue","path":"draft"}]'::jsonb, NULL, NULL,
    now(), now(), now(), now()),
  ('mcp-activation-drop-job-resolving', 'mcp-activation-drop-resolving', 'synthetic-hash', 0, NULL, 'resolving',
    NULL, NULL, 'synthetic-lease-resolving', 'synthetic-token-resolving', now() - interval '2 days',
    now() - interval '2 days', NULL, now() - interval '2 days'),
  ('mcp-activation-drop-job-preparing', 'mcp-activation-drop-preparing', 'synthetic-hash', 0, NULL,
    'preparing_runtime', NULL, NULL, NULL, NULL, now() - interval '1 day', NULL, NULL, now() - interval '1 day'),
  ('mcp-activation-drop-job-archived', 'mcp-activation-drop-archived', 'synthetic-hash', 0, NULL,
    'preparing_runtime', NULL, NULL, 'synthetic-lease-archived', 'synthetic-token-archived', now(), now(), NULL, now());
-- Every job survives without its token; only a retired stage becomes queued.
CREATE TABLE "McpActivationDropAdoptionFixture" AS
SELECT id, (to_jsonb(job) - 'workloadToken') || CASE WHEN job.stage::text IN ('resolving', 'preparing_runtime')
  THEN '{"stage":"queued"}'::jsonb ELSE '{}'::jsonb END AS snapshot
FROM "McpActivationJob" AS job WHERE id LIKE 'mcp-activation-drop-job-%';
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy.
 * Recorded columns compare exactly; columns a later migration adds are
 * ignored. A retired label raises invalid_text_representation and a terminal
 * shape violation raises check_violation. */
export const dropRetiredMcpActivationStorageProofSql = `
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM "McpActivationDropAdoptionFixture") <> ${jobCount}
    OR (SELECT count(*) FROM "McpActivationJob" WHERE id LIKE 'mcp-activation-drop-job-%') <> ${jobCount}
    OR (SELECT count(*) FROM "McpActivationDropAdoptionFixture" AS expected
      JOIN "McpActivationJob" AS job USING (id)
      WHERE (SELECT jsonb_object_agg(field.key, field.value) FROM jsonb_each(to_jsonb(job)) AS field
        WHERE expected.snapshot ? field.key) = expected.snapshot) <> ${jobCount}
  THEN RAISE EXCEPTION 'mcp_activation_jobs_not_preserved'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'McpActivationJob' AND column_name = 'workloadToken')
    OR EXISTS (SELECT 1 FROM pg_class WHERE relname = 'McpActivationJob_workloadToken_key')
  THEN RAISE EXCEPTION 'mcp_activation_workload_token_retained'; END IF;
  IF (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid = '"McpActivationStage"'::regtype)
      IS DISTINCT FROM ARRAY['queued', 'connecting', 'discovering_tools', 'publishing', 'ready', 'failed']
    OR to_regtype('"McpActivationStage_retired"') IS NOT NULL
    OR (SELECT atttypid FROM pg_attribute WHERE attrelid = '"McpActivationJob"'::regclass
      AND attname = 'stage') <> '"McpActivationStage"'::regtype
  THEN RAISE EXCEPTION 'mcp_activation_stage_type_not_contracted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index AS index_catalog
      JOIN pg_class AS index_relation ON index_relation.oid = index_catalog.indexrelid
      WHERE index_relation.relname = 'McpActivationJob_stage_updatedAt_idx'
        AND index_catalog.indisvalid AND index_catalog.indisready)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'McpActivationJob_terminal_fields_check'
      AND conrelid = '"McpActivationJob"'::regclass AND convalidated)
  THEN RAISE EXCEPTION 'mcp_activation_stage_index_or_check_invalid'; END IF;
  BEGIN
    INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", stage, "updatedAt")
    VALUES ('mcp-activation-drop-job-new', 'mcp-activation-drop-new', 'synthetic-new-hash', 0, 'resolving', now());
    RAISE EXCEPTION 'mcp_activation_resolving_stage_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", stage, "updatedAt")
    VALUES ('mcp-activation-drop-job-new', 'mcp-activation-drop-new', 'synthetic-new-hash', 0, 'preparing_runtime', now());
    RAISE EXCEPTION 'mcp_activation_preparing_stage_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    UPDATE "McpActivationJob" SET stage = 'ready' WHERE id = 'mcp-activation-drop-job-connecting';
    RAISE EXCEPTION 'mcp_activation_terminal_stage_without_completion_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "McpActivationJob" SET "completedAt" = now() WHERE id = 'mcp-activation-drop-job-connecting';
    RAISE EXCEPTION 'mcp_activation_live_stage_with_completion_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "McpActivationJob" SET "errorCode" = NULL WHERE id = 'mcp-activation-drop-job-failed';
    RAISE EXCEPTION 'mcp_activation_failure_without_error_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Valid settlements still pass the rebuilt check.
  UPDATE "McpActivationJob" SET stage = 'ready', "completedAt" = now(), "leaseId" = NULL
  WHERE id = 'mcp-activation-drop-job-connecting';
  UPDATE "McpActivationJob" SET stage = 'failed', "completedAt" = now(), "errorCode" = 'mcp_activation_failed'
  WHERE id = 'mcp-activation-drop-job-publishing';
  -- The current release queues activation at the default stage.
  INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "updatedAt")
  VALUES ('mcp-activation-drop-job-new', 'mcp-activation-drop-new', 'synthetic-new-hash', 0, now());
  IF NOT EXISTS (SELECT 1 FROM "McpActivationJob" WHERE id = 'mcp-activation-drop-job-new' AND stage = 'queued')
  THEN RAISE EXCEPTION 'mcp_activation_default_stage_not_queued'; END IF;
END $$;
ROLLBACK;
`;
