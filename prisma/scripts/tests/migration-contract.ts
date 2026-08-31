import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDisposableStatefulDatabaseUrl } from "../../../scripts/stateful-test-target";

const BASELINE = "20260815000000_baseline";
const BASELINE_SHA256 = "71c210d018bf2c56c4003a0a74f5c84dfdea939336c889b04b786444461f5b33";
const EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256 =
  "0bff7efcc322aa98df140584a4fb7ea5cf2eab85198dc656fdea7bba918756e9";
const APPEND_ONLY_PROBE = "20990101000000_append_only_contract_probe";
const KNOWLEDGE_PROFILE_MIGRATION = "20260818023000_knowledge_index_profile";
const KNOWLEDGE_SOURCES_MIGRATION = "20260818043000_knowledge_sources_v2";
const KNOWLEDGE_SNAPSHOT_TRIGGER_FIX =
  "20260818044500_knowledge_snapshot_count_trigger_fix";
const KNOWLEDGE_READ_RECEIPT_MIGRATION = "20260819193000_knowledge_read_receipt";
const KNOWLEDGE_H2_DURABLE_DISPATCH_MIGRATION =
  "20260819223000_knowledge_h2_durable_dispatch";
const KNOWLEDGE_H3_OPERATION_SEMANTICS_MIGRATION =
  "20260819233000_knowledge_h3_operation_semantics";
const KNOWLEDGE_H4_STRATEGY_EXECUTION_MIGRATION =
  "20260820013000_knowledge_h4_strategy_execution";
const KNOWLEDGE_H5_DOCUMENT_CONTEXT_MIGRATION =
  "20260820050000_knowledge_h5_document_context";
const KNOWLEDGE_H6_SEMANTIC_SHADOW_MIGRATION =
  "20260820070000_knowledge_h6_semantic_shadow";
const KNOWLEDGE_H6_SEMANTIC_DEPLOYMENT_MIGRATION =
  "20260820173000_knowledge_h6_semantic_deployment";
const KNOWLEDGE_BASIC_RUNTIME_CLEANUP_MIGRATION =
  "20260821000000_knowledge_basic_runtime_cleanup";
const KNOWLEDGE_TOOL_COEXISTENCE_MIGRATION =
  "20260822020000_knowledge_tool_coexistence_constraints";
const KNOWLEDGE_MAP_REDUCE_LIMITS_MIGRATION =
  "20260826120000_knowledge_map_reduce_result_limits";
const KNOWLEDGE_RANKING_PROFILE_V2_MIGRATION =
  "20260828090000_knowledge_ranking_profile_v2";
const KNOWLEDGE_RERANKER_RECEIPT_V2_MIGRATION =
  "20260828093000_knowledge_reranker_receipt_v2";
const KNOWLEDGE_ANSWER_AUDIT_V21_MIGRATION =
  "20260831030000_knowledge_answer_audit_v21";
const KNOWLEDGE_COVERAGE_SCOPE_V3_MIGRATION =
  "20260831043000_knowledge_coverage_scope_v3";
const KNOWLEDGE_COVERAGE_ATOMS_V4_MIGRATION =
  "20260831060000_knowledge_coverage_atoms_v4";
const KNOWLEDGE_COVERAGE_SPARSE_UNITS_V5_MIGRATION =
  "20260831070000_knowledge_coverage_sparse_units_v5";
const KNOWLEDGE_RETIRED_PURGE_GUARD_MIGRATION =
  "20260822143300_retired_knowledge_purge_guard";
const MEMORY_VNEXT_RETRIEVAL_CUTOVER_MIGRATION =
  "20260824014100_memory_vnext_retrieval_cutover";
const POSTGRES_USER = "aiqsa";
const POSTGRES_SERVICE = "postgres";
const APP_SERVICE = "app";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const composeFile = join(repositoryRoot, "docker-compose.dev.yml");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;

type Mode = "full" | "smoke";
type DatabaseRole = "bootstrap" | "seed" | "shadow" | "smoke";
type CommandResult = Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}>;

function parseMode(args: readonly string[]): Mode {
  assert.equal(
    args.length,
    1,
    "migration contract requires exactly one --mode=smoke or --mode=full argument",
  );
  const match = /^--mode=(smoke|full)$/u.exec(args[0] ?? "");
  assert.ok(match, "migration contract mode must be smoke or full");
  return match[1] as Mode;
}

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function requireSuccess(result: CommandResult, operation: string): string {
  assert.equal(
    result.status,
    0,
    `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function databaseName(role: DatabaseRole): string {
  const prefix = role === "smoke"
    ? "migration_smoke"
    : role === "shadow"
      ? "migration_shadow"
      : `baseline_${role}`;
  return `aiqsa_${prefix}_${runId}`;
}

function assertDisposableDatabase(database: string): void {
  assert.match(
    database,
    /^aiqsa_(?:migration_smoke|migration_shadow|baseline_seed|baseline_bootstrap)_[0-9]+_[0-9]+$/u,
    `refusing unsafe database target: ${database}`,
  );
}

let disposableDatabaseUrlTemplate: URL | undefined;

function databaseUrlTemplate(): URL {
  if (disposableDatabaseUrlTemplate) {
    return disposableDatabaseUrlTemplate;
  }

  const value = requireSuccess(
    compose([
      "exec",
      "-T",
      APP_SERVICE,
      "node",
      "-e",
      "process.stdout.write(process.env.DATABASE_URL ?? '')",
    ]),
    "read disposable app database target",
  );
  assert.equal(
    isDisposableStatefulDatabaseUrl(value),
    true,
    "the disposable app DATABASE_URL does not match the fail-closed stateful target contract",
  );
  disposableDatabaseUrlTemplate = new URL(value);
  return disposableDatabaseUrlTemplate;
}

function databaseUrl(database: string): string {
  assertDisposableDatabase(database);
  const url = new URL(databaseUrlTemplate());
  url.pathname = `/${database}`;
  return url.toString();
}

function postgres(args: string[], operation: string, input?: string): string {
  return requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, ...args], input),
    operation,
  );
}

function createDatabase(database: string): void {
  assertDisposableDatabase(database);
  postgres(
    ["createdb", "--username", POSTGRES_USER, database],
    `create disposable database ${database}`,
  );
}

function dropDatabase(database: string): void {
  assertDisposableDatabase(database);
  postgres(
    ["dropdb", "--if-exists", "--force", "--username", POSTGRES_USER, database],
    `drop disposable database ${database}`,
  );
}

function psqlScalar(database: string, sql: string): string {
  assertDisposableDatabase(database);
  return postgres(
    [
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
      sql,
    ],
    `query disposable database ${database}`,
  );
}

function app(
  database: string,
  command: string[],
  extraEnvironment: Record<string, string> = {},
): string {
  assertDisposableDatabase(database);
  const environment = {
    DATABASE_URL: databaseUrl(database),
    ...extraEnvironment,
  };
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => [
    "-e",
    `${name}=${value}`,
  ]);
  return requireSuccess(
    compose(["exec", "-T", ...environmentArgs, APP_SERVICE, ...command]),
    `${command.join(" ")} against ${database}`,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function committedMigrations(): string[] {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(migrations.length > 0, "committed migration history is empty");
  assert.equal(migrations[0], BASELINE, "the clean baseline must remain the first migration");
  assert.equal(
    sha256(readFileSync(join(migrationsRoot, BASELINE, "migration.sql"))),
    BASELINE_SHA256,
    "the frozen pre-production baseline changed; add an append-only migration instead",
  );
  for (const migration of migrations) {
    assert.match(
      migration,
      /^\d{14}_[A-Za-z0-9][A-Za-z0-9_-]*$/u,
      `invalid migration directory ${migration}`,
    );
    assert.equal(
      existsSync(join(migrationsRoot, migration, "migration.sql")),
      true,
      `migration ${migration} has no migration.sql`,
    );
  }
  return migrations;
}

function deployedMigrations(database: string): string[] {
  const value = psqlScalar(
    database,
    `SELECT COALESCE(
       string_agg(migration_name, E'\\n' ORDER BY migration_name),
       ''
     )
     FROM "_prisma_migrations"
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
  );
  return value === "" ? [] : value.split("\n");
}

function assertDeployedMigrations(database: string, expected: readonly string[]): void {
  assert.deepEqual(
    deployedMigrations(database),
    expected,
    "clean install did not record the complete ordered committed migration set",
  );
  assert.equal(
    psqlScalar(database, 'SELECT count(*) FROM "_prisma_migrations";'),
    String(expected.length),
    "clean install recorded failed, rolled-back, or unexpected migrations",
  );
}

function schemaCatalogDigest(database: string): string {
  assertDisposableDatabase(database);
  const dump = postgres(
    [
      "pg_dump",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--username",
      POSTGRES_USER,
      "--dbname",
      database,
    ],
    `dump schema catalog for ${database}`,
  );
  const normalized = dump
    .split("\n")
    .filter((line) => !/^\\(?:un)?restrict\s/u.test(line))
    .join("\n");
  return sha256(normalized);
}

function deployAndVerify(
  database: string,
  migrations: readonly string[],
  shadowDatabase: string,
): void {
  app(database, ["npx", "prisma", "migrate", "deploy"]);
  assertDeployedMigrations(database, migrations);
  const beforeRepeat = deployedMigrations(database);
  app(database, ["npx", "prisma", "migrate", "deploy"]);
  assert.deepEqual(
    deployedMigrations(database),
    beforeRepeat,
    "repeated migrate deploy changed the applied migration set",
  );
  assert.match(
    app(database, ["npx", "prisma", "migrate", "status"]),
    /Database schema is up to date!/u,
  );
  assert.equal(
    psqlScalar(database, `
      SELECT character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'KnowledgeProviderAttempt'
        AND column_name = 'purpose';
    `),
    "64",
    "Knowledge provider operation identifiers do not fit the active versioned purposes",
  );
  const schemaDatamodelDiff = app(database, [
    "npx",
    "prisma",
    "migrate",
    "diff",
    "--from-migrations",
    "prisma/migrations",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--shadow-database-url",
    databaseUrl(shadowDatabase),
    "--script",
  ]);
  const schemaDatamodelDiffSha256 = sha256(schemaDatamodelDiff);
  if (
    schemaDatamodelDiffSha256 !== EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256 &&
    process.env.AIQSA_PRINT_SCHEMA_DATAMODEL_DIFF === "1"
  ) {
    process.stderr.write("Reviewed SQL-only schema/datamodel delta:\n" +
      schemaDatamodelDiff + "\n");
  }
  assert.equal(
    schemaDatamodelDiffSha256,
    EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256,
    `the reviewed SQL-only schema/datamodel delta changed; received sha256=${schemaDatamodelDiffSha256}`,
  );
  app(database, [
    "npx",
    "prisma",
    "migrate",
    "diff",
    "--exit-code",
    "--from-migrations",
    "prisma/migrations",
    "--to-schema-datasource",
    "prisma/schema.prisma",
    "--shadow-database-url",
    databaseUrl(shadowDatabase),
  ]);
}

function runIntegrityProof(database: string): void {
  const unvalidatedConstraints = psqlScalar(database, `
    SELECT COALESCE(
      string_agg(
        table_relation.relname || '.' || constraint_catalog.conname,
        E'\\n'
        ORDER BY table_relation.relname, constraint_catalog.conname
      ),
      ''
    )
    FROM pg_constraint AS constraint_catalog
    INNER JOIN pg_class AS table_relation
      ON table_relation.oid = constraint_catalog.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = constraint_catalog.connamespace
    WHERE namespace.nspname = current_schema()
      AND NOT constraint_catalog.convalidated;
  `);
  assert.equal(
    unvalidatedConstraints,
    "",
    "clean install retained an unvalidated constraint",
  );
  app(database, ["npx", "tsx", "prisma/schema-integrity-smoke.ts"]);
}

function runSeedProof(database: string): void {
  const testEnvironment = {
    AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
    AIQSA_TEST_MODE: "1",
    NODE_ENV: "development",
  };
  app(database, ["npx", "prisma", "db", "seed"], testEnvironment);
  app(database, ["npx", "prisma", "db", "seed"], testEnvironment);
  app(
    database,
    ["npx", "tsx", "prisma/seed-smoke.ts", "--expect-empty-workspace"],
    testEnvironment,
  );
  runIntegrityProof(database);
}

function bootstrapFoundationDigest(database: string): string {
  return psqlScalar(
    database,
    `SELECT md5(jsonb_build_object(
      'users', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, email, "displayName", role, status) ORDER BY id)
        FROM "User"
      ), '[]'::jsonb),
      'identities', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "userId", provider, "providerAccountId", "normalizedEmail", "emailVerifiedAt" IS NOT NULL) ORDER BY id)
        FROM "AuthIdentity"
      ), '[]'::jsonb),
      'groups', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, name, "systemRole", "archivedAt") ORDER BY id)
        FROM "Group"
      ), '[]'::jsonb),
      'memberships', COALESCE((
        SELECT jsonb_agg(jsonb_build_array("userId", "groupId", role) ORDER BY "userId", "groupId")
        FROM "UserGroup"
      ), '[]'::jsonb),
      'settings', COALESCE((
        SELECT jsonb_agg(to_jsonb(settings) - 'createdAt' - 'updatedAt' ORDER BY settings."userId")
        FROM "UserSettings" AS settings
      ), '[]'::jsonb),
      'memory_settings', COALESCE((
        SELECT jsonb_agg(to_jsonb(settings) - 'updatedAt' ORDER BY settings."userId")
        FROM "UserMemorySettings" AS settings
      ), '[]'::jsonb),
      'mcp_grants', COALESCE((
        SELECT jsonb_agg(jsonb_build_array("serverId", "userId", "groupId", "canUse", "personalSlotKeys") ORDER BY "serverId", id)
        FROM "McpGrant"
      ), '[]'::jsonb),
      'model_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(
          id,
          "defaultProviderModelId",
          "memoryAdmissionTimeoutSeconds",
          version,
          "updatedByUserId"
        ) ORDER BY id)
        FROM "ModelPolicy"
      ), '[]'::jsonb),
      'system_model_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "providerModelId", "reasoningEffort", version, "updatedByUserId") ORDER BY id)
        FROM "SystemModelPolicy"
      ), '[]'::jsonb)
    )::text);`,
  );
}

function runBootstrapProof(database: string): void {
  const bootstrapEnvironment = {
    AIQSA_INITIAL_ADMIN_DISPLAY_NAME: "Baseline Administrator",
    AIQSA_INITIAL_ADMIN_EMAIL: "baseline-admin@example.invalid",
    AIQSA_INITIAL_ADMIN_PASSWORD: "Baseline-contract-password-123!",
    NODE_ENV: "production",
  };
  const first = app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.match(first, /installation bootstrap created:/u);
  const freshDigest = bootstrapFoundationDigest(database);
  const repeat = app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.match(repeat, /installation bootstrap already_adopted:/u);
  assert.equal(
    bootstrapFoundationDigest(database),
    freshDigest,
    "adopted bootstrap changed the settled fresh-install foundation",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*) FROM "User"
       WHERE email = 'baseline-admin@example.invalid'
         AND role = 'admin' AND status = 'active';`,
    ),
    "1",
    "bootstrap did not preserve one active administrator",
  );
}

function runAppendOnlyMigrationProbe(
  database: string,
  committed: readonly string[],
): void {
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "migration-contract-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");
  const probeMigration = join(probeMigrations, APPEND_ONLY_PROBE);

  try {
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    cpSync(migrationsRoot, probeMigrations, { recursive: true });
    mkdirSync(probeMigration);
    writeFileSync(
      join(probeMigration, "migration.sql"),
      'CREATE TABLE "__AIQSAAppendOnlyMigrationProbe" ("id" integer PRIMARY KEY);\n',
      { mode: 0o600 },
    );
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);
    assertDeployedMigrations(database, [...committed, APPEND_ONLY_PROBE]);
    assert.match(
      app(database, ["npx", "prisma", "migrate", "status", "--schema", containerSchema]),
      /Database schema is up to date!/u,
    );
    assert.equal(
      psqlScalar(
        database,
        `SELECT to_regclass('public."__AIQSAAppendOnlyMigrationProbe"') IS NOT NULL;`,
      ),
      "t",
      "synthetic append-only migration did not apply its probe relation",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeProfileBackfillProof(
  database: string,
  committed: readonly string[],
): void {
  const profileIndex = committed.indexOf(KNOWLEDGE_PROFILE_MIGRATION);
  assert.ok(profileIndex > 0, "Knowledge profile migration is missing from ordered history");
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "knowledge-profile-backfill-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, profileIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), { recursive: true });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    const fingerprint = "a".repeat(64);
    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('knowledge-profile-owner', 'Fixture owner', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "ProviderConnection" (
        id, "displayName", family, enabled, "activeConfig", "activeVersion", "activatedAt", "updatedAt"
      ) VALUES (
        'knowledge-profile-connection', 'Fixture embeddings', 'openai_compatible', true,
        '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "ProviderModel" (
        id, "connectionId", provider, "modelId", "displayName", "modelClass",
        "activeConfig", "activeVersion", "activatedAt", capabilities, "defaultParams", "updatedAt"
      ) VALUES (
        'knowledge-profile-model', 'knowledge-profile-connection', 'openai_compatible',
        'fixture-embed', 'Fixture embed', 'embedding',
        '{"schemaVersion":1}'::jsonb, 1, CURRENT_TIMESTAMP, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeBase" (
        id, "ownerUserId", name, "updatedAt"
      ) VALUES (
        'knowledge-profile-base', 'knowledge-profile-owner', 'Fixture base', CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeIndexGeneration" (
        id, "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
        "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
        "indexedContentRevision", status, "readyAt", "activatedAt", "updatedAt"
      ) VALUES (
        'knowledge-profile-generation', 'knowledge-profile-base', 'knowledge-profile-model',
        '{"schemaVersion":1}'::jsonb, '${fingerprint}', 1024, 1, 0, 'active',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      UPDATE "KnowledgeBase"
      SET "activeIndexGenerationId" = 'knowledge-profile-generation'
      WHERE id = 'knowledge-profile-base';
      SELECT 'fixture-ready';
    `);

    cpSync(
      join(migrationsRoot, KNOWLEDGE_PROFILE_MIGRATION),
      join(probeMigrations, KNOWLEDGE_PROFILE_MIGRATION),
      { recursive: true },
    );
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM "KnowledgeIndexGeneration" AS generation
        INNER JOIN "KnowledgeIndexProfileRevision" AS revision
          ON revision.id = generation."profileRevisionId"
        INNER JOIN "KnowledgeIndexProfile" AS profile
          ON profile."activeRevisionId" = revision.id
        WHERE generation.id = 'knowledge-profile-generation'
          AND generation."knowledgeBaseId" = 'knowledge-profile-base'
          AND revision."executionAuthority" = 'legacy_user'
          AND revision."embeddingProviderModelId" = generation."embeddingProviderModelId"
          AND btrim(revision."vectorSpaceFingerprint") = btrim(generation."vectorSpaceFingerprint")
          AND revision."targetDimension" = generation."targetDimension"
          AND revision."chunkingProfileVersion" = generation."chunkingProfileVersion";
      `),
      "1",
      "Knowledge profile migration did not preserve and identify the active legacy generation",
    );
    const mutation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeIndexProfileRevision" SET "targetDimension" = 1536;`,
    ]);
    assert.notEqual(mutation.status, 0, "activated Knowledge profile revision was mutable");
    assert.match(
      `${mutation.stdout}\n${mutation.stderr}`,
      /knowledge_index_profile_revision_immutable/u,
      "profile immutability failure was not stable",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeSourceMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const sourceIndex = committed.indexOf(KNOWLEDGE_SOURCES_MIGRATION);
  const triggerFixIndex = committed.indexOf(KNOWLEDGE_SNAPSHOT_TRIGGER_FIX);
  assert.ok(sourceIndex > 0, "Knowledge Source migration is missing from ordered history");
  assert.equal(
    triggerFixIndex,
    sourceIndex + 1,
    "Knowledge snapshot trigger fix must immediately follow the Source migration",
  );
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "knowledge-source-migration-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, sourceIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('knowledge-source-owner', 'Source fixture owner', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeBase" (id, "ownerUserId", name, "updatedAt")
      VALUES ('knowledge-source-base', 'knowledge-source-owner', 'Source fixture', CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeDocument" (id, "knowledgeBaseId", "updatedAt")
      VALUES ('knowledge-source-document', 'knowledge-source-base', CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeDocumentVersion" (
        id, "knowledgeBaseId", "documentId", "ownerUserId", "versionNumber",
        "fileName", "mimeType", "byteSize", checksum, "ingestState", "updatedAt"
      ) VALUES (
        'knowledge-source-document-version', 'knowledge-source-base',
        'knowledge-source-document', 'knowledge-source-owner', 1,
        'source.md', 'text/markdown', 16, '${"a".repeat(64)}', 'ready', CURRENT_TIMESTAMP
      );
      UPDATE "KnowledgeDocument"
      SET "currentVersionId" = 'knowledge-source-document-version'
      WHERE id = 'knowledge-source-document';
      SELECT 'fixture-ready';
    `);

    for (const migration of committed.slice(sourceIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM "KnowledgeDocument" AS document
        INNER JOIN "KnowledgeDocumentVersion" AS version
          ON version.id = document."currentVersionId"
        WHERE document.id = 'knowledge-source-document'
          AND version.id = 'knowledge-source-document-version';
      `),
      "1",
      "Knowledge Source migration changed existing V1 document identity",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT
          (SELECT count(*) FROM "KnowledgeSource") +
          (SELECT count(*) FROM "KnowledgeV1DocumentSourceMap") +
          (SELECT count(*) FROM "KnowledgeBaseSnapshot");
      `),
      "0",
      "Knowledge Source migration must remain content-free and resumable in application code",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'KnowledgeRunBinding'
          AND column_name = 'knowledgeBaseSnapshotId'
          AND is_nullable = 'YES';
      `),
      "1",
      "V1 accepted run bindings did not retain a nullable snapshot bridge",
    );

    psqlScalar(database, `
      INSERT INTO "KnowledgeSource" (
        id, "ownerUserId", name, "updatedAt"
      ) VALUES (
        'knowledge-source-proof', 'knowledge-source-owner', 'Immutable proof', CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeSourceVersion" (
        id, "sourceId", "ownerUserId", "versionNumber", "fileName", "mimeType",
        "byteSize", checksum
      ) VALUES (
        'knowledge-source-version-proof', 'knowledge-source-proof', 'knowledge-source-owner',
        1, 'proof.md', 'text/markdown', 16, '${"b".repeat(64)}'
      );
      UPDATE "KnowledgeSource"
      SET "currentVersionId" = 'knowledge-source-version-proof'
      WHERE id = 'knowledge-source-proof';
      SELECT 'source-ready';
    `);
    const mutation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeSourceVersion" SET "fileName" = 'changed.md';`,
    ]);
    assert.notEqual(mutation.status, 0, "Knowledge Source Version was mutable");
    assert.match(
      `${mutation.stdout}\n${mutation.stderr}`,
      /knowledge_source_version_immutable/u,
      "Source Version immutability failure was not stable",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeReadReceiptMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const receiptIndex = committed.indexOf(KNOWLEDGE_READ_RECEIPT_MIGRATION);
  assert.ok(receiptIndex > 0, "Knowledge read receipt migration is missing from ordered history");
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "knowledge-read-receipt-migration-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, receiptIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('knowledge-read-owner', 'Read receipt owner', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "Chat" (id, "userId", title, "updatedAt")
      VALUES ('knowledge-read-chat', 'knowledge-read-owner', 'Legacy read receipt', CURRENT_TIMESTAMP);
      INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
      VALUES ('knowledge-read-message', 'knowledge-read-chat', 'user', '{}'::jsonb, CURRENT_TIMESTAMP);
      INSERT INTO "ModelRun" (
        id, "chatId", "userId", "userMessageId", provider, "modelId", status,
        "normalizedRequest", "updatedAt"
      ) VALUES (
        'knowledge-read-run', 'knowledge-read-chat', 'knowledge-read-owner',
        'knowledge-read-message', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
        CURRENT_TIMESTAMP
      );
      INSERT INTO "ModelRunToolCall" (
        id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
        arguments, state, "startedAt", "completedAt", "updatedAt"
      ) VALUES (
        'knowledge-read-call', 'knowledge-read-run', 0, 0, 'knowledge-read-provider-call',
        'read_source', '{"query":"page 1"}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
        "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
      ) VALUES (
        'knowledge-read-operation', 'knowledge-read-run', 'knowledge-read-call', 4,
        'read_source', 'page 1', 'base_empty', 'rrf_k60', 8, 8, 0, 0.01,
        '[{"baseName":"Legacy read Base","ordinal":0}]'::jsonb, '[]'::jsonb,
        'Knowledge retrieval returned no indexed passages: base_empty.', '[]'::jsonb,
        1, CURRENT_TIMESTAMP
      );
      SELECT 'legacy-read-ready';
    `);

    for (const migration of committed.slice(receiptIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM "KnowledgeRun"
        WHERE id = 'knowledge-read-operation'
          AND operation = 'read_source'
          AND query = 'page 1'
          AND "invocationOrdinal" = 4
          AND "readReceipt" IS NULL;
      `),
      "1",
      "Knowledge read receipt migration changed or reinterpreted a legacy operation",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM pg_constraint
        WHERE conname = 'KnowledgeRun_read_receipt_operation_check'
          AND conrelid = '"KnowledgeRun"'::regclass
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%knowledge_read_source_receipt_valid_v2%'
          AND pg_get_constraintdef(oid) LIKE '%knowledge_exact_receipt_valid%'
          AND pg_get_constraintdef(oid) LIKE '%knowledge_discovery_receipt_valid%'
          AND pg_get_constraintdef(oid) NOT LIKE '%threshold%';
      `),
      "1",
      "Current threshold-free read receipt constraint is missing or unvalidated",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT knowledge_read_receipt_canonical_locator(
          '{"kind":"heading","headingPath":["Lab","Results"]}'::jsonb
        );
      `),
      "heading: Lab › Results",
      "Knowledge read receipt canonical heading locator is not deterministic",
    );
    psqlScalar(database, `
      UPDATE "KnowledgeRun"
      SET "readReceipt" = jsonb_build_object(
        'contractVersion', 1,
        'direction', 'around',
        'embedding', 'forbidden',
        'locator', 'page 1',
        'resolution', 'exact',
        'resolvedSource', jsonb_build_object(
          'sourceAlias', 'S1',
          'sourceArtifactId', 'knowledge-read-artifact',
          'sourceId', 'knowledge-read-source',
          'sourceName', 'Legacy read Source',
          'sourceVersionId', 'knowledge-read-source-version'
        ),
        'target', jsonb_build_object('kind', 'page', 'page', 1),
        'version', 1,
        'window', 3
      )
      WHERE id = 'knowledge-read-operation';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM "KnowledgeRun"
        WHERE id = 'knowledge-read-operation'
          AND "readReceipt" #>> '{resolvedSource,sourceVersionId}' =
            'knowledge-read-source-version';
      `),
      "1",
      "Knowledge read receipt constraint rejected the current populated contract",
    );
    const mismatchedLocatorTarget = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET "readReceipt" = jsonb_set(
          "readReceipt",
          '{target,page}',
          '2'::jsonb
        )
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      mismatchedLocatorTarget.status,
      0,
      "Knowledge read receipt accepted a locator that disagrees with its exact target",
    );
    assert.match(
      `${mismatchedLocatorTarget.stdout}\n${mismatchedLocatorTarget.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Mismatched Knowledge read locator did not fail with the stable constraint",
    );
    const missingRequiredField = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET "readReceipt" = "readReceipt" - 'version'
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      missingRequiredField.status,
      0,
      "Knowledge read receipt accepted a missing required field",
    );
    assert.match(
      `${missingRequiredField.stdout}\n${missingRequiredField.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Malformed Knowledge read receipt did not fail with the stable constraint",
    );
    const extraTopLevelField = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET "readReceipt" = "readReceipt" || '{"privateDebug":"forbidden"}'::jsonb
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      extraTopLevelField.status,
      0,
      "Knowledge read receipt accepted an unversioned extra field",
    );
    assert.match(
      `${extraTopLevelField.stdout}\n${extraTopLevelField.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Extra Knowledge read receipt field did not fail with the stable constraint",
    );
    const invalidHeadingElement = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET "readReceipt" = jsonb_set(
          "readReceipt",
          '{target}',
          '{"kind":"heading","headingPath":["Policy",7]}'::jsonb
        )
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      invalidHeadingElement.status,
      0,
      "Knowledge read receipt accepted a non-string heading path entry",
    );
    assert.match(
      `${invalidHeadingElement.stdout}\n${invalidHeadingElement.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Malformed Knowledge heading path did not fail with the stable constraint",
    );
    const invalidTargetKind = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET "readReceipt" = jsonb_set(
          "readReceipt",
          '{target}',
          '{"kind":"semantic_query"}'::jsonb
        )
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      invalidTargetKind.status,
      0,
      "Knowledge read receipt accepted an unsupported target kind",
    );
    assert.match(
      `${invalidTargetKind.stdout}\n${invalidTargetKind.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Unsupported Knowledge read target did not fail with the stable constraint",
    );
    const mismatchedOperation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        UPDATE "KnowledgeRun"
        SET operation = 'automatic_search'
        WHERE id = 'knowledge-read-operation';
      `,
    ]);
    assert.notEqual(
      mismatchedOperation.status,
      0,
      "Knowledge read receipt was accepted for a non-read operation",
    );
    assert.match(
      `${mismatchedOperation.stdout}\n${mismatchedOperation.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      "Knowledge read receipt operation mismatch did not fail with the stable constraint",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeH2DurableDispatchMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const h2Index = committed.indexOf(KNOWLEDGE_H2_DURABLE_DISPATCH_MIGRATION);
  assert.ok(h2Index > 0, "Knowledge H2 durable dispatch migration is missing");
  const h3Index = committed.indexOf(KNOWLEDGE_H3_OPERATION_SEMANTICS_MIGRATION);
  assert.ok(h3Index > h2Index, "Knowledge H3 operation semantics migration is missing");
  const answerAuditV21Index = committed.indexOf(KNOWLEDGE_ANSWER_AUDIT_V21_MIGRATION);
  assert.ok(
    answerAuditV21Index > h3Index,
    "Knowledge answer Audit V21 migration is missing",
  );
  const coverageScopeV3Index = committed.indexOf(KNOWLEDGE_COVERAGE_SCOPE_V3_MIGRATION);
  assert.ok(
    coverageScopeV3Index > answerAuditV21Index,
    "Knowledge Coverage Scope V3 migration is missing",
  );
  const coverageAtomsV4Index = committed.indexOf(KNOWLEDGE_COVERAGE_ATOMS_V4_MIGRATION);
  assert.ok(
    coverageAtomsV4Index > coverageScopeV3Index,
    "Knowledge Coverage atom review V4 migration is missing",
  );
  const coverageSparseUnitsV5Index = committed.indexOf(
    KNOWLEDGE_COVERAGE_SPARSE_UNITS_V5_MIGRATION,
  );
  assert.ok(
    coverageSparseUnitsV5Index > coverageAtomsV4Index,
    "Knowledge Coverage sparse unit map V5 migration is missing",
  );
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "knowledge-h2-migration-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, h2Index)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('knowledge-h2-owner', 'H2 owner', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES
        ('knowledge-h2-chat-1', 'knowledge-h2-owner', 'H2 primary', CURRENT_TIMESTAMP),
        ('knowledge-h2-chat-2', 'knowledge-h2-owner', 'H2 secondary', CURRENT_TIMESTAMP);
      INSERT INTO "Message" (id, "chatId", role, content, "updatedAt") VALUES
        ('knowledge-h2-message-1', 'knowledge-h2-chat-1', 'user', '{}'::jsonb, CURRENT_TIMESTAMP),
        ('knowledge-h2-message-2', 'knowledge-h2-chat-2', 'user', '{}'::jsonb, CURRENT_TIMESTAMP);
      INSERT INTO "ModelRun" (
        id, "chatId", "userId", "userMessageId", provider, "modelId", status,
        "normalizedRequest", "updatedAt"
      ) VALUES
        ('knowledge-h2-run-1', 'knowledge-h2-chat-1', 'knowledge-h2-owner',
         'knowledge-h2-message-1', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
         CURRENT_TIMESTAMP),
        ('knowledge-h2-run-2', 'knowledge-h2-chat-2', 'knowledge-h2-owner',
         'knowledge-h2-message-2', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
         CURRENT_TIMESTAMP);
      INSERT INTO "ModelRunToolCall" (
        id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
        arguments, state, "startedAt", "completedAt", "updatedAt"
      ) VALUES
        ('knowledge-h2-call-1', 'knowledge-h2-run-1', 0, 0, 'knowledge-h2-provider-call-1',
         'retrieve_knowledge', '{"operation":"automatic_search","query":"policy"}'::jsonb,
         'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h2-call-2', 'knowledge-h2-run-1', 0, 1, 'knowledge-h2-provider-call-2',
         'discover_sources', '{"query":"policy two"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h2-call-3', 'knowledge-h2-run-1', 0, 2, 'knowledge-h2-provider-call-3',
         'discover_sources', '{"query":"policy three"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-structured', 'knowledge-h2-run-1', 0, 3,
         'knowledge-h3-provider-call-structured', 'retrieve_knowledge',
         '{"operation":"structured_analysis"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-visual', 'knowledge-h2-run-1', 0, 4,
         'knowledge-h3-provider-call-visual', 'retrieve_knowledge',
         '{"operation":"visual_analysis"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-exact', 'knowledge-h2-run-1', 0, 5,
         'knowledge-h3-provider-call-exact', 'retrieve_knowledge',
         '{"operation":"find_exact"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-discovery', 'knowledge-h2-run-1', 0, 6,
         'knowledge-h3-provider-call-discovery', 'retrieve_knowledge',
         '{"operation":"discover_sources"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-exact-tombstone', 'knowledge-h2-run-1', 0, 7,
         'knowledge-h3-provider-call-exact-tombstone', 'retrieve_knowledge',
         '{"operation":"find_exact"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-discovery-tombstone', 'knowledge-h2-run-1', 0, 8,
         'knowledge-h3-provider-call-discovery-tombstone', 'retrieve_knowledge',
         '{"operation":"discover_sources"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h3-call-discovery-zero-tombstone', 'knowledge-h2-run-1', 0, 9,
         'knowledge-h3-provider-call-discovery-zero-tombstone', 'retrieve_knowledge',
         '{"operation":"discover_sources"}'::jsonb, 'complete', CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
        "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
      ) VALUES (
        'knowledge-h2-operation', 'knowledge-h2-run-1', 'knowledge-h2-call-1', 1,
        'automatic_search', 'policy', 'base_empty', 'rrf_k60', 1, 1, 0, 0.01,
        '[{"baseName":"Legacy H2 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
        'No matching Source metadata.', '[]'::jsonb,
        1, CURRENT_TIMESTAMP
      );
      SELECT 'knowledge-h2-pre-migration-ready';
    `);

    for (const migration of committed.slice(h2Index)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeRun"
        WHERE id = 'knowledge-h2-operation'
          AND "receiptVersion" IS NULL
          AND "budgetReservationId" IS NULL;
      `),
      "1",
      "H2 migration reinterpreted a legacy Knowledge receipt",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'KnowledgeRun_receipt_version_check',
          'KnowledgeBudgetReservation_state_check',
          'KnowledgeProviderAttempt_state_check',
          'KnowledgeRun_budget_receipt_settled'
        ) AND convalidated;
      `),
      "4",
      "H2 durable receipt/state constraints are missing or unvalidated",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeProviderAttempt"'::regclass
          AND conname IN (
            'KnowledgeProviderAttempt_contract_check',
            'KnowledgeProviderAttempt_answer_result_state_check'
          )
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%knowledge_coverage_planner_v20%';
      `),
      "2",
      "Coverage Planner V20 is missing from durable provider-attempt constraints",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'KnowledgeProviderAttempt_modelRunId_purpose_key'
          AND indexdef LIKE '%knowledge_coverage_planner_v20%';
      `),
      "1",
      "Coverage Planner V20 is missing from provider-attempt operation uniqueness",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%16%';
      `),
      "1",
      "Grounding Evidence V16 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeProviderAttempt"'::regclass
          AND conname IN (
            'KnowledgeProviderAttempt_contract_check',
            'KnowledgeProviderAttempt_answer_result_state_check'
          )
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%knowledge_coverage_auditor_v[12]%';
      `),
      "2",
      "Audited V21 operations are missing from durable provider-attempt constraints",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'KnowledgeProviderAttempt_v21_auditor_request_key'
          AND indexdef LIKE '%knowledge_coverage_auditor_v[12]%';
      `),
      "1",
      "Audited V21 request uniqueness is missing",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'KnowledgeProviderAttempt_v21_selector_request_key'
          AND indexdef LIKE '%knowledge_grounded_selector_v17%';
      `),
      "1",
      "V21 Selector repair request uniqueness is missing",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%17%';
      `),
      "1",
      "Grounding Evidence V17 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%18%';
      `),
      "1",
      "Grounding Evidence V18 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeProviderAttempt"'::regclass
          AND conname IN (
            'KnowledgeProviderAttempt_contract_check',
            'KnowledgeProviderAttempt_answer_result_state_check'
          )
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%knowledge_coverage_scope_v[3-6]%'
          AND pg_get_constraintdef(oid) LIKE '%knowledge_grounded_selector%2[01]%';
      `),
      "2",
      "Positive-finding Scope V6 and Selector V21 are missing from durable constraints",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'KnowledgeProviderAttempt_v21_scope_request_key',
            'KnowledgeProviderAttempt_v21_selector_v18_request_key',
            'KnowledgeProviderAttempt_v21_scope_v4_request_key',
            'KnowledgeProviderAttempt_v21_selector_v19_request_key',
            'KnowledgeProviderAttempt_v21_scope_v5_request_key',
            'KnowledgeProviderAttempt_v21_selector_v20_request_key',
            'KnowledgeProviderAttempt_v21_scope_v6_request_key',
            'KnowledgeProviderAttempt_v21_selector_v21_request_key'
          );
      `),
      "8",
      "Scope V3/V4/V5/V6 structural-repair request uniqueness is missing",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%19%';
      `),
      "1",
      "Grounding Evidence V19 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%20%';
      `),
      "1",
      "Grounding Evidence V20 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%21%';
      `),
      "1",
      "Grounding Evidence V21 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
          AND conname = 'KnowledgeGroundingResult_evidence_version_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%22%';
      `),
      "1",
      "Grounding Evidence V22 is missing from the durable evidence constraint",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'KnowledgeRun_evidence_shape_check',
          'KnowledgeRun_limits_check',
          'KnowledgeRun_negative_outcome_check',
          'KnowledgeRun_outcome_shape_check',
          'KnowledgeRun_read_receipt_operation_check'
        );
      `),
      "5",
      "H3 purpose receipt and tombstone constraints are missing after cleanup",
    );

    const oneSidedReceipt = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun" SET "receiptVersion" = 2
        WHERE id = 'knowledge-h2-operation';`,
    ]);
    assert.notEqual(oneSidedReceipt.status, 0, "H2 accepted a receipt without a reservation");
    assert.match(
      `${oneSidedReceipt.stdout}\n${oneSidedReceipt.stderr}`,
      /KnowledgeRun_receipt_version_check/u,
      "One-sided H2 receipt failed without the stable constraint",
    );

    psqlScalar(database, `
      INSERT INTO "KnowledgeBudgetReservation" (
        id, "modelRunId", "modelRunToolCallId", "operationOrdinal", "phaseOrdinal",
        "subqueryOrdinal", operation, "policyVersion", "idempotencyKey",
        "operationRequest", "operationRequestHash", state,
        "estimatedCandidates", "estimatedRetrievedTokens", "estimatedEmbeddingCalls",
        "estimatedLatencyMs", "estimatedCostMicros", "leaseToken",
        "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES
        (
          'knowledge-h2-reservation-1', 'knowledge-h2-run-1', 'knowledge-h2-call-1',
          1, 0, 0, 'automatic_search', 1, 'knowledge-h2-reservation-key-1',
          jsonb_build_object(
            'version', 2, 'reservationId', 'knowledge-h2-reservation-1',
            'idempotencyKey', 'knowledge-h2-reservation-key-1',
            'operation', 'automatic_search', 'phaseOrdinal', 0, 'subqueryOrdinal', 0
          ), repeat('a', 64), 'reserved', 1, 1, 0, 10, 0,
          'knowledge-h2-lease-1', CURRENT_TIMESTAMP + interval '5 minutes',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-h2-reservation-2', 'knowledge-h2-run-1', 'knowledge-h2-call-2',
          2, 0, 1, 'discover_sources', 1, 'knowledge-h2-reservation-key-2',
          jsonb_build_object(
            'version', 2, 'reservationId', 'knowledge-h2-reservation-2',
            'idempotencyKey', 'knowledge-h2-reservation-key-2',
            'operation', 'discover_sources', 'phaseOrdinal', 0, 'subqueryOrdinal', 1
          ), repeat('b', 64), 'reserved', 1, 1, 0, 10, 0,
          'knowledge-h2-lease-2', CURRENT_TIMESTAMP + interval '5 minutes',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-h2-reservations-ready';
    `);
    for (const [operation, suffix, toolCallId, ordinal, subqueryOrdinal] of [
      ["structured_analysis", "structured", "knowledge-h3-call-structured", 4, 3],
      ["visual_analysis", "visual", "knowledge-h3-call-visual", 5, 4],
    ] as const) {
      const retiredReservation = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", `
          INSERT INTO "KnowledgeBudgetReservation" (
            id, "modelRunId", "modelRunToolCallId", "operationOrdinal", "phaseOrdinal",
            "subqueryOrdinal", operation, "policyVersion", "idempotencyKey",
            "operationRequest", "operationRequestHash", state,
            "estimatedCandidates", "estimatedRetrievedTokens", "estimatedEmbeddingCalls",
            "estimatedLatencyMs", "estimatedCostMicros", "leaseToken",
            "leaseExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            'knowledge-h3-reservation-${suffix}', 'knowledge-h2-run-1',
            '${toolCallId}', ${ordinal}, 0, ${subqueryOrdinal}, '${operation}', 1,
            'knowledge-h3-reservation-key-${suffix}',
            jsonb_build_object(
              'version', 2, 'reservationId', 'knowledge-h3-reservation-${suffix}',
              'idempotencyKey', 'knowledge-h3-reservation-key-${suffix}',
              'operation', '${operation}', 'phaseOrdinal', 0,
              'subqueryOrdinal', ${subqueryOrdinal}
            ), repeat('e', 64), 'reserved', 1, 1, 0, 10, 0,
            'knowledge-h3-lease-${suffix}', CURRENT_TIMESTAMP + interval '5 minutes',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
        `,
      ]);
      assert.notEqual(
        retiredReservation.status,
        0,
        `Basic cleanup accepted a new ${operation} reservation`,
      );
      assert.match(
        `${retiredReservation.stdout}\n${retiredReservation.stderr}`,
        /KnowledgeBudgetReservation_basic_operation_check/u,
        `Retired ${operation} reservation failed without the Basic operation fence`,
      );
    }
    const h3ReceiptInsert = (values: string): string => `
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
        "baseEvidence", results, "providerText", "embeddingUsage", "readReceipt",
        "durationMs", "updatedAt"
      ) VALUES ${values};
    `;
    const malformedH3Receipts = [
      {
        label: "find_exact",
        values: `(
          'knowledge-h3-receipt-exact', 'knowledge-h2-run-1',
          'knowledge-h3-call-exact', 6, 'find_exact', 'policy',
          'complete', 'none', 2, 2, 1,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb, '[{"handle":"K1"}]'::jsonb,
          'Exact match.', '[]'::jsonb,
          '{"caseMode":"insensitive","cursor":null,"field":"filename","limit":2,"match":"token","matches":[{"field":"filename","resultOrdinal":0}],"nextCursor":null,"scannedBytes":0,"scanTruncated":false,"unexpected":true,"value":"policy","version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        )`,
      },
      {
        label: "discover_sources",
        values: `(
          'knowledge-h3-receipt-discovery', 'knowledge-h2-run-1',
          'knowledge-h3-call-discovery', 7, 'discover_sources', 'policy',
          'complete', 'none', 2, 2, 1,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
          'Source metadata match.', '[]'::jsonb,
          '{"cursor":null,"fields":["filename"],"limit":2,"nextCursor":null,"query":"policy","sources":[{"ambiguous":false,"fileName":"policy.txt","matchedFields":["filename"],"readiness":"ready","sourceAlias":"S1","sourceName":"Policy","sourceVersionNumber":1}],"unexpected":true,"version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        )`,
      },
    ] as const;
    for (const malformed of malformedH3Receipts) {
      const rejected = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", h3ReceiptInsert(malformed.values),
      ]);
      assert.notEqual(
        rejected.status,
        0,
        `H3 accepted a malformed ${malformed.label} receipt`,
      );
      assert.match(
        `${rejected.stdout}\n${rejected.stderr}`,
        /KnowledgeRun_read_receipt_operation_check/u,
        `Malformed ${malformed.label} receipt failed without the H3 receipt constraint`,
      );
    }
    for (const [operation, values] of [
      [
        "structured_analysis",
        `(
          'knowledge-h3-receipt-structured', 'knowledge-h2-run-1',
          'knowledge-h3-call-structured', 4, 'structured_analysis', 'sum revenue',
          'structured_clarification_required', 'rrf_k60', 40, 8, 0,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
          'Clarification required.', '[]'::jsonb,
          '{"question":"Choose Sales or Forecast.","status":"needs_clarification","version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        )`,
      ],
      [
        "visual_analysis",
        `(
          'knowledge-h3-receipt-visual', 'knowledge-h2-run-1',
          'knowledge-h3-call-visual', 5, 'visual_analysis', 'describe chart',
          'complete', 'rrf_k60', 40, 8, 1,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb,
          '[{"visualAnalysis":{"status":"available"}}]'::jsonb,
          'Visual analysis available.', '[]'::jsonb,
          '{"status":"available","version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        )`,
      ],
    ] as const) {
      const retiredReceipt = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", h3ReceiptInsert(values),
      ]);
      assert.notEqual(
        retiredReceipt.status,
        0,
        `Basic cleanup accepted a new ${operation} receipt`,
      );
      assert.match(
        `${retiredReceipt.stdout}\n${retiredReceipt.stderr}`,
        /KnowledgeRun_read_receipt_operation_check/u,
        `Retired ${operation} receipt failed without the Basic operation fence`,
      );
    }
    const malformedH3Tombstones = [
      {
        constraint: /KnowledgeRun_limits_check/u,
        label: "find_exact legacy limits",
        values: `(
          'knowledge-h3-tombstone-exact', 'knowledge-h2-run-1',
          'knowledge-h3-call-exact-tombstone', 8, 'find_exact', 'deleted',
          'complete', 'rrf_k60', 8, 8, 1,
          '[{"baseName":"Deleted Knowledge","ordinal":0}]'::jsonb,
          '[{"deleted":true}]'::jsonb, 'Knowledge evidence was deleted.', '[]'::jsonb,
          NULL, 1, CURRENT_TIMESTAMP
        )`,
      },
      {
        constraint: /KnowledgeRun_outcome_shape_check/u,
        label: "discover_sources nonempty results",
        values: `(
          'knowledge-h3-tombstone-discovery', 'knowledge-h2-run-1',
          'knowledge-h3-call-discovery-tombstone', 9, 'discover_sources', 'deleted',
          'complete', 'none', 8, 8, 1,
          '[{"baseName":"Deleted Knowledge","ordinal":0}]'::jsonb,
          '[{"deleted":true}]'::jsonb, 'Knowledge evidence was deleted.', '[]'::jsonb,
          NULL, 1, CURRENT_TIMESTAMP
        )`,
      },
    ] as const;
    for (const malformed of malformedH3Tombstones) {
      const rejected = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", h3ReceiptInsert(malformed.values),
      ]);
      assert.notEqual(
        rejected.status,
        0,
        `H3 accepted malformed ${malformed.label} tombstone shape`,
      );
      assert.match(
        `${rejected.stdout}\n${rejected.stderr}`,
        malformed.constraint,
        `Malformed ${malformed.label} tombstone missed its operation constraint`,
      );
    }
    psqlScalar(database, `
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
        "baseEvidence", results, "providerText", "embeddingUsage", "readReceipt",
        "durationMs", "updatedAt"
      ) VALUES
        (
          'knowledge-h3-receipt-exact', 'knowledge-h2-run-1',
          'knowledge-h3-call-exact', 6, 'find_exact', 'policy',
          'complete', 'none', 2, 2, 1,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb, '[{"handle":"K1"}]'::jsonb,
          'Exact match.', '[]'::jsonb,
          '{"caseMode":"insensitive","cursor":null,"field":"filename","limit":2,"match":"token","matches":[{"field":"filename","resultOrdinal":0}],"nextCursor":null,"scannedBytes":0,"scanTruncated":false,"value":"policy","version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-h3-receipt-discovery', 'knowledge-h2-run-1',
          'knowledge-h3-call-discovery', 7, 'discover_sources', 'policy',
          'complete', 'none', 2, 2, 1,
          '[{"baseName":"H3 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
          'Source metadata match.', '[]'::jsonb,
          '{"cursor":null,"fields":["filename"],"limit":2,"nextCursor":null,"query":"policy","sources":[{"ambiguous":false,"fileName":"policy.txt","matchedFields":["filename"],"readiness":"ready","sourceAlias":"S1","sourceName":"Policy","sourceVersionNumber":1}],"version":1}'::jsonb,
          1, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-h3-analysis-receipts-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeRun"
        WHERE id IN (
          'knowledge-h3-receipt-discovery', 'knowledge-h3-receipt-exact'
        )
          AND "readReceipt" IS NOT NULL;
      `),
      "2",
      "Current exact/discovery receipts were not durably accepted",
    );
    psqlScalar(database, `
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
        "baseEvidence", results, "providerText", "embeddingUsage", "readReceipt",
        "durationMs", "updatedAt"
      ) VALUES
        (
          'knowledge-h3-tombstone-exact', 'knowledge-h2-run-1',
          'knowledge-h3-call-exact-tombstone', 8, 'find_exact', 'deleted',
          'complete', 'none', 100, 100, 9,
          '[{"baseName":"Deleted Knowledge","ordinal":0}]'::jsonb,
          '[{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true},{"deleted":true}]'::jsonb,
          'Knowledge evidence was deleted.', '[]'::jsonb, NULL, 1, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-h3-tombstone-discovery', 'knowledge-h2-run-1',
          'knowledge-h3-call-discovery-tombstone', 9, 'discover_sources', 'deleted',
          'complete', 'none', 100, 100, 1,
          '[{"baseName":"Deleted Knowledge","ordinal":0}]'::jsonb, '[]'::jsonb,
          'Knowledge evidence was deleted.', '[]'::jsonb, NULL, 1, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-h3-tombstone-discovery-zero', 'knowledge-h2-run-1',
          'knowledge-h3-call-discovery-zero-tombstone', 10, 'discover_sources', 'deleted',
          'zero_above_threshold', 'none', 100, 100, 0,
          '[{"baseName":"Deleted Knowledge","ordinal":0}]'::jsonb, '[]'::jsonb,
          'Knowledge evidence was deleted.', '[]'::jsonb, NULL, 1, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-h3-purpose-tombstones-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeRun"
        WHERE (
          id = 'knowledge-h3-tombstone-exact'
          AND "readReceipt" IS NULL
          AND "resultLimit" = 100
          AND jsonb_array_length(results) = 9
        ) OR (
          id = 'knowledge-h3-tombstone-discovery'
          AND "readReceipt" IS NULL
          AND outcome = 'complete'
          AND jsonb_array_length(results) = 0
        ) OR (
          id = 'knowledge-h3-tombstone-discovery-zero'
          AND "readReceipt" IS NULL
          AND outcome = 'zero_above_threshold'
          AND "candidateCount" = 0
        );
      `),
      "3",
      "H3 exact/discovery privacy tombstones were not accepted by operation shape",
    );
    const unsupportedH3Operation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeBudgetReservation"
        SET operation = 'semantic_magic',
            "operationRequest" = jsonb_set(
              "operationRequest", '{operation}', to_jsonb('semantic_magic'::text)
            )
        WHERE id = 'knowledge-h2-reservation-2';`,
    ]);
    assert.notEqual(
      unsupportedH3Operation.status,
      0,
      "H3 accepted an unsupported operation kind",
    );
    assert.match(
      `${unsupportedH3Operation.stdout}\n${unsupportedH3Operation.stderr}`,
      /KnowledgeBudgetReservation_request_check/u,
      "Unsupported H3 operation failed without the stable request constraint",
    );
    const malformedReservation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeBudgetReservation" (
          id, "modelRunId", "modelRunToolCallId", "operationOrdinal", "phaseOrdinal",
          "subqueryOrdinal", operation, "policyVersion", "idempotencyKey",
          "operationRequest", "operationRequestHash", state,
          "estimatedCandidates", "estimatedRetrievedTokens", "estimatedEmbeddingCalls",
          "estimatedLatencyMs", "estimatedCostMicros", "createdAt", "updatedAt"
        ) VALUES (
          'knowledge-h2-reservation-bad', 'knowledge-h2-run-1', 'knowledge-h2-call-3',
          3, 0, 2, 'discover_sources', 1, 'knowledge-h2-reservation-key-bad',
          jsonb_build_object(
            'version', 2, 'reservationId', 'knowledge-h2-reservation-bad',
            'idempotencyKey', 'knowledge-h2-reservation-key-bad',
            'operation', 'discover_sources', 'phaseOrdinal', 0, 'subqueryOrdinal', 2
          ), repeat('c', 64), 'reserved', 1, 1, 0, 10, 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
    ]);
    assert.notEqual(malformedReservation.status, 0, "H2 accepted an unfenced reservation");
    assert.match(
      `${malformedReservation.stdout}\n${malformedReservation.stderr}`,
      /KnowledgeBudgetReservation_state_check/u,
      "Malformed H2 reservation failed without the stable state constraint",
    );

    psqlScalar(database, `
      BEGIN;
      UPDATE "KnowledgeBudgetReservation" SET
        state = 'settled', "dispatchedAt" = CURRENT_TIMESTAMP,
        "settledAt" = CURRENT_TIMESTAMP, "dispatchAttemptKey" = 'knowledge-h2-dispatch-1',
        "receiptHash" = repeat('d', 64), "actualCandidates" = 0,
        "actualRetrievedTokens" = 0, "actualEmbeddingCalls" = 0,
        "actualLatencyMs" = 3, "actualCostMicros" = 0,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h2-reservation-1';
      UPDATE "KnowledgeRun" SET
        "receiptVersion" = 2, "budgetReservationId" = 'knowledge-h2-reservation-1'
      WHERE id = 'knowledge-h2-operation';
      COMMIT;
      SELECT 'knowledge-h2-receipt-settled';
    `);
    const mismatchedReservation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun"
        SET "budgetReservationId" = 'knowledge-h2-reservation-2'
        WHERE id = 'knowledge-h2-operation';`,
    ]);
    assert.notEqual(
      mismatchedReservation.status,
      0,
      "H2 attached a reservation owned by a different tool call",
    );
    assert.match(
      `${mismatchedReservation.stdout}\n${mismatchedReservation.stderr}`,
      /KnowledgeRun_budgetReservation_fkey/u,
      "Mismatched H2 reservation failed without the exact composite FK",
    );

    psqlScalar(database, `
      INSERT INTO "ProviderRunBinding" (
        id, "modelRunId", "bindingKey", role, "credentialSource", "executionSnapshot"
      ) VALUES
        (
          'knowledge-h2-provider-binding', 'knowledge-h2-run-1', 'answer',
          'answer', 'default', '{}'::jsonb
        ),
        (
          'knowledge-v21-provider-binding', 'knowledge-h2-run-2', 'answer',
          'answer', 'default', '{}'::jsonb
        );
      INSERT INTO "KnowledgeRetrievalSession" (
        id, "modelRunId", version, "originalIntent", "scopeSnapshot",
        "readinessSummary", "citationContract", "updatedAt"
      ) VALUES
        ('knowledge-h2-session-1', 'knowledge-h2-run-1', 2, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP),
        ('knowledge-h2-session-2', 'knowledge-h2-run-2', 2, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        'knowledge-h2-attempt', 'knowledge-h2-run-1', 'answer', 1, 0, 'answer',
        'knowledge-answer:1:fixture', repeat('e', 64), repeat('f', 64), 'reserved',
        '{}'::jsonb, 'knowledge-h2-provider-lease', CURRENT_TIMESTAMP + interval '5 minutes',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "contractVersion", "evidenceReceiptHash", "acceptedRequest",
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES
        (
          'knowledge-v21-draft', 'knowledge-h2-run-2', 'answer', 1, 0,
          'knowledge_answer_draft_v21', 21, repeat('a', 64),
          '{"version":1,"operation":"knowledge_answer_draft_v21"}'::jsonb,
          'knowledge-v21-draft-key', repeat('1', 64), repeat('1', 64), 'reserved',
          '{}'::jsonb, 'knowledge-v21-draft-lease', CURRENT_TIMESTAMP + interval '5 minutes',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-initial', 'knowledge-h2-run-2', 'answer', 2, 0,
          'knowledge_grounded_selector_v17', 17, repeat('a', 64),
          '{"version":1,"operation":"knowledge_grounded_selector_v17","pass":"initial"}'::jsonb,
          'knowledge-v21-selector-initial-key', repeat('2', 64), repeat('2', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-repair', 'knowledge-h2-run-2', 'answer', 3, 0,
          'knowledge_grounded_selector_v17', 17, repeat('a', 64),
          '{"version":1,"operation":"knowledge_grounded_selector_v17","pass":"repair"}'::jsonb,
          'knowledge-v21-selector-repair-key', repeat('3', 64), repeat('3', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-auditor', 'knowledge-h2-run-2', 'answer', 4, 0,
          'knowledge_coverage_auditor_v2', 2, repeat('a', 64),
          '{"version":2,"operation":"knowledge_coverage_auditor_v2","pass":"initial"}'::jsonb,
          'knowledge-v21-auditor-key', repeat('4', 64), repeat('4', 64), 'reserved',
          '{}'::jsonb, 'knowledge-v21-auditor-lease', CURRENT_TIMESTAMP + interval '5 minutes',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-supplement', 'knowledge-h2-run-2', 'answer', 5, 0,
          'knowledge_answer_draft_supplement_v21', 21, repeat('a', 64),
          '{"version":1,"operation":"knowledge_answer_draft_supplement_v21"}'::jsonb,
          'knowledge-v21-supplement-key', repeat('5', 64), repeat('5', 64), 'reserved',
          '{}'::jsonb, 'knowledge-v21-supplement-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-final', 'knowledge-h2-run-2', 'answer', 6, 0,
          'knowledge_grounded_selector_final_v17', 17, repeat('a', 64),
          '{"version":1,"operation":"knowledge_grounded_selector_final_v17"}'::jsonb,
          'knowledge-v21-selector-final-key', repeat('6', 64), repeat('6', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-final-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-h2-provider-attempt-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeProviderAttempt"
        WHERE "modelRunId" = 'knowledge-h2-run-2'
          AND purpose IN (
            'knowledge_answer_draft_v21',
            'knowledge_grounded_selector_v17',
            'knowledge_coverage_auditor_v2',
            'knowledge_answer_draft_supplement_v21',
            'knowledge_grounded_selector_final_v17'
          );
      `),
      "6",
      "V21 bounded operation and one-repair sequence was not accepted",
    );
    psqlScalar(database, `
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "contractVersion", "evidenceReceiptHash", "acceptedRequest",
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        'knowledge-v21-auditor-repair', 'knowledge-h2-run-2', 'answer', 7, 0,
        'knowledge_coverage_auditor_v2', 2, repeat('a', 64),
        '{"version":2,"operation":"knowledge_coverage_auditor_v2","pass":"repair"}'::jsonb,
        'knowledge-v21-auditor-repair-key', repeat('7', 64), repeat('7', 64),
        'reserved', '{}'::jsonb, 'knowledge-v21-auditor-repair-lease',
        CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      SELECT 'knowledge-v21-auditor-repair-ready';
    `);
    const duplicateSelectorRequest = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeProviderAttempt" (
          id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
          "contractVersion", "evidenceReceiptHash", "acceptedRequest",
          "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
          "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          'knowledge-v21-selector-duplicate', 'knowledge-h2-run-2', 'answer', 8, 0,
          'knowledge_grounded_selector_v17', 17, repeat('a', 64),
          '{"version":1,"operation":"knowledge_grounded_selector_v17","pass":"duplicate"}'::jsonb,
          'knowledge-v21-selector-duplicate-key', repeat('7', 64), repeat('2', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-duplicate-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
    ]);
    assert.notEqual(
      duplicateSelectorRequest.status,
      0,
      "V21 accepted a duplicate Selector request instead of one distinct repair",
    );
    assert.match(
      `${duplicateSelectorRequest.stdout}\n${duplicateSelectorRequest.stderr}`,
      /KnowledgeProviderAttempt_v21_selector_request_key/u,
      "Duplicate V21 Selector request failed without the stable uniqueness index",
    );
    const duplicateAuditorRequest = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeProviderAttempt" (
          id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
          "contractVersion", "evidenceReceiptHash", "acceptedRequest",
          "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
          "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          'knowledge-v21-auditor-duplicate', 'knowledge-h2-run-2', 'answer', 9, 0,
          'knowledge_coverage_auditor_v2', 2, repeat('a', 64),
          '{"version":2,"operation":"knowledge_coverage_auditor_v2","pass":"duplicate"}'::jsonb,
          'knowledge-v21-auditor-duplicate-key', repeat('8', 64), repeat('4', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-auditor-duplicate-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `,
    ]);
    assert.notEqual(
      duplicateAuditorRequest.status,
      0,
      "V21 accepted a duplicate Auditor request instead of one distinct repair",
    );
    assert.match(
      `${duplicateAuditorRequest.stdout}\n${duplicateAuditorRequest.stderr}`,
      /KnowledgeProviderAttempt_v21_auditor_request_key/u,
      "Duplicate V21 Auditor request failed without the stable uniqueness index",
    );
    psqlScalar(database, `
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "contractVersion", "evidenceReceiptHash", "acceptedRequest",
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES
        (
          'knowledge-v21-scope-initial', 'knowledge-h2-run-2', 'answer', 10, 0,
          'knowledge_coverage_scope_v4', 4, repeat('a', 64),
          '{"version":4,"operation":"knowledge_coverage_scope_v4","pass":"initial"}'::jsonb,
          'knowledge-v21-scope-initial-key', repeat('a', 64), repeat('a', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-scope-repair', 'knowledge-h2-run-2', 'answer', 11, 0,
          'knowledge_coverage_scope_v4', 4, repeat('a', 64),
          '{"version":4,"operation":"knowledge_coverage_scope_v4","pass":"repair"}'::jsonb,
          'knowledge-v21-scope-repair-key', repeat('b', 64), repeat('b', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v18-initial', 'knowledge-h2-run-2', 'answer', 12, 0,
          'knowledge_grounded_selector_v19', 19, repeat('a', 64),
          '{"version":4,"operation":"knowledge_grounded_selector_v19","pass":"initial"}'::jsonb,
          'knowledge-v21-selector-v18-initial-key', repeat('c', 64), repeat('c', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v18-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v18-repair', 'knowledge-h2-run-2', 'answer', 13, 0,
          'knowledge_grounded_selector_v19', 19, repeat('a', 64),
          '{"version":4,"operation":"knowledge_grounded_selector_v19","pass":"repair"}'::jsonb,
          'knowledge-v21-selector-v18-repair-key', repeat('d', 64), repeat('d', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v18-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v18-final', 'knowledge-h2-run-2', 'answer', 14, 0,
          'knowledge_grounded_selector_final_v19', 19, repeat('a', 64),
          '{"version":4,"operation":"knowledge_grounded_selector_final_v19"}'::jsonb,
          'knowledge-v21-selector-v18-final-key', repeat('e', 64), repeat('e', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v18-final-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-v21-scope-v4-sequence-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeProviderAttempt"
        WHERE "modelRunId" = 'knowledge-h2-run-2'
          AND purpose IN (
            'knowledge_coverage_scope_v4',
            'knowledge_grounded_selector_v19',
            'knowledge_grounded_selector_final_v19'
          );
      `),
      "5",
      "V21 atom-review Scope, one repair, and Selector V19 sequence was not accepted",
    );
    for (const duplicate of [{
      id: "knowledge-v21-scope-duplicate",
      index: "KnowledgeProviderAttempt_v21_scope_v4_request_key",
      purpose: "knowledge_coverage_scope_v4",
      requestHash: "a",
      version: 4,
    }, {
      id: "knowledge-v21-selector-v18-duplicate",
      index: "KnowledgeProviderAttempt_v21_selector_v19_request_key",
      purpose: "knowledge_grounded_selector_v19",
      requestHash: "c",
      version: 19,
    }] as const) {
      const duplicateCurrentRequest = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", `
          INSERT INTO "KnowledgeProviderAttempt" (
            id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
            "contractVersion", "evidenceReceiptHash", "acceptedRequest",
            "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
            "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            '${duplicate.id}', 'knowledge-h2-run-2', 'answer', 15, 0,
            '${duplicate.purpose}', ${duplicate.version}, repeat('a', 64),
            '{}'::jsonb, '${duplicate.id}-key', repeat('f', 64),
            repeat('${duplicate.requestHash}', 64), 'reserved', '{}'::jsonb,
            '${duplicate.id}-lease', CURRENT_TIMESTAMP + interval '5 minutes',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
        `,
      ]);
      assert.notEqual(
        duplicateCurrentRequest.status,
        0,
        `V21 accepted a duplicate ${duplicate.purpose} request`,
      );
      assert.match(
        `${duplicateCurrentRequest.stdout}\n${duplicateCurrentRequest.stderr}`,
        new RegExp(duplicate.index, "u"),
        `Duplicate ${duplicate.purpose} failed without its stable uniqueness index`,
      );
    }
    psqlScalar(database, `
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "contractVersion", "evidenceReceiptHash", "acceptedRequest",
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES
        (
          'knowledge-v21-scope-v6-initial', 'knowledge-h2-run-2', 'answer', 22, 0,
          'knowledge_coverage_scope_v6', 6, repeat('a', 64),
          '{"version":6,"operation":"knowledge_coverage_scope_v6","pass":"initial"}'::jsonb,
          'knowledge-v21-scope-v6-initial-key', repeat('7', 64), repeat('7', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-v6-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-scope-v6-repair', 'knowledge-h2-run-2', 'answer', 23, 0,
          'knowledge_coverage_scope_v6', 6, repeat('a', 64),
          '{"version":6,"operation":"knowledge_coverage_scope_v6","pass":"repair"}'::jsonb,
          'knowledge-v21-scope-v6-repair-key', repeat('8', 64), repeat('8', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-v6-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v21-initial', 'knowledge-h2-run-2', 'answer', 24, 0,
          'knowledge_grounded_selector_v21', 21, repeat('a', 64),
          '{"version":6,"operation":"knowledge_grounded_selector_v21","pass":"initial"}'::jsonb,
          'knowledge-v21-selector-v21-initial-key', repeat('9', 64), repeat('9', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v21-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v21-repair', 'knowledge-h2-run-2', 'answer', 25, 0,
          'knowledge_grounded_selector_v21', 21, repeat('a', 64),
          '{"version":6,"operation":"knowledge_grounded_selector_v21","pass":"repair"}'::jsonb,
          'knowledge-v21-selector-v21-repair-key', repeat('a', 64), repeat('a', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v21-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v21-final', 'knowledge-h2-run-2', 'answer', 26, 0,
          'knowledge_grounded_selector_final_v21', 21, repeat('a', 64),
          '{"version":6,"operation":"knowledge_grounded_selector_final_v21"}'::jsonb,
          'knowledge-v21-selector-v21-final-key', repeat('b', 64), repeat('b', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v21-final-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-v21-scope-v6-sequence-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeProviderAttempt"
        WHERE "modelRunId" = 'knowledge-h2-run-2'
          AND purpose IN (
            'knowledge_coverage_scope_v6',
            'knowledge_grounded_selector_v21',
            'knowledge_grounded_selector_final_v21'
          );
      `),
      "5",
      "V21 positive-finding Scope, one repair, and Selector V21 sequence was not accepted",
    );
    for (const duplicate of [{
      id: "knowledge-v21-scope-v6-duplicate",
      index: "KnowledgeProviderAttempt_v21_scope_v6_request_key",
      purpose: "knowledge_coverage_scope_v6",
      requestHash: "7",
      version: 6,
    }, {
      id: "knowledge-v21-selector-v21-duplicate",
      index: "KnowledgeProviderAttempt_v21_selector_v21_request_key",
      purpose: "knowledge_grounded_selector_v21",
      requestHash: "9",
      version: 21,
    }] as const) {
      const duplicateCurrentRequest = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", `
          INSERT INTO "KnowledgeProviderAttempt" (
            id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
            "contractVersion", "evidenceReceiptHash", "acceptedRequest",
            "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
            "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            '${duplicate.id}', 'knowledge-h2-run-2', 'answer', 27, 0,
            '${duplicate.purpose}', ${duplicate.version}, repeat('a', 64),
            '{}'::jsonb, '${duplicate.id}-key', repeat('c', 64),
            repeat('${duplicate.requestHash}', 64), 'reserved', '{}'::jsonb,
            '${duplicate.id}-lease', CURRENT_TIMESTAMP + interval '5 minutes',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
        `,
      ]);
      assert.notEqual(
        duplicateCurrentRequest.status,
        0,
        `V21 accepted a duplicate ${duplicate.purpose} request`,
      );
      assert.match(
        `${duplicateCurrentRequest.stdout}\n${duplicateCurrentRequest.stderr}`,
        new RegExp(duplicate.index, "u"),
        `Duplicate ${duplicate.purpose} failed without its stable uniqueness index`,
      );
    }
    psqlScalar(database, `
      INSERT INTO "KnowledgeProviderAttempt" (
        id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
        "contractVersion", "evidenceReceiptHash", "acceptedRequest",
        "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
        "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES
        (
          'knowledge-v21-scope-v5-initial', 'knowledge-h2-run-2', 'answer', 16, 0,
          'knowledge_coverage_scope_v5', 5, repeat('a', 64),
          '{"version":5,"operation":"knowledge_coverage_scope_v5","pass":"initial"}'::jsonb,
          'knowledge-v21-scope-v5-initial-key', repeat('1', 64), repeat('1', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-v5-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-scope-v5-repair', 'knowledge-h2-run-2', 'answer', 17, 0,
          'knowledge_coverage_scope_v5', 5, repeat('a', 64),
          '{"version":5,"operation":"knowledge_coverage_scope_v5","pass":"repair"}'::jsonb,
          'knowledge-v21-scope-v5-repair-key', repeat('2', 64), repeat('2', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-scope-v5-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v20-initial', 'knowledge-h2-run-2', 'answer', 18, 0,
          'knowledge_grounded_selector_v20', 20, repeat('a', 64),
          '{"version":5,"operation":"knowledge_grounded_selector_v20","pass":"initial"}'::jsonb,
          'knowledge-v21-selector-v20-initial-key', repeat('3', 64), repeat('3', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v20-initial-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v20-repair', 'knowledge-h2-run-2', 'answer', 19, 0,
          'knowledge_grounded_selector_v20', 20, repeat('a', 64),
          '{"version":5,"operation":"knowledge_grounded_selector_v20","pass":"repair"}'::jsonb,
          'knowledge-v21-selector-v20-repair-key', repeat('4', 64), repeat('4', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v20-repair-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'knowledge-v21-selector-v20-final', 'knowledge-h2-run-2', 'answer', 20, 0,
          'knowledge_grounded_selector_final_v20', 20, repeat('a', 64),
          '{"version":5,"operation":"knowledge_grounded_selector_final_v20"}'::jsonb,
          'knowledge-v21-selector-v20-final-key', repeat('5', 64), repeat('5', 64),
          'reserved', '{}'::jsonb, 'knowledge-v21-selector-v20-final-lease',
          CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      SELECT 'knowledge-v21-scope-v5-sequence-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeProviderAttempt"
        WHERE "modelRunId" = 'knowledge-h2-run-2'
          AND purpose IN (
            'knowledge_coverage_scope_v5',
            'knowledge_grounded_selector_v20',
            'knowledge_grounded_selector_final_v20'
          );
      `),
      "5",
      "V21 sparse-unit Scope, one repair, and Selector V20 sequence was not accepted",
    );
    for (const duplicate of [{
      id: "knowledge-v21-scope-v5-duplicate",
      index: "KnowledgeProviderAttempt_v21_scope_v5_request_key",
      purpose: "knowledge_coverage_scope_v5",
      requestHash: "1",
      version: 5,
    }, {
      id: "knowledge-v21-selector-v20-duplicate",
      index: "KnowledgeProviderAttempt_v21_selector_v20_request_key",
      purpose: "knowledge_grounded_selector_v20",
      requestHash: "3",
      version: 20,
    }] as const) {
      const duplicateCurrentRequest = compose([
        "exec", "-T", POSTGRES_SERVICE,
        "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
        "--dbname", database,
        "--command", `
          INSERT INTO "KnowledgeProviderAttempt" (
            id, "modelRunId", "providerBindingKey", ordinal, "roundIndex", purpose,
            "contractVersion", "evidenceReceiptHash", "acceptedRequest",
            "idempotencyKey", "checkpointHash", "requestHash", state, "estimatedUsage",
            "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            '${duplicate.id}', 'knowledge-h2-run-2', 'answer', 21, 0,
            '${duplicate.purpose}', ${duplicate.version}, repeat('a', 64),
            '{}'::jsonb, '${duplicate.id}-key', repeat('6', 64),
            repeat('${duplicate.requestHash}', 64), 'reserved', '{}'::jsonb,
            '${duplicate.id}-lease', CURRENT_TIMESTAMP + interval '5 minutes',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
        `,
      ]);
      assert.notEqual(
        duplicateCurrentRequest.status,
        0,
        `V21 accepted a duplicate ${duplicate.purpose} request`,
      );
      assert.match(
        `${duplicateCurrentRequest.stdout}\n${duplicateCurrentRequest.stderr}`,
        new RegExp(duplicate.index, "u"),
        `Duplicate ${duplicate.purpose} failed without its stable uniqueness index`,
      );
    }
    psqlScalar(database, `
      INSERT INTO "KnowledgeGroundingResult" (
        "retrievalSessionId", version, outcome, "originalAnswerHash", "finalAnswerHash",
        evidence
      ) VALUES (
        'knowledge-h2-session-2', 20, 'answered', repeat('6', 64), repeat('7', 64),
        '{"version":20,"contracts":{"draftContractVersion":21,"selectorContractVersion":19,"coverageAuditorContractVersion":4,"settlementVersion":6}}'::jsonb
      );
      SELECT 'knowledge-v21-grounding-evidence-v20-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeGroundingResult"
        WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 20;
      `),
      "1",
      "Grounding Evidence V20 was not durably accepted",
    );
    psqlScalar(database, `
      DELETE FROM "KnowledgeGroundingResult"
      WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 20;
      SELECT 'knowledge-v21-grounding-evidence-v20-cleaned';
    `);
    psqlScalar(database, `
      INSERT INTO "KnowledgeGroundingResult" (
        "retrievalSessionId", version, outcome, "originalAnswerHash", "finalAnswerHash",
        evidence
      ) VALUES (
        'knowledge-h2-session-2', 21, 'answered', repeat('6', 64), repeat('7', 64),
        '{"version":21,"contracts":{"draftContractVersion":21,"selectorContractVersion":20,"coverageAuditorContractVersion":5,"settlementVersion":6}}'::jsonb
      );
      SELECT 'knowledge-v21-grounding-evidence-v21-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeGroundingResult"
        WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 21;
      `),
      "1",
      "Grounding Evidence V21 was not durably accepted",
    );
    psqlScalar(database, `
      DELETE FROM "KnowledgeGroundingResult"
      WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 21;
      SELECT 'knowledge-v21-grounding-evidence-v21-cleaned';
    `);
    psqlScalar(database, `
      INSERT INTO "KnowledgeGroundingResult" (
        "retrievalSessionId", version, outcome, "originalAnswerHash", "finalAnswerHash",
        evidence
      ) VALUES (
        'knowledge-h2-session-2', 22, 'answered', repeat('6', 64), repeat('7', 64),
        '{"version":22,"contracts":{"draftContractVersion":21,"selectorContractVersion":21,"coverageAuditorContractVersion":6,"settlementVersion":6}}'::jsonb
      );
      SELECT 'knowledge-v21-grounding-evidence-v22-ready';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeGroundingResult"
        WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 22;
      `),
      "1",
      "Grounding Evidence V22 was not durably accepted",
    );
    psqlScalar(database, `
      DELETE FROM "KnowledgeGroundingResult"
      WHERE "retrievalSessionId" = 'knowledge-h2-session-2' AND version = 22;
      SELECT 'knowledge-v21-grounding-evidence-v22-cleaned';
    `);
    psqlScalar(database, `
      INSERT INTO "KnowledgeGroundingResult" (
        "retrievalSessionId", version, outcome, "originalAnswerHash", "finalAnswerHash",
        evidence
      ) VALUES (
        'knowledge-h2-session-1', 17, 'answered', repeat('8', 64), repeat('9', 64),
        '{"version":17,"contracts":{"draftContractVersion":21,"selectorContractVersion":17,"coverageAuditorContractVersion":1,"settlementVersion":6}}'::jsonb
      );
      SELECT 'knowledge-v21-grounding-evidence-ready';
    `);
    const oversizedEvidenceV17 = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeGroundingResult" (
          "retrievalSessionId", version, outcome, "originalAnswerHash", "finalAnswerHash",
          evidence
        ) VALUES (
          'knowledge-h2-session-2', 17, 'answered', repeat('a', 64), repeat('b', 64),
          jsonb_build_object(
            'version', 17,
            'oversized', (
              SELECT string_agg(md5(value::text), '')
              FROM generate_series(1, 3000) AS value
            )
          )
        );
      `,
    ]);
    assert.notEqual(
      oversizedEvidenceV17.status,
      0,
      "Grounding Evidence V17 exceeded its durable content-free size bound",
    );
    assert.match(
      `${oversizedEvidenceV17.stdout}\n${oversizedEvidenceV17.stderr}`,
      /KnowledgeGroundingResult_evidence_version_check/u,
      "Oversized Grounding Evidence V17 failed without the stable constraint",
    );
    const crossRunManifest = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeEvidenceDispatchManifest" (
          id, "modelRunId", "retrievalSessionId", "providerAttemptId", version,
          "packingVersion", "promptFragmentVersion", "profileRevisionIds", coverage,
          "messageText", "messageHash", "totalBytes", "totalTokens", "itemCount",
          "excludedCount", "shortenedCount"
        ) VALUES (
          'knowledge-h2-manifest-bad', 'knowledge-h2-run-1', 'knowledge-h2-session-2',
          'knowledge-h2-attempt', 1, 'whole_source_item_v1', '2', ARRAY[]::text[],
          '{}'::jsonb, 'x', repeat('1', 64), 1, 1, 0, 0, 0
        );
      `,
    ]);
    assert.notEqual(crossRunManifest.status, 0, "H2 accepted a cross-run dispatch manifest");
    assert.match(
      `${crossRunManifest.stdout}\n${crossRunManifest.stderr}`,
      /knowledge_dispatch_manifest_scope_mismatch/u,
      "Cross-run manifest failed without the stable scope fence",
    );
    psqlScalar(database, `
      INSERT INTO "KnowledgeEvidenceDispatchManifest" (
        id, "modelRunId", "retrievalSessionId", "providerAttemptId", version,
        "packingVersion", "promptFragmentVersion", "profileRevisionIds", coverage,
        "messageText", "messageHash", "totalBytes", "totalTokens", "itemCount",
        "excludedCount", "shortenedCount"
      ) VALUES (
        'knowledge-h2-manifest', 'knowledge-h2-run-1', 'knowledge-h2-session-1',
        'knowledge-h2-attempt', 1, 'whole_source_item_v1', '2', ARRAY[]::text[],
        '{}'::jsonb, 'x', repeat('2', 64), 1, 1, 0, 0, 0
      );
      UPDATE "KnowledgeProviderAttempt" SET
        state = 'dispatched',
        "dispatchedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt"),
        "leaseExpiresAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt") +
          interval '5 minutes',
        "updatedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt")
      WHERE id = 'knowledge-h2-attempt';
      SELECT 'knowledge-h2-manifest-sealed';
    `);
    const mutableManifest = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeEvidenceDispatchManifest"
        SET "messageText" = 'y' WHERE id = 'knowledge-h2-manifest';`,
    ]);
    assert.notEqual(mutableManifest.status, 0, "H2 allowed a dispatched manifest mutation");
    assert.match(
      `${mutableManifest.stdout}\n${mutableManifest.stderr}`,
      /knowledge_dispatch_manifest_immutable/u,
      "Dispatched manifest mutation failed without the stable immutability fence",
    );

    psqlScalar(database, `DELETE FROM "ModelRun" WHERE id = 'knowledge-h2-run-1';`);
    assert.equal(
      psqlScalar(database, `
        SELECT
          (SELECT count(*) FROM "KnowledgeEvidenceDispatchManifest"
            WHERE "modelRunId" = 'knowledge-h2-run-1')
          + (SELECT count(*) FROM "KnowledgeProviderAttempt"
            WHERE "modelRunId" = 'knowledge-h2-run-1')
          + (SELECT count(*) FROM "KnowledgeBudgetReservation"
            WHERE "modelRunId" = 'knowledge-h2-run-1');
      `),
      "0",
      "H2 immutable audit children blocked their owning ModelRun cascade",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeH4StrategyExecutionMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const h3Index = committed.indexOf(KNOWLEDGE_H3_OPERATION_SEMANTICS_MIGRATION);
  const h4Index = committed.indexOf(KNOWLEDGE_H4_STRATEGY_EXECUTION_MIGRATION);
  const cleanupIndex = committed.indexOf(KNOWLEDGE_BASIC_RUNTIME_CLEANUP_MIGRATION);
  assert.ok(h3Index > 0, "Knowledge H3 operation semantics migration is missing");
  assert.ok(h4Index > h3Index, "Knowledge H4 strategy execution migration is missing");
  assert.ok(cleanupIndex > h4Index, "Knowledge Basic runtime cleanup migration is missing");
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "knowledge-h4-migration-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, h4Index)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('knowledge-h4-owner', 'H4 owner', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES
        ('knowledge-h4-chat-1', 'knowledge-h4-owner', 'H4 primary', CURRENT_TIMESTAMP),
        ('knowledge-h4-chat-2', 'knowledge-h4-owner', 'H4 secondary', CURRENT_TIMESTAMP);
      INSERT INTO "Message" (id, "chatId", role, content, "updatedAt") VALUES
        ('knowledge-h4-message-1', 'knowledge-h4-chat-1', 'user', '{}'::jsonb,
         CURRENT_TIMESTAMP),
        ('knowledge-h4-message-2', 'knowledge-h4-chat-2', 'user', '{}'::jsonb,
         CURRENT_TIMESTAMP);
      INSERT INTO "ModelRun" (
        id, "chatId", "userId", "userMessageId", provider, "modelId", status,
        "normalizedRequest", "updatedAt"
      ) VALUES
        ('knowledge-h4-run-1', 'knowledge-h4-chat-1', 'knowledge-h4-owner',
         'knowledge-h4-message-1', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
         CURRENT_TIMESTAMP),
        ('knowledge-h4-run-2', 'knowledge-h4-chat-2', 'knowledge-h4-owner',
         'knowledge-h4-message-2', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
         CURRENT_TIMESTAMP);
      INSERT INTO "ModelRunToolCall" (
        id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
        arguments, state, "startedAt", "completedAt", "updatedAt"
      ) VALUES
        ('knowledge-h4-call-legacy', 'knowledge-h4-run-1', 0, 0,
         'knowledge-h4-provider-call-legacy', 'retrieve_knowledge',
         '{"operation":"automatic_search","query":"legacy"}'::jsonb,
         'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h4-call-strategy', 'knowledge-h4-run-1', 0, 1,
         'knowledge-h4-provider-call-strategy', 'retrieve_knowledge',
         '{"operation":"automatic_search","query":"strategy"}'::jsonb,
         'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h4-call-unrelated', 'knowledge-h4-run-1', 0, 2,
         'knowledge-h4-provider-call-unrelated', 'retrieve_knowledge',
         '{"operation":"automatic_search","query":"unrelated"}'::jsonb,
         'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('knowledge-h4-call-other-run', 'knowledge-h4-run-2', 0, 0,
         'knowledge-h4-provider-call-other-run', 'retrieve_knowledge',
         '{"operation":"automatic_search","query":"other"}'::jsonb,
         'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeRetrievalSession" (
        id, "modelRunId", version, "originalIntent", "scopeSnapshot", "strategySnapshot",
        "readinessSummary", "coverageRequirements", "citationContract", "updatedAt"
      ) VALUES
        ('knowledge-h4-session-1', 'knowledge-h4-run-1', 2, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP),
        ('knowledge-h4-session-2', 'knowledge-h4-run-2', 2, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP);
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
        "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
      ) VALUES (
        'knowledge-h4-legacy-receipt', 'knowledge-h4-run-1',
        'knowledge-h4-call-legacy', 1, 'automatic_search', 'legacy', 'base_empty',
        'rrf_k60', 1, 1, 0, 0.01,
        '[{"baseName":"Legacy H4 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
        'No matching evidence.', '[]'::jsonb, 1, CURRENT_TIMESTAMP
      );
      SELECT 'knowledge-h4-pre-migration-ready';
    `);

    for (const migration of committed.slice(h4Index, cleanupIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeRun"
        WHERE id = 'knowledge-h4-legacy-receipt'
          AND "strategyStepEvidence" IS NULL;
      `),
      "1",
      "H4 migration reinterpreted a legacy Knowledge receipt",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'KnowledgeStrategyExecution_contract_check',
          'KnowledgeStrategyExecution_state_check',
          'KnowledgeStrategyMapOutput_contract_check',
          'KnowledgeStrategyStep_contract_check',
          'KnowledgeStrategyStep_state_check',
          'KnowledgeStrategyStepDependency_no_self_check',
          'KnowledgeRun_strategy_step_evidence_check',
          'KnowledgeEvidenceDispatchManifestItem_contract_check',
          'KnowledgeEvidenceDispatchManifestExclusion_contract_check'
        ) AND convalidated;
      `),
      "9",
      "H4 strategy execution constraints are missing or unvalidated",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'KnowledgeEvidenceDispatchManifestItem_contract_check',
          'KnowledgeEvidenceDispatchManifestExclusion_contract_check'
        )
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%2048%';
      `),
      "2",
      "H4 did not align frozen dispatch handles with canonical K1..K2048 bounds",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM pg_trigger
        WHERE tgname = 'KnowledgeStrategyMapOutput_guard'
          AND tgenabled = 'O'
          AND NOT tgisinternal;
      `),
      "1",
      "H4 map-output immutability/source guard is missing",
    );

    psqlScalar(database, `
      INSERT INTO "KnowledgeStrategyExecution" (
        id, "modelRunId", "retrievalSessionId", version, "plannerVersion", strategy,
        state, "executionRequest", "planHash", "executionHash", "sourceSetHash",
        "expectedSourceCount", "expectedPassageCount", "updatedAt"
      ) VALUES (
        'knowledge-h4-execution', 'knowledge-h4-run-1', 'knowledge-h4-session-1',
        1, 1, 'multi_hop', 'planned',
        jsonb_build_object(
          'version', 1,
          'executionId', 'knowledge-h4-execution',
          'modelRunId', 'knowledge-h4-run-1',
          'plannerVersion', 1,
          'strategy', 'multi_hop',
          'sourceSet', jsonb_build_array(jsonb_build_object(
            'bindingId', 'knowledge-h4-source-binding',
            'ordinal', 0,
            'passageCount', 2,
            'sourceAlias', 'S1'
          )),
          'sourceSetHash', repeat('a', 64),
          'config', '{}'::jsonb,
          'planHash', repeat('b', 64)
        ),
        repeat('b', 64), repeat('c', 64), repeat('a', 64), 1, 2,
        CURRENT_TIMESTAMP
      );
      INSERT INTO "KnowledgeStrategyStep" (
        id, "executionId", "modelRunId", "modelRunToolCallId", ordinal, kind,
        "phaseOrdinal", "streamId", "pageOrdinal", required, state,
        "materializationMode", "templateHash", "materializedAt", "idempotencyKey",
        request, "requestHash", "inputHash", "sourceSetHash", "updatedAt"
      ) VALUES
        (
          'knowledge-h4-step-root', 'knowledge-h4-execution', 'knowledge-h4-run-1',
          'knowledge-h4-call-strategy', 0, 'multi_hop_root', 0, 'root', 0, true,
          'pending', 'complete', repeat('1', 64), CURRENT_TIMESTAMP, repeat('1', 64),
          jsonb_build_object(
            'version', 1,
            'executionId', 'knowledge-h4-execution',
            'stepId', 'knowledge-h4-step-root',
            'strategy', 'multi_hop',
            'kind', 'multi_hop_root',
            'ordinal', 0,
            'phaseOrdinal', 0,
            'streamId', 'root',
            'pageOrdinal', 0,
            'required', true,
            'sourceBindingId', NULL,
            'targetOrdinal', NULL,
            'inputHash', repeat('2', 64),
            'evidenceInputHash', NULL,
            'comparisonDimensionHash', NULL,
            'sourceSetHash', repeat('a', 64),
            'cursor', NULL
          ),
          repeat('d', 64), repeat('2', 64), repeat('a', 64), CURRENT_TIMESTAMP
        ),
        (
          'knowledge-h4-step-follow-up', 'knowledge-h4-execution', 'knowledge-h4-run-1',
          NULL, 1, 'multi_hop_follow_up', 1, 'follow-up', 0, true,
          'pending', 'evidence_from_prerequisites', repeat('3', 64), NULL,
          repeat('3', 64), NULL, NULL, repeat('4', 64), repeat('a', 64),
          CURRENT_TIMESTAMP
        );
      INSERT INTO "KnowledgeStrategyStepDependency" (
        "executionId", "stepId", "dependsOnStepId"
      ) VALUES (
        'knowledge-h4-execution', 'knowledge-h4-step-follow-up',
        'knowledge-h4-step-root'
      );
      SELECT 'knowledge-h4-plan-ready';
    `);

    const selfDependency = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        INSERT INTO "KnowledgeStrategyStepDependency" (
          "executionId", "stepId", "dependsOnStepId"
        ) VALUES (
          'knowledge-h4-execution', 'knowledge-h4-step-root', 'knowledge-h4-step-root'
        );
      `,
    ]);
    assert.notEqual(selfDependency.status, 0, "H4 accepted a self dependency");
    assert.match(
      `${selfDependency.stdout}\n${selfDependency.stderr}`,
      /KnowledgeStrategyStepDependency_no_self_check/u,
      "H4 self dependency failed without the stable constraint",
    );

    psqlScalar(database, `
      UPDATE "KnowledgeStrategyExecution"
      SET state = 'running',
          "startedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt"),
          "updatedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt")
      WHERE id = 'knowledge-h4-execution';
      UPDATE "KnowledgeStrategyExecution"
      SET "processedPassageCount" = 1, "processedSetHash" = repeat('4', 64),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-execution';
      UPDATE "KnowledgeStrategyExecution"
      SET "processedPassageCount" = 2, "processedSetHash" = repeat('5', 64),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-execution';
      SELECT 'knowledge-h4-execution-running';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeStrategyExecution"
        WHERE id = 'knowledge-h4-execution'
          AND "processedSourceCount" = 0
          AND "processedPassageCount" = 2
          AND "processedSetHash" = repeat('5', 64);
      `),
      "1",
      "H4 blocked monotonic processed-set growth within one source",
    );
    const mutablePlan = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeStrategyExecution"
        SET "planHash" = repeat('9', 64), "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = 'knowledge-h4-execution';`,
    ]);
    assert.notEqual(mutablePlan.status, 0, "H4 allowed a frozen plan mutation");
    assert.match(
      `${mutablePlan.stdout}\n${mutablePlan.stderr}`,
      /knowledge_strategy_execution_plan_immutable/u,
      "H4 frozen plan mutation failed without the stable guard",
    );
    const deletedFrozenStep = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `DELETE FROM "KnowledgeStrategyStep"
        WHERE id = 'knowledge-h4-step-follow-up';`,
    ]);
    assert.notEqual(deletedFrozenStep.status, 0, "H4 deleted a frozen strategy step");
    assert.match(
      `${deletedFrozenStep.stdout}\n${deletedFrozenStep.stderr}`,
      /knowledge_strategy_step_plan_frozen/u,
      "H4 frozen step deletion failed without the stable guard",
    );
    const deletedFrozenDependency = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `DELETE FROM "KnowledgeStrategyStepDependency"
        WHERE "executionId" = 'knowledge-h4-execution';`,
    ]);
    assert.notEqual(
      deletedFrozenDependency.status,
      0,
      "H4 deleted a frozen strategy dependency",
    );
    assert.match(
      `${deletedFrozenDependency.stdout}\n${deletedFrozenDependency.stderr}`,
      /knowledge_strategy_dependency_plan_frozen/u,
      "H4 frozen dependency deletion failed without the stable guard",
    );
    const deletedExecution = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `DELETE FROM "KnowledgeStrategyExecution"
        WHERE id = 'knowledge-h4-execution';`,
    ]);
    assert.notEqual(deletedExecution.status, 0, "H4 directly deleted a strategy execution");
    assert.match(
      `${deletedExecution.stdout}\n${deletedExecution.stderr}`,
      /knowledge_strategy_execution_delete_forbidden/u,
      "H4 direct execution deletion failed without the stable guard",
    );

    psqlScalar(database, `
      UPDATE "KnowledgeStrategyStep" SET
        state = 'running', "attemptCount" = 1, "stateVersion" = 1,
        "leaseToken" = 'knowledge-h4-lease-root',
        "leaseExpiresAt" = CURRENT_TIMESTAMP + interval '5 minutes',
        "startedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-step-root';
      UPDATE "KnowledgeStrategyStep" SET
        "stateVersion" = 2, "irreversibleDispatch" = true,
        "ioStartedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-step-root';
      UPDATE "KnowledgeStrategyStep" SET
        state = 'settled', "stateVersion" = 3,
        result = jsonb_build_object(
          'version', 1,
          'executionId', 'knowledge-h4-execution',
          'stepId', 'knowledge-h4-step-root',
          'requestHash', repeat('d', 64),
          'status', 'succeeded',
          'reasonCode', NULL,
          'processedItemCount', 0,
          'processedItemsHash', repeat('f', 64),
          'cursorExhausted', true,
          'nextCursor', NULL,
          'lastItemHash', NULL
        ),
        "resultHash" = repeat('e', 64), "processedItemsHash" = repeat('f', 64),
        "processedPassageCount" = 0, "includedPassageCount" = 0,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "settledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-step-root';
      INSERT INTO "KnowledgeRun" (
        id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
        outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
        "baseEvidence", results, "providerText", "embeddingUsage", "strategyStepEvidence",
        "durationMs", "updatedAt"
      ) VALUES (
        'knowledge-h4-strategy-receipt', 'knowledge-h4-run-1',
        'knowledge-h4-call-strategy', 2, 'automatic_search', 'strategy', 'base_empty',
        'rrf_k60', 1, 1, 0, 0.01,
        '[{"baseName":"H4 Base","ordinal":0}]'::jsonb, '[]'::jsonb,
        'No matching evidence.', '[]'::jsonb,
        jsonb_build_object(
          'version', 1,
          'executionId', 'knowledge-h4-execution',
          'stepId', 'knowledge-h4-step-root',
          'ordinal', 0,
          'kind', 'multi_hop_root',
          'requestHash', repeat('d', 64),
          'resultHash', repeat('e', 64)
        ),
        1, CURRENT_TIMESTAMP
      );
      SELECT 'knowledge-h4-strategy-receipt-ready';
    `);

    const missingMarker = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun" SET "strategyStepEvidence" = NULL
        WHERE id = 'knowledge-h4-strategy-receipt';`,
    ]);
    assert.notEqual(missingMarker.status, 0, "H4 accepted a missing linked strategy marker");
    assert.match(
      `${missingMarker.stdout}\n${missingMarker.stderr}`,
      /knowledge_strategy_step_evidence_missing/u,
      "H4 missing marker failed without the stable guard",
    );
    const mismatchedMarker = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun"
        SET "strategyStepEvidence" = jsonb_set(
          "strategyStepEvidence", '{resultHash}', to_jsonb(repeat('0', 64))
        ) WHERE id = 'knowledge-h4-strategy-receipt';`,
    ]);
    assert.notEqual(mismatchedMarker.status, 0, "H4 accepted a mismatched strategy marker");
    assert.match(
      `${mismatchedMarker.stdout}\n${mismatchedMarker.stderr}`,
      /knowledge_strategy_step_evidence_mismatch/u,
      "H4 mismatched marker failed without the stable guard",
    );
    const malformedMarker = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun"
        SET "strategyStepEvidence" = "strategyStepEvidence" || '{"unexpected":true}'::jsonb
        WHERE id = 'knowledge-h4-strategy-receipt';`,
    ]);
    assert.notEqual(malformedMarker.status, 0, "H4 accepted a non-versioned strategy marker");
    assert.match(
      `${malformedMarker.stdout}\n${malformedMarker.stderr}`,
      /knowledge_strategy_step_evidence_invalid/u,
      "H4 malformed marker failed without the strict marker guard",
    );
    const unrelatedMarker = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `UPDATE "KnowledgeRun" AS legacy
        SET "strategyStepEvidence" = strategy."strategyStepEvidence"
        FROM "KnowledgeRun" AS strategy
        WHERE legacy.id = 'knowledge-h4-legacy-receipt'
          AND strategy.id = 'knowledge-h4-strategy-receipt';`,
    ]);
    assert.notEqual(unrelatedMarker.status, 0, "H4 attached a marker to an unrelated tool call");
    assert.match(
      `${unrelatedMarker.stdout}\n${unrelatedMarker.stderr}`,
      /knowledge_strategy_step_evidence_mismatch/u,
      "H4 unrelated marker failed without the same-tool-call guard",
    );

    psqlScalar(database, `
      UPDATE "KnowledgeStrategyExecution" SET
        state = 'failed', "failureCode" = 'probe_failed',
        "failedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-execution';
      BEGIN;
      SELECT set_config('aiqsa.knowledge_purge', 'on', true);
      UPDATE "KnowledgeStrategyStep" SET
        state = 'purged', "modelRunToolCallId" = NULL, "sourceBindingId" = NULL,
        "providerAttemptId" = NULL, "streamId" = NULL, "templateHash" = NULL,
        "materializedAt" = NULL, "idempotencyKey" = NULL, request = NULL,
        "requestHash" = NULL, "inputHash" = NULL, "evidenceInputHash" = NULL,
        "comparisonDimensionHash" = NULL, "sourceSetHash" = NULL, cursor = NULL,
        "cursorHash" = NULL, result = NULL, "resultHash" = NULL,
        "processedItemsHash" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "failureCode" = NULL, "purgedAt" = CURRENT_TIMESTAMP,
        "stateVersion" = "stateVersion" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-step-root';
      UPDATE "KnowledgeRun" SET "strategyStepEvidence" = NULL
      WHERE id = 'knowledge-h4-strategy-receipt';
      UPDATE "KnowledgeStrategyExecution" SET
        "executionRequest" = NULL, "planHash" = NULL, "executionHash" = NULL,
        "sourceSetHash" = NULL, "processedSetHash" = NULL, "includedSetHash" = NULL,
        "dispatchSetHash" = NULL, "dispatchManifestHash" = NULL,
        "coverageReceipt" = NULL, "coverageReceiptHash" = NULL,
        "purgedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-execution';
      COMMIT;
      SELECT 'knowledge-h4-purged';
    `);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*) FROM "KnowledgeStrategyStep" AS step
        JOIN "KnowledgeStrategyExecution" AS execution
          ON execution.id = step."executionId"
        JOIN "KnowledgeRun" AS receipt
          ON receipt.id = 'knowledge-h4-strategy-receipt'
        WHERE step.id = 'knowledge-h4-step-root'
          AND step.state = 'purged'
          AND step."irreversibleDispatch"
          AND step."attemptCount" = 1
          AND step.result IS NULL
          AND step."modelRunToolCallId" IS NULL
          AND execution."purgedAt" IS NOT NULL
          AND execution."executionRequest" IS NULL
          AND receipt."strategyStepEvidence" IS NULL;
      `),
      "1",
      "H4 privacy purge lost accounting or retained strategy payloads",
    );

    psqlScalar(database, `DELETE FROM "ModelRun" WHERE id = 'knowledge-h4-run-1';`);
    assert.equal(
      psqlScalar(database, `
        SELECT
          (SELECT count(*) FROM "KnowledgeStrategyExecution"
            WHERE "modelRunId" = 'knowledge-h4-run-1')
          + (SELECT count(*) FROM "KnowledgeStrategyStep"
            WHERE "modelRunId" = 'knowledge-h4-run-1')
          + (SELECT count(*) FROM "KnowledgeStrategyMapOutput"
            WHERE "modelRunId" = 'knowledge-h4-run-1');
      `),
      "0",
      "H4 strategy audit children blocked their owning ModelRun cascade",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function runKnowledgeValidatorRestoreSafetyProof(database: string): void {
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_proc
      WHERE proname = 'knowledge_document_context_valid'
        AND provolatile = 'i'
        AND proparallel = 'r'
        AND proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[];
    `),
    "1",
    "H5 document context validator lacks its immutable restore-safe contract",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_proc
      WHERE proname IN (
          'knowledge_discovery_receipt_valid',
          'knowledge_exact_receipt_valid'
        )
        AND provolatile = 'i'
        AND proparallel = 'r'
        AND proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[];
    `),
    "2",
    "H3 receipt validators lack their immutable restore-safe contracts",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_proc
      WHERE proname IN (
          'knowledge_structured_receipt_valid',
          'knowledge_visual_receipt_valid'
        )
        AND provolatile = 'i'
        AND proparallel = 's'
        AND proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[];
    `),
    "2",
    "H3 auxiliary receipt validators lack restore-safe helper resolution",
  );
}

function runKnowledgeH5DocumentContextMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const h4Index = committed.indexOf(KNOWLEDGE_H4_STRATEGY_EXECUTION_MIGRATION);
  const h5Index = committed.indexOf(KNOWLEDGE_H5_DOCUMENT_CONTEXT_MIGRATION);
  assert.ok(h4Index > 0, "Knowledge H4 strategy execution migration is missing");
  assert.ok(h5Index > h4Index, "Knowledge H5 document context migration is missing");

  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_constraint
      WHERE conname = 'KnowledgeArtifactPassageIndex_document_context_check'
        AND conrelid = '"KnowledgeArtifactPassageIndex"'::regclass
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%knowledge_document_context_valid%';
    `),
    "1",
    "H5 immutable passage context constraint is missing or unvalidated",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_proc
      WHERE proname = 'knowledge_read_source_receipt_valid_v2'
        AND provolatile = 'i'
        AND proparallel = 's';
    `),
    "1",
    "H5 row-aware read receipt validator is not immutable and parallel-safe",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_constraint
      WHERE conname = 'KnowledgeRun_read_receipt_operation_check'
        AND conrelid = '"KnowledgeRun"'::regclass
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%knowledge_read_source_receipt_valid_v2%';
    `),
    "1",
    "H5 row-aware Knowledge read receipt constraint is missing or unvalidated",
  );
  assert.equal(
    psqlScalar(database, `
      WITH receipt AS (
        SELECT jsonb_build_object(
          'contractVersion', 1,
          'direction', 'around',
          'embedding', 'forbidden',
          'locator', 'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
          'resolution', 'exact',
          'resolvedSource', jsonb_build_object(
            'sourceAlias', 'S1',
            'sourceArtifactId', 'artifact-1',
            'sourceId', 'source-1',
            'sourceName', 'Synthetic source',
            'sourceVersionId', 'source-version-1'
          ),
          'target', jsonb_build_object(
            'kind', 'row',
            'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30'
          ),
          'version', 1,
          'window', 1
        ) AS value
      )
      SELECT count(*) FROM receipt
      WHERE knowledge_read_source_receipt_valid_v2(
        'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
        value
      )
      AND public.knowledge_read_receipt_canonical_locator(value -> 'target') =
        'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30';
    `),
    "1",
    "H5 rejected a canonical exact table-row read receipt",
  );
  assert.equal(
    psqlScalar(database, `
      WITH receipt AS (
        SELECT jsonb_build_object(
          'contractVersion', 1,
          'direction', 'around',
          'embedding', 'forbidden',
          'locator', 'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
          'resolution', 'exact',
          'resolvedSource', jsonb_build_object(
            'sourceAlias', 'S1',
            'sourceArtifactId', 'artifact-1',
            'sourceId', 'source-1',
            'sourceName', 'Synthetic source',
            'sourceVersionId', 'source-version-1'
          ),
          'target', jsonb_build_object(
            'kind', 'row',
            'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30'
          ),
          'version', 1,
          'window', 1
        ) AS value
      ), malformed(value) AS (
        SELECT jsonb_set(
          value,
          '{target,rowId}',
          '"ktr_4A5F44F948D8C2CF5B6C787953CF3B30"'::jsonb
        ) FROM receipt
        UNION ALL
        SELECT jsonb_set(value, '{locator}', '"row:ktr_bad"'::jsonb) FROM receipt
        UNION ALL
        SELECT jsonb_set(value, '{target,privateDebug}', 'true'::jsonb) FROM receipt
      )
      SELECT count(*) FROM malformed
      WHERE NOT knowledge_read_source_receipt_valid_v2(
        value ->> 'locator',
        value
      );
    `),
    "3",
    "H5 accepted a malformed, noncanonical, or extended table-row read receipt",
  );
  psqlScalar(database, `
    INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
    VALUES ('knowledge-h5-owner', 'H5 document-context owner', 'user', 'active', CURRENT_TIMESTAMP);
    INSERT INTO "Chat" (id, "userId", title, "updatedAt")
    VALUES ('knowledge-h5-chat', 'knowledge-h5-owner', 'H5 row receipt', CURRENT_TIMESTAMP);
    INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
    VALUES ('knowledge-h5-message', 'knowledge-h5-chat', 'user', '{}'::jsonb, CURRENT_TIMESTAMP);
    INSERT INTO "ModelRun" (
      id, "chatId", "userId", "userMessageId", provider, "modelId", status,
      "normalizedRequest", "updatedAt"
    ) VALUES (
      'knowledge-h5-run', 'knowledge-h5-chat', 'knowledge-h5-owner',
      'knowledge-h5-message', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "ModelRunToolCall" (
      id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
      arguments, state, "startedAt", "completedAt", "updatedAt"
    ) VALUES (
      'knowledge-h5-call', 'knowledge-h5-run', 0, 0, 'knowledge-h5-provider-call',
      'read_source', '{"query":"page 1"}'::jsonb, 'complete',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeRun" (
      id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
      outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
      "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
    ) VALUES (
      'knowledge-h5-row-operation', 'knowledge-h5-run', 'knowledge-h5-call', 1,
      'read_source', 'page 1', 'base_empty', 'rrf_k60', 8, 8, 0, 0.01,
      '[{"baseName":"H5 row fixture","ordinal":0}]'::jsonb, '[]'::jsonb,
      'Knowledge retrieval returned no indexed passages: base_empty.', '[]'::jsonb,
      1, CURRENT_TIMESTAMP
    );
    SELECT 'knowledge-h5-row-ready';
  `);
  psqlScalar(database, `
    UPDATE "KnowledgeRun"
    SET
      query = 'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
      "readReceipt" = jsonb_build_object(
        'contractVersion', 1,
        'direction', 'around',
        'embedding', 'forbidden',
        'locator', 'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
        'resolution', 'exact',
        'resolvedSource', jsonb_build_object(
          'sourceAlias', 'S1',
          'sourceArtifactId', 'knowledge-read-artifact',
          'sourceId', 'knowledge-read-source',
          'sourceName', 'Legacy read Source',
          'sourceVersionId', 'knowledge-read-source-version'
        ),
        'target', jsonb_build_object(
          'kind', 'row',
          'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30'
        ),
        'version', 1,
        'window', 1
      )
    WHERE id = 'knowledge-h5-row-operation';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM "KnowledgeRun"
      WHERE id = 'knowledge-h5-row-operation'
        AND query = 'row:ktr_4a5f44f948d8c2cf5b6c787953cf3b30'
        AND "readReceipt" #>> '{target,rowId}' =
          'ktr_4a5f44f948d8c2cf5b6c787953cf3b30';
    `),
    "1",
    "H5 row-aware Knowledge read receipt did not persist through the DB constraint",
  );
  for (const [label, command] of [
    [
      "uppercase row identity",
      `UPDATE "KnowledgeRun" SET "readReceipt" = jsonb_set(
        "readReceipt", '{target,rowId}',
        '"ktr_4A5F44F948D8C2CF5B6C787953CF3B30"'::jsonb
      ) WHERE id = 'knowledge-h5-row-operation';`,
    ],
    [
      "short row identity",
      `UPDATE "KnowledgeRun" SET "readReceipt" = jsonb_set(
        "readReceipt", '{target,rowId}',
        '"ktr_4a5f44f948d8c2cf5b6c787953cf3b3"'::jsonb
      ) WHERE id = 'knowledge-h5-row-operation';`,
    ],
    [
      "extra row target field",
      `UPDATE "KnowledgeRun" SET "readReceipt" = jsonb_set(
        "readReceipt", '{target,privateDebug}', 'true'::jsonb
      ) WHERE id = 'knowledge-h5-row-operation';`,
    ],
    [
      "row locator mismatch",
      `UPDATE "KnowledgeRun" SET "readReceipt" = jsonb_set(
        "readReceipt", '{locator}', '"row:ktr_00000000000000000000000000000000"'::jsonb
      ) WHERE id = 'knowledge-h5-row-operation';`,
    ],
  ] as const) {
    const mutation = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", command,
    ]);
    assert.notEqual(mutation.status, 0, `H5 accepted ${label}`);
    assert.match(
      `${mutation.stdout}\n${mutation.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      `H5 ${label} did not fail with the stable read receipt constraint`,
    );
  }
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'KnowledgeArtifactPassageIndex'
        AND column_name = 'documentContext'
        AND data_type = 'jsonb'
        AND is_nullable = 'YES';
    `),
    "1",
    "H5 passage context column is missing or changed legacy-null compatibility",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_trigger
      WHERE tgrelid = '"KnowledgeArtifactPassageIndex"'::regclass
        AND tgname = 'KnowledgeArtifactPassageIndex_immutable'
        AND tgenabled = 'O'
        AND NOT tgisinternal;
    `),
    "1",
    "H5 passage context is not covered by the ready-artifact immutability guard",
  );
  assert.equal(
    psqlScalar(database, `
      WITH base_context AS (
        SELECT jsonb_build_object(
          'ambiguityReasons', jsonb_build_array(),
          'locator', jsonb_build_object(
            'blockId', 'block-1',
            'headerLineage', jsonb_build_array(jsonb_build_object(
              'columnEnd', 0,
              'columnStart', 0,
              'rowIndex', 0,
              'text', 'Actual'
            )),
            'kind', 'table_row',
            'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
            'rowIndex', 1,
            'rowKind', 'data'
          ),
          'observations', jsonb_build_array(jsonb_build_object(
            'ambiguityReasons', jsonb_build_array(),
            'confidence', 0.98,
            'date', '2026-08-20',
            'effectiveFrom', NULL,
            'effectiveTo', NULL,
            'metric', 'Glucose',
            'normalizedValue', '5.4',
            'origin', jsonb_build_object(
              'columnEnd', 0,
              'columnStart', 0,
              'kind', 'table_cell'
            ),
            'rawValue', '5,4',
            'role', 'observation',
            'subject', 'P-1',
            'unit', 'mmol/L',
            'valueKind', 'number'
          )),
          'version', 1
        ) AS value
      ), valid_context(value) AS (
        SELECT value FROM base_context
        UNION ALL
        SELECT jsonb_set(value, '{locator}', jsonb_build_object(
          'blockId', 'block-1',
          'columnEnd', 0,
          'columnStart', 0,
          'headerLineage', value #> '{locator,headerLineage}',
          'kind', 'table_row_projection',
          'projectionCount', 2,
          'projectionIndex', 0,
          'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
          'rowIndex', 1,
          'rowKind', 'data'
        )) FROM base_context
        UNION ALL
        SELECT jsonb_set(value, '{locator}', jsonb_build_object(
          'blockId', 'block-1',
          'columnEnd', 7,
          'columnStart', 7,
          'headerLineage', jsonb_build_array(jsonb_build_object(
            'columnEnd', 7,
            'columnStart', 7,
            'rowIndex', 0,
            'text', 'Actual'
          )),
          'kind', 'table_row_projection',
          'projectionCount', 8,
          'projectionIndex', 7,
          'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
          'rowIndex', 1,
          'rowKind', 'data'
        )) FROM base_context
        UNION ALL
        SELECT jsonb_set(
          jsonb_set(value, '{locator}', '{
            "fieldGroupId":"field-group-1",
            "kind":"field_pair",
            "labelCellId":1,
            "valueCellId":2
          }'::jsonb),
          '{observations,0,origin}',
          '{"cellId":2,"kind":"field_cell"}'::jsonb
        ) FROM base_context
        UNION ALL
        SELECT jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(value, '{locator}', '{
                "candidateCellIds":[6,7],
                "cellId":5,
                "fieldGroupId":"field-group-1",
                "kind":"field_ambiguous"
              }'::jsonb),
              '{ambiguityReasons}',
              '["competing_pair"]'::jsonb
            ),
            '{observations,0,ambiguityReasons}',
            '["competing_pair"]'::jsonb
          ),
          '{observations,0,origin}',
          '{"cellId":5,"kind":"field_cell"}'::jsonb
        ) FROM base_context
      )
      SELECT count(*) FROM valid_context
      WHERE "knowledge_document_context_valid"(value);
    `),
    "5",
    "H5 rejected a canonical versioned table, projection, pair, or ambiguity context",
  );
  assert.equal(
    psqlScalar(database, `
      WITH valid_context AS (
        SELECT jsonb_build_object(
          'ambiguityReasons', jsonb_build_array(),
          'locator', jsonb_build_object(
            'blockId', 'block-1',
            'headerLineage', jsonb_build_array(jsonb_build_object(
              'columnEnd', 0,
              'columnStart', 0,
              'rowIndex', 0,
              'text', 'Actual'
            )),
            'kind', 'table_row',
            'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
            'rowIndex', 1,
            'rowKind', 'data'
          ),
          'observations', jsonb_build_array(jsonb_build_object(
            'ambiguityReasons', jsonb_build_array(),
            'confidence', 0.98,
            'date', '2026-08-20',
            'effectiveFrom', NULL,
            'effectiveTo', NULL,
            'metric', 'Glucose',
            'normalizedValue', '5.4',
            'origin', jsonb_build_object(
              'columnEnd', 0,
              'columnStart', 0,
              'kind', 'table_cell'
            ),
            'rawValue', '5,4',
            'role', 'observation',
            'subject', 'P-1',
            'unit', 'mmol/L',
            'valueKind', 'number'
          )),
          'version', 1
        ) AS value
      ), malformed(value) AS (
        SELECT value || '{"unexpected":true}'::jsonb FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{locator,rowId}', '"ktr_bad"'::jsonb)
          FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{observations,0,date}', '"2026-02-30"'::jsonb)
          FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{ambiguityReasons}', '["missing_header"]'::jsonb)
          FROM valid_context
        UNION ALL
        SELECT jsonb_set(
          value,
          '{observations,0,rawValue}',
          to_jsonb(repeat('x', 262145))
        ) FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{locator}', '{}'::jsonb) FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{version}', '"1"'::jsonb) FROM valid_context
        UNION ALL
        SELECT jsonb_set(value, '{locator}', jsonb_build_object(
          'blockId', 'block-1',
          'columnEnd', 8,
          'columnStart', 8,
          'headerLineage', jsonb_build_array(jsonb_build_object(
            'columnEnd', 8,
            'columnStart', 8,
            'rowIndex', 0,
            'text', 'Actual'
          )),
          'kind', 'table_row_projection',
          'projectionCount', 9,
          'projectionIndex', 8,
          'rowId', 'ktr_4a5f44f948d8c2cf5b6c787953cf3b30',
          'rowIndex', 1,
          'rowKind', 'data'
        )) FROM valid_context
      )
      SELECT count(*) FROM malformed
      WHERE NOT "knowledge_document_context_valid"(value);
    `),
    "8",
    "H5 accepted malformed, oversized, or non-versioned document context",
  );
}

function runKnowledgeH6SemanticShadowMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const h5Index = committed.indexOf(KNOWLEDGE_H5_DOCUMENT_CONTEXT_MIGRATION);
  const h6Index = committed.indexOf(KNOWLEDGE_H6_SEMANTIC_SHADOW_MIGRATION);
  const deploymentIndex = committed.indexOf(KNOWLEDGE_H6_SEMANTIC_DEPLOYMENT_MIGRATION);
  assert.ok(h5Index > 0, "Knowledge H5 document context migration is missing");
  assert.ok(h6Index > h5Index, "Knowledge H6 semantic shadow migration is missing");
  assert.ok(
    deploymentIndex > h6Index,
    "Knowledge H6 semantic deployment migration is missing",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_constraint
      WHERE conname IN (
        'KnowledgeSemanticShadowResult_shape_check',
        'KnowledgeSemanticShadowResult_retrievalSessionId_fkey'
      )
        AND convalidated;
    `),
    "2",
    "H6 semantic shadow constraints are missing or unvalidated",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_trigger
      WHERE tgname = 'KnowledgeSemanticShadowResult_accepted_immutable'
        AND tgrelid = '"KnowledgeSemanticShadowResult"'::regclass
        AND NOT tgisinternal;
    `),
    "1",
    "H6 semantic shadow immutability trigger is missing",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT (
        pg_get_functiondef(
          'guard_accepted_knowledge_semantic_shadow_result_write()'::regprocedure
        ) LIKE '%IF final_attempt_id IS NOT NULL THEN%'
      )::TEXT;
    `),
    "true",
    "H6 current empty dispatch lineage can fall back to broader run bindings",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT (
        to_regprocedure(
          'knowledge_semantic_profile_authorized_shadow_result_valid(text,integer,text,text,text,integer,boolean,text,text[],jsonb,jsonb,text,timestamp without time zone,timestamp without time zone)'
        ) IS NOT NULL
        AND to_regprocedure(
          'knowledge_semantic_validator_deployment_released(jsonb)'
        ) IS NOT NULL
        AND pg_get_functiondef(
          'guard_accepted_knowledge_semantic_shadow_result_write()'::regprocedure
        ) LIKE '%Knowledge semantic shadow result frozen selection mismatch%'
        AND pg_get_functiondef(
          'guard_accepted_knowledge_semantic_shadow_result_write()'::regprocedure
        ) LIKE '%profile_execution_authority IS DISTINCT FROM ''installation''%'
        AND pg_get_functiondef(
          'guard_accepted_knowledge_semantic_shadow_result_write()'::regprocedure
        ) LIKE '%knowledge_semantic_validator_deployment_released%'
        AND pg_get_functiondef(
          'guard_accepted_knowledge_semantic_shadow_result_write()'::regprocedure
        ) LIKE '%OLD."purgedAt" IS NULL%'
      )::TEXT;
    `),
    "true",
    "H6 local semantic deployment lost its frozen Profile authority guard",
  );

  const zeroUsage = `jsonb_build_object(
    'cacheWriteInputTokens', NULL,
    'cachedInputTokens', NULL,
    'estimatedCostMicros', NULL,
    'inputTokens', NULL,
    'outputTokens', NULL,
    'reasoningTokens', NULL,
    'requests', 0,
    'totalTokens', NULL
  )`;
  const semanticReceiptHash = (body: string) => `encode(sha256(convert_to(
    "knowledge_semantic_canonical_json"(${body}), 'UTF8'
  )), 'hex')`;
  const sealedDiagnostic = (body: string) => `(
    ${body} || jsonb_build_object('receiptHash', ${semanticReceiptHash(body)})
  )`;
  const claimTypeCounts = `jsonb_build_object(
    'comparison', 0, 'coverage_claim', 0, 'derived_arithmetic', 0,
    'explicit_inference', 0, 'general_knowledge', 0, 'non_factual', 0,
    'source_fact', 0, 'source_summary', 0, 'temporal_observation', 0,
    'versioned_fact', 0
  )`;
  const decisionCounts = `jsonb_build_object(
    'contradicted', 0, 'supported', 0, 'uncertain', 0, 'unsupported', 0
  )`;
  const metrics = `jsonb_build_object(
    'attributableClaimCount', 0,
    'blockingApplied', false,
    'citationLocalClaimCount', 0,
    'claimCount', 0,
    'claimTypeCounts', ${claimTypeCounts},
    'confidenceBucketCounts', jsonb_build_object(
      'high', 0, 'low', 0, 'medium', 0, 'unavailable', 0
    ),
    'decisionCounts', ${decisionCounts},
    'egress', 'none',
    'executionStatus', 'complete',
    'failureReasonCode', NULL,
    'latencyMs', NULL,
    'mode', 'shadow',
    'recommendedActionCounts', jsonb_build_object('retain', 0, 'review', 0),
    'semanticProof', false,
    'usage', ${zeroUsage},
    'validatorProfile', 'structural-baseline-v1',
    'validatorVersion', 1,
    'version', 1
  )`;
  const summary = `jsonb_build_object(
    'attributableClaimCount', 0,
    'citationLocalClaimCount', 0,
    'claimCount', 0,
    'claimTypeCounts', ${claimTypeCounts},
    'decisionCounts', ${decisionCounts}
  )`;
  const diagnosticBody = `jsonb_build_object(
    'answerHash', repeat('a', 64),
    'attemptId', NULL,
    'blockingApplied', false,
    'claims', '[]'::jsonb,
    'evidenceReceiptHash', repeat('b', 64),
    'executionStatus', 'complete',
    'failureReasonCode', NULL,
    'latencyMs', NULL,
    'runId', 'knowledge-h6-run',
    'sessionId', 'knowledge-h6-session',
    'summary', ${summary},
    'usage', ${zeroUsage},
    'validator', jsonb_build_object(
      'egress', 'none',
      'profileId', 'structural-baseline-v1',
      'profileVersion', 1,
      'semanticProof', false
    ),
    'version', 1
  )`;
  const diagnosticReceiptHash = semanticReceiptHash(diagnosticBody);
  const diagnostic = sealedDiagnostic(diagnosticBody);
  const oneClaimTypeCounts = `jsonb_build_object(
    'comparison', 0, 'coverage_claim', 0, 'derived_arithmetic', 0,
    'explicit_inference', 0, 'general_knowledge', 0, 'non_factual', 0,
    'source_fact', 1, 'source_summary', 0, 'temporal_observation', 0,
    'versioned_fact', 0
  )`;
  const oneDecisionCounts = `jsonb_build_object(
    'contradicted', 0, 'supported', 0, 'uncertain', 1, 'unsupported', 0
  )`;
  const oneMetrics = `jsonb_build_object(
    'attributableClaimCount', 0,
    'blockingApplied', false,
    'citationLocalClaimCount', 1,
    'claimCount', 1,
    'claimTypeCounts', ${oneClaimTypeCounts},
    'confidenceBucketCounts', jsonb_build_object(
      'high', 0, 'low', 0, 'medium', 0, 'unavailable', 1
    ),
    'decisionCounts', ${oneDecisionCounts},
    'egress', 'none',
    'executionStatus', 'complete',
    'failureReasonCode', NULL,
    'latencyMs', NULL,
    'mode', 'shadow',
    'recommendedActionCounts', jsonb_build_object('retain', 0, 'review', 1),
    'semanticProof', false,
    'usage', ${zeroUsage},
    'validatorProfile', 'structural-baseline-v1',
    'validatorVersion', 1,
    'version', 1
  )`;
  const oneClaim = `jsonb_build_object(
    'answerEnd', 5,
    'answerStart', 0,
    'attributableHandles', '[]'::jsonb,
    'citationHandles', jsonb_build_array('K1'),
    'claimHash', repeat('d', 64),
    'confidence', 0,
    'confidenceBucket', 'unavailable',
    'contextKeyHash', NULL,
    'decision', 'uncertain',
    'locatorStates', jsonb_build_array(jsonb_build_object('handle', 'K1', 'state', 'valid')),
    'neighborhoodHash', repeat('e', 64),
    'neighborhoodRule', 'inline',
    'ordinal', 1,
    'reasonFamily', 'structural_baseline',
    'recommendedAction', 'review',
    'sourceShape', 'prose',
    'type', 'source_fact',
    'unknownCitationHandles', '[]'::jsonb,
    'version', 1
  )`;
  const oneSummary = `jsonb_build_object(
    'attributableClaimCount', 0,
    'citationLocalClaimCount', 1,
    'claimCount', 1,
    'claimTypeCounts', ${oneClaimTypeCounts},
    'decisionCounts', ${oneDecisionCounts}
  )`;
  const oneDiagnosticBody = `jsonb_build_object(
    'answerHash', repeat('a', 64),
    'attemptId', NULL,
    'blockingApplied', false,
    'claims', jsonb_build_array(${oneClaim}),
    'evidenceReceiptHash', repeat('b', 64),
    'executionStatus', 'complete',
    'failureReasonCode', NULL,
    'latencyMs', NULL,
    'runId', 'knowledge-h6-run',
    'sessionId', 'knowledge-h6-session',
    'summary', ${oneSummary},
    'usage', ${zeroUsage},
    'validator', jsonb_build_object(
      'egress', 'none',
      'profileId', 'structural-baseline-v1',
      'profileVersion', 1,
      'semanticProof', false
    ),
    'version', 1
  )`;
  const oneDiagnosticReceiptHash = semanticReceiptHash(oneDiagnosticBody);
  const oneDiagnostic = sealedDiagnostic(oneDiagnosticBody);
  const mismatchedConfidenceBody = `jsonb_set(
    ${oneDiagnosticBody}, '{claims,0,confidence}', '0.2'::jsonb
  )`;
  const shiftedClaimTypeCounts = `jsonb_set(
    jsonb_set(${oneClaimTypeCounts}, '{source_fact}', '0'::jsonb),
    '{general_knowledge}', '1'::jsonb
  )`;
  const localMetrics = `jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(${oneMetrics}, '{egress}', '"local"'::jsonb),
        '{semanticProof}', 'true'::jsonb
      ),
      '{validatorProfile}', '"local-nli-v1"'::jsonb
    ),
    '{validatorVersion}', '4'::jsonb
  )`;
  const localDiagnosticBody = `jsonb_set(
    ${oneDiagnosticBody},
    '{validator}',
    '{"egress":"local","profileId":"local-nli-v1","profileVersion":4,"semanticProof":true}'::jsonb
  )`;
  const localDiagnostic = sealedDiagnostic(localDiagnosticBody);
  const localDiagnosticReceiptHash = semanticReceiptHash(localDiagnosticBody);
  const semanticDeployment = `jsonb_build_object(
    'authorization', 'profile_authorized',
    'calibrationOutputSha256', repeat('d', 64),
    'candidateId', 'local_multilingual_nli_v1',
    'candidateIdentitySha256', repeat('a', 64),
    'candidateImplementationSha256', repeat('b', 64),
    'egress', 'local',
    'executionClass', 'real_model',
    'finalOutputSha256', repeat('e', 64),
    'profileId', 'local-nli-v1',
    'qualityEvidenceSha256', repeat('f', 64),
    'recoveryMode', 'deterministic_replay',
    'selectionFreezeVersion', 'knowledge-semantic-selection-freeze-v1',
    'selectionManifestSha256', repeat('c', 64),
    'semanticProof', true,
    'validatorVersion', 4,
    'version', 1
  )`;
  assert.equal(
    psqlScalar(database, `
      SELECT
        "knowledge_semantic_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'structural-baseline-v1',
          1, false, 'none', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${oneDiagnostic}, ${oneMetrics}, ${oneDiagnosticReceiptHash},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT || ':' ||
        "knowledge_semantic_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'structural-baseline-v1',
          1, false, 'none', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${sealedDiagnostic(mismatchedConfidenceBody)},
          ${oneMetrics}, ${semanticReceiptHash(mismatchedConfidenceBody)},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT || ':' ||
        "knowledge_semantic_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'structural-baseline-v1',
          1, false, 'none', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${sealedDiagnostic(`jsonb_set(${oneDiagnosticBody},
            '{summary,claimTypeCounts}', ${shiftedClaimTypeCounts})`)},
          jsonb_set(${oneMetrics}, '{claimTypeCounts}', ${shiftedClaimTypeCounts}),
          ${semanticReceiptHash(`jsonb_set(${oneDiagnosticBody},
            '{summary,claimTypeCounts}', ${shiftedClaimTypeCounts})`)},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT;
    `),
    "true:false:false",
    "H6 strict claim derivation or claim-derived metrics CHECK regressed",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT
        "knowledge_semantic_validator_deployment_valid"(${semanticDeployment})::TEXT || ':' ||
        "knowledge_semantic_validator_deployment_valid"(
          jsonb_set(${semanticDeployment}, '{egress}', '"external"'::jsonb)
        )::TEXT || ':' ||
        "knowledge_semantic_validator_deployment_valid"(
          jsonb_set(${semanticDeployment}, '{candidateId}', '"system_model_semantic_v1"'::jsonb)
        )::TEXT || ':' ||
        "knowledge_semantic_validator_deployment_released"(${semanticDeployment})::TEXT || ':' ||
        "knowledge_semantic_profile_authorized_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'local-nli-v1',
          4, true, 'local', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${localDiagnostic}, ${localMetrics}, ${localDiagnosticReceiptHash},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT || ':' ||
        "knowledge_semantic_profile_authorized_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'local-nli-v1',
          4, true, 'external', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${localDiagnostic}, ${localMetrics}, ${localDiagnosticReceiptHash},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT || ':' ||
        "knowledge_semantic_profile_authorized_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'local-nli-v1',
          4, true, 'local', ARRAY[]::TEXT[],
          ${localDiagnostic}, ${localMetrics}, ${localDiagnosticReceiptHash},
          CURRENT_TIMESTAMP::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT || ':' ||
        "knowledge_semantic_profile_authorized_shadow_result_valid"(
          'knowledge-h6-session', 1, 'shadow', 'complete', 'local-nli-v1',
          4, true, 'local', ARRAY['knowledge-h6-profile-revision']::TEXT[],
          ${sealedDiagnostic(`jsonb_set(${localDiagnosticBody},
            '{validator,privatePayload}', '"private"'::jsonb)`)},
          ${localMetrics}, ${semanticReceiptHash(`jsonb_set(${localDiagnosticBody},
            '{validator,privatePayload}', '"private"'::jsonb)`)},
          NULL::TIMESTAMP(3), CURRENT_TIMESTAMP::TIMESTAMP(3)
        )::TEXT;
    `),
    "true:false:false:false:true:false:false:false",
    "H6 local deployment release, privacy-shape, or external fail-closed guard regressed",
  );

  psqlScalar(database, `
    INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
    VALUES ('knowledge-h6-owner', 'H6 owner', 'user', 'active', CURRENT_TIMESTAMP);
    INSERT INTO "Chat" (id, "userId", title, "updatedAt")
    VALUES ('knowledge-h6-chat', 'knowledge-h6-owner', 'H6 shadow', CURRENT_TIMESTAMP);
    INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
    VALUES ('knowledge-h6-message', 'knowledge-h6-chat', 'user', '{}'::jsonb, CURRENT_TIMESTAMP);
    INSERT INTO "ModelRun" (
      id, "chatId", "userId", "userMessageId", provider, "modelId", status,
      "normalizedRequest", "updatedAt"
    ) VALUES (
      'knowledge-h6-run', 'knowledge-h6-chat', 'knowledge-h6-owner',
      'knowledge-h6-message', 'fixture', 'fixture-model', 'complete', '{}'::jsonb,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeRetrievalSession" (
      id, "modelRunId", version, "originalIntent", "scopeSnapshot", "strategySnapshot",
      "readinessSummary", "coverageRequirements", "citationContract", "acceptedAt",
      "receiptHash", "updatedAt"
    ) VALUES (
      'knowledge-h6-session', 'knowledge-h6-run', 2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, repeat('b', 64),
      CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeGroundingResult" (
      "retrievalSessionId", outcome, "originalAnswerHash", "finalAnswerHash", issues,
      "repairCount"
    ) VALUES (
      'knowledge-h6-session', 'passed', repeat('d', 64), repeat('a', 64), '{}'::jsonb, 0
    );
    INSERT INTO "KnowledgeSemanticShadowResult" (
      "retrievalSessionId", version, mode, "executionStatus", "validatorProfile",
      "validatorVersion", "semanticProof", "egressMode", "profileRevisionIds",
      diagnostic, "contentFreeMetrics", "receiptHash"
    ) VALUES (
      'knowledge-h6-session', 1, 'shadow', 'complete', 'structural-baseline-v1', 1,
      false, 'none', ARRAY[]::TEXT[], ${diagnostic},
      ${metrics}, ${diagnosticReceiptHash}
    );
    SELECT 'knowledge-h6-shadow-ready';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT
        (SELECT count(*) FROM "KnowledgeSemanticShadowResult"
          WHERE "retrievalSessionId" = 'knowledge-h6-session'
            AND "contentFreeMetrics" ->> 'mode' = 'shadow'
            AND diagnostic ->> 'runId' = 'knowledge-h6-run')::TEXT || ':' ||
        (SELECT count(*) FROM "KnowledgeProviderAttempt"
          WHERE "modelRunId" = 'knowledge-h6-run')::TEXT;
    `),
    "1:0",
    "H6 local structural baseline required a provider attempt or failed to persist",
  );

  const mutate = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      UPDATE "KnowledgeSemanticShadowResult"
      SET "validatorVersion" = 2
      WHERE "retrievalSessionId" = 'knowledge-h6-session';
    `,
  ]);
  assert.notEqual(mutate.status, 0, "H6 accepted mutation of an accepted shadow result");
  assert.match(
    `${mutate.stdout}\n${mutate.stderr}`,
    /accepted Knowledge semantic shadow result is immutable/u,
    "H6 immutable shadow mutation failed without the stable trigger",
  );

  const invalid = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      SET LOCAL aiqsa.knowledge_purge = 'on';
      UPDATE "KnowledgeSemanticShadowResult"
      SET "egressMode" = 'external'
      WHERE "retrievalSessionId" = 'knowledge-h6-session';
    `,
  ]);
  assert.notEqual(invalid.status, 0, "H6 accepted external egress in structural shadow storage");
  assert.match(
    `${invalid.stdout}\n${invalid.stderr}`,
    /accepted Knowledge semantic shadow result is immutable/u,
    "H6 purge update bypassed monotonic semantic-shadow scrubbing",
  );

  const purgePromotion = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      SET LOCAL aiqsa.knowledge_purge = 'on';
      UPDATE "KnowledgeSemanticShadowResult"
      SET "executionStatus" = 'complete',
          "validatorProfile" = 'local-nli-v1',
          "validatorVersion" = 4,
          "semanticProof" = true,
          "egressMode" = 'local',
          "profileRevisionIds" = ARRAY['knowledge-h6-profile-revision']::TEXT[],
          diagnostic = ${localDiagnostic},
          "contentFreeMetrics" = ${localMetrics},
          "receiptHash" = ${localDiagnosticReceiptHash}
      WHERE "retrievalSessionId" = 'knowledge-h6-session';
    `,
  ]);
  assert.notEqual(
    purgePromotion.status,
    0,
    "H6 purge bypass promoted structural evidence to an unauthorized semantic proof",
  );
  assert.match(
    `${purgePromotion.stdout}\n${purgePromotion.stderr}`,
    /accepted Knowledge semantic shadow result is immutable/u,
    "H6 purge promotion failed without the monotonic scrub guard",
  );

  const malformedPrivateDiagnostic = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      SET LOCAL aiqsa.knowledge_purge = 'on';
      UPDATE "KnowledgeSemanticShadowResult"
      SET diagnostic = jsonb_set(diagnostic, '{answerHash}', 'null'::jsonb)
      WHERE "retrievalSessionId" = 'knowledge-h6-session';
    `,
  ]);
  assert.notEqual(
    malformedPrivateDiagnostic.status,
    0,
    "H6 accepted a JSON-null private hash in an unpurged diagnostic",
  );
  assert.match(
    `${malformedPrivateDiagnostic.stdout}\n${malformedPrivateDiagnostic.stderr}`,
    /accepted Knowledge semantic shadow result is immutable/u,
    "H6 malformed private diagnostic bypassed monotonic purge scrubbing",
  );

  psqlScalar(database, `
    BEGIN;
    SET LOCAL aiqsa.knowledge_purge = 'on';
    UPDATE "KnowledgeSemanticShadowResult"
    SET diagnostic = NULL,
        "receiptHash" = NULL,
        "profileRevisionIds" = ARRAY[]::TEXT[],
        "purgedAt" = CURRENT_TIMESTAMP
    WHERE "retrievalSessionId" = 'knowledge-h6-session';
    COMMIT;
    SELECT count(*)
    FROM "KnowledgeSemanticShadowResult"
    WHERE "retrievalSessionId" = 'knowledge-h6-session'
      AND diagnostic IS NULL
      AND "receiptHash" IS NULL
      AND cardinality("profileRevisionIds") = 0
      AND "contentFreeMetrics" ->> 'mode' = 'shadow';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM "KnowledgeSemanticShadowResult"
      WHERE "retrievalSessionId" = 'knowledge-h6-session'
        AND "purgedAt" IS NOT NULL
        AND diagnostic IS NULL
        AND "receiptHash" IS NULL
        AND cardinality("profileRevisionIds") = 0;
    `),
    "1",
    "H6 purge capability did not scrub private diagnostic lineage",
  );
  psqlScalar(database, `DELETE FROM "ModelRun" WHERE id = 'knowledge-h6-run'; SELECT 1;`);
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM "KnowledgeSemanticShadowResult"
      WHERE "retrievalSessionId" = 'knowledge-h6-session';
    `),
    "0",
    "H6 shadow audit child blocked or survived its owning ModelRun cascade",
  );
}

function runKnowledgeBasicRuntimeCleanupMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const cleanupIndex = committed.indexOf(KNOWLEDGE_BASIC_RUNTIME_CLEANUP_MIGRATION);
  const deploymentIndex = committed.indexOf(KNOWLEDGE_H6_SEMANTIC_DEPLOYMENT_MIGRATION);
  const retiredPurgeGuardIndex = committed.indexOf(KNOWLEDGE_RETIRED_PURGE_GUARD_MIGRATION);
  assert.ok(
    cleanupIndex > deploymentIndex,
    "Knowledge Basic runtime cleanup migration must follow the historical H6 migration",
  );
  assert.ok(
    retiredPurgeGuardIndex > cleanupIndex,
    "Retired Knowledge purge guard migration must follow the Basic runtime cleanup",
  );
  const cleanupSql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_BASIC_RUNTIME_CLEANUP_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.doesNotMatch(
    cleanupSql,
    /\bUPDATE\s+"KnowledgeRun"\b/iu,
    "Knowledge Basic cleanup must not rewrite immutable historical operation receipts",
  );
  const retiredPurgeGuardSql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_RETIRED_PURGE_GUARD_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.match(
    retiredPurgeGuardSql,
    /CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_run_retired_operation\(\)/u,
    "Retired Knowledge purge migration must replace the existing transition guard",
  );
  assert.doesNotMatch(
    retiredPurgeGuardSql,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"KnowledgeRun"\b/iu,
    "Retired Knowledge purge guard migration must not rewrite historical receipts",
  );

  psqlScalar(database, `
    INSERT INTO "ModelRunToolCall" (
      id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
      arguments, state, "startedAt", "completedAt", "updatedAt"
    ) VALUES
      (
        'knowledge-basic-legacy-structured-call', 'knowledge-h4-run-2', 0, 1,
        'knowledge-basic-legacy-structured-provider-call', 'retrieve_knowledge',
        '{"operation":"structured_analysis"}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-basic-legacy-visual-call', 'knowledge-h4-run-2', 0, 2,
        'knowledge-basic-legacy-visual-provider-call', 'retrieve_knowledge',
        '{"operation":"visual_analysis"}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-basic-legacy-structured-complete-call', 'knowledge-h4-run-2', 0, 4,
        'knowledge-basic-legacy-structured-complete-provider-call', 'retrieve_knowledge',
        '{"operation":"structured_analysis"}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    INSERT INTO "KnowledgeBudgetReservation" (
      id, "modelRunId", "modelRunToolCallId", "operationOrdinal", "phaseOrdinal",
      "subqueryOrdinal", operation, "policyVersion", "idempotencyKey",
      "operationRequest", "operationRequestHash", state,
      "estimatedCandidates", "estimatedRetrievedTokens", "estimatedEmbeddingCalls",
      "estimatedRerankerCalls", "estimatedLatencyMs", "estimatedCostMicros",
      "estimatedValidationSlots", "estimatedRepairSlots", "leaseToken",
      "leaseExpiresAt", "createdAt", "updatedAt"
    ) VALUES
      (
        'knowledge-basic-legacy-structured-reservation', 'knowledge-h4-run-2',
        'knowledge-basic-legacy-structured-call', 2, 0, 1, 'structured_analysis', 1,
        'knowledge-basic-legacy-structured-reservation-key',
        jsonb_build_object(
          'version', 2,
          'reservationId', 'knowledge-basic-legacy-structured-reservation',
          'idempotencyKey', 'knowledge-basic-legacy-structured-reservation-key',
          'operation', 'structured_analysis', 'phaseOrdinal', 0, 'subqueryOrdinal', 1
        ), repeat('1', 64), 'reserved', 1, 1, 0, 0, 10, 0, 0, 0,
        'knowledge-basic-legacy-structured-lease',
        CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-basic-legacy-visual-reservation', 'knowledge-h4-run-2',
        'knowledge-basic-legacy-visual-call', 3, 0, 2, 'visual_analysis', 1,
        'knowledge-basic-legacy-visual-reservation-key',
        jsonb_build_object(
          'version', 2,
          'reservationId', 'knowledge-basic-legacy-visual-reservation',
          'idempotencyKey', 'knowledge-basic-legacy-visual-reservation-key',
          'operation', 'visual_analysis', 'phaseOrdinal', 0, 'subqueryOrdinal', 2
        ), repeat('2', 64), 'reserved', 1, 1, 0, 0, 10, 0, 0, 0,
        'knowledge-basic-legacy-visual-lease',
        CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    INSERT INTO "KnowledgeRun" (
      id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
      outcome, fusion, "candidateLimit", "resultLimit", "candidateCount", threshold,
      "baseEvidence", results, "providerText", "embeddingUsage", "readReceipt",
      "durationMs", "updatedAt"
    ) VALUES
      (
        'knowledge-basic-legacy-structured-run', 'knowledge-h4-run-2',
        'knowledge-basic-legacy-structured-call', 2, 'structured_analysis', 'sum revenue',
        'structured_clarification_required', 'rrf_k60', 40, 8, 0, 0.01,
        '[{"baseName":"Legacy Basic Base","ordinal":0}]'::jsonb, '[]'::jsonb,
        'Clarification required.', '[]'::jsonb,
        '{"question":"Choose Sales or Forecast.","status":"needs_clarification","version":1}'::jsonb,
        1, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-basic-legacy-visual-run', 'knowledge-h4-run-2',
        'knowledge-basic-legacy-visual-call', 3, 'visual_analysis', 'describe chart',
        'complete', 'rrf_k60', 40, 8, 1, 0.01,
        '[{"baseName":"Legacy Basic Base","ordinal":0}]'::jsonb,
        '[{"visualAnalysis":{"status":"available"}}]'::jsonb,
        'Visual analysis available.', '[]'::jsonb,
        '{"status":"available","version":1}'::jsonb,
        1, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-basic-legacy-structured-complete-run', 'knowledge-h4-run-2',
        'knowledge-basic-legacy-structured-complete-call', 5,
        'structured_analysis', 'summarize private revenue',
        'complete', 'rrf_k60', 40, 8, 1, 0.01,
        '[{"baseName":"Legacy Basic Base","ordinal":0},{"baseName":"Retained Basic Base","ordinal":1}]'::jsonb,
        '[{"handle":"K5.1","structuredAnalysis":{"summary":"private legacy structured summary"}}]'::jsonb,
        'Private legacy structured summary.', '[]'::jsonb,
        '{"status":"complete","version":1}'::jsonb,
        1, CURRENT_TIMESTAMP
      );
    SELECT 'knowledge-basic-legacy-analysis-ready';
  `);

  app(database, ["npx", "prisma", "migrate", "deploy"]);
  assertDeployedMigrations(database, committed);

  psqlScalar(database, `
    INSERT INTO "ModelRunToolCall" (
      id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
      arguments, state, "startedAt", "completedAt", "updatedAt"
    ) VALUES
      (
        'knowledge-coexistence-four-binding-call', 'knowledge-h4-run-2', 0, 3,
        'knowledge-coexistence-four-binding-provider-call', 'search_knowledge',
        '{"query":"four binding receipt","sourceAliases":[]}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'knowledge-map-reduce-scoped-call', 'knowledge-h4-run-2', 0, 5,
        'knowledge-map-reduce-scoped-provider-call', 'search_knowledge',
        '{"query":"scoped row","sourceAliases":["S1"]}'::jsonb, 'complete',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    INSERT INTO "KnowledgeRun" (
      id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
      outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
      "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
    ) VALUES (
      'knowledge-coexistence-four-binding-run', 'knowledge-h4-run-2',
      'knowledge-coexistence-four-binding-call', 4, 'automatic_search',
      'four binding receipt', 'base_empty', 'weighted_rrf_v2', 64, 16, 0,
      (SELECT jsonb_agg(jsonb_build_object(
        'baseName', 'Base ' || ordinal,
        'knowledgeBaseId', 'base-' || ordinal,
        'ordinal', ordinal - 1
      ) ORDER BY ordinal) FROM generate_series(1, 4) AS ordinal),
      '[]'::jsonb, 'No matching evidence.',
      (SELECT jsonb_agg(jsonb_build_object(
        'bindingOrdinal', ordinal - 1,
        'providerModelId', 'embedding-' || ordinal
      ) ORDER BY ordinal) FROM generate_series(1, 4) AS ordinal),
      1, CURRENT_TIMESTAMP
    ), (
      'knowledge-map-reduce-scoped-run', 'knowledge-h4-run-2',
      'knowledge-map-reduce-scoped-call', 6, 'automatic_search',
      'scoped row', 'no_relevant_evidence', 'weighted_rrf_v2', 64, 8, 0,
      '[{"baseName":"Scoped Base","ordinal":0}]'::jsonb,
      '[]'::jsonb, 'No relevant evidence.', '[]'::jsonb, 1, CURRENT_TIMESTAMP
    );
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT jsonb_array_length("baseEvidence")::text || ':' ||
        jsonb_array_length("embeddingUsage")::text
      FROM "KnowledgeRun"
      WHERE id = 'knowledge-coexistence-four-binding-run';
    `),
    "4:4",
    "Knowledge coexistence failed to persist a four-binding operation receipt",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT string_agg("resultLimit"::text, ':' ORDER BY "invocationOrdinal")
      FROM "KnowledgeRun"
      WHERE id IN (
        'knowledge-coexistence-four-binding-run',
        'knowledge-map-reduce-scoped-run'
      );
    `),
    "16:8",
    "Knowledge map/reduce limits did not admit broad sixteen and scoped eight",
  );

  for (const [label, command] of [
    [
      "arbitrary broad limit",
      `UPDATE "KnowledgeRun" SET "resultLimit" = 9
        WHERE id = 'knowledge-coexistence-four-binding-run';`,
    ],
    [
      "oversized scoped limit",
      `UPDATE "KnowledgeRun" SET "resultLimit" = 16
        WHERE id = 'knowledge-map-reduce-scoped-run';`,
    ],
  ] as const) {
    const invalidLimit = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database, "--command", command,
    ]);
    assert.notEqual(invalidLimit.status, 0, `Knowledge accepted ${label}`);
    assert.match(
      `${invalidLimit.stdout}\n${invalidLimit.stderr}`,
      /knowledge_basic_focused_run_contract_invalid/u,
      `${label} failed without the map/reduce checkpoint guard`,
    );
  }

  assert.equal(
    psqlScalar(database, `
      SELECT
        (SELECT count(*) FROM "KnowledgeRun"
          WHERE id IN (
            'knowledge-basic-legacy-structured-run',
            'knowledge-basic-legacy-structured-complete-run',
            'knowledge-basic-legacy-visual-run'
          )
          AND operation IN ('structured_analysis', 'visual_analysis')
          AND "readReceipt" IS NOT NULL)
        + (SELECT count(*) FROM "KnowledgeBudgetReservation"
          WHERE id IN (
            'knowledge-basic-legacy-structured-reservation',
            'knowledge-basic-legacy-visual-reservation'
          )
          AND operation IN ('structured_analysis', 'visual_analysis'));
    `),
    "5",
    "Basic cleanup rejected or rewrote accepted historical analysis records",
  );

  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM pg_trigger
      WHERE tgname IN (
        'KnowledgeRun_retired_operation_guard',
        'KnowledgeBudgetReservation_retired_operation_guard'
      )
        AND tgenabled = 'O'
        AND NOT tgisinternal;
    `),
    "2",
    "Retired Knowledge write guards are missing or disabled",
  );

  const rejectedRetiredInsert = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      BEGIN;
        INSERT INTO "ModelRunToolCall" (
          id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName",
          arguments, state, "startedAt", "completedAt", "updatedAt"
        ) VALUES (
          'knowledge-basic-rejected-retired-call', 'knowledge-h4-run-2', 0, 6,
          'knowledge-basic-rejected-retired-provider-call', 'retrieve_knowledge',
          '{"operation":"structured_analysis"}'::jsonb, 'complete',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
        INSERT INTO "KnowledgeRun" (
          id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation,
          query, outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
          "baseEvidence", results, "providerText", "embeddingUsage", "durationMs",
          "updatedAt"
        ) VALUES (
          'knowledge-basic-rejected-retired-run', 'knowledge-h4-run-2',
          'knowledge-basic-rejected-retired-call', 6, 'structured_analysis',
          'new retired write', 'complete', 'rrf_k60', 40, 8, 1,
          '[{"baseName":"New retired Base","ordinal":0}]'::jsonb,
          '[{"structuredAnalysis":{"summary":"must be rejected"}}]'::jsonb,
          'Must be rejected.', '[]'::jsonb, 1, CURRENT_TIMESTAMP
        );
      COMMIT;
    `,
  ]);
  assert.notEqual(
    rejectedRetiredInsert.status,
    0,
    "Retired Knowledge purge guard admitted a new analysis receipt",
  );
  assert.match(
    `${rejectedRetiredInsert.stdout}\n${rejectedRetiredInsert.stderr}`,
    /KnowledgeRun_read_receipt_operation_check/u,
    "Retired analysis INSERT failed without the production transition guard",
  );

  for (const malformedPurge of [
    {
      label: "result-count-changing",
      set: `
        "baseEvidence" = "baseEvidence",
        results = '[]'::jsonb,
        "providerText" = 'Knowledge citation evidence was deleted.'`,
    },
    {
      label: "invalid-handle",
      set: `
        "baseEvidence" = "baseEvidence",
        results = '[{"deleted":true,"handle":"K9999"}]'::jsonb,
        "providerText" = E'Knowledge passages:\n\n[K9999] Deleted Knowledge source.'`,
    },
    {
      label: "content-bearing-result",
      set: `
        "baseEvidence" = "baseEvidence",
        results = '[{"deleted":true,"handle":"K5.1","summary":"private"}]'::jsonb,
        "providerText" = E'Knowledge passages:\n\n[K5.1] Deleted Knowledge source.'`,
    },
    {
      label: "new-base-evidence",
      set: `
        "baseEvidence" = '[{"privatePayload":"new content"}]'::jsonb,
        results = '[{"deleted":true,"handle":"K5.1"}]'::jsonb,
        "providerText" = E'Knowledge passages:\n\n[K5.1] Deleted Knowledge source.'`,
    },
    {
      label: "provider-text-mismatch",
      set: `
        "baseEvidence" = "baseEvidence",
        results = '[{"deleted":true,"handle":"K5.1"}]'::jsonb,
        "providerText" = 'private legacy structured summary'`,
    },
  ] as const) {
    const rejectedPurge = compose([
      "exec", "-T", POSTGRES_SERVICE,
      "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
      "--dbname", database,
      "--command", `
        BEGIN;
          SET LOCAL aiqsa.knowledge_purge = 'on';
          UPDATE "KnowledgeRun"
          SET
            query = 'deleted_knowledge_resource',
            ${malformedPurge.set},
            "readReceipt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = 'knowledge-basic-legacy-structured-complete-run';
        COMMIT;
      `,
    ]);
    assert.notEqual(
      rejectedPurge.status,
      0,
      `Retired Knowledge purge guard admitted a ${malformedPurge.label} tombstone`,
    );
    assert.match(
      `${rejectedPurge.stdout}\n${rejectedPurge.stderr}`,
      /KnowledgeRun_read_receipt_operation_check/u,
      `Malformed ${malformedPurge.label} tombstone failed without the transition guard`,
    );
  }

  const rejectedUnscopedPurge = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `
      UPDATE "KnowledgeRun"
      SET
        query = 'deleted_knowledge_resource',
        "baseEvidence" = "baseEvidence",
        results = '[{"deleted":true,"handle":"K5.1"}]'::jsonb,
        "providerText" = E'Knowledge passages:\n\n[K5.1] Deleted Knowledge source.',
        "readReceipt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-basic-legacy-structured-complete-run';
    `,
  ]);
  assert.notEqual(
    rejectedUnscopedPurge.status,
    0,
    "Retired Knowledge purge guard admitted a tombstone outside the purge transaction",
  );
  assert.match(
    `${rejectedUnscopedPurge.stdout}\n${rejectedUnscopedPurge.stderr}`,
    /KnowledgeRun_read_receipt_operation_check/u,
    "Unscoped retired purge failed without the transition guard",
  );

  psqlScalar(database, `
    BEGIN;
      SET LOCAL aiqsa.knowledge_purge = 'on';
      UPDATE "KnowledgeRun"
      SET
        query = 'deleted_knowledge_resource',
        "baseEvidence" = "baseEvidence",
        results = '[]'::jsonb,
        "providerText" = 'Knowledge citation evidence was deleted.',
        "readReceipt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-basic-legacy-structured-run';
      UPDATE "KnowledgeRun"
      SET
        query = 'deleted_knowledge_resource',
        "baseEvidence" = '[{"deleted":true}]'::jsonb,
        results = '[{"deleted":true}]'::jsonb,
        "providerText" = 'Knowledge citation evidence was deleted.',
        "readReceipt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-basic-legacy-visual-run';
      UPDATE "KnowledgeRun"
      SET
        query = 'deleted_knowledge_resource',
        "baseEvidence" = "baseEvidence",
        results = '[{"deleted":true,"handle":"K5.1"}]'::jsonb,
        "providerText" = E'Knowledge passages:\n\n[K5.1] Deleted Knowledge source.',
        "readReceipt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-basic-legacy-structured-complete-run';
      UPDATE "KnowledgeBudgetReservation"
      SET
        "dispatchAttemptKey" = NULL,
        "failureCode" = NULL,
        "idempotencyKey" = NULL,
        "leaseExpiresAt" = NULL,
        "leaseToken" = NULL,
        "operationRequest" = NULL,
        "operationRequestHash" = NULL,
        "purgedAt" = GREATEST(CURRENT_TIMESTAMP, "createdAt"),
        "receiptHash" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id IN (
        'knowledge-basic-legacy-structured-reservation',
        'knowledge-basic-legacy-visual-reservation'
      );
    COMMIT;
    SELECT 'knowledge-basic-legacy-analysis-purged';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT
        (SELECT count(*) FROM "KnowledgeRun"
          WHERE id IN (
            'knowledge-basic-legacy-structured-run',
            'knowledge-basic-legacy-structured-complete-run',
            'knowledge-basic-legacy-visual-run'
          )
          AND operation IN ('structured_analysis', 'visual_analysis')
          AND query = 'deleted_knowledge_resource'
          AND "readReceipt" IS NULL
          AND CASE id
            WHEN 'knowledge-basic-legacy-structured-run' THEN
              "baseEvidence" = '[{"baseName":"Legacy Basic Base","ordinal":0}]'::jsonb
              AND results = '[]'::jsonb
              AND "providerText" = 'Knowledge citation evidence was deleted.'
            WHEN 'knowledge-basic-legacy-visual-run' THEN
              "baseEvidence" = '[{"deleted":true}]'::jsonb
              AND results = '[{"deleted":true}]'::jsonb
              AND "providerText" = 'Knowledge citation evidence was deleted.'
            WHEN 'knowledge-basic-legacy-structured-complete-run' THEN
              "baseEvidence" = '[{"baseName":"Legacy Basic Base","ordinal":0},{"baseName":"Retained Basic Base","ordinal":1}]'::jsonb
              AND results = '[{"deleted":true,"handle":"K5.1"}]'::jsonb
              AND "providerText" = E'Knowledge passages:\n\n[K5.1] Deleted Knowledge source.'
            ELSE false
          END)
        + (SELECT count(*) FROM "KnowledgeBudgetReservation"
          WHERE id IN (
            'knowledge-basic-legacy-structured-reservation',
            'knowledge-basic-legacy-visual-reservation'
          )
          AND operation IN ('structured_analysis', 'visual_analysis')
          AND "purgedAt" IS NOT NULL
          AND "idempotencyKey" IS NULL
          AND "operationRequest" IS NULL
          AND "operationRequestHash" IS NULL
          AND "leaseToken" IS NULL
          AND "leaseExpiresAt" IS NULL
          AND "dispatchAttemptKey" IS NULL
          AND "receiptHash" IS NULL
          AND "failureCode" IS NULL);
    `),
    "5",
    "Basic cleanup blocked or incompletely scrubbed historical analysis tombstones",
  );

  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM unnest(ARRAY[
        'KnowledgeStrategyExecution',
        'KnowledgeStrategyStep',
        'KnowledgeStrategyStepDependency',
        'KnowledgeStrategyMapOutput'
      ]) AS legacy(name)
      WHERE to_regclass('public."' || legacy.name || '"') IS NOT NULL;
    `),
    "0",
    "Basic cleanup retained a strategy runtime table",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      WHERE to_regclass('public."KnowledgePolicy"') IS NOT NULL;
    `),
    "0",
    "Basic cleanup retained the obsolete mutable Knowledge policy table",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM pg_proc
      WHERE proname IN (
        'aiqsa_guard_knowledge_strategy_dag_cycle',
        'aiqsa_guard_knowledge_strategy_dependency',
        'aiqsa_guard_knowledge_strategy_execution',
        'aiqsa_guard_knowledge_strategy_map_output',
        'aiqsa_guard_knowledge_strategy_step',
        'aiqsa_guard_knowledge_strategy_step_evidence',
        'knowledge_strategy_step_evidence_valid'
      );
    `),
    "0",
    "Basic cleanup retained a strategy runtime function",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'KnowledgeRun'
        AND column_name = 'strategyStepEvidence';
    `),
    "0",
    "Basic cleanup retained the strategy receipt marker",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM information_schema.columns AS catalog
      INNER JOIN (VALUES
        ('KnowledgeRun', 'threshold'),
        ('KnowledgeRun', 'stopReason'),
        ('KnowledgeRun', 'rerankerBinding'),
        ('KnowledgeRun', 'preRerankOrder'),
        ('KnowledgeRun', 'postRerankOrder'),
        ('KnowledgeRetrievalSession', 'strategySnapshot'),
        ('KnowledgeRetrievalSession', 'coverageRequirements'),
        ('KnowledgeGroundingResult', 'issues'),
        ('KnowledgeGroundingResult', 'repairCount'),
        ('KnowledgeBudgetReservation', 'estimatedRerankerCalls'),
        ('KnowledgeBudgetReservation', 'estimatedValidationSlots'),
        ('KnowledgeBudgetReservation', 'estimatedRepairSlots'),
        ('KnowledgeBudgetReservation', 'actualRerankerCalls'),
        ('KnowledgeBudgetReservation', 'actualValidationSlots'),
        ('KnowledgeBudgetReservation', 'actualRepairSlots')
      ) AS removed(table_name, column_name)
        USING (table_name, column_name)
      WHERE catalog.table_schema = 'public';
    `),
    "0",
    "Basic cleanup retained a planner-era retrieval, grounding, or budget column",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'KnowledgeRun'
        AND column_name = 'query'
        AND data_type = 'text'
        AND character_maximum_length IS NULL;
    `),
    "1",
    "Basic cleanup did not widen focused query storage without narrowing historical rows",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM pg_constraint
      WHERE conrelid = '"KnowledgeRun"'::regclass
        AND conname IN (
          'KnowledgeRun_evidence_shape_check',
          'KnowledgeRun_limits_check',
          'KnowledgeRun_outcome_shape_check'
        )
        AND pg_get_constraintdef(oid) NOT LIKE '%strategyStepEvidence%'
        AND convalidated;
      `),
      "3",
      "Basic historical-upgrade constraints are missing, unvalidated, or still depend on strategy state",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM pg_constraint
      WHERE (
        conrelid = '"KnowledgeRun"'::regclass
        AND conname = 'KnowledgeRun_read_receipt_operation_check'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%knowledge_read_source_receipt_valid_v2%'
        AND pg_get_constraintdef(oid) LIKE '%knowledge_exact_receipt_valid%'
        AND pg_get_constraintdef(oid) LIKE '%knowledge_discovery_receipt_valid%'
        AND pg_get_constraintdef(oid) LIKE '%knowledge_reranker_binding_valid_v2%'
        AND pg_get_constraintdef(oid) LIKE '%deleted_knowledge_resource%'
        AND pg_get_constraintdef(oid) NOT LIKE '%threshold%'
      ) OR (
        conrelid = '"KnowledgeBudgetReservation"'::regclass
        AND conname = 'KnowledgeBudgetReservation_basic_operation_check'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%structured_analysis%'
        AND pg_get_constraintdef(oid) LIKE '%visual_analysis%'
        AND pg_get_constraintdef(oid) LIKE '%purgedAt%'
        AND pg_get_constraintdef(oid) LIKE '%operationRequest%'
        AND pg_get_constraintdef(oid) LIKE '%idempotencyKey%'
      );
      `),
      "2",
      "Basic retired-operation fences are missing, unvalidated, or incompatible with historical rows",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*) FROM pg_trigger
      WHERE tgname IN (
        'KnowledgeRun_basic_focused_guard',
        'ModelRunToolCall_basic_focused_guard'
      )
        AND tgenabled = 'O'
        AND NOT tgisinternal;
    `),
    "2",
    "Basic focused checkpoint guards are missing",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      WHERE to_regclass('public."KnowledgeSemanticShadowResult"') IS NOT NULL;
    `),
    "0",
    "Basic cleanup retained pure semantic-shadow qualification storage",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM (VALUES
        (to_regprocedure('guard_accepted_knowledge_semantic_shadow_result_write()')),
        (to_regprocedure('knowledge_semantic_profile_authorized_shadow_result_valid(text,integer,text,text,text,integer,boolean,text,text[],jsonb,jsonb,text,timestamp without time zone,timestamp without time zone)')),
        (to_regprocedure('knowledge_semantic_validator_deployment_released(jsonb)')),
        (to_regprocedure('knowledge_semantic_validator_deployment_valid(jsonb)')),
        (to_regprocedure('knowledge_semantic_shadow_result_valid(text,integer,text,text,text,integer,boolean,text,text[],jsonb,jsonb,text,timestamp without time zone,timestamp without time zone)')),
        (to_regprocedure('knowledge_semantic_zero_usage_valid(jsonb)')),
        (to_regprocedure('knowledge_semantic_count_record_valid(jsonb,text[],integer,integer)')),
        (to_regprocedure('knowledge_semantic_string_array_valid(jsonb,integer,integer,text)')),
        (to_regprocedure('knowledge_semantic_canonical_json(jsonb)')),
        (to_regprocedure('knowledge_semantic_profile_revision_ids_valid(text[])'))
      ) AS retired_semantic(runtime)
      WHERE runtime IS NOT NULL;
    `),
    "0",
    "Basic cleanup retained callable semantic-shadow validator functions",
  );
  assert.equal(
    psqlScalar(database, `
      SELECT count(*)
      FROM pg_constraint
      WHERE conrelid = '"KnowledgeGroundingResult"'::regclass
        AND conname = 'KnowledgeGroundingResult_basic_shape_check'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%answered%'
        AND pg_get_constraintdef(oid) LIKE '%insufficient_evidence%'
        AND pg_get_constraintdef(oid) LIKE '%originalAnswerHash%'
        AND pg_get_constraintdef(oid) LIKE '%finalAnswerHash%';
      `),
      "1",
      "Basic grounding settlement constraint is missing or unvalidated",
  );

  psqlScalar(database, `
    INSERT INTO "KnowledgeGroundingResult" (
      "retrievalSessionId", outcome, "originalAnswerHash", "finalAnswerHash"
    ) VALUES (
      'knowledge-h4-session-2', 'answered', repeat('a', 64), repeat('b', 64)
    );
  `);
  const invalidGroundingOutcome = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeGroundingResult"
      SET outcome = 'no_answer'
      WHERE "retrievalSessionId" = 'knowledge-h4-session-2';`,
  ]);
  assert.notEqual(
    invalidGroundingOutcome.status,
    0,
    "Basic cleanup accepted a retired Knowledge grounding outcome",
  );
  assert.match(
    `${invalidGroundingOutcome.stdout}\n${invalidGroundingOutcome.stderr}`,
    /KnowledgeGroundingResult_basic_shape_check/u,
    "Retired grounding outcome failed without the current structural constraint",
  );
  const invalidGroundingHash = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeGroundingResult"
      SET "finalAnswerHash" = 'not-a-sha'
      WHERE "retrievalSessionId" = 'knowledge-h4-session-2';`,
  ]);
  assert.notEqual(
    invalidGroundingHash.status,
    0,
    "Basic cleanup accepted a malformed Knowledge grounding hash",
  );
  assert.match(
    `${invalidGroundingHash.stdout}\n${invalidGroundingHash.stderr}`,
    /KnowledgeGroundingResult_basic_shape_check/u,
    "Malformed grounding hash failed without the current structural constraint",
  );

  psqlScalar(database, `
    UPDATE "ModelRunToolCall"
    SET "toolName" = 'knowledge_focused_v1', "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = 'knowledge-h4-call-other-run';
    INSERT INTO "KnowledgeRun" (
      id, "modelRunId", "modelRunToolCallId", "invocationOrdinal", operation, query,
      outcome, fusion, "candidateLimit", "resultLimit", "candidateCount",
      "baseEvidence", results, "providerText", "embeddingUsage", "durationMs", "updatedAt"
    ) VALUES (
      'knowledge-basic-query-3000', 'knowledge-h4-run-2',
      'knowledge-h4-call-other-run', 1, 'automatic_search',
      repeat('Ж', 1499) || E'\n\n' || repeat('я', 1499),
      'base_empty', 'weighted_rrf_v2', 64, 8, 0,
      '[{"baseName":"Basic Base","ordinal":0}]'::jsonb, '[]'::jsonb,
      'No matching evidence.', '[]'::jsonb, 1, CURRENT_TIMESTAMP
    );
    SELECT char_length(query) FROM "KnowledgeRun"
    WHERE id = 'knowledge-basic-query-3000';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT char_length(query) FROM "KnowledgeRun"
      WHERE id = 'knowledge-basic-query-3000';
    `),
    "3000",
    "Basic cleanup truncated the maximum multi-message focused query",
  );

  psqlScalar(database, `
    UPDATE "KnowledgeRun"
    SET "readReceipt" = jsonb_build_object(
      'rerankerBinding', jsonb_build_object(
        'adapterVersion', NULL,
        'candidateFormatterVersion', NULL,
        'connectionSnapshotId', NULL,
        'credentialSnapshotRef', NULL,
        'durationMs', 0,
        'fallbackReason', NULL,
        'inputCandidateCount', 0,
        'orderedCandidateChunkIds', '[]'::jsonb,
        'outputOrder', '[]'::jsonb,
        'policyVersion', NULL,
        'provider', NULL,
        'providerModelId', NULL,
        'providerRequestId', NULL,
        'rankingProfileVersion', 2,
        'relevanceScores', '[]'::jsonb,
        'status', 'disabled',
        'timedOut', false,
        'upstreamModelId', NULL,
        'usage', jsonb_build_object('searchUnits', NULL, 'totalTokens', NULL),
        'version', 2
      )
    )
    WHERE id = 'knowledge-basic-query-3000';
    SELECT "readReceipt" #>> '{rerankerBinding,status}'
    FROM "KnowledgeRun" WHERE id = 'knowledge-basic-query-3000';
  `);
  assert.equal(
    psqlScalar(database, `
      SELECT "readReceipt" #>> '{rerankerBinding,status}'
      FROM "KnowledgeRun" WHERE id = 'knowledge-basic-query-3000';
    `),
    "disabled",
    "Knowledge reranker receipt v2 rejected the current content-free disabled binding",
  );

  const contentBearingRerankerReceipt = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun"
      SET "readReceipt" = jsonb_set(
        "readReceipt", '{rerankerBinding,privateText}', '"forbidden"'::jsonb
      )
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(
    contentBearingRerankerReceipt.status,
    0,
    "Knowledge reranker receipt v2 accepted an unversioned content-bearing field",
  );
  assert.match(
    `${contentBearingRerankerReceipt.stdout}\n${contentBearingRerankerReceipt.stderr}`,
    /KnowledgeRun_read_receipt_operation_check/u,
    "Content-bearing reranker receipt failed without the stable database constraint",
  );

  const unsafeQueryControl = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun" SET query = E'unsafe\\tquery'
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(
    unsafeQueryControl.status,
    0,
    "Basic cleanup accepted a focused query with a non-LF control character",
  );
  assert.match(
    `${unsafeQueryControl.stdout}\n${unsafeQueryControl.stderr}`,
    /knowledge_basic_focused_run_contract_invalid/u,
    "Unsafe focused query failed without the stable database boundary",
  );

  const oversizedQuery = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun" SET query = repeat('Ж', 3001)
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(oversizedQuery.status, 0, "Basic cleanup accepted a 3001-character query");
  assert.match(
    `${oversizedQuery.stdout}\n${oversizedQuery.stderr}`,
    /knowledge_basic_focused_run_contract_invalid/u,
    "Oversized focused query failed without the stable database boundary",
  );

  const oversizedResultLimit = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun" SET "resultLimit" = 9
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(
    oversizedResultLimit.status,
    0,
    "Basic cleanup accepted a new automatic retrieval result limit above eight",
  );
  assert.match(
    `${oversizedResultLimit.stdout}\n${oversizedResultLimit.stderr}`,
    /knowledge_basic_focused_run_contract_invalid|KnowledgeRun_limits_check/u,
    "Oversized Basic result limit failed without the fixed database boundary",
  );

  const mutatedFocusedContract = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun"
      SET "candidateLimit" = 40
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(
    mutatedFocusedContract.status,
    0,
    "Ranking profile v2 accepted the retired 40-candidate focused constant",
  );
  assert.match(
    `${mutatedFocusedContract.stdout}\n${mutatedFocusedContract.stderr}`,
    /knowledge_basic_focused_run_contract_invalid/u,
    "Retired focused candidate limit failed without the focused checkpoint guard",
  );

  const retiredFocusedOutcome = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `UPDATE "KnowledgeRun"
      SET outcome = 'zero_above_threshold'
      WHERE id = 'knowledge-basic-query-3000';`,
  ]);
  assert.notEqual(
    retiredFocusedOutcome.status,
    0,
    "Basic cleanup accepted the retired threshold outcome on a focused checkpoint",
  );
  assert.match(
    `${retiredFocusedOutcome.stdout}\n${retiredFocusedOutcome.stderr}`,
    /knowledge_basic_focused_run_contract_invalid/u,
    "Retired focused outcome failed without the focused checkpoint guard",
  );

  const promotedInvalidFocusedContract = compose([
    "exec", "-T", POSTGRES_SERVICE,
    "psql", "-X", "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER,
    "--dbname", database,
    "--command", `BEGIN;
      UPDATE "ModelRunToolCall"
      SET "toolName" = 'knowledge_search_v1', "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-call-other-run';
      UPDATE "KnowledgeRun"
      SET "candidateLimit" = 40
      WHERE id = 'knowledge-basic-query-3000';
      UPDATE "ModelRunToolCall"
      SET "toolName" = 'knowledge_focused_v1', "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = 'knowledge-h4-call-other-run';
      COMMIT;`,
  ]);
  assert.notEqual(
    promotedInvalidFocusedContract.status,
    0,
    "Basic cleanup promoted an invalid legacy receipt to a focused checkpoint",
  );
  assert.match(
    `${promotedInvalidFocusedContract.stdout}\n${promotedInvalidFocusedContract.stderr}`,
    /knowledge_basic_focused_run_contract_invalid/u,
    "Invalid focused promotion failed without the tool-call checkpoint guard",
  );
}

function runKnowledgeToolCoexistenceMigrationProof(
  committed: readonly string[],
): void {
  const cleanupIndex = committed.indexOf(KNOWLEDGE_BASIC_RUNTIME_CLEANUP_MIGRATION);
  const coexistenceIndex = committed.indexOf(KNOWLEDGE_TOOL_COEXISTENCE_MIGRATION);
  const mapReduceIndex = committed.indexOf(KNOWLEDGE_MAP_REDUCE_LIMITS_MIGRATION);
  const rankingProfileV2Index = committed.indexOf(KNOWLEDGE_RANKING_PROFILE_V2_MIGRATION);
  const rerankerReceiptV2Index = committed.indexOf(KNOWLEDGE_RERANKER_RECEIPT_V2_MIGRATION);
  assert.ok(
    coexistenceIndex > cleanupIndex,
    "Knowledge tool coexistence migration must follow the Basic runtime cleanup",
  );
  assert.ok(
    mapReduceIndex > coexistenceIndex,
    "Knowledge map/reduce limits migration must follow tool coexistence",
  );
  assert.ok(
    rankingProfileV2Index > mapReduceIndex,
    "Knowledge ranking profile v2 migration must follow map/reduce limits",
  );
  assert.ok(
    rerankerReceiptV2Index > rankingProfileV2Index,
    "Knowledge reranker receipt v2 migration must follow ranking profile v2",
  );
  const coexistenceSql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_TOOL_COEXISTENCE_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.match(
    coexistenceSql,
    /jsonb_array_length\("baseEvidence"\) BETWEEN 1 AND 128/u,
    "Knowledge tool coexistence must retain up to 128 admitted Base receipts",
  );
  assert.match(
    coexistenceSql,
    /jsonb_array_length\("embeddingUsage"\) <= 128/u,
    "Knowledge tool coexistence must retain up to 128 embedding executions",
  );
  assert.equal(
    (coexistenceSql.match(/IN \('knowledge_focused_v1', 'search_knowledge'\)/gu) ?? []).length,
    2,
    "Both immutable Knowledge receipt guards must cover the new model-facing tool",
  );
  assert.doesNotMatch(
    coexistenceSql,
    /\bUPDATE\s+"KnowledgeRun"\b/iu,
    "Knowledge tool coexistence must not rewrite immutable historical receipts",
  );
  const mapReduceSql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_MAP_REDUCE_LIMITS_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.match(
    mapReduceSql,
    /jsonb_array_length\(checkpoint_arguments -> 'sourceAliases'\) = 0[\s\S]*NOT IN \(8, 16\)/u,
    "Knowledge broad-map guard must admit only legacy eight or current sixteen",
  );
  assert.match(
    mapReduceSql,
    /ELSE NEW\."resultLimit" IS DISTINCT FROM 8/u,
    "Knowledge source-scoped reduce guard must retain eight results",
  );
  assert.match(
    mapReduceSql,
    /'no_relevant_evidence'/u,
    "Knowledge map/reduce guard must admit the current empty-evidence outcome",
  );
  assert.doesNotMatch(
    mapReduceSql,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"KnowledgeRun"\b/iu,
    "Knowledge map/reduce migration must not rewrite immutable receipts",
  );
  const rankingProfileV2Sql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_RANKING_PROFILE_V2_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.equal(
    (rankingProfileV2Sql.match(/"candidateLimit" IS DISTINCT FROM 64/gu) ?? []).length,
    2,
    "Both immutable Knowledge receipt guards must enforce ranking profile v2 limit 64",
  );
  assert.doesNotMatch(
    rankingProfileV2Sql,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"KnowledgeRun"\b/iu,
    "Knowledge ranking profile v2 migration must not rewrite immutable receipts",
  );
  const rerankerReceiptV2Sql = readFileSync(
    join(migrationsRoot, KNOWLEDGE_RERANKER_RECEIPT_V2_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.match(
    rerankerReceiptV2Sql,
    /WHEN 'automatic_search'[\s\S]*knowledge_reranker_binding_valid_v2/u,
    "Knowledge automatic-search receipts must validate hosted reranker evidence v2",
  );
  assert.match(
    rerankerReceiptV2Sql,
    /binding - ARRAY\[[\s\S]*'version'[\s\S]*\]::TEXT\[\] <> '\{\}'::JSONB/u,
    "Knowledge reranker evidence must reject unversioned top-level fields",
  );
  assert.doesNotMatch(
    rerankerReceiptV2Sql,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"KnowledgeRun"\b/iu,
    "Knowledge reranker receipt v2 migration must not rewrite immutable receipts",
  );
}

function runMemoryVNextRetrievalCutoverMigrationProof(
  database: string,
  committed: readonly string[],
): void {
  const cutoverIndex = committed.indexOf(MEMORY_VNEXT_RETRIEVAL_CUTOVER_MIGRATION);
  assert.ok(cutoverIndex > 0, "Memory vNext retrieval cutover migration is missing");
  const probeParent = join(repositoryRoot, ".aiqsa");
  const parentExisted = existsSync(probeParent);
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const probeRoot = mkdtempSync(join(probeParent, "memory-vnext-cutover-"));
  const probeSchema = join(probeRoot, "schema.prisma");
  const probeMigrations = join(probeRoot, "migrations");

  try {
    dropDatabase(database);
    createDatabase(database);
    cpSync(join(repositoryRoot, "prisma/schema.prisma"), probeSchema);
    mkdirSync(probeMigrations);
    for (const migration of committed.slice(0, cutoverIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    const containerSchema = `/app/${probeSchema.slice(repositoryRoot.length + 1)}`;
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);

    psqlScalar(database, `
      INSERT INTO "User" (id, "displayName", role, status, "updatedAt")
      VALUES ('memory-cutover-owner', 'Memory cutover fixture', 'user', 'active',
        CURRENT_TIMESTAMP);
      INSERT INTO "MemoryJob" (
        id, "userId", kind, state, "pipelineVersion", "memoryGenerationSnapshot",
        "memoryRevisionSnapshot", "idempotencyFingerprint", "updatedAt"
      ) VALUES
        (
          'memory-cutover-consolidation-job', 'memory-cutover-owner',
          'CONSOLIDATE_CANDIDATE', 'QUEUED', 'memory-fact-consolidation-v2', 0, 0,
          'memory-cutover-consolidation-fixture', CURRENT_TIMESTAMP
        ),
        (
          'memory-cutover-verification-job', 'memory-cutover-owner',
          'VERIFY_CANDIDATE', 'RETRYABLE_FAILED', 'memory-fact-verification-v2', 0, 0,
          'memory-cutover-verification-fixture', CURRENT_TIMESTAMP
        );
      SELECT 'memory-cutover-pre-migration-ready';
    `);

    for (const migration of committed.slice(cutoverIndex)) {
      cpSync(join(migrationsRoot, migration), join(probeMigrations, migration), {
        recursive: true,
      });
    }
    app(database, ["npx", "prisma", "migrate", "deploy", "--schema", containerSchema]);
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM "MemoryJob"
        WHERE "userId" = 'memory-cutover-owner'
          AND kind IN ('CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE')
          AND state = 'TERMINAL_FAILED'
          AND "completedAt" IS NOT NULL
          AND "errorCode" = 'memory_job_handler_unavailable'
          AND num_nonnulls("leaseToken", "leaseExpiresAt", "nextAttemptAt") = 0;
      `),
      "2",
      "Memory cutover left legacy candidate work reclaimable",
    );
    assert.equal(
      psqlScalar(database, `
        SELECT count(*)
        FROM pg_class AS relation
        INNER JOIN pg_index AS index_catalog ON index_catalog.indexrelid = relation.oid
        WHERE relation.relname IN (
          'MemoryFactVersion_retrieval_lifecycle_idx',
          'MemoryFactVersion_retrieval_expiry_idx',
          'MemoryEvidence_vnext_retrieval_idx'
        )
          AND index_catalog.indisvalid
          AND index_catalog.indisready;
      `),
      "3",
      "Memory cutover retrieval indexes are missing, invalid, or not ready",
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        rmdirSync(probeParent);
      } catch {
        // Preserve concurrently created operator-local state.
      }
    }
  }
}

function main(
  mode: Mode,
  databases: readonly string[],
  shadowDatabase: string,
): void {
  const migrations = committedMigrations();

  for (const database of [...databases, shadowDatabase]) {
    dropDatabase(database);
    createDatabase(database);
  }

  app(databases[0]!, ["npx", "prisma", "generate"]);
  for (const database of databases) {
    deployAndVerify(database, migrations, shadowDatabase);
  }
  const catalogDigests = databases.length > 1
    ? databases.map(schemaCatalogDigest)
    : [];
  if (catalogDigests.length > 1) {
    assert.equal(
      new Set(catalogDigests).size,
      1,
      "independent clean installs produced different schema catalogs",
    );
  }
  runKnowledgeProfileBackfillProof(shadowDatabase, migrations);
  runKnowledgeSourceMigrationProof(shadowDatabase, migrations);
  runKnowledgeReadReceiptMigrationProof(shadowDatabase, migrations);
  runKnowledgeH2DurableDispatchMigrationProof(shadowDatabase, migrations);
  runKnowledgeH4StrategyExecutionMigrationProof(shadowDatabase, migrations);
  runKnowledgeValidatorRestoreSafetyProof(databases[0]!);
  runKnowledgeH5DocumentContextMigrationProof(shadowDatabase, migrations);
  runKnowledgeH6SemanticShadowMigrationProof(shadowDatabase, migrations);
  runKnowledgeBasicRuntimeCleanupMigrationProof(shadowDatabase, migrations);
  runKnowledgeToolCoexistenceMigrationProof(migrations);
  runMemoryVNextRetrievalCutoverMigrationProof(shadowDatabase, migrations);

  if (mode === "smoke") {
    runBootstrapProof(databases[0]!);
    runSeedProof(databases[0]!);
  } else {
    runSeedProof(databases[0]!);
    runBootstrapProof(databases[1]!);
    runIntegrityProof(databases[1]!);
    runAppendOnlyMigrationProbe(databases[1]!, migrations);
  }

  const catalogEvidence = catalogDigests[0]
    ? ` catalog_sha256=${catalogDigests[0]}`
    : "";
  process.stdout.write(
    `AIQSA migration ${mode} ok: baseline_sha256=${BASELINE_SHA256} schema_datamodel_diff_sha256=${EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256}${catalogEvidence} ordered deploy, idempotence, schema parity, Knowledge profile backfill/immutability, content-free Knowledge Source bridging/immutability, legacy Knowledge read receipt preservation/constraint, H2 exact receipt/state/manifest/cascade constraints, historical H4 strategy migration proof, H5 strict immutable passage-context constraints, historical H6 semantic-shadow compatibility and Basic cleanup removal, Basic strategy cleanup/fixed query constraints, Knowledge tool coexistence receipt capacity/guards, Memory vNext legacy-job retirement/retrieval indexes, seed/integrity, fresh/adopted bootstrap${mode === "full" ? ", and synthetic append-only migration" : ""} verified across ${databases.length} disposable database(s).\n`,
  );
}

const selectedMode = parseMode(process.argv.slice(2));
const selectedRoles: DatabaseRole[] =
  selectedMode === "smoke" ? ["smoke"] : ["seed", "bootstrap"];
const disposableDatabases = selectedRoles.map(databaseName);
const shadowDatabase = databaseName("shadow");

try {
  main(selectedMode, disposableDatabases, shadowDatabase);
} finally {
  for (const database of [...disposableDatabases, shadowDatabase]) {
    try {
      dropDatabase(database);
    } catch (error) {
      process.stderr.write(
        `migration contract cleanup failed for ${database}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
