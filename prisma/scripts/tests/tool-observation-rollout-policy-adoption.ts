export const TOOL_OBSERVATION_ROLLOUT_POLICY_MIGRATION = "20260924230000_tool_observation_rollout_policy";

// An administrator-saved installation policy and an accepted pre-rollout run.
// Explicit columns keep the proof valid when later migrations add columns.
export const toolObservationRolloutPolicyFixtureSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" WHERE id = 'installation')
    THEN RAISE EXCEPTION 'observation_rollout_fixture_policy_missing'; END IF;
END $$;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('observation-rollout-owner', 'Synthetic owner', 'active', now());
UPDATE "ModelPolicy" SET "reasoningEffort" = 'high', "memoryAdmissionTimeoutSeconds" = 45,
  "maxToolCalls" = 37, "maxToolRounds" = 9, "maxMcpToolsPerDiscovery" = 11,
  "mcpAutoDiscoveryTimeoutSeconds" = 70, "mcpAutoDiscoveryMaxOutputTokens" = 4096,
  version = version + 3, "updatedByUserId" = 'observation-rollout-owner',
  "updatedAt" = TIMESTAMP '2026-09-01 00:00:00'
WHERE id = 'installation';
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('observation-rollout-chat', 'observation-rollout-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('observation-rollout-question', 'observation-rollout-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
       ('observation-rollout-answer', 'observation-rollout-chat', 'assistant', 'streaming', '{"text":""}', 'observation-rollout-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('observation-rollout-run', 'observation-rollout-chat', 'observation-rollout-owner', 'observation-rollout-question',
        'observation-rollout-answer', 'fake', 'synthetic-model', 'streaming', '{"toolMode":"auto"}', now());
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, result, "updatedAt")
VALUES ('observation-rollout-call', 'observation-rollout-run', 1, 0, 'synthetic-call', 'synthetic_tool', '{}', 'complete',
        '{"callId":"synthetic-call","name":"synthetic_tool","status":"complete","content":[{"type":"text","text":"accepted inline bytes"}]}', now());
CREATE TABLE "_ObservationRolloutFixture" AS
SELECT p.id, p."defaultProviderModelId", p."reasoningEffort", p."memoryAdmissionTimeoutSeconds", p."maxToolCalls",
  p."maxToolRounds", p."maxMcpToolsPerDiscovery", p."mcpAutoDiscoveryTimeoutSeconds", p."mcpAutoDiscoveryMaxOutputTokens",
  p.version, p."updatedByUserId", p."createdAt", p."updatedAt",
  r.status AS "runStatus", r."normalizedRequest" AS "runRequest", r."updatedAt" AS "runUpdatedAt",
  c.state AS "callState", c.result AS "callResult", c."updatedAt" AS "callUpdatedAt"
FROM "ModelPolicy" p
CROSS JOIN "ModelRun" r
JOIN "ModelRunToolCall" c ON c."modelRunId" = r.id AND c.id = 'observation-rollout-call'
WHERE p.id = 'installation' AND r.id = 'observation-rollout-run';
`;

export const toolObservationRolloutPolicyProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "_ObservationRolloutFixture") <> 1
    THEN RAISE EXCEPTION 'observation_rollout_fixture_missing'; END IF;
  -- The new column defaults to v1 (observations and compaction on without an
  -- administrator action); every existing policy value is unchanged.
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" p JOIN "_ObservationRolloutFixture" f ON f.id = p.id
    WHERE p."toolObservationPolicy" = 'v1'
      AND p."defaultProviderModelId" IS NOT DISTINCT FROM f."defaultProviderModelId"
      AND p."reasoningEffort" IS NOT DISTINCT FROM f."reasoningEffort"
      AND p."memoryAdmissionTimeoutSeconds" = f."memoryAdmissionTimeoutSeconds"
      AND p."maxToolCalls" = f."maxToolCalls" AND p."maxToolRounds" = f."maxToolRounds"
      AND p."maxMcpToolsPerDiscovery" = f."maxMcpToolsPerDiscovery"
      AND p."mcpAutoDiscoveryTimeoutSeconds" IS NOT DISTINCT FROM f."mcpAutoDiscoveryTimeoutSeconds"
      AND p."mcpAutoDiscoveryMaxOutputTokens" IS NOT DISTINCT FROM f."mcpAutoDiscoveryMaxOutputTokens"
      AND p.version = f.version AND p."updatedByUserId" IS NOT DISTINCT FROM f."updatedByUserId"
      AND p."createdAt" = f."createdAt" AND p."updatedAt" = f."updatedAt")
    THEN RAISE EXCEPTION 'observation_rollout_changed_model_policy'; END IF;
  -- An accepted run keeps its frozen request: no observation version backfill.
  IF NOT EXISTS (SELECT 1 FROM "_ObservationRolloutFixture" f
    JOIN "ModelRun" r ON r.id = 'observation-rollout-run'
    JOIN "ModelRunToolCall" c ON c.id = 'observation-rollout-call'
    WHERE r.status = f."runStatus" AND r."normalizedRequest" = f."runRequest" AND r."updatedAt" = f."runUpdatedAt"
      AND NOT (r."normalizedRequest" ? 'toolObservationVersion')
      AND c.state = f."callState" AND c.result = f."callResult" AND c."updatedAt" = f."callUpdatedAt")
    THEN RAISE EXCEPTION 'observation_rollout_changed_historical_run'; END IF;
  -- Off remains the operator's kill switch.
  UPDATE "ModelPolicy" SET "toolObservationPolicy" = 'off' WHERE id = 'installation';
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy"
    WHERE id = 'installation' AND "toolObservationPolicy" = 'off')
    THEN RAISE EXCEPTION 'observation_rollout_policy_off_not_persisted'; END IF;
  BEGIN
    UPDATE "ModelPolicy" SET "toolObservationPolicy" = 'future' WHERE id = 'installation';
    RAISE EXCEPTION 'observation_rollout_policy_accepts_unknown';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DROP TABLE "_ObservationRolloutFixture";
`;
