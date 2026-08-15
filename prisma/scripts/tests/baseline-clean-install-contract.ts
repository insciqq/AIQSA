import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASELINE = "20260815000000_baseline";
const POSTGRES_USER = "aiqsa";
const POSTGRES_PASSWORD = "aiqsa-dev-password";
const POSTGRES_SERVICE = "postgres";
const APP_SERVICE = "app";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const composeFile = join(repositoryRoot, "docker-compose.dev.yml");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;
const seedDatabase = `aiqsa_baseline_seed_${runId}`;
const bootstrapDatabase = `aiqsa_baseline_bootstrap_${runId}`;
const disposableDatabases = [seedDatabase, bootstrapDatabase];

type CommandResult = Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}>;

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

function assertDisposableDatabase(database: string): void {
  assert.match(
    database,
    /^aiqsa_baseline_(?:seed|bootstrap)_[0-9]+_[0-9]+$/u,
    `refusing unsafe database target: ${database}`,
  );
}

function databaseUrl(database: string): string {
  assertDisposableDatabase(database);
  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_SERVICE}:5432/${database}?schema=public`;
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

function assertSingleBaseline(): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(migrations, [BASELINE], "migration history must contain one clean baseline");

  const sql = readFileSync(join(migrationsRoot, BASELINE, "migration.sql"), "utf8");
  for (const staleToken of [
    "MemoryEpisode",
    "MemoryProfileProjection",
    '"episodeId"',
    '"sourceEpisodeId"',
    '"lastDreamedMessageId"',
    '"preferredProfileLanguage"',
    '"providerRequestPreview"',
    '"finalProviderResponsePreview"',
    '"showToolActivity"',
  ]) {
    assert.equal(sql.includes(staleToken), false, `baseline retained ${staleToken}`);
  }
  for (const requiredSql of [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "GENERATED ALWAYS AS",
    "USING hnsw",
    "CREATE CONSTRAINT TRIGGER",
    'ON DELETE SET NULL ("activeLeafMessageId")',
  ]) {
    assert.equal(sql.includes(requiredSql), true, `baseline is missing ${requiredSql}`);
  }
}

function assertDeployedCatalog(database: string): void {
  assert.equal(
    psqlScalar(
      database,
      `SELECT migration_name FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY finished_at;`,
    ),
    BASELINE,
    "clean install did not record exactly the baseline migration",
  );
  assert.equal(
    psqlScalar(database, "SELECT count(*) FROM pg_extension WHERE extname = 'vector';"),
    "1",
    "vector extension is missing",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*)
       FROM pg_attribute AS a
       JOIN pg_class AS c ON c.oid = a.attrelid
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attgenerated = 's';`,
    ),
    "4",
    "generated full-text search columns drifted",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'MemoryEpisode', 'MemoryEpisodeMessage',
           'MemoryProfileProjection', 'MemoryProfileProjectionFact'
         );`,
    ),
    "0",
    "retired Memory tables remain",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('UserSettings', 'showToolActivity'),
           ('ModelRun', 'providerRequestPreview'),
           ('ModelRun', 'finalProviderResponsePreview'),
           ('SearchRun', 'query'),
           ('SearchRun', 'requestPreview'),
           ('SearchRun', 'durationMs'),
           ('UserMemorySettings', 'preferredProfileLanguage'),
           ('UserMemorySettings', 'lastGlobalDreamAt'),
           ('ChatMemoryCheckpoint', 'lastDreamedMessageId'),
           ('MemoryEvidence', 'episodeId'),
           ('MemoryFeedback', 'episodeId'),
           ('MemorySuppression', 'sourceEpisodeId'),
           ('MemorySearchEntry', 'episodeId'),
           ('MemoryRetrievalAttemptItem', 'episodeId'),
           ('ModelRunMemoryItem', 'episodeId')
         );`,
    ),
    "0",
    "retired columns remain",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*)
       FROM pg_enum AS e
       JOIN pg_type AS t ON t.oid = e.enumtypid
       WHERE (t.typname, e.enumlabel) IN (
         ('MemoryEvidenceSourceType', 'EPISODE'),
         ('MemoryFeedbackTargetKind', 'EPISODE'),
         ('MemorySuppressionScope', 'SOURCE_EPISODE'),
         ('MemoryJobKind', 'EXTRACT_EPISODE'),
         ('MemoryJobKind', 'GLOBAL_DREAM'),
         ('MemoryJobKind', 'RECALCULATE_WORKING_SET'),
         ('MemorySearchItemType', 'EPISODE')
       );`,
    ),
    "0",
    "retired enum variants remain",
  );
}

function runSeedAndIntegrityProof(database: string): void {
  const testEnvironment = {
    AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
    AIQSA_TEST_MODE: "1",
    NODE_ENV: "development",
  };
  app(database, ["npx", "prisma", "db", "seed"], testEnvironment);
  app(database, ["npx", "tsx", "prisma/seed-smoke.ts"], testEnvironment);
  app(database, ["npx", "tsx", "prisma/schema-integrity-smoke.ts"], testEnvironment);
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
  const repeat = app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.match(repeat, /installation bootstrap already_adopted:/u);
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

function main(): void {
  assertSingleBaseline();
  for (const database of disposableDatabases) {
    dropDatabase(database);
    createDatabase(database);
  }

  app(seedDatabase, ["npx", "prisma", "generate"]);
  for (const database of disposableDatabases) {
    app(database, ["npx", "prisma", "migrate", "deploy"]);
    assertDeployedCatalog(database);
  }
  assert.match(
    app(seedDatabase, ["npx", "prisma", "migrate", "status"]),
    /Database schema is up to date!/u,
  );
  runSeedAndIntegrityProof(seedDatabase);
  runBootstrapProof(bootstrapDatabase);

  process.stdout.write(
    "AIQSA clean-baseline contract ok: single migration, current catalog, seed/integrity, and fresh/adopted bootstrap verified.\n",
  );
}

try {
  main();
} finally {
  for (const database of disposableDatabases) {
    try {
      dropDatabase(database);
    } catch (error) {
      process.stderr.write(
        `baseline contract cleanup failed for ${database}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
