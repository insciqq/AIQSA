-- The storage removed features left behind goes in v0.5.0 (operator request 2026-11-22): the old run core's last
-- active runs, the Codex Agent's approval source and Telegram toggles, the retired Knowledge row of chat overrides and
-- the retired decision features, the Knowledge, MCP discovery and old-core columns of usage, MCP Hub discovery attempts,
-- the one-time cost and MCP recheck adoptions, and columns nothing reads: the Answer Review choices, the Knowledge
-- defaults, the image parameters, the decision adoption markers, the Assistant developer prompt, the integer token
-- prices and the follow-up Knowledge cursor. Nothing in this release reads or writes any of it, and the production
-- rollout stops the previous release's app and worker before migrating (`agent_docs/PERSISTENCE.md`).
--
-- Kept on purpose: the `knowledge_*` usage purposes, which old usage rows still display; `ModelRun.engine`, which tells
-- the old core's answers apart; the stored request of every accepted run (snapshots are never rewritten); the chat's
-- `defaultSearchPlan`, which the previous release's tabs still send until v0.5.1; and Answer Review's sessions.
--
-- Values are rewritten or deleted first, then the storage goes:
-- - The old core's runs still active end once, as its startup sweep ended them: a Codex Agent turn as
--   `agent_mode_removed`, any other as interrupted with Continue, both final. Nothing is sent again; the answer keeps its
--   text, a call still running keeps an unknown outcome, a pending one is cancelled, a Workspace hand-off waiting for
--   the run fails, and the chat moves up the list (a Temporary chat a day past now) and is marked for past-chat search.
--   Their document preparations fail with them through the run's own terminal trigger. Every preparation planned
--   before the docling sidecar's removal belongs to such a run (the engine column, the agent engine and that removal
--   shipped together in v0.4.0), so one still unfinished fails too, whatever its run's state: no reader of its layout
--   is left. The Workspace guest of such a run is not reached from SQL; its session ends on its own idle stop.
-- - An approval card of the removed Codex Agent becomes a model card: both name their refused call, and a decided
--   card reads the same.
-- - Telegram buttons of the retired Workspace and Agent toggles are deleted: no handler answers them, and a press on a
--   button whose row is gone answers as expired, as before.
-- - The retired Knowledge row leaves chat overrides (an override set left empty is stored as none), and the retired
--   decision features (`knowledgeRelevance`, `memoryRelevance`, `toolDiscovery`) leave the administrator's overrides.
--
-- Every lock is taken up front in a fixed order, the tables that stay first, and a deadlock retries instead of failing
-- the upgrade. Columns go without a rewrite; the two enum columns are rewritten (small tables); the usage shape check
-- and the run's follow-up bounds are added back without the dropped columns and only loosen, so each reads its table
-- once and refuses no existing row.

DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "User", "UserSettings", "Folder", "AssistantDefinition", "ProviderModel", "SystemModelPolicy",
        "McpServer", "Chat", "Message", "ModelRun", "ModelRunToolCall", "WorkspaceFollowup", "ChatPdfRunPreparation",
        "ChatPdfAttachmentPreparation", "ChatSearchState", "McpToolApproval", "TelegramCallback", "UsageEvent",
        "McpHubDiscoveryAttempt", "CatalogCostBackfill" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

-- Two guards stand aside while the old core's runs end, before any row changes (a table with pending trigger events
-- cannot be altered). The follow-up guard keeps an answer from completing past an accepted follow-up; these runs end
-- with an error and their undelivered follow-ups stay undelivered. The preparation guard checks every update of a
-- document preparation against its attachment and model binding again; ending one only moves it to failed, which the
-- guard always allows, and a binding that no longer checks out must not keep its run alive.
ALTER TABLE "ModelRun" DISABLE TRIGGER "ModelRun_followup_completion_guard";
ALTER TABLE "ChatPdfAttachmentPreparation" DISABLE TRIGGER "ChatPdfAttachmentPreparation_guard";

CREATE TEMPORARY TABLE "aiqsa_retired_engine_run" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "assistantMessageId" TEXT,
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL
) ON COMMIT DROP;

-- A Codex Agent turn is one whose accepted request names an `agent` object (`isRetiredAgentRequest`).
INSERT INTO "aiqsa_retired_engine_run" ("id", "userId", "chatId", "assistantMessageId", "code", "message")
SELECT run."id", run."userId", run."chatId", run."assistantMessageId",
  CASE WHEN jsonb_typeof(run."normalizedRequest" -> 'agent') IN ('object', 'array') THEN 'agent_mode_removed'
    ELSE 'run_interrupted' END,
  CASE WHEN jsonb_typeof(run."normalizedRequest" -> 'agent') IN ('object', 'array')
    THEN 'Agent mode was removed, so this answer stopped. Nothing it started was replayed. Send the message again to continue.'
    ELSE 'This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up.' END
FROM "ModelRun" AS run
WHERE run."engine" = 'v1' AND run."status" IN ('preparing', 'queued', 'streaming', 'in_progress');

-- As the run repository's recovery terminal path ends a run (`failRun` with `recoveryTerminal`): a run that was still
-- preparing has no request written yet and gets an empty one.
UPDATE "ModelRun" AS run SET
  "status" = 'error',
  "normalizedRequest" = COALESCE(run."normalizedRequest", '{}'::jsonb),
  "errorPayload" = jsonb_build_object('code', ended."code", 'message', ended."message", 'recoveryTerminal', true),
  "answerCompletionUsage" = NULL,
  "workspaceWaitPending" = false,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "aiqsa_retired_engine_run" AS ended
WHERE run."id" = ended."id";

UPDATE "ModelRunToolCall" AS call SET "state" = 'cancelled', "completedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "aiqsa_retired_engine_run" AS ended
WHERE call."modelRunId" = ended."id" AND call."state" = 'pending';

-- A running call may already have had effects, so it keeps an unknown outcome (`runEndedToolCallResult`).
UPDATE "ModelRunToolCall" AS call SET "state" = 'error', "completedAt" = CURRENT_TIMESTAMP,
  "result" = '{"code":"run_ended_before_tool_settled","outcome":"unknown"}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
FROM "aiqsa_retired_engine_run" AS ended
WHERE call."modelRunId" = ended."id" AND call."state" = 'running';

UPDATE "WorkspaceFollowup" AS followup SET "state" = 'failed', "errorCode" = ended."code", "snapshot" = NULL,
  "admissionResult" = NULL, "claimToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
FROM "aiqsa_retired_engine_run" AS ended
WHERE followup."modelRunId" = ended."id" AND followup."state" IN ('waiting', 'preparing');

UPDATE "Message" AS message SET "status" = 'error', "errorMessage" = ended."message", "updatedAt" = CURRENT_TIMESTAMP
FROM "aiqsa_retired_engine_run" AS ended
WHERE message."id" = ended."assistantMessageId" AND message."chatId" = ended."chatId"
  AND message."status" IN ('queued', 'streaming');

UPDATE "Chat" AS chat SET "updatedAt" = CURRENT_TIMESTAMP,
  "temporaryRetentionDeadline" = CASE
    WHEN chat."memoryMode" = 'TEMPORARY' THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '24 hours'
    ELSE chat."temporaryRetentionDeadline"
  END
WHERE chat."permanentDeletionAt" IS NULL
  AND EXISTS (SELECT 1 FROM "aiqsa_retired_engine_run" AS ended
    WHERE ended."chatId" = chat."id" AND ended."userId" = chat."userId");

-- The past-chat index reconciles the chat with its active branch on its next pass (`markChatSearchDirty`); a chat with
-- no state yet is reached by the backfill.
UPDATE "ChatSearchState" AS state SET
  "dirtyAt" = GREATEST(clock_timestamp()::timestamp(3), state."dirtyAt" + INTERVAL '1 millisecond'),
  "nextAttemptAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "aiqsa_retired_engine_run" AS ended
  WHERE ended."chatId" = state."chatId" AND ended."userId" = state."userId" AND ended."assistantMessageId" IS NOT NULL);

-- An unfinished document preparation of an old-core run fails, as the run's terminal trigger fails it.
UPDATE "ChatPdfAttachmentPreparation" AS preparation SET "state" = 'failed', "errorCode" = 'pdf_preparation_failed',
  "retryable" = true, "updatedAt" = CURRENT_TIMESTAMP
FROM "ModelRun" AS run
WHERE run."id" = preparation."modelRunId" AND run."engine" = 'v1'
  AND preparation."state" IN ('checking', 'preparing', 'assembling');
UPDATE "ChatPdfRunPreparation" AS job SET "state" = 'failed', "claimToken" = NULL, "claimedAt" = NULL,
  "errorCode" = 'pdf_preparation_failed', "retryable" = true, "updatedAt" = CURRENT_TIMESTAMP
FROM "ModelRun" AS run
WHERE run."id" = job."modelRunId" AND run."engine" = 'v1' AND job."state" IN ('pending', 'preparing', 'answer_ready');

DO $migration$
DECLARE
  ended integer;
BEGIN
  SELECT count(*) INTO ended FROM "aiqsa_retired_engine_run";
  IF ended > 0 THEN
    RAISE WARNING 'retired_engine_runs_ended count=%', ended;
  END IF;
END;
$migration$;

UPDATE "McpToolApproval" SET "source" = 'model' WHERE "source" = 'agent';

DELETE FROM "TelegramCallback" WHERE "kind" IN ('toggle_workspace', 'toggle_agent');

UPDATE "Chat" SET "assistantOverrides" = NULLIF("assistantOverrides" - 'knowledge', '{}'::jsonb)
WHERE jsonb_typeof("assistantOverrides") = 'object' AND "assistantOverrides" ? 'knowledge';

UPDATE "SystemModelPolicy"
SET "decisionFeaturesJson" = "decisionFeaturesJson" - ARRAY['knowledgeRelevance', 'memoryRelevance', 'toolDiscovery']
WHERE jsonb_typeof("decisionFeaturesJson") = 'object'
  AND "decisionFeaturesJson" ?| ARRAY['knowledgeRelevance', 'memoryRelevance', 'toolDiscovery'];

-- The rewrites' deferred checks (the preparation gate, Workspace hand-off ownership, deferred keys) run now, so no
-- trigger event is pending when the tables change below; then the two guards stand again.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "ModelRun" ENABLE TRIGGER "ModelRun_followup_completion_guard";
ALTER TABLE "ChatPdfAttachmentPreparation" ENABLE TRIGGER "ChatPdfAttachmentPreparation_guard";

-- Enum values: PostgreSQL drops none in place, so each type is replaced by one without them and its column converted.
-- The state check compares "source" with an enum constant, so it is dropped around the conversion and restored unchanged.
ALTER TABLE "McpToolApproval" DROP CONSTRAINT "McpToolApproval_state_check";
ALTER TYPE "McpToolApprovalSource" RENAME TO "McpToolApprovalSource_retired";
CREATE TYPE "McpToolApprovalSource" AS ENUM ('model', 'code');
ALTER TABLE "McpToolApproval"
  ALTER COLUMN "source" TYPE "McpToolApprovalSource" USING "source"::text::"McpToolApprovalSource";
DROP TYPE "McpToolApprovalSource_retired";
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_state_check" CHECK (
  ("decision" IS NULL) = ("decidedAt" IS NULL)
  AND ("decisionNonce" IS NULL OR "decision" IS NOT NULL)
  AND (("expiresAt" IS NOT NULL) = ("decision" IS NOT NULL AND "decision" = 'allow_once'))
  AND (("consumedAt" IS NULL) = ("consumedByRunId" IS NULL))
  AND ("consumedAt" IS NULL OR "decision" = 'allow_once')
  AND (("source" = 'code') = ("toolCallId" IS NULL))
  AND "definitionHash" ~ '^[0-9a-f]{64}$'
  AND "argumentsDigest" ~ '^[0-9a-f]{64}$'
);

ALTER TYPE "TelegramCallbackKind" RENAME TO "TelegramCallbackKind_retired";
CREATE TYPE "TelegramCallbackKind" AS ENUM ('approval_allow_once', 'approval_allow_server', 'approval_deny',
  'select_chat', 'select_assistant', 'select_model', 'model_page', 'toggle_search', 'stop_run', 'unlink_confirm',
  'open_settings', 'change_undo', 'change_confirm', 'change_cancel');
ALTER TABLE "TelegramCallback"
  ALTER COLUMN "kind" TYPE "TelegramCallbackKind" USING "kind"::text::"TelegramCallbackKind";
DROP TYPE "TelegramCallbackKind_retired";

-- The one-time MCP recheck of servers with name-only evidence: every start since 2026-09-27 consumed its markers.
DROP TRIGGER IF EXISTS "McpServer_cancel_legacy_tool_recheck_on_edit" ON "McpServer";
DROP FUNCTION IF EXISTS "cancel_mcp_legacy_tool_recheck_on_edit"();
ALTER TABLE "McpServer" DROP COLUMN "legacyToolRecheckPending";

-- The one-time catalog cost adoption: the usage guards of PDF preparation and chat titles lose its exception, which
-- nothing applies any more; everything else they guard is unchanged.
CREATE OR REPLACE FUNCTION chat_pdf_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."chatPdfPreparation" IS DISTINCT FROM OLD."chatPdfPreparation" OR
    OLD."chatPdfPreparation" AND (
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens",NEW."cachedInputTokens",NEW."cacheWriteInputTokens",NEW."outputTokens",
          NEW."reasoningTokens",NEW."totalTokens",NEW."estimatedCostMicros",NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens",OLD."cachedInputTokens",OLD."cacheWriteInputTokens",OLD."outputTokens",
          OLD."reasoningTokens",OLD."totalTokens",OLD."estimatedCostMicros",OLD."usageCompleteness")) OR
      ROW(NEW."userId",NEW."provider",NEW."modelId",NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId",OLD."provider",OLD."modelId",OLD."providerModelId") OR
      (NEW."chatPdfPageAttemptId" IS NOT NULL AND NEW."chatPdfPageAttemptId" IS DISTINCT FROM OLD."chatPdfPageAttemptId")
    )) THEN RAISE EXCEPTION 'chat_pdf_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatPdfPreparation" AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfPageAttempt" a
    JOIN "ChatPdfAttachmentPreparation" p ON p."id" = a."preparationId"
    JOIN "ModelRun" r ON r."id" = p."modelRunId"
    WHERE a."id" = NEW."chatPdfPageAttemptId" AND a."state" = 'dispatched'
      AND p."providerModelId" = NEW."providerModelId" AND p."modelRunId" = NEW."modelRunId"
      AND r."userId" = NEW."userId" AND r."chatId" = NEW."chatId"
  ) THEN RAISE EXCEPTION 'chat_pdf_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chat_title_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."chatTitleGeneration" IS DISTINCT FROM OLD."chatTitleGeneration" OR
    OLD."chatTitleGeneration" AND (
      ROW(NEW."userId", NEW."provider", NEW."modelId", NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId", OLD."provider", OLD."modelId", OLD."providerModelId") OR
      (NEW."chatTitleGenerationId" IS NOT NULL AND NEW."chatTitleGenerationId" IS DISTINCT FROM OLD."chatTitleGenerationId") OR
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens", NEW."outputTokens",
          NEW."reasoningTokens", NEW."totalTokens", NEW."estimatedCostMicros", NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens", OLD."cachedInputTokens", OLD."cacheWriteInputTokens", OLD."outputTokens",
          OLD."reasoningTokens", OLD."totalTokens", OLD."estimatedCostMicros", OLD."usageCompleteness"))
    )
  ) THEN RAISE EXCEPTION 'chat_title_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatTitleGeneration" AND NOT EXISTS (
    SELECT 1 FROM "ChatTitleGeneration" title
    WHERE title."runId" = NEW."chatTitleGenerationId" AND title."runId" = NEW."modelRunId"
      AND title."status" = 'dispatched' AND title."userId" = NEW."userId" AND title."chatId" = NEW."chatId"
      AND title."providerSnapshot"->>'providerModelId' = NEW."providerModelId"
      AND title."providerSnapshot"->>'providerFamily' = NEW."provider"
      AND title."providerSnapshot"->'model'->>'upstreamModelId' = NEW."modelId"
  ) THEN RAISE EXCEPTION 'chat_title_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

DROP FUNCTION catalog_cost_adoption_valid("UsageEvent", "UsageEvent");
DROP TABLE "CatalogCostBackfill";

-- Usage keeps every row, its purpose and its counts. A check naming a dropped column would go with it silently, so the
-- shape check is dropped first and added back without the Knowledge, relevance and MCP discovery branches; the rows
-- those branches allowed have no flag left and pass as plain rows. The columns' keys, unique indexes and link checks go
-- with them, the MCP discovery attempts' key included, and then their table.
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_knowledge_shape_check",
  DROP COLUMN "knowledgeImageObservationRunId",
  DROP COLUMN "knowledgeRelevance",
  DROP COLUMN "knowledgeRelevanceAttemptId",
  DROP COLUMN "mcpHubDiscovery",
  DROP COLUMN "mcpHubDiscoveryAttemptId",
  DROP COLUMN "knowledgeBaseId",
  DROP COLUMN "knowledgeIndexGenerationId",
  DROP COLUMN "knowledgeDocumentVersionId",
  DROP COLUMN "knowledgeBatchIndex",
  DROP COLUMN "knowledgePdfProcessingAttemptId";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_shape_check" CHECK (
  (NOT "visionAnalysis" AND "visionAnalysisAttemptId" IS NULL AND (
    (NOT "optionalDecision" AND (
      (NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL AND (
        (NOT "imageGeneration" AND "imageToolCallId" IS NULL AND (
          (NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
          OR ("chatPdfPreparation" AND "providerModelId" IS NOT NULL)
        ))
        OR ("imageGeneration" AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
          AND "providerModelId" IS NOT NULL)
      ))
      OR ("chatTitleGeneration" AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
        AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
        AND "providerModelId" IS NOT NULL AND "projectId" IS NULL)
    ))
    OR ("optionalDecision" AND "providerModelId" IS NOT NULL
      AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
      AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
      AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
  ))
  OR ("visionAnalysis" AND "providerModelId" IS NOT NULL
    AND NOT "optionalDecision" AND "optionalDecisionAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL)
);
DROP TABLE "McpHubDiscoveryAttempt";

-- The follow-up bounds lose only the Knowledge cursor's terms.
ALTER TABLE "ModelRun"
  DROP CONSTRAINT "ModelRun_followup_bounds",
  DROP COLUMN "followupKnowledgeRevision",
  DROP COLUMN "followupKnowledgeOffset";
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_followup_bounds" CHECK (
  "followupRevision" BETWEEN 0 AND 96 AND "followupBudgetTokens" >= 0 AND
  ("followupMode" IS NULL OR "followupMode" IN ('chat', 'workspace', 'agent'))
);

-- Columns nothing reads, with the checks that named only them.
ALTER TABLE "UserSettings" DROP COLUMN "defaultAnswerReview", DROP COLUMN "defaultKnowledgePlan";
ALTER TABLE "Chat" DROP COLUMN "answerReviewConfig", DROP COLUMN "defaultKnowledgePlan";
ALTER TABLE "Folder" DROP COLUMN "defaultKnowledgePlan";
ALTER TABLE "SystemModelPolicy"
  DROP COLUMN "imageParamsJson",
  DROP COLUMN "decisionAdoptionVersion",
  DROP COLUMN "decisionAdoptionReason";
ALTER TABLE "AssistantDefinition" DROP COLUMN "developerPrompt";
ALTER TABLE "ProviderModel" DROP COLUMN "inputTokenPriceMicros", DROP COLUMN "outputTokenPriceMicros";

-- Nothing that stays may still name what went: a routine, constraint or index naming a dropped table, column or
-- routine, or the retired enum values, would fail on its next use, so it fails the migration here instead.
DO $migration$
DECLARE
  missed text;
BEGIN
  WITH retired AS (
    SELECT '"(knowledgeImageObservationRunId|knowledgeRelevance|knowledgeRelevanceAttemptId|mcpHubDiscovery|'
      || 'mcpHubDiscoveryAttemptId|knowledgeBaseId|knowledgeIndexGenerationId|knowledgeDocumentVersionId|'
      || 'knowledgeBatchIndex|knowledgePdfProcessingAttemptId|McpHubDiscoveryAttempt|CatalogCostBackfill|'
      || 'legacyToolRecheckPending|followupKnowledgeRevision|followupKnowledgeOffset|defaultAnswerReview|'
      || 'answerReviewConfig|defaultKnowledgePlan|imageParamsJson|decisionAdoptionVersion|decisionAdoptionReason|'
      || 'developerPrompt|inputTokenPriceMicros|outputTokenPriceMicros)"'
      || '|catalog_cost_adoption_valid|cancel_mcp_legacy_tool_recheck_on_edit|''toggle_(workspace|agent)''' AS pattern
  ), found AS (
    SELECT 'routine ' || routine.oid::regprocedure::text AS item
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = current_schema() AND routine.prosrc ~ (SELECT pattern FROM retired)
    UNION ALL
    SELECT 'constraint ' || relation.relname || '.' || constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND constraint_row.contype <> 'n'
      AND pg_get_constraintdef(constraint_row.oid) ~ (SELECT pattern FROM retired)
    UNION ALL
    SELECT 'index ' || index_relation.relname
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND pg_get_indexdef(index_row.indexrelid) ~ (SELECT pattern FROM retired)
  )
  SELECT string_agg(item, ', ' ORDER BY item) INTO missed FROM found;
  IF missed IS NOT NULL THEN
    RAISE EXCEPTION 'retired_feature_dependency_left: %', missed;
  END IF;
END;
$migration$;
