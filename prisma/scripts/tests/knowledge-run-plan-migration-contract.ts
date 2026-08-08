import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260808180000_knowledge_run_plan";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_knowledge_run_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = Readonly<{ status: number; stderr: string; stdout: string }>;

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

function psql(sql: string): CommandResult {
  return compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--set=ON_ERROR_STOP=1",
    "--username", POSTGRES_USER, "--dbname", database
  ], sql);
}

function scalar(sql: string): string {
  return requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER, "--dbname", database,
    "--command", sql
  ]), "read Knowledge run migration state");
}

function expectRejected(sql: string, expected: RegExp, label: string): void {
  const result = psql(sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${label} failed unexpectedly`);
}

function dropDatabase(): void {
  if (!databaseCreated) return;
  requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
    "--username", POSTGRES_USER, database
  ]), "drop Knowledge run migration contract database");
  databaseCreated = false;
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect development PostgreSQL service"
    ),
    POSTGRES_SERVICE
  );
  requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, database
  ]), "create Knowledge run migration contract database");
  databaseCreated = true;

  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name <= TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.at(-1), TARGET_MIGRATION, "target Knowledge run migration is missing");
  for (const migration of migrations) {
    requireSuccess(
      psql(readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8")),
      `apply migration ${migration}`
    );
  }

  assert.equal(scalar(`
    SELECT concat_ws('|',
      to_regclass('public."KnowledgeRunBinding"')::text,
      (SELECT count(*) FROM pg_constraint WHERE conname IN (
        'KnowledgeRunBinding_ordinal_check',
        'KnowledgeRunBinding_base_revision_check',
        'KnowledgeRunBinding_indexed_revision_check',
        'KnowledgeRunBinding_fingerprint_check',
        'KnowledgeRunBinding_dimension_check',
        'KnowledgeRunBinding_snapshot_check',
        'KnowledgeRunBinding_modelRunId_fkey',
        'KnowledgeRunBinding_knowledgeBaseId_fkey',
        'KnowledgeRunBinding_generation_fkey',
        'KnowledgeRunBinding_embeddingModel_fkey',
        'KnowledgeRunBinding_credential_fkey',
        'KnowledgeRunBinding_credentialVersion_fkey'
      )),
      (SELECT count(*) FROM pg_indexes WHERE indexname IN (
        'KnowledgeRunBinding_modelRunId_ordinal_key',
        'KnowledgeRunBinding_modelRunId_knowledgeBaseId_key',
        'KnowledgeRunBinding_knowledgeBaseId_indexGenerationId_idx',
        'KnowledgeRunBinding_embedding_model_idx',
        'KnowledgeRunBinding_credential_version_idx'
      ))
    );
  `), `"KnowledgeRunBinding"|12|5`, "Knowledge run constraints or indexes are missing");

  requireSuccess(psql(`
    INSERT INTO "User" ("id", "email", "displayName", "status", "updatedAt")
    VALUES ('knowledge-run-user', 'knowledge-run@contract.test', 'Knowledge run user', 'active', CURRENT_TIMESTAMP);
    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'knowledge-run-connection', 'Knowledge run endpoint', 'openai_compatible', true,
      '{}'::jsonb, 1, '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderCredential" (
      "id", "connectionId", "label", "enabled", "testedAt", "activatedAt", "updatedAt"
    ) VALUES (
      'knowledge-run-credential', 'knowledge-run-connection', 'Knowledge run key', true,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderCredentialVersion" (
      "id", "credentialId", "version", "secretEnvelope", "testEvidence", "testedAt", "activatedAt"
    ) VALUES (
      'knowledge-run-credential-version', 'knowledge-run-credential', 1,
      'sealed-contract-envelope', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "ProviderCredential" SET "activeVersionId" = 'knowledge-run-credential-version'
    WHERE "id" = 'knowledge-run-credential';
    UPDATE "ProviderConnection" SET "defaultCredentialId" = 'knowledge-run-credential'
    WHERE "id" = 'knowledge-run-connection';
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'knowledge-run-model', 'knowledge-run-connection', 'openai_compatible', 'embedding-v1',
      'Knowledge run embedding', 'embedding', 32768, '{}'::jsonb, 1, '{}'::jsonb, 1,
      '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeBase" (
      "id", "ownerUserId", "name", "contentRevision", "version", "updatedAt"
    ) VALUES ('knowledge-run-base', 'knowledge-run-user', 'Knowledge run base', 3, 1, CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "readyAt", "activatedAt", "updatedAt"
    ) VALUES (
      'knowledge-run-generation', 'knowledge-run-base', 'knowledge-run-model', '{}'::jsonb,
      repeat('a', 64), 1536, 1, 2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeBase" SET "activeIndexGenerationId" = 'knowledge-run-generation'
    WHERE "id" = 'knowledge-run-base';
    INSERT INTO "Chat" ("id", "userId", "title", "updatedAt")
    VALUES ('knowledge-run-chat', 'knowledge-run-user', 'Knowledge run contract', CURRENT_TIMESTAMP);
    INSERT INTO "Message" ("id", "chatId", "role", "content", "status", "updatedAt")
    VALUES (
      'knowledge-run-message', 'knowledge-run-chat', 'user', '{"blocks":[]}'::jsonb,
      'complete', CURRENT_TIMESTAMP
    );
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
      "normalizedRequest", "updatedAt"
    ) VALUES
      ('knowledge-run-one', 'knowledge-run-chat', 'knowledge-run-user', 'knowledge-run-message',
       'fake', 'fake-answer', 'complete', '{"knowledgePlan":{"baseIds":["knowledge-run-base"]}}'::jsonb,
       CURRENT_TIMESTAMP),
      ('knowledge-run-two', 'knowledge-run-chat', 'knowledge-run-user', 'knowledge-run-message',
       'fake', 'fake-answer', 'complete', '{"knowledgePlan":{"baseIds":["knowledge-run-base"]}}'::jsonb,
       CURRENT_TIMESTAMP);
    INSERT INTO "KnowledgeRunBinding" (
      "id", "modelRunId", "knowledgeBaseId", "ordinal", "baseContentRevision",
      "indexGenerationId", "indexedContentRevision", "vectorSpaceFingerprint", "targetDimension",
      "embeddingConnectionId", "embeddingProviderModelId", "embeddingCredentialId",
      "embeddingCredentialVersionId", "embeddingCredentialSource", "embeddingExecutionSnapshot"
    ) VALUES (
      'knowledge-run-binding', 'knowledge-run-one', 'knowledge-run-base', 0, 3,
      'knowledge-run-generation', 2, repeat('a', 64), 1536,
      'knowledge-run-connection', 'knowledge-run-model', 'knowledge-run-credential',
      'knowledge-run-credential-version', 'default', '{"version":1}'::jsonb
    );
  `), "seed valid immutable Knowledge run evidence");

  assert.equal(scalar(`
    SELECT concat_ws('|', "ordinal", "baseContentRevision", "indexedContentRevision",
      "targetDimension", jsonb_typeof("embeddingExecutionSnapshot"))
    FROM "KnowledgeRunBinding" WHERE "id" = 'knowledge-run-binding';
  `), "0|3|2|1536|object", "valid Knowledge run evidence did not round-trip");

  const bindingColumns = `
    "id", "modelRunId", "knowledgeBaseId", "ordinal", "baseContentRevision",
    "indexGenerationId", "indexedContentRevision", "vectorSpaceFingerprint", "targetDimension",
    "embeddingConnectionId", "embeddingProviderModelId", "embeddingCredentialId",
    "embeddingCredentialVersionId", "embeddingCredentialSource", "embeddingExecutionSnapshot"`;
  const bindingTail = `
    'knowledge-run-base', 1, 3, 'knowledge-run-generation', 2, repeat('b', 64), 1536,
    'knowledge-run-connection', 'knowledge-run-model', 'knowledge-run-credential',
    'knowledge-run-credential-version', 'default', '{}'::jsonb`;
  expectRejected(`
    INSERT INTO "KnowledgeRunBinding" (${bindingColumns}) VALUES (
      'knowledge-run-ordinal-invalid', 'knowledge-run-two',
      'knowledge-run-base', 3, 3, 'knowledge-run-generation', 2, repeat('b', 64), 1536,
      'knowledge-run-connection', 'knowledge-run-model', 'knowledge-run-credential',
      'knowledge-run-credential-version', 'default', '{}'::jsonb
    );
  `, /KnowledgeRunBinding_ordinal_check/u, "out-of-range Knowledge ordinal");
  expectRejected(`
    INSERT INTO "KnowledgeRunBinding" (${bindingColumns}) VALUES (
      'knowledge-run-dimension-invalid', 'knowledge-run-two',
      'knowledge-run-base', 0, 3, 'knowledge-run-generation', 2, repeat('b', 64), 768,
      'knowledge-run-connection', 'knowledge-run-model', 'knowledge-run-credential',
      'knowledge-run-credential-version', 'default', '{}'::jsonb
    );
  `, /KnowledgeRunBinding_dimension_check/u, "unsupported Knowledge dimension");
  expectRejected(`
    INSERT INTO "KnowledgeRunBinding" (${bindingColumns}) VALUES (
      'knowledge-run-duplicate', 'knowledge-run-one', ${bindingTail}
    );
  `, /KnowledgeRunBinding_modelRunId_knowledgeBaseId_key/u, "duplicate base in one run");
  requireSuccess(psql(`
    UPDATE "KnowledgeBase" SET "activeIndexGenerationId" = NULL
    WHERE "id" = 'knowledge-run-base';
    UPDATE "ProviderCredential" SET "activeVersionId" = NULL
    WHERE "id" = 'knowledge-run-credential';
  `), "detach mutable pointers before restrictive evidence checks");
  expectRejected(`DELETE FROM "KnowledgeIndexGeneration" WHERE "id" = 'knowledge-run-generation';`,
    /KnowledgeRunBinding_generation_fkey/u, "deleting accepted generation evidence");
  expectRejected(`DELETE FROM "ProviderCredentialVersion" WHERE "id" = 'knowledge-run-credential-version';`,
    /KnowledgeRunBinding_credentialVersion_fkey/u, "deleting accepted credential evidence");

  requireSuccess(psql(`DELETE FROM "ModelRun" WHERE "id" = 'knowledge-run-one';`),
    "delete accepted run");
  assert.equal(scalar(`SELECT count(*) FROM "KnowledgeRunBinding";`), "0",
    "run deletion must cascade only its owned Knowledge bindings");
}

try {
  main();
  console.log("Knowledge run plan migration contract passed.");
} finally {
  dropDatabase();
}
