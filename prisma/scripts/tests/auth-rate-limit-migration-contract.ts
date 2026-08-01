import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260801120000_durable_auth_rate_limit";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_auth_limit_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input,
      maxBuffer: 16 * 1024 * 1024
    }
  );

  if (result.error) {
    throw result.error;
  }

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
  return compose(
    [
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
    ],
    sql
  );
}

function scalar(sql: string): string {
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
    "read auth rate-limit migration contract state"
  );
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function dropDatabase(): void {
  if (!databaseCreated) {
    return;
  }

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
    "drop auth rate-limit migration contract database"
  );
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
  requireSuccess(
    compose([
      "exec",
      "-T",
      POSTGRES_SERVICE,
      "createdb",
      "--username",
      POSTGRES_USER,
      database
    ]),
    "create auth rate-limit migration contract database"
  );
  databaseCreated = true;

  const preTargetMigrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  for (const migration of preTargetMigrations) {
    requireSuccess(psql(migrationSql(migration)), `apply pre-target migration ${migration}`);
  }

  requireSuccess(psql(migrationSql(TARGET_MIGRATION)), "apply durable auth rate-limit migration");
  assert.equal(
    scalar(`
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'AuthRateLimitBucket'),
        (SELECT count(*) FROM pg_indexes
          WHERE indexname = 'AuthRateLimitBucket_resetAt_idx'),
        (SELECT count(*) FROM pg_constraint
          WHERE conname = 'AuthRateLimitBucket_attemptCount_check')
      );
    `),
    "1|1|1"
  );

  requireSuccess(
    psql(`
      INSERT INTO "AuthRateLimitBucket" (
        "keyHash", "attemptCount", "resetAt", "updatedAt"
      ) VALUES (
        repeat('a', 64), 1, CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP
      );
    `),
    "insert valid auth rate-limit bucket"
  );
  const invalidCount = psql(`
    INSERT INTO "AuthRateLimitBucket" (
      "keyHash", "attemptCount", "resetAt", "updatedAt"
    ) VALUES (
      repeat('b', 64), 0, CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP
    );
  `);
  assert.notEqual(invalidCount.status, 0, "bucket unexpectedly accepted a zero attempt count");
  assert.match(
    `${invalidCount.stdout}\n${invalidCount.stderr}`,
    /AuthRateLimitBucket_attemptCount_check/
  );

  process.stdout.write(
    "AIQSA auth rate-limit migration contract ok: durable bucket table, expiry index, and count constraint installed.\n"
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.exitCode = 1;
} finally {
  try {
    dropDatabase();
  } catch (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    process.stderr.write(`auth rate-limit migration contract cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
