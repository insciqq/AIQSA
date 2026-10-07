import { USAGE_PURPOSES, type UsagePurpose } from "../../../lib/domain/usagePurpose";

/** Every existing usage record gains the purpose its shape proves; nothing else changes. */
export const USAGE_EVENT_PURPOSE_MIGRATION = "20261008130000_usage_event_purpose";

type Fixture = Readonly<{ id: string; purpose: UsagePurpose; fields: Readonly<Record<string, string>> }>;

const run = { modelRunId: "'purpose-run'", chatId: "'purpose-chat'" };
const answerModel = { provider: "'openai'", modelId: "'purpose-answer-upstream'", providerModelId: "'purpose-answer'" };
const tokens = (input: number | null, output: number | null) => ({
  inputTokens: String(input ?? "NULL"), outputTokens: String(output ?? "NULL"),
  totalTokens: String(input === null && output === null ? "NULL" : (input ?? 0) + (output ?? 0)),
  usageCompleteness: input !== null && output !== null ? "'COMPLETE'" : input !== null || output !== null ? "'PARTIAL'" : "'UNAVAILABLE'"
});
const raw = (provider: string, modelId: string) => ({ provider: `'${provider}'`, modelId: `'${modelId}'` });

/** One row per backfill rule, in rule order; ids are synthetic. */
const fixtures: readonly Fixture[] = [
  { id: "purpose-image", purpose: "image_generation", fields: { ...run, ...answerModel, imageGeneration: "true", estimatedCostMicros: "500" } },
  { id: "purpose-title", purpose: "chat_title", fields: { ...run, ...answerModel, ...tokens(10, 5), chatTitleGeneration: "true" } },
  // A chat row by shape: the id rule must win over the answer rule.
  { id: "chat-summary:purpose-claim:purpose-attempt:0", purpose: "chat_summary",
    fields: { chatId: "'purpose-chat'", ...raw("openai", "purpose-answer"), ...tokens(100, 20) } },
  // Flagged visionAnalysis as well: the observation link must win.
  { id: "purpose-knowledge-image", purpose: "knowledge_indexing",
    fields: { ...run, ...answerModel, ...tokens(30, 10), visionAnalysis: "true", knowledgeImageObservationRunId: "'purpose-run'" } },
  { id: "purpose-vision", purpose: "chat_vision", fields: { ...run, ...answerModel, ...tokens(30, 10), visionAnalysis: "true" } },
  { id: "purpose-chat-pdf", purpose: "chat_pdf", fields: { ...run, ...answerModel, chatPdfPreparation: "true" } },
  { id: "purpose-knowledge-pdf", purpose: "knowledge_indexing",
    fields: { ...answerModel, ...tokens(1000, 200), knowledgePdfProcessingAttemptId: "'purpose-pdf-attempt'" } },
  { id: "purpose-decision", purpose: "skill_selection", fields: { ...run, ...answerModel, optionalDecision: "true", operationCount: "1" } },
  { id: "purpose-relevance", purpose: "knowledge_retrieval", fields: { ...run, ...answerModel, ...tokens(40, 2), knowledgeRelevance: "true" } },
  // Receipts linked to their attempts carry deferred ownership checks that a
  // backfill update must not leave pending before the column becomes required.
  { id: "purpose-decision-linked", purpose: "skill_selection", fields: { ...answerModel, ...tokens(20, 4),
    optionalDecision: "true", optionalDecisionAttemptId: "'purpose-decision-attempt'", operationCount: "1" } },
  { id: "purpose-relevance-linked", purpose: "knowledge_retrieval", fields: { ...run, ...answerModel, ...tokens(40, 2),
    knowledgeRelevance: "true", knowledgeRelevanceAttemptId: "'purpose-relevance-attempt'" } },
  { id: "purpose-hub", purpose: "other", fields: { ...answerModel, ...tokens(12, 3), mcpHubDiscovery: "true" } },
  { id: "purpose-memory-index", purpose: "memory_indexing", fields: { ...raw("openai", "purpose-embedding-upstream"),
    providerModelId: "'purpose-embedding'", memoryExecutionBindingId: "'purpose-binding-index'", ...tokens(40, null) } },
  { id: "purpose-memory-rerank", purpose: "memory_retrieval", fields: { ...raw("openai", "purpose-reranker-upstream"),
    providerModelId: "'purpose-reranker'", memoryExecutionBindingId: "'purpose-binding-rerank'", ...tokens(40, null) } },
  { id: "purpose-memory-extract", purpose: "memory_processing", fields: { ...answerModel,
    memoryExecutionBindingId: "'purpose-binding-extract'", ...tokens(400, 50) } },
  // Run rows name the run's connection and ProviderModel id.
  { id: "purpose-answer", purpose: "chat_answer", fields: { ...run, ...raw("purpose-conn", "purpose-answer"), ...tokens(100, 50) } },
  // A resolved answer model outweighs an input-only token shape.
  { id: "purpose-answer-partial", purpose: "chat_answer", fields: { ...run, ...raw("purpose-conn", "purpose-answer"), ...tokens(100, null) } },
  { id: "purpose-query-embedding", purpose: "knowledge_retrieval",
    fields: { ...run, ...raw("openai", "purpose-embedding-upstream"), ...tokens(8, null) } },
  { id: "purpose-query-embedding-unresolved", purpose: "knowledge_retrieval",
    fields: { ...run, ...raw("openai", "purpose-deleted-embedding"), ...tokens(8, null) } },
  // A deleted chat's run link is gone; the opaque chat id remains.
  { id: "purpose-chat-only", purpose: "chat_answer", fields: { chatId: "'purpose-deleted-chat'", ...raw("purpose-conn", "purpose-answer"), ...tokens(30, 10) } },
  { id: "purpose-ingestion", purpose: "knowledge_indexing", fields: { ...raw("openai", "purpose-embedding-upstream"), ...tokens(500, null) } },
  { id: "purpose-ingestion-by-id", purpose: "knowledge_indexing", fields: { ...raw("openai", "purpose-embedding"), ...tokens(null, null) } },
  { id: "purpose-ingestion-configured", purpose: "knowledge_indexing",
    fields: { ...raw("openai", "purpose-configured-upstream"), ...tokens(null, null) } },
  { id: "purpose-ingestion-unresolved", purpose: "knowledge_indexing", fields: { ...raw("gone", "gone-embedding"), ...tokens(500, null) } },
  // Memory calls whose binding a purge detached.
  { id: "purpose-detached-answer", purpose: "memory_processing", fields: { ...raw("openai", "purpose-answer-upstream"), ...tokens(100, null) } },
  { id: "purpose-detached-output", purpose: "memory_processing", fields: { ...raw("gone", "gone-model"), ...tokens(10, 5) } },
  { id: "purpose-detached-reranker", purpose: "other", fields: { ...raw("openai", "purpose-reranker-upstream"), ...tokens(30, null) } },
  // Two models share this upstream id: unresolved, and without tokens it proves nothing.
  { id: "purpose-ambiguous", purpose: "other", fields: { ...raw("openai", "purpose-twin-upstream"), ...tokens(null, null) } },
  { id: "purpose-unknown", purpose: "other", fields: { ...raw("gone", "gone-model"), ...tokens(null, null) } }
];

function usageInsert(fixture: Fixture): string {
  const columns: Record<string, string> = { id: `'${fixture.id}'`, userId: "'purpose-user'", ...fixture.fields };
  return `INSERT INTO "UsageEvent" (${Object.keys(columns).map((column) => `"${column}"`).join(", ")})
VALUES (${Object.values(columns).join(", ")});`;
}

const binding = (id: string, role: string, ordinal: number) => `('${id}', 'purpose-user', 'JOB', 'purpose-memory-job',
  '${role}', ${ordinal}, 'SUCCEEDED', 'openai', '${"d".repeat(64)}', 'synthetic-policy', 'synthetic-prompt', 'synthetic-schema',
  'synthetic-pipeline', '{}', '${"c".repeat(64)}', '${"b".repeat(64)}', 'UNAVAILABLE', now() - interval '2 minutes',
  now() - interval '1 minute', now(), now(), now())`;

// Replica mode skips the receipts' dispatch guards and foreign keys: these
// rows exercise only the purpose backfill, never their writers' admission.
export const usageEventPurposeFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('purpose-user', 'Synthetic owner', 'active', now());
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt") VALUES
  ('purpose-conn', 'Synthetic connection', 'openai', now()),
  ('purpose-conn-twin', 'Synthetic second connection', 'openai', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "modelClass", "displayName",
  "activeConfig", "activeVersion", "activatedAt", capabilities, "defaultParams", "updatedAt")
VALUES
  ('purpose-answer', 'purpose-conn', 'openai', 'purpose-answer-upstream', 'answer', 'Synthetic answer', NULL, 0, NULL, '{}', '{}', now()),
  ('purpose-embedding', 'purpose-conn', 'openai', 'purpose-embedding-upstream', 'embedding', 'Synthetic embedding', NULL, 0, NULL, '{}', '{}', now()),
  ('purpose-configured', 'purpose-conn', 'openai', 'purpose-configured-base', 'embedding', 'Synthetic configured',
    '{"upstreamModelId":"purpose-configured-upstream"}', 1, now(), '{}', '{}', now()),
  ('purpose-reranker', 'purpose-conn', 'openai', 'purpose-reranker-upstream', 'reranker', 'Synthetic reranker', NULL, 0, NULL, '{}', '{}', now()),
  ('purpose-twin-embedding', 'purpose-conn', 'openai', 'purpose-twin-upstream', 'embedding', 'Synthetic twin', NULL, 0, NULL, '{}', '{}', now()),
  ('purpose-twin-answer', 'purpose-conn-twin', 'openai', 'purpose-twin-upstream', 'answer', 'Synthetic twin', NULL, 0, NULL, '{}', '{}', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('purpose-chat', 'purpose-user', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt") VALUES ('purpose-message', 'purpose-chat', 'user', '{}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('purpose-run', 'purpose-user', 'purpose-chat', 'purpose-message', 'purpose-conn', 'purpose-answer', 'complete', '{}', now());
INSERT INTO "ProviderRunBinding" (id, "modelRunId", "bindingKey", role, "connectionId", "providerModelId", "credentialSource", "executionSnapshot")
VALUES ('purpose-vision-binding', 'purpose-run', 'vision_analysis', 'vision_analysis', 'purpose-conn', 'purpose-answer', 'default', '{}');
INSERT INTO "KnowledgeImageObservation" ("modelRunId", "providerBindingKey", "requestHash", images)
VALUES ('purpose-run', 'vision_analysis', '${"a".repeat(64)}', '[{}]');
INSERT INTO "KnowledgePdfProcessingAttempt" (id, "sourceArtifactId", "sourceVersionId", "batchIndex", mode, "pageStart",
  "pageEnd", "requestDigest", "updatedAt")
VALUES ('purpose-pdf-attempt', 'purpose-source-artifact', 'purpose-source-version', 0, 'system_model_direct_pdf', 1, 1,
  '${"b".repeat(64)}', now());
INSERT INTO "OptionalDecisionAttempt" (id, "userId", "modelRunId", purpose, "operationKey", "inputHash", "executionSnapshot")
VALUES ('purpose-decision-attempt', 'purpose-user', NULL, 'skill_catalog_relevance', 'purpose-operation', '${"e".repeat(64)}', '{}');
INSERT INTO "KnowledgeRelevanceAttempt" (id, "reservationId", ordinal, "executionSnapshot", "inputHash")
VALUES ('purpose-relevance-attempt', 'purpose-reservation', 1, '{}', '${"f".repeat(64)}');
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion", "memoryGenerationSnapshot", "memoryRevisionSnapshot",
  "idempotencyFingerprint", "completedAt")
VALUES ('purpose-memory-job', 'purpose-user', 'EMBED_ITEMS', 'SUCCEEDED', 'synthetic-pipeline', 0, 0, 'purpose-memory-job', now());
INSERT INTO "MemoryExecutionBinding" (id, "userId", "ownerType", "memoryJobId", "logicalRole", ordinal, state,
  "providerId", "destinationFingerprint", "policyVersion", "promptVersion", "schemaVersion", "pipelineVersion",
  "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash", "usageCompleteness", "createdAt", "startedAt",
  "completedAt", "recoverableUntil", "relationsDetachedAt")
VALUES ${binding("purpose-binding-index", "MEMORY_DOCUMENT_EMBED", 0)},
  ${binding("purpose-binding-rerank", "MEMORY_RERANK", 1)},
  ${binding("purpose-binding-extract", "MEMORY_FACT_EXTRACT", 2)};
${fixtures.map(usageInsert).join("\n")}
COMMIT;
CREATE TABLE "_UsagePurposeUpgradeFixture" AS SELECT id, to_jsonb(ue) AS snapshot FROM "UsageEvent" AS ue;
`;

const expected = fixtures.map(({ id, purpose }) => `('${id}', '${purpose}')`).join(",\n    ");

/** Runs in a rolled-back transaction, so the repeated deploy runs it again. */
export const usageEventPurposeProofSql = `
BEGIN;
DO $proof$ DECLARE mismatch TEXT; BEGIN
  IF (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = '"UsagePurpose"'::regtype)
    IS DISTINCT FROM '${USAGE_PURPOSES.join(",")}'
    THEN RAISE EXCEPTION 'usage_purpose_vocabulary_mismatch'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"UsageEvent"'::regclass AND tgenabled = 'O'
      AND tgname IN ('UsageEvent_optional_decision_owner_check', 'UsageEvent_knowledge_relevance_owner_check')) <> 2
    THEN RAISE EXCEPTION 'usage_purpose_owner_checks_not_restored'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'UsageEvent' AND column_name = 'purpose' AND is_nullable = 'NO' AND column_default IS NULL)
    THEN RAISE EXCEPTION 'usage_purpose_not_required'; END IF;
  SELECT string_agg(expected.id || '=' || COALESCE(ue."purpose"::text, 'missing'), ', ' ORDER BY expected.id) INTO mismatch
  FROM (VALUES
    ${expected}
  ) AS expected(id, purpose)
  LEFT JOIN "UsageEvent" AS ue ON ue.id = expected.id
  WHERE ue."purpose" IS DISTINCT FROM expected.purpose::"UsagePurpose";
  IF mismatch IS NOT NULL THEN RAISE EXCEPTION 'usage_purpose_backfill_mismatch: %', mismatch; END IF;
  -- Only the purpose was added: every column the row had keeps its value.
  IF EXISTS (SELECT 1 FROM "_UsagePurposeUpgradeFixture" AS fixture
      LEFT JOIN "UsageEvent" AS ue ON ue.id = fixture.id
      WHERE ue.id IS NULL OR fixture.snapshot IS DISTINCT FROM (SELECT jsonb_object_agg(field.key, field.value)
        FROM jsonb_each(to_jsonb(ue)) AS field WHERE fixture.snapshot ? field.key))
    THEN RAISE EXCEPTION 'usage_purpose_changed_existing_accounting'; END IF;
  BEGIN
    UPDATE "UsageEvent" SET "purpose" = NULL WHERE id = 'purpose-answer';
    RAISE EXCEPTION 'usage_purpose_nullable';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
END $proof$;
-- Previous-release writers name no purpose during Compose replacement.
INSERT INTO "UsageEvent" (id, "userId", "chatId", "modelRunId", provider, "modelId", "inputTokens", "outputTokens",
  "totalTokens", "usageCompleteness")
VALUES ('purpose-previous-answer', 'purpose-user', 'purpose-chat', 'purpose-run', 'purpose-conn', 'purpose-answer', 10, 5, 15, 'COMPLETE');
INSERT INTO "UsageEvent" (id, "userId", provider, "modelId", "inputTokens", "totalTokens", "usageCompleteness")
VALUES ('purpose-previous-ingestion', 'purpose-user', 'openai', 'purpose-embedding-upstream', 12, 12, 'PARTIAL');
INSERT INTO "UsageEvent" (id, "userId", "chatId", "modelRunId", provider, "modelId", "providerModelId", "visionAnalysis")
VALUES ('purpose-previous-vision', 'purpose-user', 'purpose-chat', 'purpose-run', 'openai', 'purpose-answer-upstream', 'purpose-answer', true);
-- A current writer's choice is never reclassified.
INSERT INTO "UsageEvent" (id, "userId", "chatId", "modelRunId", provider, "modelId", "purpose")
VALUES ('purpose-current-search', 'purpose-user', 'purpose-chat', 'purpose-run', 'purpose-conn', 'purpose-answer', 'web_search');
DO $proof$ BEGIN
  IF (SELECT string_agg(id || '=' || "purpose"::text, ',' ORDER BY id) FROM "UsageEvent"
      WHERE id IN ('purpose-previous-answer', 'purpose-previous-ingestion', 'purpose-previous-vision', 'purpose-current-search'))
    IS DISTINCT FROM 'purpose-current-search=web_search,purpose-previous-answer=chat_answer,purpose-previous-ingestion=knowledge_indexing,purpose-previous-vision=chat_vision'
    THEN RAISE EXCEPTION 'usage_purpose_previous_writer_unclassified'; END IF;
END $proof$;
ROLLBACK;
`;
