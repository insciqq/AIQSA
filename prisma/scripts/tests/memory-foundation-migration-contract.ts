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
    SET "state" = 'ORPHANED', "systemTo" = CURRENT_TIMESTAMP + interval '1 millisecond'
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
  } finally {
    dropDatabases();
  }

  console.info("Memory migration contract passed through the Phase 4 history schema.");
}

main();
