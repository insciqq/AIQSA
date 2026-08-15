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

const BASELINE = "20260815000000_baseline";
const BASELINE_SHA256 = "71c210d018bf2c56c4003a0a74f5c84dfdea939336c889b04b786444461f5b33";
const APPEND_ONLY_PROBE = "20990101000000_append_only_contract_probe";
const POSTGRES_USER = "aiqsa";
const POSTGRES_PASSWORD = "aiqsa-dev-password";
const POSTGRES_SERVICE = "postgres";
const APP_SERVICE = "app";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const composeFile = join(repositoryRoot, "docker-compose.dev.yml");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;

type Mode = "full" | "smoke";
type DatabaseRole = "bootstrap" | "seed" | "smoke";
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
  const prefix = role === "smoke" ? "migration_smoke" : `baseline_${role}`;
  return `aiqsa_${prefix}_${runId}`;
}

function assertDisposableDatabase(database: string): void {
  assert.match(
    database,
    /^aiqsa_(?:migration_smoke|baseline_seed|baseline_bootstrap)_[0-9]+_[0-9]+$/u,
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
       string_agg(migration_name, E'\\n' ORDER BY started_at, id),
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

function deployAndVerify(database: string, migrations: readonly string[]): void {
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
}

function runIntegrityProof(database: string): void {
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
  app(database, ["npx", "tsx", "prisma/seed-smoke.ts"], testEnvironment);
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
        SELECT jsonb_agg(jsonb_build_array(id, "defaultProviderModelId", version, "updatedByUserId") ORDER BY id)
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

function main(mode: Mode, databases: readonly string[]): void {
  const migrations = committedMigrations();

  for (const database of databases) {
    dropDatabase(database);
    createDatabase(database);
  }

  app(databases[0]!, ["npx", "prisma", "generate"]);
  for (const database of databases) {
    deployAndVerify(database, migrations);
  }
  const catalogDigests = databases.map(schemaCatalogDigest);
  assert.equal(
    new Set(catalogDigests).size,
    1,
    "independent clean installs produced different schema catalogs",
  );

  if (mode === "smoke") {
    runBootstrapProof(databases[0]!);
    runSeedProof(databases[0]!);
  } else {
    runSeedProof(databases[0]!);
    runBootstrapProof(databases[1]!);
    runIntegrityProof(databases[1]!);
    runAppendOnlyMigrationProbe(databases[1]!, migrations);
  }

  process.stdout.write(
    `AIQSA migration ${mode} ok: baseline_sha256=${BASELINE_SHA256} catalog_sha256=${catalogDigests[0]} ordered deploy, idempotence, seed/integrity, fresh/adopted bootstrap${mode === "full" ? ", and synthetic append-only migration" : ""} verified across ${databases.length} disposable database(s).\n`,
  );
}

const selectedMode = parseMode(process.argv.slice(2));
const selectedRoles: DatabaseRole[] =
  selectedMode === "smoke" ? ["smoke"] : ["seed", "bootstrap"];
const disposableDatabases = selectedRoles.map(databaseName);

try {
  main(selectedMode, disposableDatabases);
} finally {
  for (const database of disposableDatabases) {
    try {
      dropDatabase(database);
    } catch (error) {
      process.stderr.write(
        `migration contract cleanup failed for ${database}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
