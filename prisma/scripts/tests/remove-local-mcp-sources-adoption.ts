export const REMOVE_LOCAL_MCP_SOURCES_MIGRATION = "20261003090000_remove_local_mcp_sources";

// The migration only relaxes the column. Leftover local rows are removed by the
// acknowledged installation bootstrap gate, which this proof never runs.
// Jobs stay out of the stages a later migration retires, so the snapshot holds.
const storedStateSql = `SELECT jsonb_build_object(
  'servers', (SELECT jsonb_agg(to_jsonb(server) ORDER BY id) FROM "McpServer" AS server),
  'revisions', (SELECT jsonb_agg(to_jsonb(revision) ORDER BY id) FROM "McpRevision" AS revision),
  'jobs', (SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM "McpActivationJob" AS job)
)`;

export const removeLocalMcpSourcesFixtureSql = `
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, draft, "updatedAt")
SELECT 'mcp-local-removal-' || name, 'local_removal_' || name, 'Synthetic server', true, draft, now()
FROM (VALUES
  ('remote', '{"source":{"kind":"remote","url":"https://mcp.example.test/mcp"},"transport":"streamable_http"}'::jsonb),
  ('local', '{"source":{"kind":"npm","package":"@example/mcp","version":"1.0.0"},"transport":"stdio"}'::jsonb),
  ('legacy', '{}'::jsonb),
  ('new', '{"source":{"kind":"remote","url":"https://mcp.example.test/new"},"transport":"streamable_http"}'::jsonb),
  ('old_writer', '{"source":{"kind":"remote","url":"https://mcp.example.test/old"},"transport":"streamable_http"}'::jsonb)
) AS fixture(name, draft);
INSERT INTO "McpRevision" (id, "serverId", "revisionNumber", configuration,
  "validationEvidence", "draftHash", "identityHash")
SELECT id || '-v1', id, 1, draft, '{"toolNames":["read"]}'::jsonb, 'synthetic-draft-hash', 'synthetic-identity'
FROM "McpServer" WHERE id IN ('mcp-local-removal-remote', 'mcp-local-removal-local');
UPDATE "McpServer" SET "activeRevisionId" = id || '-v1'
WHERE id IN ('mcp-local-removal-remote', 'mcp-local-removal-local');
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", stage, "workloadToken", "updatedAt")
VALUES
  ('mcp-local-removal-job-remote', 'mcp-local-removal-remote', 'synthetic-draft-hash', 0, 'connecting', 'synthetic-token-remote', now()),
  ('mcp-local-removal-job-local', 'mcp-local-removal-local', 'synthetic-draft-hash', 0, 'connecting', 'synthetic-token-local', now());
CREATE TABLE "McpLocalRemovalAdoptionFixture" (phase text PRIMARY KEY, snapshot jsonb NOT NULL);
INSERT INTO "McpLocalRemovalAdoptionFixture" VALUES ('before', (${storedStateSql}));
`;

export const removeLocalMcpSourcesProofSql = `
DO $$ BEGIN
  IF (${storedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpLocalRemovalAdoptionFixture" WHERE phase = 'before') THEN
    RAISE EXCEPTION 'mcp_local_removal_migration_changed_existing_rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'McpActivationJob' AND column_name = 'workloadToken' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'mcp_activation_workload_token_not_nullable';
  END IF;
END $$;

-- The current release queues activation without a token.
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "updatedAt")
VALUES ('mcp-local-removal-job-new', 'mcp-local-removal-new', 'synthetic-new-hash', 0, now());
-- A previous-release writer still names a token during Compose replacement.
INSERT INTO "McpActivationJob" (id, "serverId", "draftHash", "sharedConfigVersion", "workloadToken", "updatedAt")
VALUES ('mcp-local-removal-job-old', 'mcp-local-removal-old_writer', 'synthetic-old-hash', 0, 'synthetic-token-old', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "McpActivationJob" WHERE id = 'mcp-local-removal-job-new'
    AND "workloadToken" IS NULL AND stage = 'queued') THEN
    RAISE EXCEPTION 'mcp_activation_job_without_token_not_stored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "McpActivationJob" WHERE id = 'mcp-local-removal-job-old'
    AND "workloadToken" = 'synthetic-token-old') THEN
    RAISE EXCEPTION 'mcp_activation_job_with_token_not_stored';
  END IF;
  BEGIN
    UPDATE "McpActivationJob" SET "workloadToken" = 'synthetic-token-remote' WHERE id = 'mcp-local-removal-job-old';
    RAISE EXCEPTION 'mcp_activation_workload_token_uniqueness_lost';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
INSERT INTO "McpLocalRemovalAdoptionFixture" VALUES ('after', (${storedStateSql}));
`;

export const removeLocalMcpSourcesRepeatProofSql = `
DO $$ BEGIN
  IF (${storedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpLocalRemovalAdoptionFixture" WHERE phase = 'after') THEN
    RAISE EXCEPTION 'mcp_local_removal_redeploy_changed_rows';
  END IF;
END $$;
`;
