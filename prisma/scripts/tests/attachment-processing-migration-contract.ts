import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260808150000_async_attachment_processing";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_attachment_processing_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = { status: number; stderr: string; stdout: string };

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function requireSuccess(result: CommandResult, operation: string): string {
  assert.equal(result.status, 0, `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
  ]), "read attachment-processing migration contract state");
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function dropDatabase(): void {
  if (!databaseCreated) return;
  requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
    "--username", POSTGRES_USER, database
  ]), "drop attachment-processing migration contract database");
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
    "create attachment-processing migration contract database"
  );
  databaseCreated = true;

  const preTargetMigrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  for (const migration of preTargetMigrations) {
    requireSuccess(psql(migrationSql(migration)), `apply pre-target migration ${migration}`);
  }
  requireSuccess(psql(`
    INSERT INTO "User" ("id", "email", "displayName", "updatedAt")
    VALUES ('attachment-contract-user', 'attachment-contract@example.test', 'Attachment contract', CURRENT_TIMESTAMP);
    INSERT INTO "Attachment" (
      "id", "userId", "kind", "mimeType", "fileName", "storageKey", "status", "byteSize", "metadata"
    ) VALUES (
      'legacy-ready', 'attachment-contract-user', 'document', 'text/plain', 'legacy.txt',
      'private/legacy', 'ready', 1, '{}'::jsonb
    );
  `), "load legacy ready attachment fixture");

  requireSuccess(psql(migrationSql(TARGET_MIGRATION)), "apply async attachment migration");

  assert.equal(scalar(`
    SELECT concat_ws('|',
      (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
       FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'AttachmentStatus'),
      (SELECT concat("status", ':', ("updatedAt" IS NOT NULL)::text)
       FROM "Attachment" WHERE "id" = 'legacy-ready'),
      (SELECT count(*) FROM pg_class WHERE relname = 'AttachmentProcessingJob'),
      (SELECT count(*) FROM pg_indexes WHERE indexname IN (
        'AttachmentProcessingJob_attachmentId_key',
        'AttachmentProcessingJob_nextAttemptAt_claimedAt_createdAt_idx'
      )),
      (SELECT character_maximum_length FROM information_schema.columns
       WHERE table_name = 'Attachment' AND column_name = 'processingErrorCode'),
      (SELECT character_maximum_length FROM information_schema.columns
       WHERE table_name = 'AttachmentProcessingJob' AND column_name = 'lastErrorCode')
    );
  `), "processing,ready,failed|ready:true|1|2|64|64");

  requireSuccess(psql(`
    UPDATE "Attachment" SET "status" = 'processing' WHERE "id" = 'legacy-ready';
    INSERT INTO "AttachmentProcessingJob" ("id", "attachmentId", "updatedAt")
    VALUES ('processing-job', 'legacy-ready', CURRENT_TIMESTAMP);
    DELETE FROM "Attachment" WHERE "id" = 'legacy-ready';
  `), "exercise processing state and cascade");
  assert.equal(scalar(`SELECT count(*) FROM "AttachmentProcessingJob";`), "0");

  process.stdout.write(
    "AIQSA attachment-processing migration contract ok: legacy readiness, closed lifecycle states, bounded errors, durable jobs, indexes, and cascade verified.\n"
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
    process.stderr.write(`attachment-processing migration contract cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
