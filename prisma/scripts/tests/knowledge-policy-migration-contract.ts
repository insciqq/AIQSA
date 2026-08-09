import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260809020000_knowledge_policy";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const suffix = `${process.pid}_${Date.now()}`;
const databases = new Set<string>();

function compose(args: string[], input?: string) {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function requireSuccess(result: ReturnType<typeof compose>, operation: string): string {
  assert.equal(
    result.status,
    0,
    `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

function psql(database: string, sql: string) {
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
  ]), "read Knowledge policy migration state");
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
      `apply migration ${name}`
    );
  }
}

function createDatabase(name: string): void {
  requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, name]),
    `create ${name}`
  );
  databases.add(name);
}

function dropDatabases(): void {
  for (const name of databases) {
    requireSuccess(compose([
      "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
      "--username", POSTGRES_USER, name
    ]), `drop ${name}`);
  }
  databases.clear();
}

function expectRejected(database: string, sql: string, expected: RegExp): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, "invalid Knowledge policy unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function assertPolicy(database: string): void {
  assert.equal(
    scalar(database, `
      SELECT concat_ws('|', "id", "candidateLimit", "resultLimit", "scoreThreshold", "version")
      FROM "KnowledgePolicy";
    `),
    "installation|40|8|0.01|1"
  );
  expectRejected(
    database,
    `INSERT INTO "KnowledgePolicy" ("id") VALUES ('other');`,
    /KnowledgePolicy_singleton_check/u
  );
  expectRejected(
    database,
    `UPDATE "KnowledgePolicy" SET "candidateLimit" = 4, "resultLimit" = 5 WHERE "id" = 'installation';`,
    /KnowledgePolicy_result_limit_check/u
  );
  expectRejected(
    database,
    `UPDATE "KnowledgePolicy" SET "scoreThreshold" = 2 WHERE "id" = 'installation';`,
    /KnowledgePolicy_score_threshold_check/u
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
  const before = migrationNames((name) => name < TARGET_MIGRATION);
  const through = migrationNames((name) => name <= TARGET_MIGRATION);
  assert.ok(through.includes(TARGET_MIGRATION), "Knowledge policy migration is missing");
  const existing = `aiqsa_knowledge_policy_existing_${suffix}`;
  const fresh = `aiqsa_knowledge_policy_fresh_${suffix}`;

  try {
    createDatabase(existing);
    applyMigrations(existing, before);
    requireSuccess(psql(existing, `
      INSERT INTO "User" ("id", "displayName", "role", "status", "updatedAt")
      VALUES ('policy-admin', 'Policy Admin', 'admin', 'active', CURRENT_TIMESTAMP);
    `), "seed existing installation");
    applyMigrations(existing, [TARGET_MIGRATION]);
    assertPolicy(existing);
    assert.equal(scalar(existing, `SELECT count(*) FROM "User" WHERE "id" = 'policy-admin';`), "1");

    createDatabase(fresh);
    applyMigrations(fresh, through);
    assertPolicy(fresh);
  } finally {
    dropDatabases();
  }
  process.stdout.write("Knowledge policy migration contract passed.\n");
}

main();
