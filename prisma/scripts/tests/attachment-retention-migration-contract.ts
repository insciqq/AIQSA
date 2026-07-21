import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260718193000_attachment_retention_outbox";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_retention_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024
  });

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
  assert.equal(result.status, 0, `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
    "read retention migration contract state"
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
    "drop retention migration contract database"
  );
  databaseCreated = false;
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect Compose PostgreSQL service"
    ),
    POSTGRES_SERVICE
  );
  requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, database]),
    "create retention migration contract database"
  );
  databaseCreated = true;

  const preTargetMigrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  for (const migration of preTargetMigrations) {
    requireSuccess(psql(migrationSql(migration)), `apply pre-target migration ${migration}`);
  }

  requireSuccess(
    psql(`
      INSERT INTO "User" ("id", "email", "displayName", "updatedAt")
      VALUES ('retention-contract-user', 'retention-contract@example.test', 'Retention contract', CURRENT_TIMESTAMP);

      INSERT INTO "Attachment" (
        "id", "userId", "kind", "mimeType", "fileName", "storageKey", "status", "byteSize", "metadata"
      ) VALUES
        ('retention-contract-a', 'retention-contract-user', 'document', 'text/plain', 'a.txt', 'legacy/shared-key', 'ready', 1, '{}'::jsonb),
        ('retention-contract-b', 'retention-contract-user', 'document', 'text/plain', 'b.txt', 'legacy/shared-key', 'ready', 1, '{}'::jsonb);
    `),
    "load duplicate legacy attachment-key fixture"
  );
  requireSuccess(psql(migrationSql(TARGET_MIGRATION)), "apply attachment retention migration");

  assert.equal(
    scalar(`
      SELECT concat_ws('|',
        (SELECT count(*) FROM "Attachment" WHERE "storageKey" = 'legacy/shared-key'),
        (SELECT count(*) FROM pg_class WHERE relname = 'AttachmentDeletionJob'),
        (SELECT count(*) FROM pg_indexes WHERE indexname IN (
          'AttachmentDeletionJob_storageKey_key',
          'AttachmentDeletionJob_claimedAt_createdAt_idx',
          'Attachment_storageKey_idx',
          'AuthFlowToken_consumedAt_idx'
        ))
      );
    `),
    "2|1|4"
  );
  requireSuccess(
    psql(`
      INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "updatedAt")
      VALUES ('retention-job-a', 'legacy/job-key', CURRENT_TIMESTAMP);
    `),
    "insert retention outbox job"
  );
  const duplicate = psql(`
    INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "updatedAt")
    VALUES ('retention-job-b', 'legacy/job-key', CURRENT_TIMESTAMP);
  `);
  assert.notEqual(duplicate.status, 0, "outbox unexpectedly accepted a duplicate storage key");
  assert.match(`${duplicate.stdout}\n${duplicate.stderr}`, /AttachmentDeletionJob_storageKey_key/);

  process.stdout.write(
    "AIQSA retention migration contract ok: legacy duplicate keys preserved and durable outbox/index constraints installed.\n"
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
    process.stderr.write(`retention migration contract cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
