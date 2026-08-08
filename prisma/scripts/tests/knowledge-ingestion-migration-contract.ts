import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260808170000_knowledge_ingestion_pipeline";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const suffix = `${process.pid}_${Date.now()}`;
const upgradeDatabase = `aiqsa_knowledge_ingestion_upgrade_${suffix}`;
const freshDatabase = `aiqsa_knowledge_ingestion_fresh_${suffix}`;
const createdDatabases = new Set<string>();

type CommandResult = Readonly<{ status: number; stderr: string; stdout: string }>;

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function requireSuccess(result: CommandResult, operation: string): string {
  assert.equal(result.status, 0, `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function psql(database: string, sql: string): CommandResult {
  return compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--set=ON_ERROR_STOP=1",
    "--username", POSTGRES_USER, "--dbname", database
  ], sql);
}

function scalar(database: string, sql: string): string {
  return requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER, "--dbname", database,
    "--command", sql
  ]), "read Knowledge ingestion migration state");
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
    requireSuccess(compose([
      "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
      "--username", POSTGRES_USER, database
    ]), `drop ${database}`);
  }
  createdDatabases.clear();
}

function expectRejected(database: string, sql: string, expected: RegExp, label: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${label} failed unexpectedly`);
}

function seedFoundationRows(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "status", "updatedAt")
    VALUES ('ingestion-owner', 'ingestion-owner@example.test', 'Ingestion owner', 'active', CURRENT_TIMESTAMP);
    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'ingestion-connection', 'Ingestion connection', 'openai_compatible', true,
      '{}'::jsonb, 1, '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'ingestion-model', 'ingestion-connection', 'openai_compatible', 'embed-v1',
      'Embedding v1', 'embedding', 32768, '{}'::jsonb, 1, '{}'::jsonb, 1,
      '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeBase" (
      "id", "ownerUserId", "name", "contentRevision", "version", "updatedAt"
    ) VALUES ('ingestion-base', 'ingestion-owner', 'Ingestion base', 1, 1, CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "readyAt", "activatedAt", "updatedAt"
    ) VALUES (
      'ingestion-generation', 'ingestion-base', 'ingestion-model', '{}'::jsonb,
      repeat('a', 64), 1536, 1, 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeBase" SET "activeIndexGenerationId" = 'ingestion-generation'
    WHERE "id" = 'ingestion-base';
    INSERT INTO "KnowledgeDocument" ("id", "knowledgeBaseId", "currentVersionId", "updatedAt")
    VALUES ('ingestion-document', 'ingestion-base', NULL, CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "versionNumber", "fileName", "mimeType",
      "byteSize", "checksum", "originalStorageKey", "normalizedTextStorageKey",
      "pageCount", "visibleFromRevision", "ingestState", "ingestCompletedAt", "updatedAt"
    ) VALUES (
      'ingestion-version', 'ingestion-base', 'ingestion-document', 1, 'fixture.txt', 'text/plain',
      10, repeat('b', 64), 'knowledge/original', 'knowledge/normalized',
      1, 1, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeDocument" SET "currentVersionId" = 'ingestion-version'
    WHERE "id" = 'ingestion-document';
    INSERT INTO "UsageEvent" ("id", "userId", "provider", "modelId")
    VALUES ('legacy-usage', 'ingestion-owner', 'fake', 'fake-qsa');
  `), "seed pre-ingestion Knowledge rows");
}

function assertUpgradeContracts(database: string): void {
  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT "ingestEmbeddedChunkCount" FROM "KnowledgeDocumentVersion" WHERE "id" = 'ingestion-version'),
      (SELECT ("sourceIndexGenerationId" IS NULL)::int FROM "KnowledgeIndexGeneration" WHERE "id" = 'ingestion-generation'),
      (SELECT ("providerModelId" IS NULL AND "knowledgeBaseId" IS NULL)::int FROM "UsageEvent" WHERE "id" = 'legacy-usage'),
      (SELECT count(*) FROM information_schema.tables WHERE table_name = 'KnowledgeGenerationDocument')
    );
  `), "0|1|1|1", "existing foundation rows did not adopt inert ingestion defaults");

  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT count(*) FROM pg_constraint WHERE conname IN (
        'KnowledgeIndexGeneration_reindex_source_check',
        'KnowledgeDocumentVersion_normalized_object_check',
        'KnowledgeDocumentVersion_ingest_progress_check',
        'KnowledgeGenerationDocument_progress_check',
        'UsageEvent_knowledge_shape_check'
      )),
      (SELECT count(*) FROM pg_indexes WHERE indexname IN (
        'KnowledgeIndexGeneration_one_building_reindex_idx',
        'KnowledgeDocumentVersion_one_active_ingest_idx',
        'UsageEvent_knowledge_batch_key'
      ))
    );
  `), "5|3", "ingestion constraints or idempotency indexes are missing");

  requireSuccess(psql(database, `
    UPDATE "KnowledgeDocumentVersion"
    SET "ingestGenerationId" = 'ingestion-generation',
        "normalizedTextByteSize" = 20,
        "normalizedTextChecksum" = repeat('c', 64),
        "ingestChunkCount" = 1,
        "ingestEmbeddedChunkCount" = 1
    WHERE "id" = 'ingestion-version';
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "sourceIndexGenerationId",
      "sourceBaseVersion", "targetContentRevision", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "updatedAt"
    ) VALUES (
      'ingestion-shadow', 'ingestion-base', 'ingestion-model', 'ingestion-generation',
      1, 1, '{}'::jsonb, repeat('d', 64), 1536, 1, 0, 'building', CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeGenerationDocument" (
      "knowledgeBaseId", "indexGenerationId", "documentVersionId", "chunkCount",
      "embeddedChunkCount", "state", "updatedAt"
    ) VALUES ('ingestion-base', 'ingestion-shadow', 'ingestion-version', 1, 1, 'ready', CURRENT_TIMESTAMP);
    INSERT INTO "UsageEvent" (
      "id", "userId", "provider", "modelId", "providerModelId", "knowledgeBaseId",
      "knowledgeIndexGenerationId", "knowledgeDocumentVersionId", "knowledgeBatchIndex",
      "inputTokens", "totalTokens"
    ) VALUES (
      'knowledge-usage', 'ingestion-owner', 'openai_compatible', 'embed-v1', 'ingestion-model',
      'ingestion-base', 'ingestion-shadow', 'ingestion-version', 0, 4, 4
    );
  `), "create valid shadow generation and batch evidence");

  expectRejected(database, `
    INSERT INTO "UsageEvent" (
      "id", "userId", "provider", "modelId", "providerModelId", "knowledgeBaseId",
      "knowledgeIndexGenerationId", "knowledgeDocumentVersionId", "knowledgeBatchIndex"
    ) VALUES (
      'duplicate-knowledge-usage', 'ingestion-owner', 'openai_compatible', 'embed-v1',
      'ingestion-model', 'ingestion-base', 'ingestion-shadow', 'ingestion-version', 0
    );
  `, /UsageEvent_knowledge_batch_key/u, "duplicate Knowledge batch marker");

  expectRejected(database, `
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "sourceIndexGenerationId",
      "sourceBaseVersion", "targetContentRevision", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "updatedAt"
    ) VALUES (
      'ingestion-shadow-two', 'ingestion-base', 'ingestion-model', 'ingestion-generation',
      1, 1, '{}'::jsonb, repeat('e', 64), 1536, 1, 0, 'building', CURRENT_TIMESTAMP
    );
  `, /KnowledgeIndexGeneration_one_building_reindex_idx/u, "second building reindex");

  expectRejected(database, `
    UPDATE "KnowledgeGenerationDocument"
    SET "state" = 'parsing' WHERE "indexGenerationId" = 'ingestion-shadow';
  `, /KnowledgeGenerationDocument_state_check/u, "unsupported reindex work state");

  requireSuccess(psql(database, `
    INSERT INTO "KnowledgeDocument" ("id", "knowledgeBaseId", "updatedAt")
    VALUES ('pending-document', 'ingestion-base', CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "ingestGenerationId", "versionNumber",
      "fileName", "mimeType", "byteSize", "checksum", "originalStorageKey", "ingestState", "updatedAt"
    ) VALUES (
      'pending-version-one', 'ingestion-base', 'pending-document', 'ingestion-generation', 1,
      'pending.txt', 'text/plain', 1, repeat('1', 64), 'knowledge/pending-one', 'queued', CURRENT_TIMESTAMP
    );
  `), "create one active document ingest");
  expectRejected(database, `
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "ingestGenerationId", "versionNumber",
      "fileName", "mimeType", "byteSize", "checksum", "originalStorageKey", "ingestState", "updatedAt"
    ) VALUES (
      'pending-version-two', 'ingestion-base', 'pending-document', 'ingestion-generation', 2,
      'pending-2.txt', 'text/plain', 1, repeat('2', 64), 'knowledge/pending-two', 'parsing', CURRENT_TIMESTAMP
    );
  `, /KnowledgeDocumentVersion_one_active_ingest_idx/u, "second active version ingest");

  requireSuccess(psql(database, `
    INSERT INTO "KnowledgeDocument" ("id", "knowledgeBaseId", "updatedAt")
    VALUES ('purged-document', 'ingestion-base', CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "versionNumber", "fileName", "mimeType",
      "byteSize", "checksum", "originalStorageKey", "normalizedTextStorageKey",
      "normalizedTextByteSize", "normalizedTextChecksum", "ingestState", "ingestErrorCode",
      "ingestCompletedAt", "updatedAt"
    ) VALUES (
      'purged-version', 'ingestion-base', 'purged-document', 1, 'purged.txt', 'text/plain',
      1, repeat('3', 64), 'knowledge/purged-original', 'knowledge/purged-normalized',
      10, repeat('4', 64), 'failed', 'parser_rejected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeDocumentVersion"
    SET "originalStorageKey" = NULL, "normalizedTextStorageKey" = NULL,
        "normalizedTextByteSize" = NULL, "normalizedTextChecksum" = NULL,
        "payloadPurgedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'purged-version';
  `), "retain identity while purging failed never-visible payloads");
  assert.equal(
    scalar(database, `SELECT ("originalStorageKey" IS NULL AND "payloadPurgedAt" IS NOT NULL)::int
      FROM "KnowledgeDocumentVersion" WHERE "id" = 'purged-version';`),
    "1"
  );
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect disposable development PostgreSQL"
    ),
    POSTGRES_SERVICE
  );
  const beforeTarget = migrationNames((name) => name < TARGET_MIGRATION);
  const throughTarget = migrationNames((name) => name <= TARGET_MIGRATION);
  assert.ok(throughTarget.includes(TARGET_MIGRATION), "Knowledge ingestion target migration is missing");

  try {
    createDatabase(upgradeDatabase);
    applyMigrations(upgradeDatabase, beforeTarget);
    seedFoundationRows(upgradeDatabase);
    applyMigrations(upgradeDatabase, [TARGET_MIGRATION]);
    assertUpgradeContracts(upgradeDatabase);

    createDatabase(freshDatabase);
    applyMigrations(freshDatabase, throughTarget);
    assert.equal(scalar(freshDatabase, `
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'KnowledgeGenerationDocument'),
        (SELECT count(*) FROM pg_indexes WHERE indexname = 'UsageEvent_knowledge_batch_key')
      );
    `), "1|1", "fresh migration path omitted Knowledge ingestion structures");
  } finally {
    dropDatabases();
  }
  process.stdout.write("Knowledge ingestion migration contract passed.\n");
}

main();
