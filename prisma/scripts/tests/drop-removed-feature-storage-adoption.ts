/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const DROP_REMOVED_FEATURE_STORAGE_MIGRATION = "20261123010000_drop_removed_feature_storage";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]): string => values.map(quote).join(", ");

const INTERRUPTED = "This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up.";
const AGENT_REMOVED = "Agent mode was removed, so this answer stopped. Nothing it started was replayed. Send the message again to continue.";
const BEFORE = "2026-10-01 07:00:00";

/** Columns the drop removes from tables that stay, by table. */
const DROPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  AssistantDefinition: ["developerPrompt"],
  Chat: ["answerReviewConfig", "defaultKnowledgePlan"],
  Folder: ["defaultKnowledgePlan"],
  McpServer: ["legacyToolRecheckPending"],
  ModelRun: ["followupKnowledgeRevision", "followupKnowledgeOffset"],
  ProviderModel: ["inputTokenPriceMicros", "outputTokenPriceMicros"],
  SystemModelPolicy: ["imageParamsJson", "decisionAdoptionVersion", "decisionAdoptionReason"],
  UsageEvent: ["knowledgeImageObservationRunId", "knowledgeRelevance", "knowledgeRelevanceAttemptId", "mcpHubDiscovery",
    "mcpHubDiscoveryAttemptId", "knowledgeBaseId", "knowledgeIndexGenerationId", "knowledgeDocumentVersionId",
    "knowledgeBatchIndex", "knowledgePdfProcessingAttemptId"],
  UserSettings: ["defaultAnswerReview", "defaultKnowledgePlan"]
};

/** One digest of a table's rows (less the named keys), so a proof can show they did not change. */
const rowsDigest = (table: string, where = "TRUE", minus: readonly string[] = []): string => {
  const row = minus.length > 0 ? `(to_jsonb(r) - ARRAY[${list(minus)}]::text[])` : "to_jsonb(r)";
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY ${row}::text), '')) FROM "${table}" AS r WHERE ${where})`;
};

/** The old core's runs the fixture leaves active, their answers and chats; each ends in the drop. */
const ENDED_RUNS = ["drf-stream-run", "drf-agent-run", "drf-pdf-run", "drf-wait-run"];
const ENDED_ANSWERS = ["drf-stream-answer", "drf-agent-answer", "drf-pdf-answer", "drf-wait-answer"];
const ENDED_CHATS = ["drf-stream-chat", "drf-agent-chat", "drf-pdf-chat", "drf-wait-chat"];
/** Chats whose Assistant overrides named the retired Knowledge row. */
const STRIPPED_CHATS = ["drf-overrides-chat", "drf-knowledge-only-chat", "drf-fenced-chat"];
/** Runs whose unfinished document preparations end with the drop. */
const PDF_RUNS = ["drf-pdf-run", "drf-error-run"];

/** What the drop must leave as it was: every row outside the rewrites, less the columns that go. */
const keptDigest = `md5(concat_ws('|', ${[
  rowsDigest("User"),
  rowsDigest("UserSettings", "TRUE", DROPPED_COLUMNS.UserSettings),
  rowsDigest("Folder", "TRUE", DROPPED_COLUMNS.Folder),
  rowsDigest("AssistantDefinition", "TRUE", DROPPED_COLUMNS.AssistantDefinition),
  rowsDigest("ProviderModel", "TRUE", DROPPED_COLUMNS.ProviderModel),
  rowsDigest("SystemModelPolicy", "TRUE", [...DROPPED_COLUMNS.SystemModelPolicy, "decisionFeaturesJson"]),
  rowsDigest("McpServer", "TRUE", DROPPED_COLUMNS.McpServer),
  rowsDigest("UsageEvent", "TRUE", DROPPED_COLUMNS.UsageEvent),
  rowsDigest("Chat", `r.id NOT IN (${list([...ENDED_CHATS, ...STRIPPED_CHATS])})`, DROPPED_COLUMNS.Chat),
  rowsDigest("Chat", `r.id IN (${list(STRIPPED_CHATS)})`, [...DROPPED_COLUMNS.Chat, "assistantOverrides"]),
  rowsDigest("ModelRun", `r.id NOT IN (${list(ENDED_RUNS)})`, DROPPED_COLUMNS.ModelRun),
  rowsDigest("Message", `r.id NOT IN (${list(ENDED_ANSWERS)})`),
  rowsDigest("ModelRunToolCall", `r."modelRunId" NOT IN (${list(ENDED_RUNS)})`),
  rowsDigest("WorkspaceFollowup", `r."modelRunId" NOT IN (${list(ENDED_RUNS)})`),
  rowsDigest("ChatPdfRunPreparation", `r."modelRunId" NOT IN (${list(PDF_RUNS)})`),
  rowsDigest("ChatPdfAttachmentPreparation", `r."modelRunId" NOT IN (${list(PDF_RUNS)})`),
  rowsDigest("ChatSearchState", `r."chatId" NOT IN (${list(ENDED_CHATS)})`),
  rowsDigest("McpToolApproval", "r.id <> 'drf-approval-agent'"),
  rowsDigest("McpToolApproval", "r.id = 'drf-approval-agent'", ["source"]),
  rowsDigest("TelegramCallback", "r.kind::text NOT IN ('toggle_workspace', 'toggle_agent')"),
  rowsDigest("TelegramLink")
].join(",\n  ")}))`;

const question = `'{"blocks":[{"type":"text","text":"Synthetic question"}]}'`;
const hex = (character: string): string => `repeat('${character}', 64)`;

// Every retired value the previous release may hold, written in replica mode (no triggers or keys, checks kept) as
// that release left it: the old core's active runs (an ordinary turn with pending, running and finished calls and a
// past-chat state, a Codex Agent turn in a Temporary chat, one waiting at its PDF gate, one waiting for a Workspace
// hand-off behind a finished run with the follow-up Knowledge cursor) beside runs that stay (finished, a recoverable
// error with a document preparation left unfinished, an agent-engine run); approval cards of each source; Telegram
// buttons of each retired toggle beside a live one; chat overrides with the Knowledge row (beside another row, alone,
// on a chat fenced for deletion, and a deleted Assistant's marker); the retired decision features; usage of every
// retired shape (Knowledge indexing batches and PDFs, relevance, image observation, MCP discovery with its attempt)
// beside an answer; and the unread columns set to values their defaults never hold.
export const dropRemovedFeatureStorageFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('drf-owner', 'Synthetic owner', 'active', now());
INSERT INTO "UserSettings" (id, "userId", "defaultAnswerReview", "defaultKnowledgePlan", "updatedAt")
VALUES ('drf-settings', 'drf-owner', '{"enabled":true,"maxRounds":2,"reviewers":[]}', '{"baseIds":["drf-base"]}', '${BEFORE}');
INSERT INTO "Folder" (id, "userId", name, "defaultKnowledgePlan", "updatedAt")
VALUES ('drf-folder', 'drf-owner', 'Synthetic folder', '{"baseIds":["drf-base"]}', '${BEFORE}');
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('drf-provider', 'Synthetic provider', 'openai', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities,
  "defaultParams", "inputTokenPriceMicros", "outputTokenPriceMicros", "updatedAt")
VALUES ('drf-answer', 'drf-provider', 'openai', 'synthetic-answer', 'Synthetic answer', 'answer', '{}', '{}', 3, 12, now());
INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "providerModelId", "systemPrompt", "developerPrompt",
  "searchPlan", "updatedAt")
VALUES ('drf-assistant', 'drf-owner', 'Synthetic Assistant', '{}', 'drf-answer', 'Synthetic instructions.', 'Retired prompt.',
  '{"mode":"off"}', '${BEFORE}');
UPDATE "SystemModelPolicy" SET "imageParamsJson" = '{"size":"1024x1024"}', "decisionAdoptionVersion" = 0,
  "decisionAdoptionReason" = 'pending',
  "decisionFeaturesJson" = '{"skillSuggestions":false,"memoryControlScreen":true,"toolDiscovery":false,"knowledgeRelevance":true,"memoryRelevance":false}'
WHERE id = 'installation';
INSERT INTO "McpServer" (id, namespace, "displayName", enabled, "legacyToolRecheckPending", "updatedAt")
VALUES ('drf-server', 'drf_server', 'Synthetic server', true, true, '${BEFORE}');

INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt", "answerReviewConfig", "defaultKnowledgePlan") VALUES
  ('drf-stream-chat', 'drf-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}', '{"enabled":true}', '{"baseIds":[]}'),
  ('drf-pdf-chat', 'drf-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}', NULL, NULL),
  ('drf-wait-chat', 'drf-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}', NULL, NULL),
  ('drf-kept-chat', 'drf-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}', NULL, NULL),
  ('drf-native-chat', 'drf-owner', 'Synthetic chat', '${BEFORE}', '${BEFORE}', NULL, NULL);
INSERT INTO "Chat" (id, "userId", title, "memoryMode", "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
  "createdAt", "updatedAt")
VALUES ('drf-agent-chat', 'drf-owner', 'Synthetic chat', 'TEMPORARY', 'temporary-24h-v1',
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour',
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour');
INSERT INTO "Chat" (id, "userId", title, "assistantId", "assistantOverrides", "createdAt", "updatedAt") VALUES
  ('drf-overrides-chat', 'drf-owner', 'Synthetic chat', 'drf-assistant',
    '{"knowledge":{"mode":"off"},"search":{"mode":"off"}}', '${BEFORE}', '${BEFORE}'),
  ('drf-knowledge-only-chat', 'drf-owner', 'Synthetic chat', 'drf-assistant', '{"knowledge":null}', '${BEFORE}', '${BEFORE}'),
  ('drf-deleted-assistant-chat', 'drf-owner', 'Synthetic chat', NULL, '{"assistantDeleted":true}', '${BEFORE}', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", title, "assistantId", "assistantOverrides", archived, "permanentDeletionAt",
  "permanentDeletionOperationId", "createdAt", "updatedAt")
VALUES ('drf-fenced-chat', 'drf-owner', 'Synthetic chat', 'drf-assistant', '{"knowledge":{"mode":"off"},"model":{"mode":"inherit"}}',
  true, '${BEFORE}', 'drf-fenced-operation', '${BEFORE}', '${BEFORE}');

INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "createdAt", "updatedAt") VALUES
  ('drf-stream-question', 'drf-stream-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-stream-answer', 'drf-stream-chat', 'assistant', 'streaming',
    '{"blocks":[{"type":"text","text":"Partial answer"}]}', 'drf-stream-question', '${BEFORE}', '${BEFORE}'),
  ('drf-agent-question', 'drf-agent-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-agent-answer', 'drf-agent-chat', 'assistant', 'queued', '{"blocks":[]}', 'drf-agent-question', '${BEFORE}', '${BEFORE}'),
  ('drf-pdf-question', 'drf-pdf-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-pdf-answer', 'drf-pdf-chat', 'assistant', 'streaming', '{"blocks":[]}', 'drf-pdf-question', '${BEFORE}', '${BEFORE}'),
  ('drf-done-question', 'drf-wait-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-done-answer', 'drf-wait-chat', 'assistant', 'complete',
    '{"blocks":[{"type":"text","text":"Finished answer"}]}', 'drf-done-question', '${BEFORE}', '${BEFORE}'),
  ('drf-wait-question', 'drf-wait-chat', 'user', 'complete', ${question}, 'drf-done-answer', '${BEFORE}', '${BEFORE}'),
  ('drf-wait-answer', 'drf-wait-chat', 'assistant', 'queued', '{"blocks":[]}', 'drf-wait-question', '${BEFORE}', '${BEFORE}'),
  ('drf-error-question', 'drf-kept-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-error-answer', 'drf-kept-chat', 'assistant', 'error', '{"blocks":[]}', 'drf-error-question', '${BEFORE}', '${BEFORE}'),
  ('drf-native-question', 'drf-native-chat', 'user', 'complete', ${question}, NULL, '${BEFORE}', '${BEFORE}'),
  ('drf-native-answer', 'drf-native-chat', 'assistant', 'streaming', '{"blocks":[]}', 'drf-native-question', '${BEFORE}', '${BEFORE}');
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-stream-answer' WHERE id = 'drf-stream-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-agent-answer' WHERE id = 'drf-agent-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-pdf-answer' WHERE id = 'drf-pdf-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-wait-answer' WHERE id = 'drf-wait-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-error-answer' WHERE id = 'drf-kept-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'drf-native-answer' WHERE id = 'drf-native-chat';

INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", "workspaceWaitPending", "errorPayload", engine, "createdAt", "updatedAt") VALUES
  ('drf-stream-run', 'drf-owner', 'drf-stream-chat', 'drf-stream-question', 'drf-stream-answer', 'fake', 'synthetic-model',
    'streaming', '{"content":{"blocks":[]}}', false, NULL, 'v1', '${BEFORE}', '${BEFORE}'),
  ('drf-agent-run', 'drf-owner', 'drf-agent-chat', 'drf-agent-question', 'drf-agent-answer', 'fake', 'synthetic-model',
    'in_progress', '{"agent":{"mode":"codex"}}', false, NULL, 'v1', '${BEFORE}', '${BEFORE}'),
  ('drf-pdf-run', 'drf-owner', 'drf-pdf-chat', 'drf-pdf-question', 'drf-pdf-answer', 'fake', 'synthetic-model',
    'preparing', NULL, false, NULL, 'v1', '${BEFORE}', '${BEFORE}'),
  ('drf-wait-run', 'drf-owner', 'drf-wait-chat', 'drf-wait-question', 'drf-wait-answer', 'fake', 'synthetic-model',
    'preparing', NULL, true, NULL, 'v1', '${BEFORE}', '${BEFORE}'),
  ('drf-error-run', 'drf-owner', 'drf-kept-chat', 'drf-error-question', 'drf-error-answer', 'fake', 'synthetic-model',
    'error', '{}', false, '{"code":"provider_error","message":"Synthetic failure"}', 'v1', '${BEFORE}', '${BEFORE}'),
  ('drf-native-run', 'drf-owner', 'drf-native-chat', 'drf-native-question', 'drf-native-answer', 'fake', 'synthetic-model',
    'streaming', '{}', false, NULL, 'native', '${BEFORE}', '${BEFORE}');
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", engine, "followupMode", "followupRevision", "followupKnowledgeRevision", "followupKnowledgeOffset",
  "followupClosedAt", "createdAt", "updatedAt")
VALUES ('drf-done-run', 'drf-owner', 'drf-wait-chat', 'drf-done-question', 'drf-done-answer', 'fake', 'synthetic-model',
  'complete', '{}', 'v1', 'chat', 2, 1, 3, '${BEFORE}', '${BEFORE}', '${BEFORE}');

INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state,
  "completedAt", "updatedAt") VALUES
  ('drf-call-pending', 'drf-stream-run', 0, 0, 'synthetic-pending', 'synthetic_tool', '{}', 'pending', NULL, '${BEFORE}'),
  ('drf-call-running', 'drf-stream-run', 0, 1, 'synthetic-running', 'synthetic_tool', '{}', 'running', NULL, '${BEFORE}'),
  ('drf-call-complete', 'drf-stream-run', 0, 2, 'synthetic-complete', 'synthetic_tool', '{}', 'complete', '${BEFORE}', '${BEFORE}'),
  ('drf-call-agent', 'drf-done-run', 0, 0, 'synthetic-agent', 'records__write', '{}', 'error', '${BEFORE}', '${BEFORE}'),
  ('drf-call-model', 'drf-done-run', 1, 0, 'synthetic-model', 'records__write', '{}', 'error', '${BEFORE}', '${BEFORE}');
INSERT INTO "ChatSearchState" ("chatId", "userId", "indexedLeafMessageId", "dirtyAt", "nextAttemptAt", "updatedAt") VALUES
  ('drf-stream-chat', 'drf-owner', 'drf-stream-question', '${BEFORE}', '${BEFORE}', '${BEFORE}'),
  ('drf-kept-chat', 'drf-owner', NULL, '${BEFORE}', NULL, '${BEFORE}');

INSERT INTO "ChatPdfRunPreparation" ("modelRunId", "admissionKey", snapshot, state, "claimToken", "claimedAt", "updatedAt")
VALUES ('drf-pdf-run', ${hex("d")}, '{"version":1}', 'pending', 'drf-claim', '${BEFORE}', '${BEFORE}'),
  ('drf-error-run', ${hex("e")}, '{"version":1}', 'preparing', NULL, NULL, '${BEFORE}');
INSERT INTO "ChatPdfAttachmentPreparation" (id, "modelRunId", "attachmentId", route, state, "sourceChecksum", "sourceByteSize",
  "compatibilityKey", "updatedAt") VALUES
  ('drf-pdf-prep', 'drf-pdf-run', 'drf-pdf-file', 'local_text', 'checking', ${hex("a")}, 1024, ${hex("b")}, '${BEFORE}'),
  ('drf-docling-prep', 'drf-error-run', 'drf-docling-file', 'local_text', 'preparing', ${hex("a")}, 1024, ${hex("c")}, '${BEFORE}');
INSERT INTO "WorkspaceFollowup" ("modelRunId", "chatId", "predecessorRunId", "admissionKey", state, snapshot,
  "admissionResult", "deadlineAt", "updatedAt")
VALUES ('drf-wait-run', 'drf-wait-chat', 'drf-done-run', ${hex("f")}, 'waiting', '{"version":1}', '{"runId":"drf-wait-run"}',
  CURRENT_TIMESTAMP + INTERVAL '1 hour', '${BEFORE}');

INSERT INTO "McpToolApproval" (id, "userId", "chatId", "modelRunId", "toolCallId", source, "serverId", "serverName",
  "toolName", "toolTitle", "definitionHash", "argumentsDigest", decision, "decidedAt") VALUES
  ('drf-approval-agent', 'drf-owner', 'drf-wait-chat', 'drf-done-run', 'drf-call-agent', 'agent', 'drf-server',
    'Synthetic server', 'records__write', 'Write record', ${hex("1")}, ${hex("2")}, 'deny', '${BEFORE}'),
  ('drf-approval-model', 'drf-owner', 'drf-wait-chat', 'drf-done-run', 'drf-call-model', 'model', 'drf-server',
    'Synthetic server', 'records__write', 'Write record', ${hex("1")}, ${hex("3")}, NULL, NULL),
  ('drf-approval-code', 'drf-owner', 'drf-wait-chat', 'drf-done-run', NULL, 'code', 'drf-server',
    'Synthetic server', 'records__write', 'Write record', ${hex("1")}, ${hex("4")}, NULL, NULL);

INSERT INTO "TelegramLink" (id, "userId", "botId", "telegramUserId", "telegramChatId")
VALUES ('drf-link', 'drf-owner', 7000000001, 7000000002, 7000000002);
INSERT INTO "TelegramCallback" (id, "linkId", kind, payload, "expiresAt") VALUES
  ('drf-callback-workspace', 'drf-link', 'toggle_workspace', '{}', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('drf-callback-agent0000', 'drf-link', 'toggle_agent', '{}', CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('drf-callback-select000', 'drf-link', 'select_chat', '{"chatId":"drf-kept-chat"}', CURRENT_TIMESTAMP + INTERVAL '1 day');

INSERT INTO "McpHubDiscoveryAttempt" (id, "userId", "clientId", "grantId", "connectionId", "providerModelId",
  "credentialVersionId", state, "completedAt")
VALUES ('drf-hub-attempt', 'drf-owner', 'synthetic-client', 'drf-grant', 'drf-provider', 'drf-answer', 'drf-credential',
  'COMPLETE', '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "knowledgeBaseId",
  "knowledgeIndexGenerationId", "knowledgeDocumentVersionId", "knowledgeBatchIndex", "inputTokens", "createdAt")
VALUES ('drf-usage-index', 'drf-owner', 'knowledge_indexing', 'openai', 'synthetic-embedding', 'drf-answer', 'drf-base',
  'drf-generation', 'drf-version', 0, 40, '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "knowledgePdfProcessingAttemptId",
  "inputTokens", "createdAt")
VALUES ('drf-usage-pdf', 'drf-owner', 'knowledge_indexing', 'openai', 'synthetic-answer', 'drf-answer', 'drf-pdf-attempt', 50,
  '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "knowledgeRelevance",
  "knowledgeRelevanceAttemptId", "inputTokens", "createdAt")
VALUES ('drf-usage-relevance', 'drf-owner', 'knowledge_retrieval', 'openai', 'synthetic-answer', 'drf-answer', true,
  'drf-relevance-attempt', 60, '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "visionAnalysis",
  "knowledgeImageObservationRunId", "inputTokens", "createdAt")
VALUES ('drf-usage-observation', 'drf-owner', 'knowledge_indexing', 'openai', 'synthetic-answer', 'drf-answer', true,
  'drf-observation-run', 70, '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "mcpHubDiscovery",
  "mcpHubDiscoveryAttemptId", "inputTokens", "createdAt")
VALUES ('drf-usage-hub', 'drf-owner', 'other', 'openai', 'synthetic-answer', 'drf-answer', true, 'drf-hub-attempt', 80,
  '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "chatId", "modelRunId", "inputTokens", "outputTokens",
  "createdAt")
VALUES ('drf-usage-answer', 'drf-owner', 'chat_answer', 'fake', 'synthetic-model', 'drf-wait-chat', 'drf-done-run', 20, 5,
  '${BEFORE}');
COMMIT;

CREATE TABLE "_DropRemovedFeatureFixture" AS SELECT ${keptDigest} AS kept;
`;

const RETIRED_TYPES_AND_RELATIONS = ["McpHubDiscoveryAttempt", "CatalogCostBackfill", "McpToolApprovalSource_retired",
  "TelegramCallbackKind_retired"];
const RETIRED_ROUTINES = ["catalog_cost_adoption_valid", "cancel_mcp_legacy_tool_recheck_on_edit"];
const TELEGRAM_KINDS = ["approval_allow_once", "approval_allow_server", "approval_deny", "select_chat", "select_assistant",
  "select_model", "model_page", "toggle_search", "stop_run", "unlink_confirm", "open_settings", "change_undo",
  "change_confirm", "change_cancel"];

const droppedColumnPairs = Object.entries(DROPPED_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `(${quote(table)}, ${quote(column)})`)).join(", ");

const runEnded = (run: string, code: string, message: string, request: string): string =>
  `EXISTS (SELECT 1 FROM "ModelRun" WHERE id = ${quote(run)} AND status = 'error' AND NOT "workspaceWaitPending"
      AND "answerCompletionUsage" IS NULL AND "normalizedRequest" = ${request}::jsonb
      AND "errorPayload" = jsonb_build_object('code', ${quote(code)}, 'message', ${quote(message)}, 'recoveryTerminal', true))`;
const answerEnded = (answer: string, message: string): string =>
  `EXISTS (SELECT 1 FROM "Message" WHERE id = ${quote(answer)} AND status = 'error' AND "errorMessage" = ${quote(message)})`;

// Each probe ends rolled back, so the proof also serves as the repeat proof.
export const dropRemovedFeatureStorageProofSql = `
DO $$
DECLARE
  violated text;
BEGIN
  -- Nothing of the retired storage is left in the catalog; the replaced types, checks and guards are in place.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND (table_name::text, column_name::text) IN (VALUES ${droppedColumnPairs}))
    OR EXISTS (SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND (relation.relname IN (${list(RETIRED_TYPES_AND_RELATIONS)})
        OR relation.relname ~* '^UsageEvent_(knowledge|mcpHub)'))
    OR EXISTS (SELECT 1 FROM pg_type AS type_row JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
      WHERE namespace.nspname = current_schema() AND type_row.typname IN (${list(RETIRED_TYPES_AND_RELATIONS)}))
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN (${list(RETIRED_ROUTINES)}))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'McpServer_cancel_legacy_tool_recheck_on_edit')
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"UsageEvent"'::regclass
      AND (conname ~* '(knowledge|mcpHub)' OR pg_get_constraintdef(oid) ~ '"(knowledge|mcpHub)'))
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_left'; END IF;
  IF (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid = '"McpToolApprovalSource"'::regtype) IS DISTINCT FROM ARRAY['model', 'code']
    OR (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid = '"TelegramCallbackKind"'::regtype) IS DISTINCT FROM ARRAY[${list(TELEGRAM_KINDS)}]
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_enum_values'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND (
        (conrelid = '"UsageEvent"'::regclass AND conname = 'UsageEvent_shape_check')
        OR (conrelid = '"ModelRun"'::regclass AND conname = 'ModelRun_followup_bounds'))) <> 2
    OR (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND (
        (tgrelid = '"ModelRun"'::regclass AND tgname = 'ModelRun_followup_completion_guard')
        OR (tgrelid = '"ChatPdfAttachmentPreparation"'::regclass AND tgname = 'ChatPdfAttachmentPreparation_guard'))) <> 2
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('chat_pdf_usage_guard', 'chat_title_usage_guard')
      AND prosrc ~ 'catalog_cost')
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_guards'; END IF;

  -- The old core's active runs ended once, as its sweep ended them; their calls, hand-off, documents, chats and index
  -- state followed. Everything else is as it was.
  IF NOT (${runEnded("drf-stream-run", "run_interrupted", INTERRUPTED, `'{"content":{"blocks":[]}}'`)}
      AND ${runEnded("drf-agent-run", "agent_mode_removed", AGENT_REMOVED, `'{"agent":{"mode":"codex"}}'`)}
      AND ${runEnded("drf-pdf-run", "run_interrupted", INTERRUPTED, "'{}'")}
      AND ${runEnded("drf-wait-run", "run_interrupted", INTERRUPTED, "'{}'")}
      AND ${answerEnded("drf-stream-answer", INTERRUPTED)} AND ${answerEnded("drf-agent-answer", AGENT_REMOVED)}
      AND ${answerEnded("drf-pdf-answer", INTERRUPTED)} AND ${answerEnded("drf-wait-answer", INTERRUPTED)}
      AND EXISTS (SELECT 1 FROM "Message" WHERE id = 'drf-stream-answer'
        AND content = '{"blocks":[{"type":"text","text":"Partial answer"}]}'::jsonb))
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_run_not_ended'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ModelRunToolCall" WHERE id = 'drf-call-pending' AND state = 'cancelled'
      AND "completedAt" IS NOT NULL AND result IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "ModelRunToolCall" WHERE id = 'drf-call-running' AND state = 'error'
      AND "completedAt" IS NOT NULL AND result = '{"code":"run_ended_before_tool_settled","outcome":"unknown"}'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM "ModelRunToolCall" WHERE id = 'drf-call-complete' AND state = 'complete'
      AND "completedAt" = '${BEFORE}')
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_calls'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "WorkspaceFollowup" WHERE "modelRunId" = 'drf-wait-run' AND state = 'failed'
      AND "errorCode" = 'run_interrupted' AND snapshot IS NULL AND "admissionResult" IS NULL AND "claimToken" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" WHERE "modelRunId" = 'drf-pdf-run' AND state = 'failed'
      AND "claimToken" IS NULL AND "claimedAt" IS NULL AND "errorCode" = 'pdf_preparation_failed' AND retryable)
    OR (SELECT count(*) FROM "ChatPdfAttachmentPreparation" WHERE id IN ('drf-pdf-prep', 'drf-docling-prep')
      AND state = 'failed' AND "errorCode" = 'pdf_preparation_failed' AND retryable) <> 2
    OR NOT EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" WHERE "modelRunId" = 'drf-error-run' AND state = 'failed')
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_gates'; END IF;
  IF (SELECT count(*) FROM "Chat" WHERE id IN (${list(ENDED_CHATS)}) AND "updatedAt" > '2026-11-01') <> 4
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drf-agent-chat' AND "memoryMode" = 'TEMPORARY'
      AND "temporaryRetentionDeadline" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '23 hours')
    OR NOT EXISTS (SELECT 1 FROM "ChatSearchState" WHERE "chatId" = 'drf-stream-chat' AND "dirtyAt" > '2026-11-01'
      AND "nextAttemptAt" IS NULL)
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_chats'; END IF;

  -- Rewritten values: approval sources, Telegram buttons, chat overrides and decision features.
  IF NOT EXISTS (SELECT 1 FROM "McpToolApproval" WHERE id = 'drf-approval-agent' AND source = 'model'
      AND "toolCallId" = 'drf-call-agent' AND decision = 'deny')
    OR EXISTS (SELECT 1 FROM "TelegramCallback" WHERE id IN ('drf-callback-workspace', 'drf-callback-agent0000'))
    OR NOT EXISTS (SELECT 1 FROM "TelegramCallback" WHERE id = 'drf-callback-select000' AND kind = 'select_chat')
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drf-overrides-chat' AND "assistantOverrides" = '{"search":{"mode":"off"}}'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drf-knowledge-only-chat' AND "assistantOverrides" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drf-fenced-chat' AND "permanentDeletionAt" = '${BEFORE}'
      AND "assistantOverrides" = '{"model":{"mode":"inherit"}}'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'drf-deleted-assistant-chat' AND "assistantOverrides" = '{"assistantDeleted":true}'::jsonb)
    OR (SELECT "decisionFeaturesJson" FROM "SystemModelPolicy" WHERE id = 'installation')
      IS DISTINCT FROM '{"skillSuggestions":false,"memoryControlScreen":true}'::jsonb
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_values'; END IF;

  -- Usage keeps every row and its purpose; everything outside the rewrites is unchanged.
  IF (SELECT string_agg(id || ':' || purpose::text || ':' || "inputTokens", ',' ORDER BY id) FROM "UsageEvent"
      WHERE id LIKE 'drf-usage-%') IS DISTINCT FROM 'drf-usage-answer:chat_answer:20,drf-usage-hub:other:80,'
      || 'drf-usage-index:knowledge_indexing:40,drf-usage-observation:knowledge_indexing:70,'
      || 'drf-usage-pdf:knowledge_indexing:50,drf-usage-relevance:knowledge_retrieval:60'
    OR (SELECT kept FROM "_DropRemovedFeatureFixture") IS DISTINCT FROM ${keptDigest}
    THEN RAISE EXCEPTION 'drop_removed_feature_storage_changed_what_stays'; END IF;

  -- The retired values are refused, and the replaced checks still refuse what they refused.
  BEGIN
    INSERT INTO "McpToolApproval" (id, "userId", "chatId", "modelRunId", "toolCallId", source, "serverId", "serverName",
      "toolName", "toolTitle", "definitionHash", "argumentsDigest")
    VALUES ('drf-probe-approval', 'drf-owner', 'drf-wait-chat', 'drf-done-run', 'drf-call-model', 'agent', 'drf-server',
      'Synthetic server', 'records__write', 'Write record', ${hex("1")}, ${hex("5")});
    RAISE EXCEPTION 'drop_removed_feature_storage_agent_source_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TelegramCallback" (id, "linkId", kind, payload, "expiresAt")
    VALUES ('drf-probe-callback0000', 'drf-link', 'toggle_agent', '{}', CURRENT_TIMESTAMP + INTERVAL '1 day');
    RAISE EXCEPTION 'drop_removed_feature_storage_toggle_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "optionalDecision")
    VALUES ('drf-probe-usage', 'drf-owner', 'other', 'fake', 'synthetic-model', true);
    RAISE EXCEPTION 'drop_removed_feature_storage_usage_shape_lost';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated <> 'UsageEvent_shape_check' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "ModelRun" SET "followupRevision" = 97 WHERE id = 'drf-error-run';
    RAISE EXCEPTION 'drop_removed_feature_storage_followup_bounds_lost';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated <> 'ModelRun_followup_bounds' THEN RAISE; END IF;
  END;
END $$;
`;
