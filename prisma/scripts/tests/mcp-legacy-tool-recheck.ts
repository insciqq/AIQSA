export const MCP_LEGACY_TOOL_RECHECK_MIGRATION = "20260927230000_mcp_legacy_tool_recheck";

const storedStateSql = `SELECT jsonb_build_object(
  'servers', (SELECT jsonb_agg(to_jsonb(server) - ARRAY['legacyToolRecheckPending', 'ownerUserId', 'connectorKey'] ORDER BY id) FROM "McpServer" AS server),
  'revisions', (SELECT jsonb_agg(to_jsonb(revision) ORDER BY id) FROM "McpRevision" AS revision),
  'grants', (SELECT jsonb_agg(to_jsonb(grant_row) ORDER BY id) FROM "McpGrant" AS grant_row),
  'toolPolicies', (SELECT jsonb_agg(to_jsonb(policy) ORDER BY id) FROM "McpToolAccessPolicy" AS policy),
  'toolUsers', (SELECT jsonb_agg(to_jsonb(tool_user) ORDER BY "policyId", "userId") FROM "McpToolUserGrant" AS tool_user)
)`;

const upgradedStateSql = `SELECT jsonb_build_object(
  'data', (${storedStateSql}),
  'pending', (SELECT jsonb_object_agg(id, "legacyToolRecheckPending") FROM "McpServer")
)`;

export const mcpLegacyToolRecheckFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('mcp-recheck-owner', 'Synthetic owner', 'active', now());
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, "archivedAt", draft,
  "testedDraftHash", "draftTestEvidence", "sharedConfigEnvelope", "sharedConfigVersion", "updatedAt")
SELECT 'mcp-recheck-' || name, 'recheck_' || name, 'Synthetic server', enabled, archived,
  '{"toolAllowlist":["read"],"transport":"streamable-http"}'::jsonb,
  'synthetic-draft-hash', '{"toolNames":["read"]}'::jsonb, 'synthetic-sealed-config', 7, now()
FROM (VALUES
  ('untouched', true, NULL::timestamp),
  ('consumed', true, NULL::timestamp),
  ('draft', true, NULL::timestamp),
  ('revision', true, NULL::timestamp),
  ('shared', true, NULL::timestamp),
  ('enabled', true, NULL::timestamp),
  ('archived', true, NULL::timestamp),
  ('disabled', false, NULL::timestamp),
  ('already_archived', true, '2026-09-01'::timestamp),
  ('unpublished', true, NULL::timestamp)
) AS fixture(name, enabled, archived);
INSERT INTO "McpRevision" (id, "serverId", "revisionNumber", configuration,
  "validationEvidence", "draftHash", "identityHash")
SELECT id || '-v1', id, 1, draft, "draftTestEvidence", "testedDraftHash", 'synthetic-identity-v1'
FROM "McpServer" WHERE id <> 'mcp-recheck-unpublished';
INSERT INTO "McpRevision" (id, "serverId", "revisionNumber", configuration,
  "validationEvidence", "draftHash", "identityHash")
SELECT id || '-v2', id, 2, draft, "draftTestEvidence", "testedDraftHash", 'synthetic-identity-v2'
FROM "McpServer" WHERE id = 'mcp-recheck-revision';
UPDATE "McpServer" SET "activeRevisionId" = id || '-v1' WHERE id <> 'mcp-recheck-unpublished';
INSERT INTO "McpGrant" (id, "serverId", "userId", "canUse", "personalSlotKeys", "updatedAt")
VALUES ('mcp-recheck-grant', 'mcp-recheck-untouched', 'mcp-recheck-owner', true, ARRAY['synthetic-token'], now());
INSERT INTO "McpToolAccessPolicy" (id, "serverId", "toolName", restricted)
VALUES ('mcp-recheck-policy', 'mcp-recheck-untouched', 'read', true);
INSERT INTO "McpToolUserGrant" ("policyId", "userId") VALUES ('mcp-recheck-policy', 'mcp-recheck-owner');
CREATE TABLE "McpRecheckAdoptionFixture" (phase text PRIMARY KEY, snapshot jsonb NOT NULL);
INSERT INTO "McpRecheckAdoptionFixture" VALUES ('before', (${storedStateSql}));
`;

export const mcpLegacyToolRecheckProofSql = `
DO $$ BEGIN
  IF (${storedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpRecheckAdoptionFixture" WHERE phase = 'before') THEN
    RAISE EXCEPTION 'mcp_recheck_existing_configuration_revision_or_grant_changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "McpServer" WHERE "legacyToolRecheckPending" IS DISTINCT FROM
    (id NOT IN ('mcp-recheck-disabled', 'mcp-recheck-already_archived', 'mcp-recheck-unpublished'))) THEN
    RAISE EXCEPTION 'mcp_recheck_predecessor_backfill_wrong';
  END IF;
END $$;

-- Old writers do not know the new column. Unrelated and same-value writes retain the marker.
UPDATE "McpServer" SET "displayName" = 'Renamed synthetic server', description = 'Synthetic description',
  "updatedAt" = now(), draft = draft, "activeRevisionId" = "activeRevisionId",
  "sharedConfigVersion" = "sharedConfigVersion", enabled = enabled, "archivedAt" = "archivedAt"
WHERE id = 'mcp-recheck-untouched';
UPDATE "McpServer" SET draft = draft || '{"toolAllowlist":[]}'::jsonb WHERE id = 'mcp-recheck-draft';
UPDATE "McpServer" SET "activeRevisionId" = id || '-v2' WHERE id = 'mcp-recheck-revision';
UPDATE "McpServer" SET "sharedConfigVersion" = 8 WHERE id = 'mcp-recheck-shared';
UPDATE "McpServer" SET enabled = false WHERE id = 'mcp-recheck-enabled';
UPDATE "McpServer" SET "archivedAt" = now() WHERE id = 'mcp-recheck-archived';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "McpServer" WHERE id = 'mcp-recheck-untouched' AND "legacyToolRecheckPending") THEN
    RAISE EXCEPTION 'mcp_recheck_unrelated_write_cancelled_marker';
  END IF;
  IF EXISTS (SELECT 1 FROM "McpServer" WHERE id IN ('mcp-recheck-draft', 'mcp-recheck-revision',
    'mcp-recheck-shared', 'mcp-recheck-enabled', 'mcp-recheck-archived') AND "legacyToolRecheckPending") THEN
    RAISE EXCEPTION 'mcp_recheck_old_writer_edit_did_not_cancel_marker';
  END IF;
END $$;

-- Post-upgrade creation and publication also work without naming the new field.
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, "updatedAt")
VALUES ('mcp-recheck-new', 'recheck_new', 'Synthetic new server', true, now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "McpServer" WHERE id = 'mcp-recheck-new' AND NOT "legacyToolRecheckPending") THEN
    RAISE EXCEPTION 'mcp_recheck_new_server_not_default_false';
  END IF;
END $$;
INSERT INTO "McpRevision" (id, "serverId", "revisionNumber", configuration,
  "validationEvidence", "draftHash", "identityHash")
VALUES ('mcp-recheck-new-v1', 'mcp-recheck-new', 1, '{}', '{"toolNames":[]}', 'new-draft', 'new-identity');
UPDATE "McpServer" SET "activeRevisionId" = 'mcp-recheck-new-v1' WHERE id = 'mcp-recheck-new';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "McpServer" WHERE id = 'mcp-recheck-new' AND NOT "legacyToolRecheckPending") THEN
    RAISE EXCEPTION 'mcp_recheck_new_publication_queued_upgrade_marker';
  END IF;
END $$;
UPDATE "McpServer" SET "legacyToolRecheckPending" = false WHERE id = 'mcp-recheck-consumed';
INSERT INTO "McpRecheckAdoptionFixture" VALUES ('after', (${upgradedStateSql}));
`;

export const mcpLegacyToolRecheckRepeatProofSql = `
DO $$ BEGIN
  IF (${upgradedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "McpRecheckAdoptionFixture" WHERE phase = 'after') THEN
    RAISE EXCEPTION 'mcp_recheck_redeploy_changed_rows_or_requeued_consumed_marker';
  END IF;
END $$;
`;
