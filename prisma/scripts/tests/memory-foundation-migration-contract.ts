import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260810100000_memory_engine_phase1_foundation";
const MEMORY_FOLLOWUP_MIGRATIONS = [
  "20260810160000_memory_execution_usage_evidence",
  "20260810161000_memory_execution_usage_shape",
  "20260810170000_memory_coordinator_fairness"
] as const;
const CHAT_SCOPE_MIGRATION = "20260810180000_memory_chat_scope_state";
const SCOPE_LIFECYCLE_MIGRATION = "20260810190000_memory_scope_lifecycle";
const TEMPORARY_RETENTION_MIGRATION = "20260810200000_memory_temporary_retention";
const HISTORY_SCHEMA_MIGRATION = "20260810210000_memory_history_schema";
const HISTORY_EGRESS_MIGRATION = "20260810220000_memory_history_tool_egress_guard";
const ADMIN_EGRESS_MIGRATION = "20260811120000_memory_admin_egress_consent";
const FACT_CANDIDATE_MIGRATION = "20260811130000_memory_fact_candidates";
const FACT_CONSOLIDATION_MIGRATION = "20260811140000_memory_fact_consolidation";
const LEARNING_REVIEW_MIGRATION = "20260811150000_memory_learning_review";
const FORGET_UNDO_MIGRATION = "20260811160000_memory_forget_undo_window";
const FORGET_UNDO_SHAPE_MIGRATION = "20260811161000_memory_forget_undo_outbox_shape";
const WORKING_SET_PROFILE_MIGRATION = "20260811170000_memory_working_set_profile";
const PERMANENT_CHAT_DELETE_MIGRATION = "20260812100000_memory_permanent_chat_delete";
const VERIFICATION_AUTHORITY_V2_MIGRATION =
  "20260812194000_memory_verification_authority_v2";
const SEMANTIC_RETRIEVAL_MIGRATION =
  "20260813090000_multilingual_memory_semantic_retrieval";
const FACT_RECEIPT_PROVENANCE_MIGRATION =
  "20260813100000_memory_fact_receipt_provenance";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const suffix = `${process.pid}_${Date.now()}`;
const upgradeDatabase = `aiqsa_memory_upgrade_${suffix}`;
const freshDatabase = `aiqsa_memory_fresh_${suffix}`;
const rollbackDatabase = `aiqsa_memory_rollback_${suffix}`;
const scopeRollbackDatabase = `aiqsa_memory_scope_rollback_${suffix}`;
const temporaryRollbackDatabase = `aiqsa_memory_temporary_rollback_${suffix}`;
const historyRollbackDatabase = `aiqsa_memory_history_rollback_${suffix}`;
const historyEgressRollbackDatabase = `aiqsa_memory_history_egress_rollback_${suffix}`;
const adminEgressRollbackDatabase = `aiqsa_memory_admin_egress_rollback_${suffix}`;
const factCandidateRollbackDatabase = `aiqsa_memory_fact_candidate_rollback_${suffix}`;
const factConsolidationRollbackDatabase =
  `aiqsa_memory_fact_consolidation_rollback_${suffix}`;
const learningReviewRollbackDatabase =
  `aiqsa_memory_learning_review_rollback_${suffix}`;
const workingSetProfileRollbackDatabase =
  `aiqsa_memory_working_set_profile_rollback_${suffix}`;
const permanentChatDeleteRollbackDatabase =
  `aiqsa_memory_permanent_chat_delete_rollback_${suffix}`;
const createdDatabases = new Set<string>();

type CommandResult = Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}>;

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

function requireSuccess(result: CommandResult, operation: string): string {
  assert.equal(
    result.status,
    0,
    `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

function psql(database: string, sql: string): CommandResult {
  return compose([
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "psql",
    "-X",
    "--set=ON_ERROR_STOP=1",
    "--username",
    POSTGRES_USER,
    "--dbname",
    database
  ], sql);
}

function scalar(database: string, sql: string): string {
  return requireSuccess(
    compose([
      "exec",
      "-T",
      POSTGRES_SERVICE,
      "psql",
      "-X",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--username",
      POSTGRES_USER,
      "--dbname",
      database,
      "--command",
      sql
    ]),
    "read Memory migration contract state"
  );
}

function migrationNames(predicate: (name: string) => boolean): string[] {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function applyMigrations(database: string, names: readonly string[]): void {
  for (const name of names) {
    requireSuccess(
      psql(database, readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8")),
      `apply migration ${name} to ${database}`
    );
  }
}

function createDatabase(database: string): void {
  requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, database]),
    `create ${database}`
  );
  createdDatabases.add(database);
}

function dropDatabases(): void {
  for (const database of createdDatabases) {
    requireSuccess(
      compose([
        "exec",
        "-T",
        POSTGRES_SERVICE,
        "dropdb",
        "--if-exists",
        "--force",
        "--username",
        POSTGRES_USER,
        database
      ]),
      `drop ${database}`
    );
  }
  createdDatabases.clear();
}

function expectRejected(database: string, sql: string, expected: RegExp, label: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${label} failed unexpectedly`);
}

function seedUpgradeFixture(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt") VALUES
      ('memory-owner-a', 'memory-a@example.test', 'Memory A', 'user', 'active', CURRENT_TIMESTAMP),
      ('memory-owner-b', 'memory-b@example.test', 'Memory B', 'user', 'active', CURRENT_TIMESTAMP);

    INSERT INTO "Folder" ("id", "userId", "name", "updatedAt") VALUES
      ('memory-folder-a', 'memory-owner-a', 'A', CURRENT_TIMESTAMP),
      ('memory-folder-b', 'memory-owner-b', 'B', CURRENT_TIMESTAMP);

    INSERT INTO "Chat" ("id", "userId", "folderId", "title", "updatedAt") VALUES
      ('memory-chat-a', 'memory-owner-a', 'memory-folder-a', 'A', CURRENT_TIMESTAMP),
      ('memory-chat-b', 'memory-owner-b', 'memory-folder-b', 'B', CURRENT_TIMESTAMP);

    INSERT INTO "Message" ("id", "chatId", "role", "content", "status", "updatedAt") VALUES
      ('memory-user-message-a', 'memory-chat-a', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
      ('memory-assistant-message-a', 'memory-chat-a', 'assistant', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
      ('memory-user-message-b', 'memory-chat-b', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
      ('memory-assistant-message-b', 'memory-chat-b', 'assistant', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP);

    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "assistantMessageId",
      "provider", "modelId", "status", "normalizedRequest", "updatedAt"
    ) VALUES (
      'memory-legacy-run', 'memory-chat-a', 'memory-owner-a', 'memory-user-message-a',
      'memory-assistant-message-a', 'fake', 'fake-qsa', 'complete', '{}'::jsonb,
      CURRENT_TIMESTAMP
    );
  `), "seed pre-Memory upgrade fixture");
}

function assertUpgradePreserved(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM "UserMemorySettings"),
        (SELECT (NOT "useMemoryFacts" AND NOT "referenceChatHistory" AND NOT "learnAutomatically")::int
         FROM "UserMemorySettings" WHERE "userId" = 'memory-owner-a'),
        (SELECT "providerRequestPreview"->>'unavailable' FROM "ModelRun" WHERE "id" = 'memory-legacy-run'),
        (SELECT ("normalizedRequest" = '{}'::jsonb)::int FROM "ModelRun" WHERE "id" = 'memory-legacy-run')
      );
    `),
    "2|1|legacy_pre_memory_phase1|1",
    "upgrade did not preserve legacy runs with inert settings"
  );
}

function assertScopeAndFactContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "MemoryScope" ("id", "userId", "scopeType", "state")
    VALUES ('memory-global-a', 'memory-owner-a', 'GLOBAL_USER', 'ACTIVE');
  `), "create global Memory scope");

  expectRejected(database, `
    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
    ) VALUES (
      'memory-folder-scope-dark', 'memory-owner-a', 'FOLDER', 'memory-folder-a',
      'memory-folder-a', 'ACTIVE'
    );
  `, /feature-dark until Phase 3 authorization/u, "feature-dark non-global scope");

  requireSuccess(
    psql(database, `ALTER TABLE "MemoryScope" DISABLE TRIGGER "MemoryScope_phase1_guard";`),
    "temporarily expose target ownership constraint"
  );
  try {
    expectRejected(database, `
      INSERT INTO "MemoryScope" (
        "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
      ) VALUES (
        'memory-cross-owner-scope', 'memory-owner-a', 'FOLDER', 'memory-folder-b',
        'memory-folder-b', 'ACTIVE'
      );
    `, /MemoryScope_folder_fkey/u, "cross-owner scope target");
  } finally {
    requireSuccess(
      psql(database, `ALTER TABLE "MemoryScope" ENABLE TRIGGER "MemoryScope_phase1_guard";`),
      "restore feature-dark scope guard"
    );
  }

  requireSuccess(psql(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO "MemoryFact" (
      "id", "userId", "scopeId", "canonicalKey", "category", "state", "currentVersionId"
    ) VALUES (
      'memory-fact-a', 'memory-owner-a', 'memory-global-a', 'profile.language',
      'preference', 'ACTIVE', 'memory-version-a'
    );
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "actorUserId", "factId",
      "factVersionId", "metadata"
    ) VALUES (
      'memory-event-a', 'memory-owner-a', 'EXPLICIT_SAVE', 'USER', 'memory-owner-a',
      'memory-fact-a', 'memory-version-a', '{}'::jsonb
    );
    INSERT INTO "MemoryFactVersion" (
      "id", "userId", "factId", "displayText", "normalizedSearchText",
      "languageCode", "structuredValue", "category", "modality", "sourceMode",
      "state", "confidence", "importance", "directness", "sensitivityClass",
      "createdByEventId", "pipelineVersion"
    ) VALUES (
      'memory-version-a', 'memory-owner-a', 'memory-fact-a', 'Отвечай по-русски',
      'отвечай по русски', 'ru', '{"language":"ru"}'::jsonb, 'preference',
      'PREFERENCE', 'EXPLICIT', 'ACTIVE', 1, 1, 'DIRECT', 'NORMAL',
      'memory-event-a', 'memory-pipeline-v1'
    );
    COMMIT;
  `), "commit deferrable fact/event/version graph");

  expectRejected(database, `
    BEGIN;
    INSERT INTO "MemoryFact" (
      "id", "userId", "scopeId", "canonicalKey", "category", "state", "currentVersionId"
    ) VALUES (
      'memory-invalid-pointer', 'memory-owner-a', 'memory-global-a', 'invalid.pointer',
      'preference', 'ACTIVE', 'missing-version'
    );
    COMMIT;
  `, /(MemoryFact_current_version_fkey|ACTIVE Memory fact must point)/u, "invalid fact current pointer");

  expectRejected(database, `
    INSERT INTO "MemoryFact" (
      "id", "userId", "scopeId", "canonicalKey", "category", "state", "currentVersionId"
    ) VALUES (
      'memory-cross-owner-fact', 'memory-owner-b', 'memory-global-a', 'cross.owner',
      'preference', 'RETRACTED', NULL
    );
  `, /MemoryFact_scope_fkey/u, "cross-owner fact scope");
}

function assertGenerationAndSearchContracts(database: string): void {
  expectRejected(database, `
    DELETE FROM "UserMemorySettings" WHERE "userId" = 'memory-owner-b';
  `, /Every user must retain one inert-or-enabled Memory settings row/u, "orphaned user settings");

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "MemoryIndexGeneration" (
      "id", "userId", "generation", "state", "indexMode", "targetMemoryRevision",
      "indexedThroughMemoryRevision", "languageProfile", "normalizationVersion",
      "chunkingVersion", "retrievalPipelineVersion", "readyAt", "activatedAt"
    ) VALUES (
      'memory-generation-a', 'memory-owner-a', 1, 'ACTIVE', 'LEXICAL_ONLY', 0, 0,
      'RU_EN_MULTILINGUAL_V1', 'memory-normalization-v1', 'memory-chunking-v1',
      'memory-retrieval-v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "UserMemorySettings"
    SET "activeIndexGenerationId" = 'memory-generation-a'
    WHERE "userId" = 'memory-owner-a';
    COMMIT;

    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "factVersionId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash", "languageCode",
      "safetyIdentitySnapshot", "sourceIdentitySnapshot", "suppressionIdentitySnapshot",
      "embeddingState"
    ) VALUES (
      'memory-search-a', 'memory-owner-a', 'memory-generation-a', 'FACT_VERSION',
      'memory-version-a', 'Ёж любит API', 'Еж любит API', repeat('a', 64), 'ru',
      repeat('b', 64), repeat('c', 64), repeat('d', 64), 'NOT_APPLICABLE'
    );
  `), "create active lexical generation and search entry");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        ("searchVectorSimple" @@ plainto_tsquery('simple', 'API'))::int,
        ("searchVectorRussian" @@ plainto_tsquery('russian', 'еж'))::int,
        (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema()
          AND indexname IN (
            'MemorySearchEntry_simple_gin_idx',
            'MemorySearchEntry_russian_gin_idx',
            'MemorySearchEntry_english_gin_idx'
          ))
      ) FROM "MemorySearchEntry" WHERE "id" = 'memory-search-a';
    `),
    "1|1|3",
    "generated Memory lexical vectors or GIN indexes are missing"
  );

  expectRejected(database, `
    UPDATE "MemorySearchEntry" SET "embeddingState" = 'PENDING'
    WHERE "id" = 'memory-search-a';
  `, /Lexical Memory generation cannot contain vector work/u, "vector work in lexical generation");

  expectRejected(database, `
    UPDATE "MemoryIndexGeneration" SET "normalizationVersion" = 'changed'
    WHERE "id" = 'memory-generation-a';
  `, /configuration is immutable/u, "generation configuration mutation");

  requireSuccess(psql(database, `
    INSERT INTO "MemoryIndexGeneration" (
      "id", "userId", "generation", "state", "indexMode", "targetMemoryRevision",
      "indexedThroughMemoryRevision", "languageProfile", "normalizationVersion",
      "chunkingVersion", "retrievalPipelineVersion"
    ) VALUES
      ('memory-generation-failed-2', 'memory-owner-a', 2, 'FAILED', 'LEXICAL_ONLY', 0, 0,
       'RU_EN_MULTILINGUAL_V1', 'memory-normalization-v1', 'memory-chunking-v1', 'memory-retrieval-v1'),
      ('memory-generation-failed-3', 'memory-owner-a', 3, 'FAILED', 'LEXICAL_ONLY', 0, 0,
       'RU_EN_MULTILINGUAL_V1', 'memory-normalization-v1', 'memory-chunking-v1', 'memory-retrieval-v1');
  `), "retain failed generation evidence");
}

function assertPreparingAndOutboxContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "Message" ("id", "chatId", "role", "content", "status", "updatedAt")
    VALUES ('memory-preparing-assistant', 'memory-chat-a', 'assistant', '[]'::jsonb, 'streaming', CURRENT_TIMESTAMP);

    BEGIN;
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "assistantMessageId", "provider",
      "modelId", "status", "normalizedRequest", "providerRequestPreview", "updatedAt"
    ) VALUES (
      'memory-preparing-run', 'memory-chat-a', 'memory-owner-a', 'memory-user-message-a',
      'memory-preparing-assistant', 'fake', 'fake-qsa', 'preparing', NULL, NULL, CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryRetrievalAttempt" (
      "id", "userId", "modelRunId", "attemptOrdinal", "chatId", "admissionKind",
      "admittedUserMessageId", "admittedAssistantLeafMessageId", "chatMemoryModeSnapshot",
      "settingsSnapshot", "memoryGenerationSnapshot", "retrievalRevisionSnapshot",
      "indexGenerationIdSnapshot", "utilityEgressMode", "externalRolesUsed", "queryHash",
      "boundedPrivateBaseRequestSnapshot", "baseRequestHash", "state", "expiresAt"
    ) VALUES (
      'memory-attempt-1', 'memory-owner-a', 'memory-preparing-run', 1, 'memory-chat-a',
      'NORMAL_SEND', 'memory-user-message-a', 'memory-preparing-assistant', 'NORMAL',
      '{}'::jsonb, 0, 0, 'memory-generation-a', 'LOCAL_ONLY', ARRAY[]::text[], repeat('q', 64),
      '{}'::jsonb, repeat('r', 64), 'PENDING', CURRENT_TIMESTAMP + interval '10 minutes'
    );
    COMMIT;
  `), "admit PREPARING run and retrieval attempt atomically");

  expectRejected(database, `
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "assistantMessageId", "provider",
      "modelId", "status", "normalizedRequest", "providerRequestPreview", "updatedAt"
    ) VALUES (
      'memory-second-active-run', 'memory-chat-a', 'memory-owner-a', 'memory-user-message-a',
      'memory-assistant-message-a', 'fake', 'fake-qsa', 'queued', '{}'::jsonb, '{}'::jsonb,
      CURRENT_TIMESTAMP
    );
  `, /ModelRun_one_active_per_chat_idx/u, "PREPARING active-run fence");

  requireSuccess(psql(database, `
    UPDATE "MemoryRetrievalAttempt"
    SET "state" = 'READY', "outcome" = 'EMPTY'
    WHERE "id" = 'memory-attempt-1';

    BEGIN;
    UPDATE "MemoryRetrievalAttempt"
    SET "state" = 'CONSUMED', "consumedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'memory-attempt-1';
    INSERT INTO "ModelRunMemoryBinding" (
      "id", "userId", "modelRunId", "retrievalAttemptId", "memoryGenerationSnapshot",
      "retrievalRevisionSnapshot", "finalizedRevisionSnapshot", "settingsSnapshot",
      "indexGenerationId", "queryHash", "queryPlannerVersion", "retrievalPipelineVersion",
      "contextTextHash", "contextTokenCount", "outcome", "finalizedAt"
    ) VALUES (
      'memory-run-binding-1', 'memory-owner-a', 'memory-preparing-run', 'memory-attempt-1',
      0, 0, 0, '{}'::jsonb, 'memory-generation-a', repeat('q', 64), 'planner-v1',
      'memory-retrieval-v1', repeat('s', 64), 0, 'EMPTY', CURRENT_TIMESTAMP
    );
    UPDATE "ModelRun"
    SET "status" = 'queued', "normalizedRequest" = '{}'::jsonb,
        "providerRequestPreview" = '{}'::jsonb
    WHERE "id" = 'memory-preparing-run';
    COMMIT;

    INSERT INTO "MemoryRetrievalAttempt" (
      "id", "userId", "modelRunId", "attemptOrdinal", "chatId", "admissionKind",
      "admittedUserMessageId", "admittedAssistantLeafMessageId", "chatMemoryModeSnapshot",
      "settingsSnapshot", "memoryGenerationSnapshot", "retrievalRevisionSnapshot",
      "utilityEgressMode", "externalRolesUsed", "queryHash", "baseRequestHash", "state",
      "outcome", "errorCode", "expiresAt"
    ) VALUES (
      'memory-attempt-failed-2', 'memory-owner-a', 'memory-preparing-run', 2, 'memory-chat-a',
      'NORMAL_SEND', 'memory-user-message-a', 'memory-preparing-assistant', 'NORMAL',
      '{}'::jsonb, 0, 0, 'LOCAL_ONLY', ARRAY[]::text[], repeat('t', 64), repeat('u', 64),
      'FAILED', 'FAILED_SAFE', 'embedding_unavailable', CURRENT_TIMESTAMP + interval '10 minutes'
    );
  `), "finalize run and retain failed attempt history");

  expectRejected(database, `
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
      "normalizedRequest", "providerRequestPreview", "updatedAt"
    ) VALUES (
      'memory-invalid-null-run', 'memory-chat-b', 'memory-owner-b', 'memory-user-message-b',
      'fake', 'fake-qsa', 'complete', NULL, NULL, CURRENT_TIMESTAMP
    );
  `, /ModelRun_memory_request_shape_check/u, "null finalized run request");

  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
    VALUES ('memory-delete-owner', 'delete@example.test', 'Delete', 'user', 'active', CURRENT_TIMESTAMP);
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId", "memoryGeneration", "state"
    ) VALUES (
      'memory-delete-obligation', 'memory-delete-owner', 'ACCOUNT_MEMORY_DELETE', 'ACCOUNT',
      'memory-delete-owner', 1, 'PENDING'
    );
  `), "create account deletion obligation");

  assert.equal(
    scalar(database, `SELECT count(*) FROM "UserMemorySettings" WHERE "userId" = 'memory-delete-owner';`),
    "1",
    "new users do not receive inert Memory settings"
  );
  expectRejected(database, `
    DELETE FROM "User" WHERE "id" = 'memory-delete-owner';
  `, /MemoryDeletionOutbox_user_fkey/u, "unfinished account deletion obligation");

  expectRejected(database, `
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "logicalRole", "ordinal", "state", "providerId",
      "destinationFingerprint", "policyVersion", "promptVersion", "schemaVersion",
      "pipelineVersion", "secretFreeExecutionSnapshot", "inputHash"
    ) VALUES (
      'memory-invalid-execution', 'memory-owner-a', 'JOB', 'EXTRACTOR', 0, 'PENDING',
      'fake', repeat('v', 64), 'policy-v1', 'prompt-v1', 'schema-v1', 'pipeline-v1',
      '{}'::jsonb, repeat('w', 64)
    );
  `, /MemoryExecutionBinding_shape_check/u, "execution without exact owner and provider relations");

  requireSuccess(psql(database, `
    INSERT INTO "MemoryJob" (
      "id", "userId", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot", "idempotencyFingerprint",
      "completedAt"
    ) VALUES (
      'memory-usage-job-a', 'memory-owner-a', 'EXTRACT_FACTS', 'SUCCEEDED',
      'memory-pipeline-v1', 0, 0, repeat('x', 64), CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "providerId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion", "secretFreeExecutionSnapshot",
      "inputHash", "usageCompleteness", "recoverableUntil", "relationsDetachedAt",
      "completedAt"
    ) VALUES (
      'memory-usage-execution-a', 'memory-owner-a', 'JOB', 'memory-usage-job-a',
      'EXTRACTOR', 0, 'SUCCEEDED', 'fake', repeat('y', 64), 'policy-v1', 'prompt-v1',
      'schema-v1', 'memory-pipeline-v1', '{}'::jsonb, repeat('z', 64), 'UNAVAILABLE',
      CURRENT_TIMESTAMP - interval '1 second', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "create settled detached execution evidence");

  expectRejected(database, `
    INSERT INTO "UsageEvent" (
      "id", "userId", "provider", "modelId", "memoryExecutionBindingId"
    ) VALUES (
      'memory-cross-owner-usage', 'memory-owner-b', 'fake', 'fake-qsa',
      'memory-usage-execution-a'
    );
  `, /UsageEvent_memory_execution_fkey/u, "cross-owner Memory usage binding");

  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
    VALUES ('memory-cascade-owner', 'cascade@example.test', 'Cascade', 'user', 'active', CURRENT_TIMESTAMP);
    DELETE FROM "User" WHERE "id" = 'memory-cascade-owner';
  `), "cascade inert settings with their deleted owner");
}

function assertFreshContracts(database: string): void {
  const requiredTables = [
    "MemoryDeletionOutbox",
    "MemoryExecutionBinding",
    "MemoryFact",
    "MemoryFactVersion",
    "MemoryIndexGeneration",
    "MemoryRetrievalAttempt",
    "MemoryScope",
    "MemorySearchEntry",
    "ModelRunMemoryBinding",
    "UserMemorySettings"
  ];
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (${requiredTables.map((name) => `'${name}'`).join(",")});
    `),
    String(requiredTables.length),
    "fresh migration is missing Memory foundation tables"
  );
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM pg_constraint
      WHERE conname IN (
        'MemoryDeletionOutbox_user_fkey',
        'MemoryFact_current_version_fkey',
        'MemoryFactVersion_created_event_fkey',
        'MemoryRetrievalAttempt_shape_check',
        'MemoryScope_target_shape_check',
        'ModelRun_memory_request_shape_check'
      ) AND convalidated;
    `),
    "6",
    "critical Memory constraints are absent or unvalidated"
  );
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'MemoryFact_active_owner_scope_idx',
          'MemoryJob_pending_owner_due_idx'
        );
    `),
    "2",
    "required active/claimable Memory partial indexes are absent"
  );
}

function seedExecutionUsageUpgradeFixture(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "UsageEvent" (
      "id", "userId", "modelRunId", "provider", "modelId"
    ) VALUES (
      'memory-legacy-usage', 'memory-owner-a', 'memory-legacy-run', 'fake', 'fake-qsa'
    );

    INSERT INTO "MemoryJob" (
      "id", "userId", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot", "idempotencyFingerprint",
      "completedAt"
    ) VALUES (
      'memory-execution-usage-job', 'memory-owner-a', 'EXTRACT_FACTS', 'SUCCEEDED',
      'memory-pipeline-v1', 0, 0, repeat('u', 64), CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "providerId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion", "secretFreeExecutionSnapshot",
      "inputHash", "usageCompleteness", "recoverableUntil", "relationsDetachedAt",
      "completedAt"
    ) VALUES (
      'memory-execution-usage-binding', 'memory-owner-a', 'JOB',
      'memory-execution-usage-job', 'MEMORY_FACT_EXTRACT', 0, 'SUCCEEDED',
      'openai_compatible', repeat('v', 64), 'policy-v1', 'prompt-v1', 'schema-v1',
      'memory-pipeline-v1', '{}'::jsonb, repeat('w', 64), 'UNAVAILABLE',
      CURRENT_TIMESTAMP - interval '1 second', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "seed Memory execution usage upgrade fixture");
}

function seedExecutionUsageFreshOwner(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-owner-a', 'memory-fresh-a@example.test', 'Memory fresh A',
      'user', 'active', CURRENT_TIMESTAMP
    );
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES ('memory-chat-a', 'memory-owner-a', 'Memory fresh chat', CURRENT_TIMESTAMP);
    INSERT INTO "Message" ("id", "chatId", "role", "content", "status", "updatedAt") VALUES
      ('memory-user-message-a', 'memory-chat-a', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
      ('memory-assistant-message-a', 'memory-chat-a', 'assistant', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP);
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "assistantMessageId",
      "provider", "modelId", "status", "normalizedRequest", "providerRequestPreview",
      "updatedAt"
    ) VALUES (
      'memory-legacy-run', 'memory-chat-a', 'memory-owner-a', 'memory-user-message-a',
      'memory-assistant-message-a', 'fake', 'fake-qsa', 'complete', '{}'::jsonb,
      '{}'::jsonb, CURRENT_TIMESTAMP
    );
  `), "seed fresh Memory execution usage owner");
}

function assertExecutionUsageContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT count(*)
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'UsageEvent'
        AND column_name IN (
          'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
          'reasoningTokens', 'totalTokens', 'estimatedCostMicros'
        )
        AND is_nullable = 'YES'
        AND column_default IS NULL;
    `),
    "7",
    "Memory usage evidence columns are not nullable and default-free"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
        "outputTokens", "reasoningTokens", "totalTokens", "estimatedCostMicros")
      FROM "UsageEvent" WHERE "id" = 'memory-legacy-usage';
    `),
    "0|0|0|0|0|0|0",
    "nullable migration changed existing ordinary usage evidence"
  );

  requireSuccess(psql(database, `
    INSERT INTO "UsageEvent" (
      "id", "userId", "provider", "modelId", "providerModelId",
      "memoryExecutionBindingId"
    ) VALUES (
      'memory-execution-usage', 'memory-owner-a', 'openai_compatible',
      'memory-upstream-model', 'memory-provider-model-snapshot',
      'memory-execution-usage-binding'
    );
  `), "create nullable Memory execution usage evidence");
  assert.equal(
    scalar(database, `
      SELECT num_nonnulls(
        "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
        "reasoningTokens", "totalTokens", "estimatedCostMicros"
      ) FROM "UsageEvent" WHERE "id" = 'memory-execution-usage';
    `),
    "0",
    "Memory usage synthesized unreported categories"
  );

  expectRejected(database, `
    UPDATE "UsageEvent" SET "providerModelId" = NULL
    WHERE "id" = 'memory-execution-usage';
  `, /UsageEvent_knowledge_shape_check/u, "Memory usage without deployment evidence");
  expectRejected(database, `
    UPDATE "UsageEvent" SET "modelRunId" = 'memory-legacy-run'
    WHERE "id" = 'memory-execution-usage';
  `, /UsageEvent_knowledge_shape_check/u, "Memory usage copied into answer-run accounting");
  expectRejected(database, `
    UPDATE "UsageEvent" SET "providerModelId" = 'forbidden-provider-model'
    WHERE "id" = 'memory-legacy-usage';
  `, /UsageEvent_knowledge_shape_check/u, "ordinary usage impersonating bound utility usage");
}

function assertCoordinatorFairnessContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT string_agg("pipeline", ',' ORDER BY "pipeline")
      FROM "DocumentProcessingFairnessCursor"
      WHERE "pipeline" LIKE 'memory-%';
    `),
    "memory-delete,memory-job",
    "Memory coordinator fairness lanes were not seeded independently"
  );

  requireSuccess(psql(database, `
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES
      ('memory-job', 'memory-owner-a', CURRENT_TIMESTAMP),
      ('memory-delete', 'memory-owner-b', CURRENT_TIMESTAMP)
    ON CONFLICT ("pipeline") DO UPDATE SET
      "lastGrantedOwnerUserId" = EXCLUDED."lastGrantedOwnerUserId",
      "updatedAt" = EXCLUDED."updatedAt";
  `), "update Memory coordinator fairness lanes");

  expectRejected(database, `
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES ('memory-unsupported', NULL, CURRENT_TIMESTAMP);
  `, /DocumentProcessingFairnessCursor_pipeline_check/u, "unsupported fairness lane");
}

function assertFeatureDarkScopeContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-phase3-owner-b', 'memory-phase3-b@example.test', 'Memory Phase 3 B',
      'user', 'active', CURRENT_TIMESTAMP
    );
    INSERT INTO "Folder" ("id", "userId", "name", "updatedAt")
    VALUES (
      'memory-phase3-folder-b', 'memory-phase3-owner-b', 'Phase 3 B', CURRENT_TIMESTAMP
    );
    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryMode",
      "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
      "createdAt", "updatedAt"
    ) VALUES (
      'memory-phase3-feature-dark-temp', 'memory-owner-a', 'Feature-dark Temporary',
      'TEMPORARY', 'temporary-24h-v1', CURRENT_TIMESTAMP + interval '24 hours',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "create second Phase 3 scope owner");

  expectRejected(database, `
    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
    ) VALUES (
      'memory-phase3-dark-scope', 'memory-owner-a', 'FOLDER', 'memory-phase3-folder-b',
      'memory-phase3-folder-b', 'ACTIVE'
    );
  `, /feature-dark until Phase 3 authorization/u, "feature-dark scoped target");

  requireSuccess(
    psql(database, `ALTER TABLE "MemoryScope" DISABLE TRIGGER "MemoryScope_phase1_guard";`),
    "temporarily expose inherited scope constraints"
  );
  try {
    expectRejected(database, `
      INSERT INTO "MemoryScope" (
        "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
      ) VALUES (
        'memory-phase3-cross-owner-scope', 'memory-owner-a', 'FOLDER',
        'memory-phase3-folder-b', 'memory-phase3-folder-b', 'ACTIVE'
      );
    `, /MemoryScope_folder_fkey/u, "cross-owner Phase 3 scope target");

    expectRejected(database, `
      INSERT INTO "MemoryScope" (
        "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
      ) VALUES (
        'memory-phase3-dangling-scope', 'memory-owner-a', 'FOLDER',
        'memory-phase3-missing-folder', 'memory-phase3-missing-folder', 'ACTIVE'
      );
    `, /MemoryScope_folder_fkey/u, "dangling Phase 3 scope target");
  } finally {
    requireSuccess(
      psql(database, `ALTER TABLE "MemoryScope" ENABLE TRIGGER "MemoryScope_phase1_guard";`),
      "restore feature-dark scope guard"
    );
  }
}

function assertChatScopeSchemaContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', deletion."state", deletion."memoryGeneration")
      FROM "MemoryDeletionOutbox" AS deletion
      WHERE deletion."userId" = 'memory-owner-a'
        AND deletion."operation" = 'TEMPORARY_DELETE'
        AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
        AND deletion."targetId" = 'memory-phase3-feature-dark-temp';
    `),
    "PENDING|0",
    "Temporary-retention migration did not adopt a feature-dark row"
  );

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        "memoryMode",
        "memoryBranchGeneration",
        "memorySourceRevision",
        num_nonnulls("temporaryRetentionPolicyVersion", "temporaryRetentionDeadline")
      )
      FROM "Chat"
      WHERE "id" = 'memory-chat-a';
    `),
    "NORMAL|0|0|0",
    "Phase 3 migration changed an existing chat or invented source state"
  );

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM pg_constraint
         WHERE conname = 'Chat_memory_state_check' AND convalidated),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'Chat_memoryMode_temporaryRetentionDeadline_idx'),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'Chat_memory_mode_guard' AND NOT tgisinternal),
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'MemoryScope_folder_fkey',
           'MemoryScope_chat_fkey',
           'MemoryScope_target_shape_check'
         ) AND convalidated)
      );
    `),
    "1|1|1|3",
    "Phase 3 chat or inherited typed-scope constraints are incomplete"
  );

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES ('memory-phase3-normal', 'memory-owner-a', 'Normal', CURRENT_TIMESTAMP);

    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryMode",
      "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
      "createdAt", "updatedAt"
    ) VALUES (
      'memory-phase3-temporary', 'memory-owner-a', 'Temporary', 'TEMPORARY',
      'temporary-24h-v1', CURRENT_TIMESTAMP + interval '24 hours',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId",
      "memoryGeneration", "state", "nextAttemptAt", "updatedAt"
    ) VALUES (
      'memory-phase3-temporary-delete', 'memory-owner-a', 'TEMPORARY_DELETE',
      'TEMPORARY_CHAT@temporary-24h-v1', 'memory-phase3-temporary', 0,
      'PENDING', CURRENT_TIMESTAMP + interval '24 hours', CURRENT_TIMESTAMP
    );

    UPDATE "Chat"
    SET "temporaryRetentionDeadline" = "temporaryRetentionDeadline" + interval '1 hour'
    WHERE "id" = 'memory-phase3-temporary';
    COMMIT;
  `), "create ordinary and admitted Temporary chat state");

  expectRejected(database, `
    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryMode", "temporaryRetentionDeadline", "updatedAt"
    ) VALUES (
      'memory-phase3-temp-no-policy', 'memory-owner-a', 'Invalid', 'TEMPORARY',
      CURRENT_TIMESTAMP + interval '24 hours', CURRENT_TIMESTAMP
    );
  `, /Chat_memory_state_check/u, "Temporary chat without reviewed policy");

  expectRejected(database, `
    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryMode", "temporaryRetentionPolicyVersion",
      "temporaryRetentionDeadline", "updatedAt"
    ) VALUES (
      'memory-phase3-temp-old-policy', 'memory-owner-a', 'Invalid', 'TEMPORARY',
      'temporary-legacy', CURRENT_TIMESTAMP + interval '24 hours', CURRENT_TIMESTAMP
    );
  `, /Chat_memory_state_check/u, "Temporary chat with unreviewed policy");

  expectRejected(database, `
    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryMode", "temporaryRetentionPolicyVersion",
      "temporaryRetentionDeadline", "updatedAt"
    ) VALUES (
      'memory-phase3-temp-expired', 'memory-owner-a', 'Invalid', 'TEMPORARY',
      'temporary-24h-v1', CURRENT_TIMESTAMP - interval '1 second', CURRENT_TIMESTAMP
    );
  `, /Chat_memory_state_check/u, "Temporary chat with a pre-creation deadline");

  expectRejected(database, `
    INSERT INTO "Chat" (
      "id", "userId", "title", "memoryBranchGeneration", "updatedAt"
    ) VALUES (
      'memory-phase3-negative-counter', 'memory-owner-a', 'Invalid', -1, CURRENT_TIMESTAMP
    );
  `, /Chat_memory_state_check/u, "negative chat Memory counter");

  expectRejected(database, `
    UPDATE "Chat"
    SET "memoryMode" = 'NORMAL',
        "temporaryRetentionPolicyVersion" = NULL,
        "temporaryRetentionDeadline" = NULL
    WHERE "id" = 'memory-phase3-temporary';
  `, /Temporary chat mode is immutable after first-send admission/u, "Temporary-to-normal conversion");

  expectRejected(database, `
    INSERT INTO "Message" (
      "id", "chatId", "role", "content", "status", "updatedAt"
    ) VALUES (
      'memory-phase3-normal-message', 'memory-phase3-normal', 'user',
      '{"blocks":[{"type":"text","text":"already sent"}]}'::jsonb,
      'complete', CURRENT_TIMESTAMP
    );
    UPDATE "Chat"
    SET "memoryMode" = 'TEMPORARY',
        "temporaryRetentionPolicyVersion" = 'temporary-24h-v1',
        "temporaryRetentionDeadline" = CURRENT_TIMESTAMP + interval '24 hours'
    WHERE "id" = 'memory-phase3-normal';
  `, /Temporary chat mode is immutable after first-send admission/u, "late Temporary conversion");

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES (
      'memory-phase3-pre-send', 'memory-owner-a', 'Pre-send', CURRENT_TIMESTAMP
    );
    UPDATE "Chat"
    SET "memoryMode" = 'TEMPORARY',
        "temporaryRetentionPolicyVersion" = 'temporary-24h-v1',
        "temporaryRetentionDeadline" = CURRENT_TIMESTAMP + interval '24 hours'
    WHERE "id" = 'memory-phase3-pre-send';
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId",
      "memoryGeneration", "state", "nextAttemptAt", "updatedAt"
    ) VALUES (
      'memory-phase3-pre-send-delete', 'memory-owner-a', 'TEMPORARY_DELETE',
      'TEMPORARY_CHAT@temporary-24h-v1', 'memory-phase3-pre-send', 0,
      'PENDING', CURRENT_TIMESTAMP + interval '24 hours', CURRENT_TIMESTAMP
    );
    INSERT INTO "Message" (
      "id", "chatId", "role", "content", "status", "updatedAt"
    ) VALUES (
      'memory-phase3-pre-send-message', 'memory-phase3-pre-send', 'user',
      '{"blocks":[{"type":"text","text":"temporary"}]}'::jsonb,
      'complete', CURRENT_TIMESTAMP
    );
    COMMIT;
  `), "admit Temporary and its one deletion obligation atomically");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', chat."memoryMode", deletion."state",
        deletion."memoryGeneration")
      FROM "Chat" AS chat
      INNER JOIN "MemoryDeletionOutbox" AS deletion
        ON deletion."targetId" = chat."id"
       AND deletion."operation" = 'TEMPORARY_DELETE'
      WHERE chat."id" = 'memory-phase3-pre-send';
    `),
    "TEMPORARY|PENDING|0",
    "pre-send admission did not bind the exact durable deletion obligation"
  );

  expectRejected(database, `
    BEGIN;
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES (
      'memory-phase3-unbound-temp', 'memory-owner-a', 'Unbound', CURRENT_TIMESTAMP
    );
    UPDATE "Chat"
    SET "memoryMode" = 'TEMPORARY',
        "temporaryRetentionPolicyVersion" = 'temporary-24h-v1',
        "temporaryRetentionDeadline" = CURRENT_TIMESTAMP + interval '24 hours'
    WHERE "id" = 'memory-phase3-unbound-temp';
    INSERT INTO "Message" (
      "id", "chatId", "role", "content", "status", "updatedAt"
    ) VALUES (
      'memory-phase3-unbound-message', 'memory-phase3-unbound-temp', 'user',
      '{"blocks":[]}'::jsonb, 'complete', CURRENT_TIMESTAMP
    );
    COMMIT;
  `, /exactly one durable deletion obligation/u, "unbound Temporary admission");

  expectRejected(database, `
    DELETE FROM "Chat" WHERE "id" = 'memory-phase3-pre-send';
  `, /claimed durable obligation/u, "uncoordinated Temporary hard delete");

  expectRejected(database, `
    BEGIN;
    DELETE FROM "Message" WHERE "chatId" = 'memory-phase3-pre-send';
    DELETE FROM "MemoryDeletionOutbox"
    WHERE "id" = 'memory-phase3-pre-send-delete';
    COMMIT;
  `, /exactly one durable deletion obligation/u,
  "remove Temporary messages and deletion obligation");

  expectRejected(database, `
    UPDATE "MemoryDeletionOutbox"
    SET "targetId" = 'memory-phase3-normal'
    WHERE "id" = 'memory-phase3-pre-send-delete';
  `, /exactly one durable deletion obligation/u,
  "retarget the only Temporary deletion obligation");

  expectRejected(database, `
    UPDATE "Chat"
    SET "temporaryRetentionPolicyVersion" = 'temporary-replacement'
    WHERE "id" = 'memory-phase3-temporary';
  `, /Temporary retention policy is immutable after admission/u, "Temporary policy replacement");

  requireSuccess(psql(database, `
    UPDATE "Chat" SET "memoryMode" = 'EXCLUDED'
    WHERE "id" = 'memory-phase3-normal';
    UPDATE "Chat" SET "archived" = TRUE
    WHERE "id" = 'memory-phase3-normal';
  `), "change independent ordinary chat organization and source mode");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', "memoryMode", "archived"::int,
        "memoryBranchGeneration", "memorySourceRevision")
      FROM "Chat" WHERE "id" = 'memory-phase3-normal';
    `),
    "EXCLUDED|1|0|0",
    "archive state changed chat Memory mode or counters"
  );

}

function assertChatScopeMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_chat_memory_mode_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END
    $$;
  `), "install rollback-conflict fixture");

  const result = psql(
    database,
    readFileSync(join(migrationsRoot, CHAT_SCOPE_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting Phase 3 migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_chat_memory_mode_guard" already exists/u,
    "Phase 3 rollback fixture failed for an unexpected reason"
  );

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'Chat'
           AND column_name IN (
             'memoryMode', 'memoryBranchGeneration', 'memorySourceRevision',
             'temporaryRetentionPolicyVersion', 'temporaryRetentionDeadline'
           )),
        (SELECT count(*) FROM pg_constraint WHERE conname = 'Chat_memory_state_check'),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'Chat_memoryMode_temporaryRetentionDeadline_idx'),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'Chat_memory_mode_guard' AND NOT tgisinternal),
        (SELECT count(*) FROM pg_proc WHERE proname = 'aiqsa_chat_memory_mode_guard')
      );
    `),
    "0|0|0|0|1",
    "failed Phase 3 migration left partial durable state"
  );
}

function assertScopeLifecycleContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" (
      "id", "email", "displayName", "role", "status", "updatedAt"
    ) VALUES (
      'memory-owner-b', 'memory-scope-owner-b@example.test', 'Memory scope B',
      'user', 'active', CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING;
    INSERT INTO "Folder" ("id", "userId", "name", "updatedAt")
    VALUES ('memory-scope-live-folder', 'memory-owner-a', 'Scoped target', CURRENT_TIMESTAMP);
    INSERT INTO "AssistantDefinition" (
      "id", "ownerUserId", "version", "createdAt", "updatedAt"
    ) VALUES (
      'memory-scope-assistant-a', 'memory-owner-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "AssistantDefinition" (
      "id", "ownerUserId", "version", "createdAt", "updatedAt"
    ) VALUES (
      'memory-scope-assistant-b', 'memory-owner-b', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "folderId", "state"
    ) VALUES (
      'memory-scope-folder-a', 'memory-owner-a', 'FOLDER', 'memory-scope-live-folder',
      'memory-scope-live-folder', 'ACTIVE'
    );
    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "assistantId", "state"
    ) VALUES (
      'memory-scope-assistant-owned', 'memory-owner-a', 'ASSISTANT',
      'memory-scope-assistant-a', 'memory-scope-assistant-a', 'ACTIVE'
    );
    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "chatId", "state"
    ) VALUES (
      'memory-scope-chat-owned', 'memory-owner-a', 'CHAT',
      'memory-chat-a', 'memory-chat-a', 'ACTIVE'
    );
  `), "activate owned typed Memory scopes");

  expectRejected(database, `
    INSERT INTO "MemoryScope" (
      "id", "userId", "scopeType", "targetIdSnapshot", "assistantId", "state"
    ) VALUES (
      'memory-scope-assistant-foreign', 'memory-owner-a', 'ASSISTANT',
      'memory-scope-assistant-b', 'memory-scope-assistant-b', 'ACTIVE'
    );
  `, /MemoryScope_assistant_fkey/u, "foreign-owned Assistant Memory scope");

  requireSuccess(psql(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO "MemoryFact" (
      "id", "userId", "scopeId", "canonicalKey", "category", "state", "currentVersionId"
    ) VALUES (
      'memory-scope-fact-a', 'memory-owner-a', 'memory-scope-folder-a',
      'scope.lifecycle', 'preference', 'ACTIVE', 'memory-scope-version-a'
    );
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "actorUserId", "factId",
      "factVersionId", "metadata"
    ) VALUES (
      'memory-scope-event-a', 'memory-owner-a', 'EXPLICIT_SAVE', 'USER',
      'memory-owner-a', 'memory-scope-fact-a', 'memory-scope-version-a', '{}'::jsonb
    );
    INSERT INTO "MemoryFactVersion" (
      "id", "userId", "factId", "displayText", "normalizedSearchText",
      "languageCode", "structuredValue", "category", "modality", "sourceMode",
      "state", "confidence", "importance", "directness", "sensitivityClass",
      "createdByEventId", "pipelineVersion"
    ) VALUES (
      'memory-scope-version-a', 'memory-owner-a', 'memory-scope-fact-a',
      'Scoped lifecycle', 'scoped lifecycle', 'en', '{"scope":"folder"}'::jsonb,
      'preference', 'PREFERENCE', 'EXPLICIT', 'ACTIVE', 1, 1, 'DIRECT', 'NORMAL',
      'memory-scope-event-a', 'memory-pipeline-v1'
    );
    COMMIT;
  `), "create active fact under an owned typed scope");

  expectRejected(database, `
    BEGIN;
    UPDATE "MemoryScope"
    SET "state" = 'ORPHANED', "folderId" = NULL, "orphanedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'memory-scope-folder-a';
    COMMIT;
  `, /ACTIVE Memory fact requires an ACTIVE scope/u, "dangling active scoped fact");

  expectRejected(database, `
    UPDATE "MemoryFact" SET "scopeId" = 'memory-global-a'
    WHERE "id" = 'memory-scope-fact-a';
  `, /Memory fact scope identity is immutable/u, "in-place fact rescope");

  requireSuccess(psql(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE "MemoryFactVersion"
    SET "state" = 'ORPHANED', "systemTo" = "systemFrom" + interval '1 millisecond'
    WHERE "id" = 'memory-scope-version-a';
    UPDATE "MemoryFact"
    SET "state" = 'ORPHANED', "currentVersionId" = NULL
    WHERE "id" = 'memory-scope-fact-a';
    UPDATE "MemoryScope"
    SET "state" = 'ORPHANED', "folderId" = NULL, "orphanedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'memory-scope-folder-a';
    DELETE FROM "Folder" WHERE "id" = 'memory-scope-live-folder';
    COMMIT;
  `), "detach a typed target only with its fact lifecycle transition");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', scope."targetIdSnapshot", COALESCE(scope."folderId", 'NULL'),
        scope."state", fact."state", COALESCE(fact."currentVersionId", 'NULL'), version."state")
      FROM "MemoryScope" AS scope
      INNER JOIN "MemoryFact" AS fact ON fact."scopeId" = scope."id"
      INNER JOIN "MemoryFactVersion" AS version ON version."factId" = fact."id"
      WHERE scope."id" = 'memory-scope-folder-a';
    `),
    "memory-scope-live-folder|NULL|ORPHANED|ORPHANED|NULL|ORPHANED",
    "scope tombstone did not preserve identity and clear live pointers"
  );
}

function assertHistorySchemaContracts(database: string, withCardinality: boolean): void {
  const historyTables = [
    "ChatMemoryCheckpoint",
    "MemoryEpisode",
    "MemoryEpisodeMessage",
    "MemoryRecallChunk",
    "MemoryRecallChunkMessage"
  ];
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (${historyTables.map((name) => `'${name}'`).join(",")});
    `),
    String(historyTables.length),
    "Phase 4 history tables are incomplete"
  );
  assert.equal(
    scalar(database, `
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
      FROM pg_enum
      WHERE enumtypid = '"MemorySearchItemType"'::regtype;
    `),
    "FACT_VERSION,EPISODE,RECALL_CHUNK",
    "Phase 4 search target enum is incomplete"
  );
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'MemorySearchEntry_embedding_1024_hnsw_idx',
          'MemorySearchEntry_embedding_1536_hnsw_idx',
          'MemorySearchEntry_episode_target_key',
          'MemorySearchEntry_recall_chunk_target_key'
        );
    `),
    "4",
    "Phase 4 typed-target or HNSW indexes are missing"
  );

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "Chat" ("id", "userId", "folderId", "title", "updatedAt")
    VALUES (
      'memory-history-chat-b', 'memory-phase3-owner-b', 'memory-phase3-folder-b',
      'History B', CURRENT_TIMESTAMP
    );
    INSERT INTO "Message" ("id", "chatId", "role", "content", "status", "updatedAt") VALUES
      ('memory-history-user-b', 'memory-history-chat-b', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
      ('memory-history-assistant-b', 'memory-history-chat-b', 'assistant', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP);
    UPDATE "Chat"
    SET "activeLeafMessageId" = 'memory-history-assistant-b'
    WHERE "id" = 'memory-history-chat-b';
    UPDATE "Chat"
    SET "activeLeafMessageId" = 'memory-assistant-message-a'
    WHERE "id" = 'memory-chat-a';

    INSERT INTO "MemoryIndexGeneration" (
      "id", "userId", "generation", "state", "indexMode", "targetMemoryRevision",
      "indexedThroughMemoryRevision", "languageProfile", "normalizationVersion",
      "chunkingVersion", "retrievalPipelineVersion", "readyAt", "activatedAt"
    )
    SELECT
      'memory-history-lexical-a', 'memory-owner-a', 9, 'ACTIVE', 'LEXICAL_ONLY',
      settings."memoryRevision", settings."memoryRevision", 'RU_EN_MULTILINGUAL_V1',
      'memory-normalization-v1', 'memory-chunking-v1', 'memory-retrieval-v1',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "UserMemorySettings" AS settings
    WHERE settings."userId" = 'memory-owner-a'
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryIndexGeneration"
        WHERE "userId" = 'memory-owner-a' AND "state" = 'ACTIVE'
      );
    UPDATE "UserMemorySettings"
    SET "activeIndexGenerationId" = (
      SELECT "id" FROM "MemoryIndexGeneration"
      WHERE "userId" = 'memory-owner-a' AND "state" = 'ACTIVE'
    )
    WHERE "userId" = 'memory-owner-a';

    INSERT INTO "ChatMemoryCheckpoint" (
      "id", "userId", "chatId", "branchGeneration", "sourceRevision",
      "activeLeafMessageId", "sourceContentHash", "lastIndexedMessageId",
      "status", "lastSucceededAt"
    ) VALUES (
      'memory-history-checkpoint-a', 'memory-owner-a', 'memory-chat-a', 0, 0,
      'memory-assistant-message-a', repeat('a', 64), 'memory-assistant-message-a',
      'READY', CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-history-chunk-a', chat."userId", chat."id", chat."folderId", 0, 0, 0,
      repeat('b', 64), 'Безопасный фрагмент API', 'безопасный фрагмент api', 'ru',
      CURRENT_TIMESTAMP - interval '1 minute', CURRENT_TIMESTAMP, 'ACTIVE',
      'memory-chunking-v1', 'memory-source-v1', 'NORMAL', 'NOT_NEEDED'
    FROM "Chat" AS chat WHERE chat."id" = 'memory-chat-a';
    INSERT INTO "MemoryRecallChunkMessage" (
      "userId", "chunkId", "chatId", "messageId", "ordinal", "role"
    ) VALUES (
      'memory-owner-a', 'memory-history-chunk-a', 'memory-chat-a',
      'memory-user-message-a', 0, 'user'
    );
    INSERT INTO "MemoryEpisode" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "safeSummary", "normalizedSafeSearchText",
      "languageCode", "keywords", "entities", "occurredFrom", "occurredTo",
      "state", "extractorRole", "createdByExecutionId", "pipelineVersion",
      "sourceHash", "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-history-episode-a', chat."userId", chat."id", chat."folderId", 0, 0,
      'Обсуждение безопасного API', 'обсуждение безопасного api', 'ru',
      '["api"]'::jsonb, '[]'::jsonb, CURRENT_TIMESTAMP - interval '1 minute',
      CURRENT_TIMESTAMP, 'ACTIVE', 'MEMORY_EPISODE_EXTRACT',
      'memory-execution-usage-binding', 'memory-episode-v1', repeat('c', 64),
      'memory-source-v1', 'NORMAL', 'NOT_NEEDED'
    FROM "Chat" AS chat WHERE chat."id" = 'memory-chat-a';
    INSERT INTO "MemoryEpisodeMessage" (
      "userId", "episodeId", "chatId", "messageId", "ordinal"
    ) VALUES (
      'memory-owner-a', 'memory-history-episode-a', 'memory-chat-a',
      'memory-user-message-a', 0
    );

    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "recallChunkId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embeddingState"
    )
    SELECT
      'memory-history-search-chunk-a', 'memory-owner-a', generation."id",
      'RECALL_CHUNK', 'memory-history-chunk-a', 'Безопасный фрагмент API',
      'Безопасный фрагмент API', repeat('d', 64), 'ru', repeat('e', 64),
      repeat('f', 64), repeat('g', 64), 'NOT_APPLICABLE'
    FROM "MemoryIndexGeneration" AS generation
    WHERE generation."userId" = 'memory-owner-a' AND generation."state" = 'ACTIVE';
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "episodeId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embeddingState"
    )
    SELECT
      'memory-history-search-episode-a', 'memory-owner-a', generation."id",
      'EPISODE', 'memory-history-episode-a', 'Обсуждение безопасного API',
      'Обсуждение безопасного API', repeat('h', 64), 'ru', repeat('i', 64),
      repeat('j', 64), repeat('k', 64), 'NOT_APPLICABLE'
    FROM "MemoryIndexGeneration" AS generation
    WHERE generation."userId" = 'memory-owner-a' AND generation."state" = 'ACTIVE';
    COMMIT;
  `), "create Phase 4 history aggregates and lexical targets");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM "ChatMemoryCheckpoint" WHERE "userId" = 'memory-owner-a'),
        (SELECT count(*) FROM "MemoryRecallChunkMessage" WHERE "userId" = 'memory-owner-a'),
        (SELECT count(*) FROM "MemoryEpisodeMessage" WHERE "userId" = 'memory-owner-a'),
        (SELECT ("searchVectorRussian" @@ plainto_tsquery('russian', 'фрагмент'))::int
         FROM "MemorySearchEntry" WHERE "id" = 'memory-history-search-chunk-a'),
        (SELECT ("searchVectorSimple" @@ plainto_tsquery('simple', 'API'))::int
         FROM "MemorySearchEntry" WHERE "id" = 'memory-history-search-episode-a')
      );
    `),
    "1|1|1|1|1",
    "history joins or synchronous multilingual lexical rows are incomplete"
  );

  expectRejected(database, `
    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    ) VALUES (
      'memory-history-cross-owner', 'memory-owner-a', 'memory-history-chat-b',
      'memory-phase3-folder-b', 0, 0, 0, repeat('l', 64), 'cross owner',
      'cross owner', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ACTIVE',
      'memory-chunking-v1', 'memory-source-v1', 'NORMAL', 'NOT_NEEDED'
    );
  `, /MemoryRecallChunk_(chat|folder)_fkey/u, "cross-owner history source");

  expectRejected(database, `
    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-history-stale-source', chat."userId", chat."id", chat."folderId", 99,
      0, 99, repeat('m', 64), 'stale source', 'stale source', 'en',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ACTIVE', 'memory-chunking-v1',
      'memory-source-v1', 'NORMAL', 'NOT_NEEDED'
    FROM "Chat" AS chat WHERE chat."id" = 'memory-chat-a';
  `, /ACTIVE Memory history must match/u, "active stale source generation");

  expectRejected(database, `
    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-history-secret', chat."userId", chat."id", chat."folderId", 0, 0,
      98, repeat('n', 64), 'must not persist', 'must not persist', 'en',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ACTIVE', 'memory-chunking-v1',
      'memory-source-v1', 'SECRET_TAINTED', 'EXCLUDED'
    FROM "Chat" AS chat WHERE chat."id" = 'memory-chat-a';
  `, /MemoryRecallChunk_shape_check/u, "secret-tainted derivative retention");

  expectRejected(database, `
    INSERT INTO "MemoryRecallChunkMessage" (
      "userId", "chunkId", "chatId", "messageId", "ordinal", "role"
    ) VALUES (
      'memory-owner-a', 'memory-history-chunk-a', 'memory-history-chat-b',
      'memory-history-user-b', 2, 'user'
    );
  `, /MemoryRecallChunkMessage_chunk_fkey/u, "cross-chat chunk message");

  expectRejected(database, `
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "episodeId",
      "recallChunkId", "safeSearchText", "safeSearchTextYoNormalized",
      "safeContentHash", "languageCode", "safetyIdentitySnapshot",
      "sourceIdentitySnapshot", "suppressionIdentitySnapshot", "embeddingState"
    )
    SELECT
      'memory-history-invalid-target-shape', 'memory-owner-a', generation."id",
      'EPISODE', 'memory-history-episode-a', 'memory-history-chunk-a', 'invalid',
      'invalid', repeat('o', 64), 'en', repeat('p', 64), repeat('q', 64),
      repeat('r', 64), 'NOT_APPLICABLE'
    FROM "MemoryIndexGeneration" AS generation
    WHERE generation."userId" = 'memory-owner-a' AND generation."state" = 'ACTIVE';
  `, /MemorySearchEntry_shape_check/u, "multi-target search row");

  expectRejected(database, `
    UPDATE "Chat"
    SET "memorySourceRevision" = "memorySourceRevision" + 1
    WHERE "id" = 'memory-chat-a';
  `, /ACTIVE Memory history must match/u, "source revision without derivative transition");

  if (withCardinality) {
    requireSuccess(psql(database, `
      INSERT INTO "MemoryEvidence" (
        "id", "userId", "factVersionId", "stance", "sourceType", "chatId",
        "episodeId", "branchGeneration", "safeExcerpt", "safeSourceHash",
        "sourceProjectionVersion", "safetyClass", "observedAt"
      ) VALUES (
        'memory-history-episode-evidence', 'memory-owner-a', 'memory-version-a',
        'SUPPORTS', 'EPISODE', 'memory-chat-a', 'memory-history-episode-a', 0,
        'Безопасное эпизодическое свидетельство', repeat('s', 64),
        'memory-source-v1', 'NORMAL', CURRENT_TIMESTAMP
      );
      INSERT INTO "MemorySuppression" (
        "id", "userId", "scope", "sourceChatId", "sourceEpisodeId",
        "sourceBranchGeneration", "deletionGeneration", "fingerprintKeyVersion",
        "normalizationVersion"
      ) VALUES (
        'memory-history-episode-suppression', 'memory-owner-a', 'SOURCE_EPISODE',
        'memory-chat-a', 'memory-history-episode-a', 0, 0, 'memory-key-v1',
        'memory-normalization-v1'
      );

      INSERT INTO "MemoryRetrievalAttemptItem" (
        "id", "userId", "attemptId", "ordinal", "itemType", "exactItemId",
        "episodeId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot", "exactSafeText",
        "textHash", "sourceSnapshot", "versionSnapshot", "laneRanks",
        "featureSnapshot", "selectionReason"
      ) VALUES (
        'memory-history-attempt-item', 'memory-owner-a', 'memory-attempt-1', 10,
        'EPISODE', 'memory-history-episode-a', 'memory-history-episode-a',
        'memory-chat-a', 0, 0, repeat('c', 64), 'Обсуждение безопасного API',
        repeat('t', 64), '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        'history-schema-contract'
      );

      INSERT INTO "MemoryEpisode" (
        "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
        "sourceRevisionAtCreation", "safeSummary", "normalizedSafeSearchText",
        "languageCode", "keywords", "entities", "state", "extractorRole",
        "createdByExecutionId", "pipelineVersion", "sourceHash",
        "sourceProjectionVersion", "safetyClass", "redactionState"
      )
      SELECT
        'memory-history-accepted-episode', chat."userId", chat."id", chat."folderId",
        0, 0, 'Accepted history snapshot', 'accepted history snapshot', 'en',
        '[]'::jsonb, '[]'::jsonb, 'ACTIVE', 'MEMORY_EPISODE_EXTRACT',
        'memory-execution-usage-binding', 'memory-episode-v1', repeat('u', 64),
        'memory-source-v1', 'NORMAL', 'NOT_NEEDED'
      FROM "Chat" AS chat WHERE chat."id" = 'memory-chat-a';
      INSERT INTO "ModelRunMemoryItem" (
        "id", "userId", "bindingId", "ordinal", "itemType", "exactItemId",
        "episodeId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot",
        "sourceMessageIdsSnapshot", "includedText", "includedTextHash",
        "itemStateAtAdmission", "laneRanks", "featureSnapshot", "finalScore",
        "selectionReason"
      ) VALUES (
        'memory-history-accepted-item', 'memory-owner-a', 'memory-run-binding-1', 10,
        'EPISODE', 'memory-history-accepted-episode', 'memory-history-accepted-episode',
        'memory-chat-a', 0, 0, repeat('u', 64), ARRAY['memory-user-message-a'],
        'Accepted history snapshot', repeat('v', 64), 'ACTIVE', '{}'::jsonb,
        '{}'::jsonb, 0.8, 'history-schema-contract'
      );
      DELETE FROM "MemoryEpisode" WHERE "id" = 'memory-history-accepted-episode';
    `), "prove typed staging and immutable accepted history snapshots");

    assert.equal(
      scalar(database, `
        SELECT concat_ws('|', "exactItemId", COALESCE("episodeId", 'NULL'),
          "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
          "sourceRevisionSnapshot", "sourceContentHashSnapshot")
        FROM "ModelRunMemoryItem" WHERE "id" = 'memory-history-accepted-item';
      `),
      `memory-history-accepted-episode|NULL|memory-chat-a|0|0|${"u".repeat(64)}`,
      "accepted history snapshot did not retain exact source-generation evidence"
    );

    expectRejected(database, `
      INSERT INTO "MemoryRetrievalAttemptItem" (
        "id", "userId", "attemptId", "ordinal", "itemType", "exactItemId",
        "recallChunkId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
        "sourceRevisionSnapshot", "sourceContentHashSnapshot", "exactSafeText",
        "textHash", "selectionReason"
      ) VALUES (
        'memory-history-wrong-generation-item', 'memory-owner-a', 'memory-attempt-1',
        11, 'RECALL_CHUNK', 'memory-history-chunk-a', 'memory-history-chunk-a',
        'memory-chat-a', 0, 999, repeat('b', 64), 'wrong generation',
        repeat('w', 64), 'history-schema-contract'
      );
    `, /MemoryRetrievalAttemptItem_recall_chunk_fkey/u,
    "staged item with mismatched source generation");
  }

  requireSuccess(psql(database, `
    BEGIN;
    UPDATE "MemoryRecallChunk"
    SET "state" = 'INVALIDATED', "invalidatedAt" = CURRENT_TIMESTAMP
    WHERE "userId" = 'memory-owner-a' AND "chatId" = 'memory-chat-a'
      AND "state" = 'ACTIVE';
    UPDATE "MemoryEpisode"
    SET "state" = 'INVALIDATED', "invalidatedAt" = CURRENT_TIMESTAMP
    WHERE "userId" = 'memory-owner-a' AND "chatId" = 'memory-chat-a'
      AND "state" = 'ACTIVE';
    UPDATE "ChatMemoryCheckpoint"
    SET "status" = 'STALE'
    WHERE "userId" = 'memory-owner-a' AND "chatId" = 'memory-chat-a';
    UPDATE "Chat"
    SET "memorySourceRevision" = "memorySourceRevision" + 1
    WHERE "id" = 'memory-chat-a';
    COMMIT;
  `), "advance chat source only with atomic history invalidation");

  if (!withCardinality) return;

  requireSuccess(psql(database, `
    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'memory-history-embedding-connection', 'Memory history embedding',
      'openai_compatible', true, '{}'::jsonb, 1, '{}'::jsonb, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig",
      "activeVersion", "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'memory-history-embedding-model', 'memory-history-embedding-connection',
      'openai_compatible', 'memory-history-embedding', 'Memory history embedding',
      'embedding', 32768, '{}'::jsonb, 1, '{}'::jsonb, 1, '{}'::jsonb,
      '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryIndexGeneration" (
      "id", "userId", "generation", "state", "indexMode",
      "targetMemoryRevision", "indexedThroughMemoryRevision",
      "embeddingConnectionId", "embeddingProviderModelId",
      "embeddingConfigurationFingerprint", "embeddingDimension",
      "vectorSpaceFingerprint", "languageProfile", "normalizationVersion",
      "chunkingVersion", "retrievalPipelineVersion"
    ) VALUES
      (
        'memory-history-hybrid-1024', 'memory-owner-a', 10, 'BUILDING', 'HYBRID',
        0, 0, 'memory-history-embedding-connection', 'memory-history-embedding-model',
        repeat('x', 64), 1024, repeat('y', 64), 'RU_EN_MULTILINGUAL_V1',
        'memory-normalization-v1', 'memory-chunking-v1', 'memory-retrieval-v1'
      ),
      (
        'memory-history-hybrid-1536', 'memory-phase3-owner-b', 10, 'BUILDING',
        'HYBRID', 0, 0, 'memory-history-embedding-connection',
        'memory-history-embedding-model', repeat('z', 64), 1536, repeat('0', 64),
        'RU_EN_MULTILINGUAL_V1', 'memory-normalization-v1', 'memory-chunking-v1',
        'memory-retrieval-v1'
      );

    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-cardinality-1024-chunk-' || n, chat."userId", chat."id", chat."folderId",
      chat."memoryBranchGeneration", chat."memorySourceRevision", 1000 + n,
      md5('memory-cardinality-1024-' || n), 'Recall fixture ' || n,
      'recall fixture ' || n, 'en', CURRENT_TIMESTAMP - interval '1 day',
      CURRENT_TIMESTAMP, 'ACTIVE', 'memory-chunking-v1', 'memory-source-v1',
      'NORMAL', 'NOT_NEEDED'
    FROM generate_series(1, 5001) AS n
    CROSS JOIN "Chat" AS chat
    WHERE chat."id" = 'memory-chat-a';
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "recallChunkId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embedding", "embeddingDimension",
      "embeddingState"
    )
    SELECT
      'memory-cardinality-1024-search-' || n, 'memory-owner-a',
      'memory-history-hybrid-1024', 'RECALL_CHUNK',
      'memory-cardinality-1024-chunk-' || n, 'Recall fixture ' || n,
      'Recall fixture ' || n, md5('memory-cardinality-1024-search-' || n), 'en',
      md5('memory-safety-1024-' || n), md5('memory-source-1024-' || n),
      md5('memory-suppression-1024-' || n),
      (ARRAY[1::real] || array_fill((n % 17)::real / 1000, ARRAY[1023]))::vector,
      1024, 'READY'
    FROM generate_series(1, 5001) AS n;

    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "sourceFolderId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      'memory-cardinality-1536-chunk-' || n, chat."userId", chat."id", chat."folderId",
      chat."memoryBranchGeneration", chat."memorySourceRevision", 1000 + n,
      md5('memory-cardinality-1536-' || n), 'Recall fixture B ' || n,
      'recall fixture b ' || n, 'en', CURRENT_TIMESTAMP - interval '1 day',
      CURRENT_TIMESTAMP, 'ACTIVE', 'memory-chunking-v1', 'memory-source-v1',
      'NORMAL', 'NOT_NEEDED'
    FROM generate_series(1, 32) AS n
    CROSS JOIN "Chat" AS chat
    WHERE chat."id" = 'memory-history-chat-b';
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "recallChunkId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embedding", "embeddingDimension",
      "embeddingState"
    )
    SELECT
      'memory-cardinality-1536-search-' || n, 'memory-phase3-owner-b',
      'memory-history-hybrid-1536', 'RECALL_CHUNK',
      'memory-cardinality-1536-chunk-' || n, 'Recall fixture B ' || n,
      'Recall fixture B ' || n, md5('memory-cardinality-1536-search-' || n), 'en',
      md5('memory-safety-1536-' || n), md5('memory-source-1536-' || n),
      md5('memory-suppression-1536-' || n),
      (ARRAY[1::real] || array_fill((n % 19)::real / 1000, ARRAY[1535]))::vector,
      1536, 'READY'
    FROM generate_series(1, 32) AS n;
    ANALYZE "MemorySearchEntry";
  `), "load Phase 4 realistic HNSW cardinality fixtures");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM "MemorySearchEntry"
         WHERE "indexGenerationId" = 'memory-history-hybrid-1024'),
        (SELECT count(*) FROM "MemorySearchEntry"
         WHERE "indexGenerationId" = 'memory-history-hybrid-1536')
      );
    `),
    "5001|32",
    "HNSW cardinality fixtures are incomplete"
  );

  const plan1024 = requireSuccess(psql(database, `
    SET enable_seqscan = off;
    SET enable_sort = off;
    EXPLAIN (COSTS OFF)
    SELECT "id"
    FROM "MemorySearchEntry"
    WHERE "userId" = 'memory-owner-a'
      AND "indexGenerationId" = 'memory-history-hybrid-1024'
      AND "itemType" = 'RECALL_CHUNK'
      AND "embeddingState" = 'READY'
      AND "embeddingDimension" = 1024
    ORDER BY ("embedding"::vector(1024) <=>
      ((ARRAY[1::real] || array_fill(0::real, ARRAY[1023]))::vector(1024)))
    LIMIT 10;
  `), "EXPLAIN Memory 1024 HNSW index usability");
  assert.match(
    plan1024,
    /MemorySearchEntry_embedding_1024_hnsw_idx/u,
    "1024-dimensional Memory HNSW index is not usable"
  );

  const plan1536 = requireSuccess(psql(database, `
    SET enable_seqscan = off;
    SET enable_sort = off;
    EXPLAIN (COSTS OFF)
    SELECT "id"
    FROM "MemorySearchEntry"
    WHERE "userId" = 'memory-phase3-owner-b'
      AND "indexGenerationId" = 'memory-history-hybrid-1536'
      AND "itemType" = 'RECALL_CHUNK'
      AND "embeddingState" = 'READY'
      AND "embeddingDimension" = 1536
    ORDER BY ("embedding"::vector(1536) <=>
      ((ARRAY[1::real] || array_fill(0::real, ARRAY[1535]))::vector(1536)))
    LIMIT 10;
  `), "EXPLAIN Memory 1536 HNSW index usability");
  assert.match(
    plan1536,
    /MemorySearchEntry_embedding_1536_hnsw_idx/u,
    "1536-dimensional Memory HNSW index is not usable"
  );
}

function assertScopeLifecycleMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_fact_scope_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install scoped-lifecycle rollback-conflict fixture");

  const result = psql(
    database,
    readFileSync(join(migrationsRoot, SCOPE_LIFECYCLE_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting scoped-lifecycle migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_fact_scope_guard" already exists/u,
    "scoped-lifecycle rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'MemoryScope_phase1_guard' AND NOT tgisinternal),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'MemoryScope_identity_guard' AND NOT tgisinternal),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'AssistantDefinition_ownerUserId_id_key')
      );
    `),
    "1|0|0",
    "failed scoped-lifecycle migration left partial durable state"
  );
}

function assertTemporaryRetentionMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_assert_temporary_chat_obligation(text, text)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  `), "install Temporary-retention rollback-conflict fixture");

  const result = psql(
    database,
    readFileSync(join(migrationsRoot, TEMPORARY_RETENTION_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting Temporary-retention migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_assert_temporary_chat_obligation" already exists/u,
    "Temporary-retention rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'MemoryDeletionOutbox_temporary_chat_key'),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'Chat_temporary_delete_guard' AND NOT tgisinternal),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'Chat_temporary_obligation_guard',
           'Message_temporary_obligation_guard',
           'MemoryDeletionOutbox_temporary_chat_guard'
         ) AND NOT tgisinternal),
        (SELECT count(*) FROM pg_proc
         WHERE proname = 'aiqsa_temporary_chat_delete_guard')
      );
    `),
    "0|0|0|0",
    "failed Temporary-retention migration left partial durable state"
  );

  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-temp-rollback-owner', 'Temporary rollback', 'user', 'active',
      CURRENT_TIMESTAMP
    );
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES (
      'memory-temp-rollback-chat', 'memory-temp-rollback-owner', 'Temporary rollback',
      CURRENT_TIMESTAMP
    );
  `), "create Temporary-retention rollback guard fixture");
  expectRejected(database, `
    UPDATE "Chat"
    SET "memoryMode" = 'TEMPORARY',
        "temporaryRetentionPolicyVersion" = 'temporary-24h-v1',
        "temporaryRetentionDeadline" = CURRENT_TIMESTAMP + interval '24 hours'
    WHERE "id" = 'memory-temp-rollback-chat';
  `, /Temporary chat mode is immutable after admission/u,
  "pre-migration Temporary mode guard after rollback");
}

function assertHistoryEgressContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-r2-default-owner', 'Memory R2 defaults', 'user', 'active',
      CURRENT_TIMESTAMP
    );
  `), "create post-R2 Memory-default owner");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM "UserMemorySettings"
         WHERE NOT "useMemoryFacts" OR NOT "referenceChatHistory"),
        (SELECT concat_ws(':', "useMemoryFacts"::int, "referenceChatHistory"::int,
          "learnAutomatically"::int)
         FROM "UserMemorySettings" WHERE "userId" = 'memory-r2-default-owner')
      );
    `),
    "0|1:1:0",
    "Revision 2 Memory defaults were not applied to existing and new owners"
  );

  requireSuccess(psql(database, `
    INSERT INTO "ModelRunToolCall" (
      "id", "modelRunId", "roundIndex", "ordinal", "providerCallId",
      "toolName", "arguments", "state", "result", "startedAt", "completedAt", "updatedAt"
    ) VALUES
      (
        'memory-history-tool-call', 'memory-legacy-run', 1, 0,
        'memory-history-provider-call', 'search_my_history',
        '{"query":"safe history"}'::jsonb, 'complete', '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'memory-egress-tool-call', 'memory-legacy-run', 1, 1,
        'memory-egress-provider-call', 'mcp_safe_lookup',
        '{"query":"direct user value"}'::jsonb, 'complete', '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

    INSERT INTO "MemoryHistoryRun" (
      "id", "userId", "modelRunId", "modelRunToolCallId",
      "invocationOrdinal", "state", "outcome", "query", "queryHash",
      "privateRequest", "indexingEvidence", "results", "providerResult",
      "resultHash", "resultCount", "durationMs", "completedAt"
    ) VALUES (
      'memory-history-receipt', 'memory-owner-a', 'memory-legacy-run',
      'memory-history-tool-call', 1, 'COMPLETE', 'RESULTS', 'safe history',
      repeat('a', 64), '{"query":"safe history","pageSize":20}'::jsonb,
      '{"lexicalState":"READY","vectorState":"READY"}'::jsonb,
      '{"results":[{"sourceChatId":"memory-chat-a","sourceMessageIds":["memory-user-message-a"],"snippet":"safe"}]}'::jsonb,
      '{"callId":"memory-history-provider-call","content":[],"name":"search_my_history","status":"complete"}'::jsonb,
      repeat('b', 64), 1, 5, CURRENT_TIMESTAMP
    );

    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "modelRunToolCallId", "requestOrdinal",
      "mode", "destinationKind", "destinationFingerprint",
      "destinationSnapshot", "requestEvidenceHash", "requestPreviewHash", "dispatchState",
      "dispatchStartedAt", "dispatchCompletedAt"
    ) VALUES
      (
        'memory-egress-receipt', 'memory-owner-a', 'memory-legacy-run',
        'memory-egress-tool-call', 1, 'TOOL_CALL', 'mcp',
        repeat('c', 64), '{"kind":"mcp","serverId":"safe-server","version":1}'::jsonb,
        repeat('d', 64), repeat('e', 64), 'COMPLETED',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchCompletedAt", "errorCode"
    ) VALUES (
      'memory-egress-provider-blocked', 'memory-owner-a', 'memory-legacy-run', 2,
      'PROVIDER_REQUEST', 'answer_provider', repeat('f', 64),
      '{"kind":"answer_provider","provider":"openai","version":1}'::jsonb,
      repeat('0', 64), 'BLOCKED', CURRENT_TIMESTAMP,
      'memory_egress_destination_revoked'
    );

  `), "create bounded history and egress receipts");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT concat_ws(':', "state", "outcome", "resultCount")
         FROM "MemoryHistoryRun" WHERE "id" = 'memory-history-receipt'),
        (SELECT concat_ws(':', "mode", "dispatchState")
         FROM "MemoryToolEgressReceipt" WHERE "id" = 'memory-egress-receipt'),
        (SELECT concat_ws(':', "mode", "dispatchState", "errorCode")
         FROM "MemoryToolEgressReceipt" WHERE "id" = 'memory-egress-provider-blocked')
      );
    `),
    "COMPLETE:RESULTS:1|TOOL_CALL:COMPLETED|PROVIDER_REQUEST:BLOCKED:memory_egress_destination_revoked",
    "history or egress receipt state was not retained exactly"
  );

  expectRejected(database, `
    INSERT INTO "MemoryHistoryRun" (
      "id", "userId", "modelRunId", "modelRunToolCallId", "invocationOrdinal",
      "query", "queryHash", "privateRequest"
    ) VALUES (
      'memory-history-third-call', 'memory-owner-a', 'memory-legacy-run',
      'memory-egress-tool-call', 3, 'third', repeat('1', 64), '{}'::jsonb
    );
  `, /MemoryHistoryRun_shape_check/u, "third history-tool invocation");

  expectRejected(database, `
    INSERT INTO "MemoryHistoryRun" (
      "id", "userId", "modelRunId", "modelRunToolCallId", "invocationOrdinal",
      "query", "queryHash", "privateRequest"
    ) VALUES (
      'memory-history-cross-owner', 'memory-owner-b', 'memory-legacy-run',
      'memory-egress-tool-call', 2, 'cross owner', repeat('2', 64), '{}'::jsonb
    );
  `, /MemoryHistoryRun_modelRun_fkey/u, "cross-owner history receipt");

  expectRejected(database, `
    INSERT INTO "MemoryHistoryRun" (
      "id", "userId", "modelRunId", "modelRunToolCallId", "invocationOrdinal",
      "query", "queryHash", "privateRequest"
    ) VALUES (
      'memory-history-oversized', 'memory-owner-a', 'memory-legacy-run',
      'memory-egress-tool-call', 2, 'oversized', repeat('3', 64),
      jsonb_build_object('query', repeat('x', 20000))
    );
  `, /MemoryHistoryRun_shape_check/u, "oversized private history request");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchStartedAt"
    ) VALUES (
      'memory-egress-invalid-hash', 'memory-owner-a', 'memory-legacy-run', 3,
      'PROVIDER_REQUEST', 'answer_provider', 'invalid', '{}'::jsonb,
      repeat('4', 64), 'DISPATCHED', CURRENT_TIMESTAMP
    );
  `, /MemoryToolEgressReceipt_shape_check/u, "malformed egress hash");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchStartedAt"
    ) VALUES (
      'memory-egress-cross-owner', 'memory-owner-b', 'memory-legacy-run', 3,
      'PROVIDER_REQUEST', 'answer_provider', repeat('5', 64), '{}'::jsonb,
      repeat('6', 64), 'DISPATCHED', CURRENT_TIMESTAMP
    );
  `, /MemoryToolEgressReceipt_modelRun_fkey/u, "cross-owner egress receipt");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchStartedAt"
    ) VALUES (
      'memory-egress-ordinal-overflow', 'memory-owner-a', 'memory-legacy-run', 65,
      'PROVIDER_REQUEST', 'answer_provider', repeat('7', 64), '{}'::jsonb,
      repeat('8', 64), 'DISPATCHED', CURRENT_TIMESTAMP
    );
  `, /MemoryToolEgressReceipt_shape_check/u, "egress request ordinal overflow");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchStartedAt"
    ) VALUES (
      'memory-egress-tool-without-call', 'memory-owner-a', 'memory-legacy-run', 3,
      'TOOL_CALL', 'mcp', repeat('9', 64), '{}'::jsonb,
      repeat('a', 64), 'DISPATCHED', CURRENT_TIMESTAMP
    );
  `, /MemoryToolEgressReceipt_shape_check/u, "tool receipt without exact tool call");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState"
    ) VALUES (
      'memory-egress-incomplete-completion', 'memory-owner-a', 'memory-legacy-run', 3,
      'PROVIDER_REQUEST', 'answer_provider', repeat('a', 64), '{}'::jsonb,
      repeat('b', 64), 'COMPLETED'
    );
  `, /MemoryToolEgressReceipt_shape_check/u, "completed receipt without timestamps");

  expectRejected(database, `
    INSERT INTO "MemoryToolEgressReceipt" (
      "id", "userId", "modelRunId", "requestOrdinal", "mode",
      "destinationKind", "destinationFingerprint", "destinationSnapshot",
      "requestEvidenceHash", "dispatchState", "dispatchStartedAt"
    ) VALUES (
      'memory-egress-oversized-snapshot', 'memory-owner-a', 'memory-legacy-run', 3,
      'PROVIDER_REQUEST', 'answer_provider', repeat('b', 64),
      jsonb_build_object('value', repeat('x', 40000)), repeat('c', 64),
      'DISPATCHED', CURRENT_TIMESTAMP
    );
  `, /MemoryToolEgressReceipt_shape_check/u, "oversized destination snapshot");

  requireSuccess(psql(database, `
    UPDATE "MemoryHistoryRun"
    SET
      "query" = NULL,
      "privateRequest" = '{}'::jsonb,
      "results" = NULL,
      "providerResult" = NULL,
      "resultHash" = NULL,
      "retentionState" = 'SCRUBBED',
      "plaintextPurgedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'memory-history-receipt';
  `), "scrub private history plaintext");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT concat_ws(':', "retentionState", ("query" IS NULL)::int,
          ("providerResult" IS NULL)::int)
         FROM "MemoryHistoryRun" WHERE "id" = 'memory-history-receipt'),
        (SELECT concat_ws(':', "mode", "dispatchState", ("requestEvidenceHash" IS NOT NULL)::int)
         FROM "MemoryToolEgressReceipt" WHERE "id" = 'memory-egress-receipt')
      );
    `),
    "SCRUBBED:1:1|TOOL_CALL:COMPLETED:1",
    "private-history scrub or immutable passive receipt state is invalid"
  );
}

function assertSemanticRetrievalContracts(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-semantic-default-owner', 'Memory semantic defaults', 'user', 'active',
      CURRENT_TIMESTAMP
    );
  `), "create post-semantic-retrieval default owner");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT concat_ws(':', "useMemoryFacts"::int, "referenceChatHistory"::int,
          "learnAutomatically"::int)
         FROM "UserMemorySettings"
         WHERE "userId" = 'memory-semantic-default-owner'),
        (SELECT "learnAutomatically"::int FROM "UserMemorySettings"
         WHERE "userId" = 'memory-r2-default-owner'),
        (SELECT count(*) FROM pg_enum
         WHERE enumtypid = '"MemoryCoreSalience"'::regtype),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND (
             (table_name = 'MemoryCandidate'
               AND column_name IN ('proposedCoreEligible', 'proposedCoreSalience'))
             OR (table_name = 'MemoryFactVersion'
               AND column_name IN ('coreEligible', 'coreSalience'))
           )),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'UserMemorySettings'
           AND column_name = 'learnAutomatically'
           AND column_default = 'true'::text),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryFactVersion'
           AND (
             (column_name = 'coreEligible' AND column_default = 'false'::text)
             OR (column_name = 'coreSalience' AND column_default LIKE '%NONE%')
           )),
        (SELECT character_maximum_length FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryHistoryRun' AND column_name = 'query'),
        (SELECT count(*) FROM pg_constraint
         WHERE conname = 'MemoryCandidate_shape_check'
           AND pg_get_constraintdef(oid) LIKE '%proposedCoreEligible%'
           AND pg_get_constraintdef(oid) LIKE '%memory-fact-extraction-v2%'),
        (SELECT count(*) FROM pg_proc
         WHERE proname = 'aiqsa_memory_candidate_decision_authority_trigger'
           AND pg_get_functiondef(oid) LIKE '%memory-fact-consolidation-v2%')
      );
    `),
    "1:1:1|0|4|4|1|2|2000|1|1",
    "multilingual semantic retrieval migration contract drifted"
  );
}

function assertFactReceiptProvenanceContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM pg_constraint
      WHERE conname = 'MemoryRetrievalAttemptItem_shape_check'
        AND pg_get_constraintdef(oid) LIKE
          '%num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot") = 2%'
        AND pg_get_constraintdef(oid) LIKE
          '%num_nonnulls("sourceRevisionSnapshot", "sourceContentHashSnapshot") = 0%';
    `),
    "1",
    "automatic fact receipt message-provenance shape is not installed"
  );
}

function assertHistoryEgressMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE TYPE "MemoryHistoryRunState" AS ENUM ('fixture');
  `), "install history-egress rollback-conflict fixture");

  const result = psql(
    database,
    readFileSync(join(migrationsRoot, HISTORY_EGRESS_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting history-egress migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /type "MemoryHistoryRunState" already exists/u,
    "history-egress rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('MemoryHistoryRun', 'MemoryToolEgressReceipt')),
        (SELECT count(*) FROM pg_type
         WHERE typname IN (
           'MemoryHistoryRunOutcome', 'MemoryReceiptRetentionState',
           'MemoryToolEgressMode', 'MemoryToolEgressDispatchState'
         ))
      );
    `),
    "0|0",
    "failed history-egress migration left partial durable state"
  );
}

function assertAdminEgressContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM "MemoryEgressAdminPolicy"),
        (SELECT concat_ws(':', "id", "version", jsonb_array_length("acceptedDestinations"),
          ("acceptedFingerprint" IS NULL)::int, ("acceptedAt" IS NULL)::int)
         FROM "MemoryEgressAdminPolicy" WHERE "id" = 'installation'),
        (SELECT count(*) FROM pg_constraint
         WHERE conname = 'MemoryEgressAdminPolicy_shape_check' AND convalidated),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'MemoryEgressAdminPolicy_acceptedByUserId_idx')
      );
    `),
    "1|installation:1:0:1:1|1|1",
    "administrator Memory egress singleton is incomplete"
  );

  requireSuccess(psql(database, `
    INSERT INTO "User" (
      "id", "displayName", "role", "status", "updatedAt"
    ) VALUES (
      'memory-egress-admin', 'Memory egress admin', 'admin', 'active', CURRENT_TIMESTAMP
    );
    UPDATE "MemoryEgressAdminPolicy"
    SET
      "acceptedFingerprint" = repeat('a', 64),
      "acceptedPolicyVersion" = 'memory-utility-egress-v1',
      "acceptedDestinations" = jsonb_build_array(jsonb_build_object(
        'destinationFingerprint', repeat('b', 64),
        'role', 'MEMORY_DOCUMENT_EMBED'
      )),
      "acceptedAt" = CURRENT_TIMESTAMP,
      "acceptedByUserId" = 'memory-egress-admin',
      "version" = "version" + 1;
  `), "accept an administrator-owned Memory destination snapshot");

  expectRejected(database, `
    INSERT INTO "MemoryEgressAdminPolicy" ("id") VALUES ('second-installation');
  `, /MemoryEgressAdminPolicy_shape_check/u, "second installation Memory policy");
  expectRejected(database, `
    UPDATE "MemoryEgressAdminPolicy"
    SET "acceptedFingerprint" = 'invalid'
    WHERE "id" = 'installation';
  `, /MemoryEgressAdminPolicy_shape_check/u, "malformed administrator fingerprint");
  expectRejected(database, `
    UPDATE "MemoryEgressAdminPolicy"
    SET "acceptedDestinations" = '{}'::jsonb
    WHERE "id" = 'installation';
  `, /MemoryEgressAdminPolicy_shape_check/u, "non-array administrator destinations");

  requireSuccess(psql(database, `
    DELETE FROM "User" WHERE "id" = 'memory-egress-admin';
  `), "remove the acknowledging administrator");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        ("acceptedByUserId" IS NULL)::int,
        ("acceptedFingerprint" = repeat('a', 64))::int,
        jsonb_array_length("acceptedDestinations"),
        "version")
      FROM "MemoryEgressAdminPolicy" WHERE "id" = 'installation';
    `),
    "1|1|1|2",
    "administrator deletion rewrote accepted destination evidence"
  );
}

function assertAdminEgressMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE TABLE "MemoryEgressAdminPolicy" ("fixture" TEXT);
  `), "install administrator-egress rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, ADMIN_EGRESS_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting administrator-egress migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /relation "MemoryEgressAdminPolicy" already exists/u,
    "administrator-egress rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryEgressAdminPolicy' AND column_name = 'fixture'),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryEgressAdminPolicy' AND column_name = 'id'),
        (SELECT count(*) FROM pg_constraint
         WHERE conname = 'MemoryEgressAdminPolicy_shape_check'),
        (SELECT count(*) FROM pg_indexes
         WHERE indexname = 'MemoryEgressAdminPolicy_acceptedByUserId_idx')
      );
    `),
    "1|0|0|0",
    "failed administrator-egress migration left partial durable state"
  );
}

function assertHistorySchemaMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_assert_history_source(text, text)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  `), "install history-schema rollback-conflict fixture");

  const result = psql(
    database,
    readFileSync(join(migrationsRoot, HISTORY_SCHEMA_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting history-schema migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_assert_history_source" already exists/u,
    "history-schema rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemorySearchItemType"'::regtype),
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('ChatMemoryCheckpoint', 'MemoryRecallChunk', 'MemoryEpisode')),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ModelRunMemoryItem' AND column_name = 'exactItemId'),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname LIKE 'MemorySearchEntry_embedding_%_hnsw_idx')
      );
    `),
    "FACT_VERSION|0|0|0",
    "failed history-schema migration left partial durable state"
  );
}

function assertFactCandidateContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryCandidateState"'::regtype),
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('MemoryCandidate', 'MemoryCandidateMessage')),
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'MemoryCandidate_shape_check',
           'MemoryCandidate_job_source_fkey',
           'MemoryCandidateMessage_candidate_fkey',
           'MemoryCandidateMessage_message_fkey'
         ) AND convalidated),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'MemoryCandidate_authority_trigger',
           'MemoryCandidateMessage_authority_trigger',
           'MemoryCandidate_evidence_trigger',
           'MemoryCandidateMessage_evidence_trigger',
           'Message_memory_candidate_authority_trigger',
           'MemoryExecutionBinding_candidate_authority_trigger',
           'MemoryJob_candidate_authority_trigger'
         ) AND NOT tgisinternal)
      );
    `),
    "PENDING,DEFERRED,PROMOTED,REJECTED,STALE|2|4|7",
    "fact-candidate schema authority is incomplete"
  );

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "MemoryJob" (
      "id", "userId", "chatId", "activeLeafMessageId", "branchGeneration",
      "sourceRevision", "sourceHash", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot",
      "idempotencyFingerprint", "acceptedResultHash", "completedAt"
    ) VALUES (
      'memory-fact-candidate-job', 'memory-owner-a', 'memory-chat-a',
      'memory-assistant-message-a', 0, 0, repeat('a', 64), 'EXTRACT_FACTS',
      'SUCCEEDED', 'memory-fact-extraction-v1', 0, 0, repeat('b', 64),
      repeat('c', 64), CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "providerId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion",
      "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash",
      "usageCompleteness", "recoverableUntil", "relationsDetachedAt", "completedAt"
    ) VALUES (
      'memory-fact-candidate-binding', 'memory-owner-a', 'JOB',
      'memory-fact-candidate-job', 'MEMORY_FACT_EXTRACT', 0, 'SUCCEEDED',
      'openai_compatible', repeat('d', 64), 'memory-fact-policy-v1',
      'memory-fact-prompt-v1', 'memory-fact-schema-v1',
      'memory-fact-extraction-v1', '{}'::jsonb, repeat('e', 64), repeat('f', 64),
      'UNAVAILABLE', CURRENT_TIMESTAMP - interval '1 second', CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryCandidate" (
      "id", "userId", "jobId", "chatId", "branchGeneration", "sourceRevision",
      "sourceHash", "sourceProjectionHash", "sourceProjectionVersion",
      "createdByExecutionId", "proposedCanonicalKey", "proposedDisplayText",
      "proposedValue", "proposedCategory", "proposedModality", "proposedScope",
      "sourceTimezone", "proposedDirectness", "proposedSensitivity", "languageCode",
      "importance", "confidence", "negated", "state", "pipelineVersion"
    ) VALUES (
      repeat('1', 64), 'memory-owner-a', 'memory-fact-candidate-job',
      'memory-chat-a', 0, 0, repeat('a', 64), repeat('2', 64),
      'memory-fact-source-projection-v1', 'memory-fact-candidate-binding',
      'user.preference.drink', 'I prefer tea.', '{"drink":"tea"}'::jsonb,
      'preference', 'PREFERENCE',
      '{"type":"CHAT","target_id":"memory-chat-a"}'::jsonb, 'UTC', 'DIRECT',
      'NORMAL', 'en', 0.5, 0.9, false, 'PENDING', 'memory-fact-extraction-v1'
    );
    INSERT INTO "MemoryCandidateMessage" (
      "userId", "candidateId", "chatId", "messageId", "ordinal",
      "startOffset", "endOffset", "sourceTextHash"
    ) VALUES (
      'memory-owner-a', repeat('1', 64), 'memory-chat-a', 'memory-user-message-a',
      0, 0, 13, repeat('3', 64)
    );
    COMMIT;
  `), "persist one exact direct-USER fact candidate");

  expectRejected(database, `
    INSERT INTO "MemoryCandidateMessage" (
      "userId", "candidateId", "chatId", "messageId", "ordinal",
      "startOffset", "endOffset", "sourceTextHash"
    ) VALUES (
      'memory-owner-a', repeat('1', 64), 'memory-chat-a',
      'memory-assistant-message-a', 1, 0, 4, repeat('4', 64)
    );
  `, /exact settled direct USER message/u, "assistant fact-candidate evidence");

  expectRejected(database, `
    INSERT INTO "MemoryCandidateMessage" (
      "userId", "candidateId", "chatId", "messageId", "ordinal",
      "startOffset", "endOffset", "sourceTextHash"
    ) VALUES (
      'memory-owner-b', repeat('1', 64), 'memory-chat-b',
      'memory-user-message-b', 1, 0, 4, repeat('4', 64)
    );
  `, /exact settled direct USER message|MemoryCandidateMessage_candidate_fkey/u,
  "cross-owner fact-candidate evidence");

  expectRejected(database, `
    UPDATE "Message" SET "role" = 'assistant'
    WHERE "chatId" = 'memory-chat-a' AND "id" = 'memory-user-message-a';
  `, /must remain a settled direct USER message/u, "fact source role mutation");

  expectRejected(database, `
    INSERT INTO "MemoryCandidate" (
      "id", "userId", "jobId", "chatId", "branchGeneration", "sourceRevision",
      "sourceHash", "sourceProjectionHash", "sourceProjectionVersion",
      "createdByExecutionId", "proposedCanonicalKey", "proposedDisplayText",
      "proposedValue", "proposedCategory", "proposedModality", "proposedScope",
      "sourceTimezone", "proposedDirectness", "proposedSensitivity", "languageCode",
      "importance", "confidence", "negated", "state", "pipelineVersion"
    ) VALUES (
      repeat('5', 64), 'memory-owner-a', 'memory-fact-candidate-job',
      'memory-chat-a', 0, 0, repeat('a', 64), repeat('6', 64),
      'memory-fact-source-projection-v1', 'memory-execution-usage-binding',
      'user.preference.other', 'I prefer tea.', '{}'::jsonb, 'preference',
      'PREFERENCE', '{"type":"CHAT","target_id":"memory-chat-a"}'::jsonb,
      'UTC', 'DIRECT', 'NORMAL', 'en', 0.5, 0.9, false, 'PENDING',
      'memory-fact-extraction-v1'
    );
  `, /exact succeeded fact-extraction authority/u, "unrelated extraction binding");
}

function assertFactCandidateMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_candidate_authority_trigger() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install fact-candidate rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, FACT_CANDIDATE_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting fact-candidate migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_candidate_authority_trigger" already exists/u,
    "fact-candidate rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('MemoryCandidate', 'MemoryCandidateMessage')),
        (SELECT count(*) FROM pg_type WHERE typname = 'MemoryCandidateState'),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'MemoryJob_source_identity_key')
      );
    `),
    "0|0|0",
    "failed fact-candidate migration left partial durable state"
  );
}

function assertFactConsolidationContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryConsolidationOperation"'::regtype),
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryCandidateDecisionState"'::regtype),
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryCandidateDecision'),
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'MemoryCandidateDecision_shape_check',
           'MemoryCandidateDecision_candidate_fkey',
           'MemoryCandidateDecision_consolidation_job_fkey',
           'MemoryCandidateDecision_consolidation_execution_fkey',
           'MemoryCandidateDecision_verification_job_fkey',
           'MemoryCandidateDecision_verification_execution_fkey',
           'MemoryCandidateDecision_target_fact_fkey',
           'MemoryCandidateDecision_target_version_fkey'
         ) AND convalidated),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'MemoryCandidateDecision_authority_trigger',
           'MemoryCandidateDecision_immutable_trigger'
         ) AND NOT tgisinternal)
      );
    `),
    "ADD,REINFORCE,SUPERSEDE,CONFLICT,EXPIRE,NOOP,DEFER|" +
      "PENDING_VERIFICATION,APPLIED,REJECTED,STALE|1|8|2",
    "fact-consolidation decision authority is incomplete"
  );

  requireSuccess(psql(database, `
    INSERT INTO "MemoryJob" (
      "id", "userId", "chatId", "activeLeafMessageId", "branchGeneration",
      "sourceRevision", "sourceHash", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot",
      "idempotencyFingerprint", "acceptedResultHash", "completedAt"
    ) VALUES (
      'memory-fact-consolidation-job', 'memory-owner-a', 'memory-chat-a',
      'memory-assistant-message-a', 0, 0, repeat('a', 64),
      'CONSOLIDATE_CANDIDATE', 'SUCCEEDED', 'memory-fact-consolidation-v1',
      0, 0,
      'consolidate-candidate:' || repeat('1', 64) || ':0:' || repeat('a', 24),
      repeat('8', 64), CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "providerId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion",
      "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash",
      "usageCompleteness", "recoverableUntil", "relationsDetachedAt", "completedAt"
    ) VALUES (
      'memory-fact-consolidation-binding', 'memory-owner-a', 'JOB',
      'memory-fact-consolidation-job', 'MEMORY_CONSOLIDATE', 0, 'SUCCEEDED',
      'openai_compatible', repeat('d', 64), 'memory-fact-consolidation-policy-v1',
      'memory-fact-consolidation-prompt-v1', 'memory-fact-consolidation-schema-v1',
      'memory-fact-consolidation-v1', '{}'::jsonb, repeat('7', 64),
      repeat('8', 64), 'UNAVAILABLE', CURRENT_TIMESTAMP - interval '1 second',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "create exact consolidation authority");

  expectRejected(database, `
    INSERT INTO "MemoryCandidateDecision" (
      "id", "userId", "candidateId", "consolidationJobId",
      "consolidationExecutionId", "operation", "reasonCode",
      "requiresVerification", "state", "relatedSnapshotHash",
      "consolidationInputHash", "consolidationOutputHash", "resolvedAt"
    ) VALUES (
      repeat('2', 64), 'memory-owner-a', repeat('1', 64),
      'memory-fact-consolidation-job', 'memory-fact-candidate-binding', 'ADD',
      'new_supported_fact', false, 'APPLIED', repeat('6', 64), repeat('7', 64),
      repeat('8', 64), CURRENT_TIMESTAMP
    );
  `, /exact consolidation authority/u, "unrelated consolidation binding");

  expectRejected(database, `
    INSERT INTO "MemoryCandidateDecision" (
      "id", "userId", "candidateId", "consolidationJobId",
      "consolidationExecutionId", "operation", "targetFactId", "targetVersionId",
      "reasonCode", "requiresVerification", "state", "relatedSnapshotHash",
      "consolidationInputHash", "consolidationOutputHash", "resolvedAt"
    ) VALUES (
      repeat('2', 64), 'memory-owner-a', repeat('1', 64),
      'memory-fact-consolidation-job', 'memory-fact-consolidation-binding', 'ADD',
      'memory-fact-a', 'memory-version-a', 'new_supported_fact', false, 'APPLIED',
      repeat('6', 64), repeat('7', 64), repeat('8', 64), CURRENT_TIMESTAMP
    );
  `, /MemoryCandidateDecision_shape_check/u, "ADD decision with a target");

  requireSuccess(psql(database, `
    INSERT INTO "MemoryCandidateDecision" (
      "id", "userId", "candidateId", "consolidationJobId",
      "consolidationExecutionId", "operation", "reasonCode",
      "requiresVerification", "state", "relatedSnapshotHash",
      "consolidationInputHash", "consolidationOutputHash", "resolvedAt"
    ) VALUES (
      repeat('2', 64), 'memory-owner-a', repeat('1', 64),
      'memory-fact-consolidation-job', 'memory-fact-consolidation-binding', 'ADD',
      'new_supported_fact', false, 'APPLIED', repeat('6', 64), repeat('7', 64),
      repeat('8', 64), CURRENT_TIMESTAMP
    );
  `), "persist one exact applied consolidation decision");

  requireSuccess(psql(database, `
    BEGIN;
    INSERT INTO "MemoryCandidate" (
      "id", "userId", "jobId", "chatId", "branchGeneration", "sourceRevision",
      "sourceHash", "sourceProjectionHash", "sourceProjectionVersion",
      "createdByExecutionId", "proposedCanonicalKey", "proposedDisplayText",
      "proposedValue", "proposedCategory", "proposedModality", "proposedScope",
      "sourceTimezone", "proposedDirectness", "proposedSensitivity", "languageCode",
      "importance", "confidence", "negated", "state", "pipelineVersion"
    ) VALUES (
      repeat('5', 64), 'memory-owner-a', 'memory-fact-candidate-job',
      'memory-chat-a', 0, 0, repeat('a', 64), repeat('4', 64),
      'memory-fact-source-projection-v1', 'memory-fact-candidate-binding',
      'user.preference.other', 'I prefer water.', '{"drink":"water"}'::jsonb,
      'preference', 'PREFERENCE',
      '{"type":"CHAT","target_id":"memory-chat-a"}'::jsonb, 'UTC', 'DIRECT',
      'NORMAL', 'en', 0.8, 0.9, false, 'PENDING', 'memory-fact-extraction-v1'
    );
    INSERT INTO "MemoryCandidateMessage" (
      "userId", "candidateId", "chatId", "messageId", "ordinal",
      "startOffset", "endOffset", "sourceTextHash"
    ) VALUES (
      'memory-owner-a', repeat('5', 64), 'memory-chat-a', 'memory-user-message-a',
      0, 0, 13, repeat('3', 64)
    );
    INSERT INTO "MemoryJob" (
      "id", "userId", "chatId", "activeLeafMessageId", "branchGeneration",
      "sourceRevision", "sourceHash", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot",
      "idempotencyFingerprint", "acceptedResultHash", "completedAt"
    ) VALUES
      (
        'memory-fact-consolidation-job-verify', 'memory-owner-a', 'memory-chat-a',
        'memory-assistant-message-a', 0, 0, repeat('a', 64),
        'CONSOLIDATE_CANDIDATE', 'SUCCEEDED', 'memory-fact-consolidation-v1', 0, 0,
        'consolidate-candidate:' || repeat('5', 64) || ':0:' || repeat('a', 24),
        repeat('8', 64), CURRENT_TIMESTAMP
      ),
      (
        'memory-fact-verification-job', 'memory-owner-a', 'memory-chat-a',
        'memory-assistant-message-a', 0, 0, repeat('a', 64),
        'VERIFY_CANDIDATE', 'SUCCEEDED', 'memory-fact-verification-v1', 0, 0,
        'verify-candidate:' || repeat('9', 64), repeat('6', 64), CURRENT_TIMESTAMP
      );
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "providerId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion",
      "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash",
      "usageCompleteness", "recoverableUntil", "relationsDetachedAt", "completedAt"
    ) VALUES
      (
        'memory-fact-consolidation-binding-verify', 'memory-owner-a', 'JOB',
        'memory-fact-consolidation-job-verify', 'MEMORY_CONSOLIDATE', 0,
        'SUCCEEDED', 'openai_compatible', repeat('d', 64),
        'memory-fact-consolidation-policy-v1', 'memory-fact-consolidation-prompt-v1',
        'memory-fact-consolidation-schema-v1', 'memory-fact-consolidation-v1',
        '{}'::jsonb, repeat('7', 64), repeat('8', 64), 'UNAVAILABLE',
        CURRENT_TIMESTAMP - interval '1 second', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'memory-fact-verification-binding', 'memory-owner-a', 'JOB',
        'memory-fact-verification-job', 'MEMORY_VERIFY', 0, 'SUCCEEDED',
        'openai_compatible', repeat('d', 64), 'memory-fact-verification-policy-v1',
        'memory-fact-verification-prompt-v1', 'memory-fact-verification-schema-v1',
        'memory-fact-verification-v1', '{}'::jsonb, repeat('4', 64),
        repeat('6', 64), 'UNAVAILABLE', CURRENT_TIMESTAMP - interval '1 second',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    INSERT INTO "MemoryCandidateDecision" (
      "id", "userId", "candidateId", "consolidationJobId",
      "consolidationExecutionId", "operation", "reasonCode",
      "requiresVerification", "state", "relatedSnapshotHash",
      "consolidationInputHash", "consolidationOutputHash",
      "verificationJobId", "verificationInputHash"
    ) VALUES (
      repeat('9', 64), 'memory-owner-a', repeat('5', 64),
      'memory-fact-consolidation-job-verify',
      'memory-fact-consolidation-binding-verify', 'ADD', 'new_supported_fact',
      true, 'PENDING_VERIFICATION', repeat('6', 64), repeat('7', 64),
      repeat('8', 64), 'memory-fact-verification-job', repeat('4', 64)
    );
    UPDATE "MemoryCandidateDecision"
    SET "state" = 'APPLIED', "resolvedAt" = CURRENT_TIMESTAMP,
      "verificationExecutionId" = 'memory-fact-verification-binding',
      "verificationOutputHash" = repeat('6', 64)
    WHERE "id" = repeat('9', 64);
    COMMIT;
  `), "persist and verify one selective consolidation decision");

  expectRejected(database, `
    UPDATE "MemoryCandidateDecision" SET "reasonCode" = 'changed'
    WHERE "id" = repeat('9', 64);
  `, /decision authority is immutable/u, "mutated consolidation authority");
}

function assertFactConsolidationMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_candidate_decision_authority_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install fact-consolidation rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, FACT_CONSOLIDATION_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting fact-consolidation migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_candidate_decision_authority_trigger" already exists/u,
    "fact-consolidation rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'MemoryCandidateDecision'),
        (SELECT count(*) FROM pg_type
         WHERE typname IN ('MemoryConsolidationOperation', 'MemoryCandidateDecisionState'))
      );
    `),
    "0|0",
    "failed fact-consolidation migration left partial durable state"
  );
}

function assertVerificationAuthorityV2Contracts(database: string): void {
  const functionDefinition = scalar(database, `
    SELECT pg_get_functiondef(
      'aiqsa_memory_candidate_decision_authority_trigger()'::regprocedure
    );
  `);
  assert.match(
    functionDefinition,
    /memory-fact-verification-v1/u,
    "verification authority upgrade dropped in-flight v1 compatibility"
  );
  assert.match(
    functionDefinition,
    /memory-fact-verification-v2/u,
    "verification authority upgrade did not admit the current v2 pipeline"
  );
}

function assertLearningReviewContracts(
  database: string,
  verifyBehavior = true
): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryFeedbackType"'::regtype),
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryFeedbackTargetKind"'::regtype),
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'MemoryFeedback'),
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'MemoryFeedback_user_fkey', 'MemoryFeedback_fact_fkey',
           'MemoryFeedback_version_fkey', 'MemoryFeedback_episode_fkey',
           'MemoryFeedback_recall_chunk_fkey', 'MemoryFeedback_run_fkey',
           'MemoryFeedback_run_item_fkey', 'MemoryFeedback_run_tool_fkey',
           'MemoryFeedback_retracts_fkey', 'MemoryFeedback_event_fkey',
           'MemoryFeedback_shape_check'
         ) AND convalidated),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'MemoryFeedback_append_only_guard', 'MemoryFeedback_target_guard'
         ) AND NOT tgisinternal)
      );
    `),
    "CORRECT,INCORRECT,NOT_USEFUL,WRONG_SCOPE,OUTDATED,TOO_SENSITIVE,RETRACT|" +
      "FACT_VERSION,EPISODE,RECALL_CHUNK|1|11|2",
    "learning-review feedback schema is incomplete"
  );
  if (!verifyBehavior) return;

  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "displayName", "role", "status", "updatedAt")
    VALUES (
      'memory-feedback-owner-b', 'Memory feedback B', 'user', 'active',
      CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "actorUserId", "factId",
      "factVersionId", "metadata"
    ) VALUES
      (
        'memory-feedback-event-a', 'memory-owner-a', 'USER_FEEDBACK', 'USER',
        'memory-owner-a', 'memory-fact-a', 'memory-version-a',
        jsonb_build_object(
          'feedbackId', 'memory-feedback-a', 'feedbackType', 'INCORRECT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-retract', 'memory-owner-a', 'USER_FEEDBACK', 'USER',
        'memory-owner-a', 'memory-fact-a', 'memory-version-a',
        jsonb_build_object(
          'feedbackId', 'memory-feedback-retract', 'feedbackType', 'RETRACT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-run', 'memory-owner-a', 'USER_FEEDBACK', 'USER',
        'memory-owner-a', 'memory-fact-a', 'memory-version-a',
        jsonb_build_object(
          'feedbackId', 'memory-feedback-run', 'feedbackType', 'NOT_USEFUL',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-wrong-run', 'memory-owner-a', 'USER_FEEDBACK',
        'USER', 'memory-owner-a', 'memory-fact-a', 'memory-version-a',
        jsonb_build_object(
          'feedbackId', 'memory-feedback-wrong-run', 'feedbackType', 'INCORRECT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-second-retract', 'memory-owner-a',
        'USER_FEEDBACK', 'USER', 'memory-owner-a', 'memory-fact-a',
        'memory-version-a', jsonb_build_object(
          'feedbackId', 'memory-feedback-second-retract',
          'feedbackType', 'RETRACT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-wrong-signal', 'memory-owner-a',
        'USER_FEEDBACK', 'SYSTEM', NULL, 'memory-fact-a', 'memory-version-a',
        jsonb_build_object(
          'feedbackId', 'memory-feedback-wrong-signal',
          'feedbackType', 'INCORRECT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-wrong-tool', 'memory-owner-a',
        'USER_FEEDBACK', 'USER', 'memory-owner-a', 'memory-fact-a',
        'memory-version-a', jsonb_build_object(
          'feedbackId', 'memory-feedback-wrong-tool',
          'feedbackType', 'INCORRECT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      ),
      (
        'memory-feedback-event-b', 'memory-feedback-owner-b', 'USER_FEEDBACK',
        'USER', 'memory-feedback-owner-b', NULL, NULL, jsonb_build_object(
          'feedbackId', 'memory-feedback-cross-owner',
          'feedbackType', 'INCORRECT',
          'schemaVersion', 'memory-feedback-event-v1'
        )
      );

    INSERT INTO "ModelRunMemoryItem" (
      "id", "userId", "bindingId", "ordinal", "itemType", "exactItemId",
      "factVersionId", "includedText", "includedTextHash",
      "itemStateAtAdmission", "laneRanks", "featureSnapshot", "finalScore",
      "selectionReason"
    ) VALUES (
      'memory-feedback-run-item', 'memory-owner-a', 'memory-run-binding-1', 99,
      'FACT_VERSION', 'memory-version-a', 'memory-version-a',
      'Frozen fact text', repeat('a', 64), 'ACTIVE', '{}'::jsonb, '{}'::jsonb,
      1, 'learning-review-contract'
    );

    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "comment",
      "memoryEventId"
    ) VALUES (
      'memory-feedback-a', 'memory-owner-a', repeat('a', 64),
      'memory-feedback-request-a', 'INCORRECT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'Private bounded correction note',
      'memory-feedback-event-a'
    );
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId",
      "retractsFeedbackId", "memoryEventId"
    ) VALUES (
      'memory-feedback-retract', 'memory-owner-a', repeat('b', 64),
      'memory-feedback-request-retract', 'RETRACT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-feedback-a',
      'memory-feedback-event-retract'
    );
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId",
      "modelRunMemoryItemId", "memoryEventId"
    ) VALUES (
      'memory-feedback-run', 'memory-owner-a', repeat('c', 64),
      'memory-feedback-request-run', 'NOT_USEFUL', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-preparing-run',
      'memory-feedback-run-item', 'memory-feedback-event-run'
    );
  `), "persist append-only feedback, retraction, and exact run provenance");

  expectRejected(database, `
    UPDATE "MemoryFeedback" SET "comment" = 'mutated'
    WHERE "id" = 'memory-feedback-a';
  `, /append-only except for one-way purge/u, "mutated feedback history");

  expectRejected(database, `
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "memoryEventId"
    ) VALUES (
      'memory-feedback-wrong-signal', 'memory-owner-a', repeat('0', 64),
      'memory-feedback-wrong-signal', 'INCORRECT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-feedback-event-wrong-signal'
    );
  `, /event must match its immutable signal/u, "feedback bound to a non-user event");

  expectRejected(database, `
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "memoryEventId"
    ) VALUES (
      'memory-feedback-cross-owner', 'memory-feedback-owner-b', repeat('d', 64),
      'memory-feedback-cross-owner', 'INCORRECT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-feedback-event-b'
    );
  `, /(event must match its immutable signal|MemoryFeedback_(?:fact|version)_fkey)/u,
  "cross-owner feedback target");

  expectRejected(database, `
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId",
      "modelRunMemoryItemId", "memoryEventId"
    ) VALUES (
      'memory-feedback-wrong-run', 'memory-owner-a', repeat('e', 64),
      'memory-feedback-wrong-run', 'INCORRECT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-legacy-run',
      'memory-feedback-run-item', 'memory-feedback-event-wrong-run'
    );
  `, /run item must match/u, "run feedback bound to another run");

  expectRejected(database, `
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId",
      "modelRunToolCallId", "memoryEventId"
    ) VALUES (
      'memory-feedback-wrong-tool', 'memory-owner-a', repeat('1', 64),
      'memory-feedback-wrong-tool', 'INCORRECT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-legacy-run',
      'memory-history-tool-call', 'memory-feedback-event-wrong-tool'
    );
  `, /tool provenance must name mark_memory_incorrect/u,
  "feedback bound to a different first-party tool");

  expectRejected(database, `
    INSERT INTO "MemoryFeedback" (
      "id", "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId",
      "retractsFeedbackId", "memoryEventId"
    ) VALUES (
      'memory-feedback-second-retract', 'memory-owner-a', repeat('f', 64),
      'memory-feedback-second-retract', 'RETRACT', 'FACT_VERSION',
      'memory-fact-a', 'memory-version-a', 'memory-feedback-a',
      'memory-feedback-event-second-retract'
    );
  `, /MemoryFeedback_userId_retractsFeedbackId_key/u,
  "duplicate feedback retraction");

  requireSuccess(psql(database, `
    UPDATE "MemoryFeedback"
    SET
      "memoryFactId" = NULL,
      "memoryFactVersionId" = NULL,
      "episodeId" = NULL,
      "recallChunkId" = NULL,
      "modelRunId" = NULL,
      "modelRunMemoryItemId" = NULL,
      "modelRunToolCallId" = NULL,
      "sourceChatIdSnapshot" = NULL,
      "sourceBranchGenerationSnapshot" = NULL,
      "comment" = NULL,
      "retractsFeedbackId" = NULL,
      "memoryEventId" = NULL,
      "contentPurgedAt" = CURRENT_TIMESTAMP,
      "purgeReason" = 'contract_purge'
    WHERE "userId" = 'memory-owner-a';
  `), "scrub feedback through its one-way purge transition");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', count(*),
        count(*) FILTER (WHERE "contentPurgedAt" IS NOT NULL),
        count(*) FILTER (WHERE num_nonnulls(
          "memoryFactId", "memoryFactVersionId", "episodeId", "recallChunkId",
          "modelRunId", "modelRunMemoryItemId", "modelRunToolCallId",
          "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "comment",
          "retractsFeedbackId", "memoryEventId"
        ) = 0))
      FROM "MemoryFeedback" WHERE "userId" = 'memory-owner-a';
    `),
    "3|3|3",
    "feedback purge retained plaintext or target/provenance joins"
  );
  expectRejected(database, `
    UPDATE "MemoryFeedback"
    SET "contentPurgedAt" = NULL, "purgeReason" = NULL
    WHERE "id" = 'memory-feedback-a';
  `, /append-only except for one-way purge/u, "reversed feedback purge");
}

function assertLearningReviewMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_feedback_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install learning-review rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, LEARNING_REVIEW_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting learning-review migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_feedback_guard" already exists/u,
    "learning-review rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'MemoryFeedback'),
        (SELECT count(*) FROM pg_type
         WHERE typname IN ('MemoryFeedbackType', 'MemoryFeedbackTargetKind'))
      );
    `),
    "0|0",
    "failed learning-review migration left partial durable state"
  );
}

function assertForgetUndoContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT count(*)
      FROM pg_enum enum_value
      JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
      WHERE enum_type.typname = 'MemoryDeletionState'
        AND enum_value.enumlabel = 'CANCELLED';
    `),
    "1",
    "forget Undo migration did not install the terminal cancellation state"
  );
  requireSuccess(psql(database, `
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId",
      "memoryGeneration", "nextAttemptAt"
    ) VALUES (
      'memory-forget-undo-contract', 'memory-owner-a', 'FORGET_PURGE',
      'MEMORY_FACT@contract-v1', 'memory-forget-undo-target', 0,
      CURRENT_TIMESTAMP + interval '1 minute'
    );
    UPDATE "MemoryDeletionOutbox"
    SET
      "state" = 'CANCELLED',
      "nextAttemptAt" = NULL,
      "completedAt" = CURRENT_TIMESTAMP,
      "errorCode" = 'memory_purge_cancelled_by_undo'
    WHERE "id" = 'memory-forget-undo-contract';
  `), "commit a terminal Forget Undo cancellation");
  expectRejected(database, `
    UPDATE "MemoryDeletionOutbox"
    SET "completedAt" = NULL
    WHERE "id" = 'memory-forget-undo-contract';
  `, /MemoryDeletionOutbox_shape_check/u, "cancelled deletion without completion evidence");
}

function assertWorkingSetProfileContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum WHERE enumtypid = '"MemoryProfileProjectionState"'::regtype),
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('MemoryProfileProjection', 'MemoryProfileProjectionFact')),
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'MemoryProfileProjection_user_fkey',
           'MemoryProfileProjection_scope_fkey',
           'MemoryProfileProjection_execution_fkey',
           'MemoryProfileProjection_shape_check',
           'MemoryProfileProjectionFact_projection_fkey',
           'MemoryProfileProjectionFact_fact_fkey',
           'MemoryProfileProjectionFact_version_fkey',
           'MemoryProfileProjectionFact_shape_check'
         ) AND convalidated),
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'MemoryProfileProjection_append_only_guard',
           'MemoryProfileProjection_authority_guard',
           'MemoryProfileProjectionFact_immutable_guard',
           'MemoryProfileProjectionFact_authority_guard'
         ) AND NOT tgisinternal),
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'MemoryProfileProjection_active_scope_language_key')
      );
    `),
    "ACTIVE,INVALIDATED|2|8|4|1",
    "working-set profile schema authority is incomplete"
  );

  requireSuccess(psql(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO "MemoryScope" ("id", "userId", "scopeType", "state")
    SELECT 'memory-profile-global', 'memory-owner-a', 'GLOBAL_USER', 'ACTIVE'
    WHERE NOT EXISTS (
      SELECT 1 FROM "MemoryScope"
      WHERE "userId" = 'memory-owner-a' AND "scopeType" = 'GLOBAL_USER'
        AND "state" = 'ACTIVE'
    );

    INSERT INTO "MemoryFact" (
      "id", "userId", "scopeId", "canonicalKey", "category", "state",
      "currentVersionId", "temperatureClass", "temperatureScore"
    ) VALUES (
      'memory-profile-fact', 'memory-owner-a',
      (SELECT "id" FROM "MemoryScope"
       WHERE "userId" = 'memory-owner-a' AND "scopeType" = 'GLOBAL_USER'
         AND "state" = 'ACTIVE' ORDER BY "createdAt", "id" LIMIT 1),
      'profile.response.language', 'preference', 'ACTIVE',
      'memory-profile-version', 'HOT', 1
    );
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "actorUserId", "factId",
      "factVersionId", "metadata"
    ) VALUES (
      'memory-profile-event', 'memory-owner-a', 'EXPLICIT_SAVE', 'USER',
      'memory-owner-a', 'memory-profile-fact', 'memory-profile-version',
      '{"schemaVersion":"memory-profile-contract-v1"}'::jsonb
    );
    INSERT INTO "MemoryFactVersion" (
      "id", "userId", "factId", "displayText", "normalizedSearchText",
      "languageCode", "structuredValue", "category", "modality", "sourceMode",
      "state", "confidence", "importance", "directness", "sensitivityClass",
      "createdByEventId", "pipelineVersion"
    ) VALUES (
      'memory-profile-version', 'memory-owner-a', 'memory-profile-fact',
      'Отвечай по-русски и сохраняй факты.',
      'отвечай по русски и сохраняй факты', 'ru',
      '{"language":"ru"}'::jsonb, 'preference', 'PREFERENCE', 'EXPLICIT',
      'ACTIVE', 1, 1, 'DIRECT', 'NORMAL', 'memory-profile-event',
      'memory-profile-fixture-v1'
    );
    INSERT INTO "MemoryEvidence" (
      "id", "userId", "factVersionId", "stance", "sourceType",
      "memoryEventId", "sourceRole", "safeExcerpt", "safeSourceHash",
      "sourceProjectionVersion", "safetyClass", "observedAt"
    ) VALUES (
      'memory-profile-evidence', 'memory-owner-a', 'memory-profile-version',
      'SUPPORTS', 'EXPLICIT_ACTION', 'memory-profile-event', 'user',
      'Отвечай по-русски и сохраняй факты.', repeat('1', 64),
      'memory-profile-source-v1', 'NORMAL', CURRENT_TIMESTAMP
    );

    DO $profile_generation$
    DECLARE
      active_generation_id TEXT;
      next_generation INTEGER;
      current_revision INTEGER;
    BEGIN
      SELECT settings."activeIndexGenerationId", settings."memoryRevision"
      INTO active_generation_id, current_revision
      FROM "UserMemorySettings" AS settings
      WHERE settings."userId" = 'memory-owner-a';
      IF active_generation_id IS NULL THEN
        SELECT COALESCE(max(generation."generation"), 0) + 1
        INTO next_generation
        FROM "MemoryIndexGeneration" AS generation
        WHERE generation."userId" = 'memory-owner-a';
        INSERT INTO "MemoryIndexGeneration" (
          "id", "userId", "generation", "state", "indexMode",
          "targetMemoryRevision", "indexedThroughMemoryRevision",
          "languageProfile", "normalizationVersion", "chunkingVersion",
          "retrievalPipelineVersion", "readyAt", "activatedAt"
        ) VALUES (
          'memory-profile-generation', 'memory-owner-a', next_generation,
          'ACTIVE', 'LEXICAL_ONLY', current_revision, current_revision,
          'RU_EN_MULTILINGUAL_V1', 'memory-normalization-v1',
          'memory-chunking-v1', 'memory-retrieval-v1',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
        UPDATE "UserMemorySettings"
        SET "activeIndexGenerationId" = 'memory-profile-generation'
        WHERE "userId" = 'memory-owner-a';
      END IF;
    END
    $profile_generation$;

    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "factVersionId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embeddingState"
    ) SELECT
      'memory-profile-search', 'memory-owner-a', settings."activeIndexGenerationId",
      'FACT_VERSION', 'memory-profile-version',
      'Отвечай по-русски и сохраняй факты.',
      'Отвечай по-русски и сохраняй факты.', repeat('a', 64), 'ru',
      repeat('b', 64), repeat('c', 64), repeat('d', 64), 'NOT_APPLICABLE'
    FROM "UserMemorySettings" AS settings
    WHERE settings."userId" = 'memory-owner-a';

    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'memory-profile-connection', 'Memory profile contract',
      'openai_compatible', true, '{}'::jsonb, 1, '{}'::jsonb, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig",
      "activeVersion", "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'memory-profile-model', 'memory-profile-connection', 'openai_compatible',
      'memory-profile-model', 'Memory profile contract model', 'answer', 32768,
      '{}'::jsonb, 1, '{}'::jsonb, 1, '{}'::jsonb, '{}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderCredential" (
      "id", "connectionId", "label", "enabled", "draftVersion",
      "testedAt", "activatedAt", "updatedAt"
    ) VALUES (
      'memory-profile-credential', 'memory-profile-connection',
      'Memory profile contract credential', true, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderCredentialVersion" (
      "id", "credentialId", "version", "secretEnvelope", "testEvidence",
      "testedAt", "activatedAt"
    ) VALUES (
      'memory-profile-credential-v1', 'memory-profile-credential', 1,
      'contract-envelope', '{"ok":true}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "ProviderCredential"
    SET "activeVersionId" = 'memory-profile-credential-v1'
    WHERE "id" = 'memory-profile-credential';

    INSERT INTO "MemoryJob" (
      "id", "userId", "kind", "state", "pipelineVersion",
      "memoryGenerationSnapshot", "memoryRevisionSnapshot",
      "idempotencyFingerprint", "acceptedResultHash", "completedAt"
    ) SELECT
      'memory-profile-job', settings."userId", 'RECALCULATE_WORKING_SET',
      'SUCCEEDED', 'memory-working-set-profile-v1', settings."memoryGeneration",
      settings."memoryRevision", 'memory-profile:' || repeat('e', 64) || ':' || repeat('9', 24),
      repeat('f', 64), CURRENT_TIMESTAMP
    FROM "UserMemorySettings" AS settings
    WHERE settings."userId" = 'memory-owner-a';
    INSERT INTO "MemoryExecutionBinding" (
      "id", "userId", "ownerType", "memoryJobId", "logicalRole", "ordinal",
      "state", "connectionId", "providerId", "providerModelId", "credentialId",
      "credentialVersionId", "destinationFingerprint", "policyVersion",
      "promptVersion", "schemaVersion", "pipelineVersion",
      "secretFreeExecutionSnapshot", "inputHash", "acceptedOutputHash",
      "usageCompleteness", "startedAt", "completedAt"
    ) VALUES (
      'memory-profile-binding', 'memory-owner-a', 'JOB', 'memory-profile-job',
      'MEMORY_PROFILE', 0, 'SUCCEEDED', 'memory-profile-connection',
      'openai_compatible', 'memory-profile-model', 'memory-profile-credential',
      'memory-profile-credential-v1', repeat('2', 64),
      'memory-profile-policy-v1', 'memory-profile-prompt-v1',
      'memory-profile-schema-v1', 'memory-working-set-profile-v1',
      '{}'::jsonb, repeat('e', 64), repeat('f', 64), 'UNAVAILABLE',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "UsageEvent" (
      "id", "userId", "provider", "modelId", "providerModelId",
      "memoryExecutionBindingId"
    ) VALUES (
      'memory-profile-usage', 'memory-owner-a', 'openai_compatible',
      'memory-profile-model', 'memory-profile-model', 'memory-profile-binding'
    );

    INSERT INTO "MemoryProfileProjection" (
      "id", "userId", "scopeId", "memoryGeneration", "memoryRevision",
      "languageCode", "summary", "safeContentHash", "projectionVersion",
      "safetyClass", "redactionState", "state", "createdByExecutionId",
      "inputHash", "outputHash", "sourceIdentitySnapshot",
      "safetyIdentitySnapshot", "suppressionIdentitySnapshot", "asOf"
    ) SELECT
      'memory-profile-projection', settings."userId", fact."scopeId",
      settings."memoryGeneration", settings."memoryRevision", 'ru',
      'Отвечай по-русски и сохраняй факты.', repeat('3', 64),
      'memory-profile-projection-v1', 'NORMAL', 'NOT_NEEDED', 'ACTIVE',
      'memory-profile-binding', repeat('e', 64), repeat('f', 64),
      repeat('4', 64), repeat('5', 64), repeat('6', 64),
      CURRENT_TIMESTAMP - interval '1 second'
    FROM "UserMemorySettings" AS settings
    INNER JOIN "MemoryFact" AS fact ON fact."userId" = settings."userId"
      AND fact."id" = 'memory-profile-fact'
    WHERE settings."userId" = 'memory-owner-a';
    INSERT INTO "MemoryProfileProjectionFact" (
      "userId", "projectionId", "factId", "factVersionId", "ordinal",
      "factVersionContentHash", "sourceIdentitySnapshot",
      "safetyIdentitySnapshot", "suppressionIdentitySnapshot"
    ) VALUES (
      'memory-owner-a', 'memory-profile-projection', 'memory-profile-fact',
      'memory-profile-version', 0, repeat('a', 64), repeat('c', 64),
      repeat('b', 64), repeat('d', 64)
    );
    COMMIT;
  `), "persist one exact usage-backed Memory profile");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', profile."state", profile."languageCode",
        profile."summary", count(contributor.*))
      FROM "MemoryProfileProjection" AS profile
      LEFT JOIN "MemoryProfileProjectionFact" AS contributor
        ON contributor."userId" = profile."userId"
        AND contributor."projectionId" = profile."id"
      WHERE profile."id" = 'memory-profile-projection'
      GROUP BY profile."id";
    `),
    "ACTIVE|ru|Отвечай по-русски и сохраняй факты.|1",
    "exact Memory profile projection was not retained"
  );

  expectRejected(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO "MemoryProfileProjection" (
      "id", "userId", "scopeId", "memoryGeneration", "memoryRevision",
      "languageCode", "summary", "safeContentHash", "projectionVersion",
      "safetyClass", "redactionState", "state", "createdByExecutionId",
      "inputHash", "outputHash", "sourceIdentitySnapshot",
      "safetyIdentitySnapshot", "suppressionIdentitySnapshot", "asOf"
    ) SELECT
      'memory-profile-wrong-language', settings."userId", fact."scopeId",
      settings."memoryGeneration", settings."memoryRevision", 'en',
      'Отвечай по-русски и сохраняй факты.', repeat('3', 64),
      'memory-profile-projection-v1', 'NORMAL', 'NOT_NEEDED', 'ACTIVE',
      'memory-profile-binding', repeat('e', 64), repeat('f', 64),
      repeat('4', 64), repeat('5', 64), repeat('6', 64),
      CURRENT_TIMESTAMP - interval '1 second'
    FROM "UserMemorySettings" AS settings
    INNER JOIN "MemoryFact" AS fact ON fact."userId" = settings."userId"
      AND fact."id" = 'memory-profile-fact'
    WHERE settings."userId" = 'memory-owner-a';
    INSERT INTO "MemoryProfileProjectionFact" (
      "userId", "projectionId", "factId", "factVersionId", "ordinal",
      "factVersionContentHash", "sourceIdentitySnapshot",
      "safetyIdentitySnapshot", "suppressionIdentitySnapshot"
    ) VALUES (
      'memory-owner-a', 'memory-profile-wrong-language', 'memory-profile-fact',
      'memory-profile-version', 0, repeat('a', 64), repeat('c', 64),
      repeat('b', 64), repeat('d', 64)
    );
    COMMIT;
  `, /stale, unsafe, or out of scope/u, "profile with a mismatched contributor language");

  expectRejected(database, `
    UPDATE "MemoryProfileProjection"
    SET "summary" = 'Unsupported profile text'
    WHERE "id" = 'memory-profile-projection';
  `, /append-only except for invalidation and one-way purge/u,
  "in-place Memory profile rewrite");

  requireSuccess(psql(database, `
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;
    DELETE FROM "MemoryProfileProjectionFact"
    WHERE "projectionId" = 'memory-profile-projection';
    UPDATE "MemoryProfileProjection"
    SET
      "state" = 'INVALIDATED',
      "summary" = NULL,
      "safeContentHash" = NULL,
      "redactionState" = 'EXCLUDED',
      "plaintextPurgedAt" = GREATEST("updatedAt", CURRENT_TIMESTAMP),
      "purgeReason" = 'fact_forgotten',
      "updatedAt" = GREATEST("updatedAt", CURRENT_TIMESTAMP)
    WHERE "id" = 'memory-profile-projection';
    COMMIT;
  `), "one-way purge an invalidated Memory profile");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', "state", "redactionState",
        ("summary" IS NULL)::int, ("plaintextPurgedAt" IS NOT NULL)::int,
        (SELECT count(*) FROM "MemoryProfileProjectionFact"
         WHERE "projectionId" = 'memory-profile-projection'))
      FROM "MemoryProfileProjection" WHERE "id" = 'memory-profile-projection';
    `),
    "INVALIDATED|EXCLUDED|1|1|0",
    "Memory profile purge retained plaintext or contributor links"
  );
  expectRejected(database, `
    UPDATE "MemoryProfileProjection"
    SET "summary" = 'Отвечай по-русски и сохраняй факты.',
      "safeContentHash" = repeat('3', 64), "plaintextPurgedAt" = NULL,
      "purgeReason" = NULL, "redactionState" = 'NOT_NEEDED'
    WHERE "id" = 'memory-profile-projection';
  `, /append-only except for invalidation and one-way purge/u,
  "reversed Memory profile purge");
}

function assertWorkingSetProfileMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_memory_profile_append_only_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install working-set profile rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, WORKING_SET_PROFILE_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting working-set profile migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_memory_profile_append_only_guard" already exists/u,
    "working-set profile rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('MemoryProfileProjection', 'MemoryProfileProjectionFact')),
        (SELECT count(*) FROM pg_type
         WHERE typname = 'MemoryProfileProjectionState'));
    `),
    "0|0",
    "failed working-set profile migration left partial durable state"
  );
}

function assertPermanentChatDeleteContracts(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'Chat'
           AND column_name IN ('permanentDeletionAt', 'permanentDeletionOperationId')),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'MemoryEvent'
           AND column_name = 'sourceDeletedAt'),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'MemoryDeletionOutbox'
           AND column_name IN (
             'admissionAuthorizationId', 'admittedChatSourceRevision',
             'admittedActiveLeafMessageId', 'alsoForgetOriginMemories'
           )),
        (SELECT count(*) FROM pg_trigger
         WHERE NOT tgisinternal AND tgname = ANY(ARRAY[
           'Chat_permanent_deletion_guard',
           'Message_permanent_chat_write_guard',
           'ModelRun_permanent_chat_write_guard',
           'Attachment_permanent_chat_write_guard',
           'SharedChatSnapshot_permanent_chat_write_guard',
           'MemoryScope_permanent_chat_write_guard',
           'ChatMemoryCheckpoint_permanent_chat_write_guard',
           'MemoryRecallChunk_permanent_chat_write_guard',
           'MemoryEpisode_permanent_chat_write_guard',
           'MemoryCandidate_permanent_chat_write_guard',
           'MemoryEvidence_permanent_chat_write_guard',
           'MemoryJob_permanent_chat_write_guard',
           'MemoryRetrievalAttempt_permanent_chat_write_guard',
           'MemoryEvent_permanent_chat_source_write_guard',
           'MemorySuppression_permanent_chat_source_write_guard',
           'MemoryMutationAuthorization_permanent_chat_source_write_guard',
           'MemoryRetrievalAttemptItem_permanent_source_write_guard',
           'ModelRunMemoryItem_permanent_source_write_guard',
           'MemoryFeedback_permanent_source_write_guard',
           'MemoryDeletionOutbox_admission_immutable_guard',
           'MemoryEvent_deleted_source_guard'
         ])))
    `),
    "2|1|4|21",
    "permanent-chat deletion schema or no-resurrection guards are incomplete"
  );

  requireSuccess(psql(database, `
    INSERT INTO "Chat" (
      "id", "userId", "title", "archived", "memoryMode",
      "memorySourceRevision", "updatedAt"
    ) VALUES (
      'memory-p8-chat', 'memory-owner-a', 'Permanent delete fixture', TRUE,
      'EXCLUDED', 1, CURRENT_TIMESTAMP
    );
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "sourceChatId", "metadata"
    ) VALUES (
      'memory-p8-source-event', 'memory-owner-a', 'AUTO_PROPOSE', 'JOB',
      'memory-p8-chat', '{}'::jsonb
    );
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId",
      "memoryGeneration", "admissionAuthorizationId",
      "admittedChatSourceRevision", "admittedActiveLeafMessageId",
      "alsoForgetOriginMemories"
    ) SELECT
      'memory-p8-delete', settings."userId", 'SOURCE_PURGE',
      'CHAT@memory-p8-chat-delete-v1', 'memory-p8-chat',
      settings."memoryGeneration", 'memory-p8-authorization', 0, NULL, FALSE
    FROM "UserMemorySettings" AS settings
    WHERE settings."userId" = 'memory-owner-a';
    UPDATE "Chat"
    SET "permanentDeletionAt" = CURRENT_TIMESTAMP,
      "permanentDeletionOperationId" = 'memory-p8-delete'
    WHERE "id" = 'memory-p8-chat';
  `), "install exact permanent-chat deletion fence fixture");

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', chat."archived"::int, chat."memoryMode",
        (chat."permanentDeletionAt" IS NOT NULL)::int,
        deletion."operation", deletion."targetType",
        deletion."alsoForgetOriginMemories"::int)
      FROM "Chat" AS chat
      INNER JOIN "MemoryDeletionOutbox" AS deletion
        ON deletion."userId" = chat."userId"
        AND deletion."id" = chat."permanentDeletionOperationId"
      WHERE chat."id" = 'memory-p8-chat';
    `),
    "1|EXCLUDED|1|SOURCE_PURGE|CHAT@memory-p8-chat-delete-v1|0",
    "permanent-chat fence did not retain its exact durable obligation"
  );

  expectRejected(database, `
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId", "memoryGeneration"
    ) VALUES (
      'memory-p8-malformed', 'memory-owner-a', 'SOURCE_PURGE',
      'CHAT@memory-p8-chat-delete-v1', 'malformed-chat', 0
    );
  `, /MemoryDeletionOutbox_shape_check/u, "untyped permanent-chat deletion obligation");
  expectRejected(database, `
    INSERT INTO "MemoryDeletionOutbox" (
      "id", "userId", "operation", "targetType", "targetId", "memoryGeneration",
      "admissionAuthorizationId", "admittedChatSourceRevision",
      "alsoForgetOriginMemories"
    ) VALUES (
      'memory-p8-smuggled', 'memory-owner-a', 'BULK_CLEAR',
      'HISTORY_INDEX@memory-p4-history-clear-v1', 'smuggled', 0,
      'memory-p8-smuggled-auth', 0, FALSE
    );
  `, /MemoryDeletionOutbox_shape_check/u, "admission metadata on a non-chat obligation");
  expectRejected(database, `
    INSERT INTO "Message" ("id", "chatId", "role", "content", "updatedAt")
    VALUES ('memory-p8-late-message', 'memory-p8-chat', 'user', '{}'::jsonb,
      CURRENT_TIMESTAMP);
  `, /cannot accept new aggregate children/u, "message resurrection after fence");
  expectRejected(database, `
    INSERT INTO "MemoryEvent" (
      "id", "userId", "operation", "actorType", "sourceChatId", "metadata"
    ) VALUES (
      'memory-p8-late-event', 'memory-owner-a', 'AUTO_PROPOSE', 'JOB',
      'memory-p8-chat', '{}'::jsonb
    );
  `, /cannot become a reusable source/u, "Memory source resurrection after fence");
  expectRejected(database, `
    UPDATE "MemoryDeletionOutbox"
    SET "alsoForgetOriginMemories" = TRUE
    WHERE "id" = 'memory-p8-delete';
  `, /admission metadata is immutable/iu, "permanent-delete choice rewrite");
  expectRejected(database, `
    UPDATE "Chat"
    SET "permanentDeletionAt" = NULL, "permanentDeletionOperationId" = NULL
    WHERE "id" = 'memory-p8-chat';
  `, /deletion fence is immutable/iu, "permanent-delete fence reversal");

  requireSuccess(psql(database, `
    UPDATE "MemoryEvent"
    SET "sourceChatId" = NULL, "sourceDeletedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'memory-p8-source-event';
  `), "detach a deleted Memory source once");
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', ("sourceChatId" IS NULL)::int,
        ("sourceDeletedAt" IS NOT NULL)::int)
      FROM "MemoryEvent" WHERE "id" = 'memory-p8-source-event';
    `),
    "1|1",
    "deleted Memory event source was not detached"
  );
  expectRejected(database, `
    UPDATE "MemoryEvent"
    SET "sourceDeletedAt" = NULL
    WHERE "id" = 'memory-p8-source-event';
  `, /Deleted source lifecycle is immutable/u, "deleted-source reversal");
}

function assertPermanentChatDeleteMigrationAtomicRollback(database: string): void {
  requireSuccess(psql(database, `
    CREATE FUNCTION aiqsa_permanent_chat_delete_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `), "install permanent-chat rollback-conflict fixture");
  const result = psql(
    database,
    readFileSync(join(migrationsRoot, PERMANENT_CHAT_DELETE_MIGRATION, "migration.sql"), "utf8")
  );
  assert.notEqual(result.status, 0, "conflicting permanent-chat migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /function "aiqsa_permanent_chat_delete_guard" already exists/u,
    "permanent-chat rollback fixture failed for an unexpected reason"
  );
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'Chat'
           AND column_name IN ('permanentDeletionAt', 'permanentDeletionOperationId')),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'MemoryEvent'
           AND column_name = 'sourceDeletedAt'),
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'MemoryDeletionOutbox'
           AND column_name IN (
             'admissionAuthorizationId', 'admittedChatSourceRevision',
             'admittedActiveLeafMessageId', 'alsoForgetOriginMemories'
           )))
    `),
    "0|0|0",
    "failed permanent-chat migration left partial durable state"
  );
}

function main(): void {
  requireSuccess(compose(["up", "-d", POSTGRES_SERVICE]), "start disposable PostgreSQL service");
  try {
    createDatabase(upgradeDatabase);
    applyMigrations(upgradeDatabase, migrationNames((name) => name < TARGET_MIGRATION));
    seedUpgradeFixture(upgradeDatabase);
    applyMigrations(upgradeDatabase, [TARGET_MIGRATION]);
    assertUpgradePreserved(upgradeDatabase);
    assertScopeAndFactContracts(upgradeDatabase);
    assertGenerationAndSearchContracts(upgradeDatabase);
    assertPreparingAndOutboxContracts(upgradeDatabase);
    seedExecutionUsageUpgradeFixture(upgradeDatabase);
    applyMigrations(upgradeDatabase, MEMORY_FOLLOWUP_MIGRATIONS);
    assertExecutionUsageContracts(upgradeDatabase);
    assertCoordinatorFairnessContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [CHAT_SCOPE_MIGRATION]);
    assertFeatureDarkScopeContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [
      SCOPE_LIFECYCLE_MIGRATION,
      TEMPORARY_RETENTION_MIGRATION
    ]);
    assertChatScopeSchemaContracts(upgradeDatabase);
    assertScopeLifecycleContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [HISTORY_SCHEMA_MIGRATION]);
    assertHistorySchemaContracts(upgradeDatabase, true);
    applyMigrations(upgradeDatabase, [HISTORY_EGRESS_MIGRATION]);
    assertHistoryEgressContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [ADMIN_EGRESS_MIGRATION]);
    assertAdminEgressContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [FACT_CANDIDATE_MIGRATION]);
    assertFactCandidateContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [FACT_CONSOLIDATION_MIGRATION]);
    assertFactConsolidationContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [LEARNING_REVIEW_MIGRATION]);
    assertLearningReviewContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [
      FORGET_UNDO_MIGRATION,
      FORGET_UNDO_SHAPE_MIGRATION
    ]);
    assertForgetUndoContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [WORKING_SET_PROFILE_MIGRATION]);
    assertWorkingSetProfileContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [PERMANENT_CHAT_DELETE_MIGRATION]);
    assertPermanentChatDeleteContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [VERIFICATION_AUTHORITY_V2_MIGRATION]);
    assertVerificationAuthorityV2Contracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [SEMANTIC_RETRIEVAL_MIGRATION]);
    assertSemanticRetrievalContracts(upgradeDatabase);
    applyMigrations(upgradeDatabase, [FACT_RECEIPT_PROVENANCE_MIGRATION]);
    assertFactReceiptProvenanceContracts(upgradeDatabase);

    createDatabase(freshDatabase);
    applyMigrations(freshDatabase, migrationNames((name) => name <= TARGET_MIGRATION));
    assertFreshContracts(freshDatabase);
    seedExecutionUsageFreshOwner(freshDatabase);
    seedExecutionUsageUpgradeFixture(freshDatabase);
    applyMigrations(freshDatabase, MEMORY_FOLLOWUP_MIGRATIONS);
    assertExecutionUsageContracts(freshDatabase);
    assertCoordinatorFairnessContracts(freshDatabase);
    applyMigrations(freshDatabase, [CHAT_SCOPE_MIGRATION]);
    assertFeatureDarkScopeContracts(freshDatabase);
    applyMigrations(freshDatabase, [
      SCOPE_LIFECYCLE_MIGRATION,
      TEMPORARY_RETENTION_MIGRATION
    ]);
    assertChatScopeSchemaContracts(freshDatabase);
    assertScopeLifecycleContracts(freshDatabase);
    applyMigrations(freshDatabase, [HISTORY_SCHEMA_MIGRATION]);
    assertHistorySchemaContracts(freshDatabase, false);
    applyMigrations(freshDatabase, [HISTORY_EGRESS_MIGRATION]);
    assertHistoryEgressContracts(freshDatabase);
    applyMigrations(freshDatabase, [ADMIN_EGRESS_MIGRATION]);
    assertAdminEgressContracts(freshDatabase);
    applyMigrations(freshDatabase, [FACT_CANDIDATE_MIGRATION]);
    assertFactCandidateContracts(freshDatabase);
    applyMigrations(freshDatabase, [FACT_CONSOLIDATION_MIGRATION]);
    assertFactConsolidationContracts(freshDatabase);
    applyMigrations(freshDatabase, [LEARNING_REVIEW_MIGRATION]);
    assertLearningReviewContracts(freshDatabase, false);
    applyMigrations(freshDatabase, [
      FORGET_UNDO_MIGRATION,
      FORGET_UNDO_SHAPE_MIGRATION
    ]);
    assertForgetUndoContracts(freshDatabase);
    applyMigrations(freshDatabase, [WORKING_SET_PROFILE_MIGRATION]);
    assertWorkingSetProfileContracts(freshDatabase);
    applyMigrations(freshDatabase, [PERMANENT_CHAT_DELETE_MIGRATION]);
    assertPermanentChatDeleteContracts(freshDatabase);
    applyMigrations(freshDatabase, [VERIFICATION_AUTHORITY_V2_MIGRATION]);
    assertVerificationAuthorityV2Contracts(freshDatabase);
    applyMigrations(freshDatabase, [SEMANTIC_RETRIEVAL_MIGRATION]);
    assertSemanticRetrievalContracts(freshDatabase);
    applyMigrations(freshDatabase, [FACT_RECEIPT_PROVENANCE_MIGRATION]);
    assertFactReceiptProvenanceContracts(freshDatabase);

    createDatabase(rollbackDatabase);
    applyMigrations(rollbackDatabase, migrationNames((name) => name < CHAT_SCOPE_MIGRATION));
    assertChatScopeMigrationAtomicRollback(rollbackDatabase);

    createDatabase(scopeRollbackDatabase);
    applyMigrations(
      scopeRollbackDatabase,
      migrationNames((name) => name < SCOPE_LIFECYCLE_MIGRATION)
    );
    assertScopeLifecycleMigrationAtomicRollback(scopeRollbackDatabase);

    createDatabase(temporaryRollbackDatabase);
    applyMigrations(
      temporaryRollbackDatabase,
      migrationNames((name) => name < TEMPORARY_RETENTION_MIGRATION)
    );
    assertTemporaryRetentionMigrationAtomicRollback(temporaryRollbackDatabase);

    createDatabase(historyRollbackDatabase);
    applyMigrations(
      historyRollbackDatabase,
      migrationNames((name) => name < HISTORY_SCHEMA_MIGRATION)
    );
    assertHistorySchemaMigrationAtomicRollback(historyRollbackDatabase);

    createDatabase(historyEgressRollbackDatabase);
    applyMigrations(
      historyEgressRollbackDatabase,
      migrationNames((name) => name < HISTORY_EGRESS_MIGRATION)
    );
    assertHistoryEgressMigrationAtomicRollback(historyEgressRollbackDatabase);

    createDatabase(adminEgressRollbackDatabase);
    applyMigrations(
      adminEgressRollbackDatabase,
      migrationNames((name) => name < ADMIN_EGRESS_MIGRATION)
    );
    assertAdminEgressMigrationAtomicRollback(adminEgressRollbackDatabase);

    createDatabase(factCandidateRollbackDatabase);
    applyMigrations(
      factCandidateRollbackDatabase,
      migrationNames((name) => name < FACT_CANDIDATE_MIGRATION)
    );
    assertFactCandidateMigrationAtomicRollback(factCandidateRollbackDatabase);

    createDatabase(factConsolidationRollbackDatabase);
    applyMigrations(
      factConsolidationRollbackDatabase,
      migrationNames((name) => name < FACT_CONSOLIDATION_MIGRATION)
    );
    assertFactConsolidationMigrationAtomicRollback(factConsolidationRollbackDatabase);

    createDatabase(learningReviewRollbackDatabase);
    applyMigrations(
      learningReviewRollbackDatabase,
      migrationNames((name) => name < LEARNING_REVIEW_MIGRATION)
    );
    assertLearningReviewMigrationAtomicRollback(learningReviewRollbackDatabase);

    createDatabase(workingSetProfileRollbackDatabase);
    applyMigrations(
      workingSetProfileRollbackDatabase,
      migrationNames((name) => name < WORKING_SET_PROFILE_MIGRATION)
    );
    assertWorkingSetProfileMigrationAtomicRollback(workingSetProfileRollbackDatabase);

    createDatabase(permanentChatDeleteRollbackDatabase);
    applyMigrations(
      permanentChatDeleteRollbackDatabase,
      migrationNames((name) => name < PERMANENT_CHAT_DELETE_MIGRATION)
    );
    assertPermanentChatDeleteMigrationAtomicRollback(permanentChatDeleteRollbackDatabase);
  } finally {
    dropDatabases();
  }

  console.info(
    "Memory migration contract passed through multilingual semantic retrieval and receipt-provenance fences."
  );
}

main();
