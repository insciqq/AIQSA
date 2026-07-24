import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260723234500_smtp_control";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_smtp_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024
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

function scalar(sql: string): string {
  return requireSuccess(compose([
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
  ]), "read SMTP migration contract state");
}

function expectRejection(label: string, sql: string, constraint: string): void {
  const result = psql(sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(constraint, "u"));
}

function applyMigrations(): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name <= TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert(migrations.includes(TARGET_MIGRATION), "SMTP control migration is missing");
  for (const migration of migrations) {
    requireSuccess(
      psql(readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8")),
      `apply migration ${migration}`
    );
  }
}

function run(): void {
  requireSuccess(compose([
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "createdb",
    "--username",
    POSTGRES_USER,
    database
  ]), "create disposable SMTP contract database");
  databaseCreated = true;
  applyMigrations();

  assert.equal(
    scalar(`SELECT concat_ws('|', "id", "draftVersion", "activeVersion", "enabled", "secretGenerationCounter") FROM "SmtpControl";`),
    "installation-smtp|0|0|f|0"
  );
  assert.equal(scalar(`SELECT count(*) FROM "SmtpControl";`), "1");

  expectRejection(
    "second SMTP identity",
    `INSERT INTO "SmtpControl" ("id") VALUES ('another-smtp');`,
    "SmtpControl_singleton_check"
  );
  expectRejection(
    "unpaired draft envelope",
    `UPDATE "SmtpControl" SET "draftConfig" = '{}'::jsonb, "draftPasswordEnvelope" = 'cipher';`,
    "SmtpControl_draft_secret_check"
  );
  expectRejection(
    "generation beyond permanent counter",
    `UPDATE "SmtpControl" SET
      "draftConfig" = '{}'::jsonb,
      "draftPasswordEnvelope" = 'cipher',
      "draftSecretGeneration" = 1;`,
    "SmtpControl_draft_secret_check"
  );
  expectRejection(
    "stale draft test evidence",
    `UPDATE "SmtpControl" SET
      "draftConfig" = '{}'::jsonb,
      "draftVersion" = 2,
      "draftTestVersion" = 1,
      "draftTestAt" = CURRENT_TIMESTAMP,
      "draftTestCode" = 'accepted';`,
    "SmtpControl_draft_test_check"
  );
  expectRejection(
    "failed evidence marked tested",
    `UPDATE "SmtpControl" SET
      "draftConfig" = '{}'::jsonb,
      "draftVersion" = 2,
      "draftTestVersion" = 2,
      "draftTestAt" = CURRENT_TIMESTAMP,
      "draftTestCode" = 'smtp_connection_failed',
      "testedDraftVersion" = 2;`,
    "SmtpControl_tested_draft_check"
  );
  expectRejection(
    "enabled empty active slot",
    `UPDATE "SmtpControl" SET "enabled" = true;`,
    "SmtpControl_active_slot_check"
  );
  expectRejection(
    "health from superseded version",
    `UPDATE "SmtpControl" SET
      "activeConfig" = '{}'::jsonb,
      "activeVersion" = 3,
      "activatedAt" = CURRENT_TIMESTAMP,
      "healthActiveVersion" = 2,
      "lastAttemptAt" = CURRENT_TIMESTAMP;`,
    "SmtpControl_health_check"
  );

  requireSuccess(psql(`
    INSERT INTO "User" ("id", "displayName", "updatedAt")
    VALUES ('smtp-admin', 'SMTP admin', CURRENT_TIMESTAMP);
    UPDATE "SmtpControl"
    SET "configurationUpdatedByUserId" = 'smtp-admin';
    DELETE FROM "User" WHERE "id" = 'smtp-admin';
  `), "verify nullable SMTP actor metadata");
  assert.equal(
    scalar(`SELECT "configurationUpdatedByUserId" IS NULL FROM "SmtpControl";`),
    "t"
  );

  requireSuccess(psql(`UPDATE "SmtpControl" SET
    "draftVersion" = 9,
    "activeVersion" = 8,
    "secretGenerationCounter" = 4,
    "draftConfig" = NULL,
    "activeConfig" = NULL,
    "enabled" = false;`), "verify permanent cleared lineage");
  assert.equal(
    scalar(`SELECT concat_ws('|', count(*), min("draftVersion"), min("activeVersion"), min("secretGenerationCounter")) FROM "SmtpControl";`),
    "1|9|8|4"
  );
}

try {
  run();
  process.stdout.write("SMTP control migration contract passed.\n");
} finally {
  if (databaseCreated) {
    const dropped = compose([
      "exec",
      "-T",
      POSTGRES_SERVICE,
      "dropdb",
      "--if-exists",
      "--force",
      "--username",
      POSTGRES_USER,
      database
    ]);
    if (dropped.status !== 0) {
      process.stderr.write(dropped.stderr || dropped.stdout);
      process.exitCode = 1;
    }
  }
}
