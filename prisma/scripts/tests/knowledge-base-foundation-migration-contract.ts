import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260808160000_knowledge_base_foundation";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const suffix = `${process.pid}_${Date.now()}`;
const existingDatabase = `aiqsa_knowledge_existing_${suffix}`;
const freshDatabase = `aiqsa_knowledge_fresh_${suffix}`;
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
    "read Knowledge migration contract state"
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

function assertExtension(database: string): void {
  const version = scalar(database, `SELECT extversion FROM pg_extension WHERE extname = 'vector';`);
  assert.match(version, /^\d+\.\d+\.\d+$/u, "pgvector extension version is missing");
  const [major, minor] = version.split(".").map(Number);
  assert.ok(major! > 0 || minor! >= 7, `pgvector ${version} is below the supported 0.7 minimum`);
}

function seedExistingSchema(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
    VALUES ('knowledge-owner', 'knowledge-owner@example.test', 'Knowledge Owner', 'admin', 'active', CURRENT_TIMESTAMP);

    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'answer-connection', 'Answer connection', 'openai', true, '{}'::jsonb, 1,
      '{"allowPrivateNetwork":false,"apiRoot":"https://example.test/v1"}'::jsonb, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'answer-model', 'answer-connection', 'openai', 'answer-model', 'Answer model', 'answer',
      32768, '{}'::jsonb, 1,
      '{
        "adapterKind":"openai_responses_native",
        "answerSelectable":true,
        "capabilities":{"contextWindow":32768,"nativePdfInput":false,"nativeSearch":false,"pdf":false,"reasoning":false,"streaming":true,"toolCalling":false,"vision":false},
        "defaultParams":{},"modelClass":"answer","upstreamModelId":"answer-model"
      }'::jsonb,
      1,
      '{"contextWindow":32768,"nativePdfInput":false,"nativeSearch":false,"pdf":false,"reasoning":false,"streaming":true,"toolCalling":false,"vision":false}'::jsonb,
      '{}'::jsonb,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );

    INSERT INTO "Folder" ("id", "userId", "name", "updatedAt")
    VALUES ('existing-folder', 'knowledge-owner', 'Existing folder', CURRENT_TIMESTAMP);
    INSERT INTO "Chat" ("id", "userId", "folderId", "title", "updatedAt")
    VALUES ('existing-chat', 'knowledge-owner', 'existing-folder', 'Existing chat', CURRENT_TIMESTAMP);
    INSERT INTO "AssistantDefinition" ("id", "ownerUserId", "version", "updatedAt")
    VALUES ('existing-assistant', 'knowledge-owner', 1, CURRENT_TIMESTAMP);
    INSERT INTO "AssistantRevision" (
      "id", "assistantId", "revisionNumber", "name", "description", "avatar",
      "providerModelId", "systemPrompt", "runControls", "searchPlan"
    ) VALUES (
      'existing-assistant-revision', 'existing-assistant', 1, 'Existing Assistant', '',
      '{"kind":"generated"}'::jsonb, 'answer-model', '', '{}'::jsonb,
      '{"mode":"all_selected","optionIds":[]}'::jsonb
    );
    UPDATE "AssistantDefinition"
    SET "currentRevisionId" = 'existing-assistant-revision'
    WHERE "id" = 'existing-assistant';
  `), "seed existing-volume fixture");
}

function seedKnowledgeFixture(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'embedding-connection', 'Embedding destination', 'openai_compatible', true,
      '{}'::jsonb, 1,
      '{"allowPrivateNetwork":false,"apiRoot":"https://embedding.example.test/v1"}'::jsonb,
      1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'embedding-model', 'embedding-connection', 'openai_compatible', 'embed-v1',
      'Embedding model', 'embedding', 32768, '{}'::jsonb, 1,
      '{
        "adapterKind":"openai_embeddings_compatible","answerSelectable":false,
        "capabilities":{"contextWindow":32768,"nativePdfInput":false,"nativeSearch":false,"pdf":false,"reasoning":false,"streaming":false,"toolCalling":false,"vision":false},
        "defaultParams":{},
        "embedding":{"nativeDimension":1536,"providerFamily":"openai_compatible","queryInstructionTemplate":null,"supportsMrl":false,"targetDimension":1536},
        "modelClass":"embedding","upstreamModelId":"embed-v1"
      }'::jsonb,
      1,
      '{"contextWindow":32768,"nativePdfInput":false,"nativeSearch":false,"pdf":false,"reasoning":false,"streaming":false,"toolCalling":false,"vision":false}'::jsonb,
      '{}'::jsonb,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );

    INSERT INTO "KnowledgeBase" (
      "id", "ownerUserId", "name", "description", "contentRevision", "version", "updatedAt"
    ) VALUES
      ('base-one', 'knowledge-owner', 'Base one', '', 2, 1, CURRENT_TIMESTAMP),
      ('base-two', 'knowledge-owner', 'Base two', '', 0, 1, CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "readyAt", "activatedAt", "updatedAt"
    ) VALUES (
      'generation-one', 'base-one', 'embedding-model', '{"schemaVersion":1}'::jsonb,
      repeat('a', 64), 1536, 1, 2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "updatedAt"
    ) VALUES (
      'generation-one-shadow', 'base-one', 'embedding-model', '{"schemaVersion":1}'::jsonb,
      repeat('b', 64), 1536, 1, 0, 'building', CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeBase"
    SET "activeIndexGenerationId" = 'generation-one'
    WHERE "id" = 'base-one';

    INSERT INTO "KnowledgeDocument" ("id", "knowledgeBaseId", "updatedAt") VALUES
      ('document-a', 'base-one', CURRENT_TIMESTAMP),
      ('document-b', 'base-one', CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "versionNumber", "fileName", "mimeType",
      "byteSize", "checksum", "originalStorageKey", "normalizedTextStorageKey",
      "pageCount", "visibleFromRevision", "visibleUntilRevision", "ingestState",
      "ingestCompletedAt", "updatedAt"
    ) VALUES
      ('document-a-v1', 'base-one', 'document-a', 1, 'a-v1.pdf', 'application/pdf',
        100, repeat('1', 64), 'knowledge/a-v1/original', 'knowledge/a-v1/text', 1,
        1, 2, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('document-a-v2', 'base-one', 'document-a', 2, 'a-v2.pdf', 'application/pdf',
        120, repeat('2', 64), 'knowledge/a-v2/original', 'knowledge/a-v2/text', 1,
        2, NULL, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('document-b-v1', 'base-one', 'document-b', 1, 'b-v1.txt', 'text/plain',
        80, repeat('3', 64), 'knowledge/b-v1/original', 'knowledge/b-v1/text', 1,
        1, NULL, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    UPDATE "KnowledgeDocument" SET "currentVersionId" = 'document-a-v2'
      WHERE "id" = 'document-a';
    UPDATE "KnowledgeDocument" SET "currentVersionId" = 'document-b-v1'
      WHERE "id" = 'document-b';

    INSERT INTO "KnowledgeChunk" (
      "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
      "chunkIndex", "page", "headingPath", "text", "embeddingDimension", "embedding"
    ) VALUES (
      'chunk-a-v2', 'base-one', 'document-a-v2', 'generation-one', 0, 1,
      ARRAY['Overview'], 'Multilingual product guide', 1536,
      array_fill(1::real, ARRAY[1536])::vector
    );
  `), "seed Knowledge revision and vector fixture");
}

function assertKnowledgeContracts(database: string): void {
  assertExtension(database);
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        (SELECT COALESCE(cardinality("knowledgeBaseIds"), -1) FROM "AssistantRevision" WHERE "id" = 'existing-assistant-revision'),
        (SELECT ("defaultKnowledgePlan" IS NULL)::int FROM "Folder" WHERE "id" = 'existing-folder'),
        (SELECT ("defaultKnowledgePlan" IS NULL)::int FROM "Chat" WHERE "id" = 'existing-chat')
      );
    `),
    "0|1|1",
    "existing Assistant/Folder/Chat rows did not adopt inert Knowledge defaults"
  );

  seedKnowledgeFixture(database);
  assert.equal(
    scalar(database, `
      SELECT string_agg("id", ',' ORDER BY "id")
      FROM "KnowledgeDocumentVersion"
      WHERE "knowledgeBaseId" = 'base-one'
        AND "visibleFromRevision" <= 1
        AND ("visibleUntilRevision" IS NULL OR "visibleUntilRevision" > 1);
    `),
    "document-a-v1,document-b-v1"
  );
  assert.equal(
    scalar(database, `
      SELECT string_agg("id", ',' ORDER BY "id")
      FROM "KnowledgeDocumentVersion"
      WHERE "knowledgeBaseId" = 'base-one'
        AND "visibleFromRevision" <= 2
        AND ("visibleUntilRevision" IS NULL OR "visibleUntilRevision" > 2);
    `),
    "document-a-v2,document-b-v1"
  );
  requireSuccess(
    psql(database, `UPDATE "KnowledgeDocument" SET "currentVersionId" = 'document-a-v1' WHERE "id" = 'document-a';`),
    "move current pointer without changing temporal authority"
  );
  assert.equal(
    scalar(database, `
      SELECT string_agg("id", ',' ORDER BY "id")
      FROM "KnowledgeDocumentVersion"
      WHERE "knowledgeBaseId" = 'base-one'
        AND "visibleFromRevision" <= 2
        AND ("visibleUntilRevision" IS NULL OR "visibleUntilRevision" > 2);
    `),
    "document-a-v2,document-b-v1",
    "current pointer rewrote accepted revision meaning"
  );

  assert.equal(
    scalar(database, `
      SELECT concat_ws('|',
        vector_dims("embedding"),
        ("searchVector" @@ plainto_tsquery('simple', 'product'))::int,
        "embeddingDimension")
      FROM "KnowledgeChunk" WHERE "id" = 'chunk-a-v2';
    `),
    "1536|1|1536"
  );
  assert.equal(
    scalar(database, `
      SELECT count(*) FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'KnowledgeChunk_embedding_1024_hnsw_idx',
          'KnowledgeChunk_embedding_1536_hnsw_idx',
          'KnowledgeChunk_searchVector_gin_idx'
        );
    `),
    "3"
  );

  expectRejected(
    database,
    `UPDATE "KnowledgeBase" SET "activeIndexGenerationId" = 'generation-one-shadow' WHERE "id" = 'base-two';`,
    /KnowledgeBase_activeIndexGeneration_fkey/u,
    "cross-base active generation"
  );
  expectRejected(
    database,
    `UPDATE "KnowledgeDocument" SET "currentVersionId" = 'document-a-v2' WHERE "id" = 'document-b';`,
    /KnowledgeDocument_currentVersion_fkey/u,
    "cross-document current version"
  );
  expectRejected(
    database,
    `INSERT INTO "KnowledgeChunk" (
      "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
      "chunkIndex", "page", "text", "embeddingDimension", "embedding"
    ) VALUES (
      'bad-dimension', 'base-one', 'document-a-v2', 'generation-one', 1, 1,
      'bad', 1024, array_fill(1::real, ARRAY[1536])::vector
    );`,
    /KnowledgeChunk_dimension_check/u,
    "mismatched vector dimension"
  );

  requireSuccess(psql(database, `
    INSERT INTO "Group" ("id", "name", "updatedAt")
    VALUES ('knowledge-group', 'Knowledge readers', CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeBasePublication" (
      "id", "knowledgeBaseId", "scope", "groupId", "publishedByUserId", "updatedAt"
    ) VALUES
      ('knowledge-group-publication', 'base-one', 'group', 'knowledge-group', 'knowledge-owner', CURRENT_TIMESTAMP),
      ('knowledge-installation-publication', 'base-one', 'installation', NULL, 'knowledge-owner', CURRENT_TIMESTAMP);
  `), "create valid Knowledge publications");
  expectRejected(
    database,
    `INSERT INTO "KnowledgeBasePublication" (
      "id", "knowledgeBaseId", "scope", "groupId", "updatedAt"
    ) VALUES ('bad-publication', 'base-two', 'installation', 'knowledge-group', CURRENT_TIMESTAMP);`,
    /KnowledgeBasePublication_scope_group_check/u,
    "invalid publication scope/group pair"
  );
  expectRejected(
    database,
    `INSERT INTO "KnowledgeBasePublication" (
      "id", "knowledgeBaseId", "scope", "groupId", "updatedAt"
    ) VALUES ('duplicate-installation', 'base-one', 'installation', NULL, CURRENT_TIMESTAMP);`,
    /KnowledgeBasePublication_installation_key/u,
    "duplicate installation publication"
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
  assert.ok(throughTarget.includes(TARGET_MIGRATION), "Knowledge target migration is missing");

  try {
    createDatabase(existingDatabase);
    applyMigrations(existingDatabase, beforeTarget);
    seedExistingSchema(existingDatabase);
    applyMigrations(existingDatabase, [TARGET_MIGRATION]);
    assertKnowledgeContracts(existingDatabase);

    createDatabase(freshDatabase);
    applyMigrations(freshDatabase, throughTarget);
    assertExtension(freshDatabase);
    assert.equal(
      scalar(freshDatabase, `
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'KnowledgeBase', 'KnowledgeIndexGeneration', 'KnowledgeDocument',
            'KnowledgeDocumentVersion', 'KnowledgeChunk', 'KnowledgeBasePublication'
          );
      `),
      "6",
      "fresh migration did not create the complete Knowledge aggregate"
    );
  } finally {
    dropDatabases();
  }
  process.stdout.write("Knowledge Base migration contract passed.\n");
}

main();
