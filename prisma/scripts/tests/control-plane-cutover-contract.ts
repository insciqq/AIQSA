import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const POSTGRES_USER = "aiqsa";
const POSTGRES_PASSWORD = "aiqsa-dev-password";
const POSTGRES_SERVICE = "postgres";
const KEY = Buffer.alloc(32, 0x43).toString("base64");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const cutoverScript = join(repositoryRoot, "prisma/scripts/control-plane-cutover.ts");
const runId = `${process.pid}_${Date.now()}`;
const databases = new Set<string>();

type CommandResult = { status: number; stderr: string; stdout: string };

function command(program: string, args: string[], options: {
  env?: Record<string, string | undefined>;
  input?: string;
} = {}): CommandResult {
  const result = spawnSync(program, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: options.env as NodeJS.ProcessEnv | undefined,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function compose(args: string[], input?: string): CommandResult {
  return command("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], { input });
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
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--set=ON_ERROR_STOP=1",
    "--username", POSTGRES_USER, "--dbname", database
  ], sql);
}

function scalar(database: string, sql: string): string {
  return requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER, "--dbname", database,
    "--command", sql
  ]), "read cutover state");
}

function createDatabase(name: string): void {
  requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, name
  ]), `create ${name}`);
  databases.add(name);
}

function dropDatabase(name: string): void {
  compose([
    "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
    "--username", POSTGRES_USER, name
  ]);
  databases.delete(name);
}

function applyMigrations(database: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    requireSuccess(
      psql(database, readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8")),
      `apply ${migration}`
    );
  }
}

function runCutover(
  database: string,
  extraEnv: Record<string, string | undefined>
): CommandResult {
  return command(join(repositoryRoot, "node_modules/.bin/tsx"), [cutoverScript], {
    env: {
      ...process.env,
      AIQSA_ENCRYPTION_KEY: KEY,
      AIQSA_SMTP_FROM: "",
      AIQSA_SMTP_HOST: "",
      AIQSA_SMTP_PASSWORD: "",
      AIQSA_SMTP_PORT: "",
      AIQSA_SMTP_SECURE: "",
      AIQSA_SMTP_STARTTLS: "",
      AIQSA_SMTP_USER: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      DATABASE_URL: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${database}?schema=public`,
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      ...extraEnv
    }
  });
}

function validEnvironment(): Record<string, string | undefined> {
  return {
    AIQSA_SMTP_FROM: "AIQSA <mail@example.test>",
    AIQSA_SMTP_HOST: "smtp.example.test",
    AIQSA_SMTP_PASSWORD: "smtp-secret-do-not-print",
    AIQSA_SMTP_USER: "mailer@example.test",
    OPENAI_API_KEY: "provider-secret-do-not-print"
  };
}

function validAndIdempotent(): void {
  const database = `aiqsa_control_cutover_${runId}`;
  createDatabase(database);
  try {
    applyMigrations(database);
    const first = runCutover(database, validEnvironment());
    const output = requireSuccess(first, "run control-plane cutover");
    assert(!output.includes("do-not-print"));
    const result = JSON.parse(output) as {
      providers: { imported: string[]; skippedConfigured: string[] };
      smtp: { imported: boolean; skippedConfigured: boolean };
    };
    assert.deepEqual(result.providers, { imported: ["openai"], skippedConfigured: [] });
    assert.deepEqual(result.smtp, { imported: true, skippedConfigured: false });

    assert.equal(scalar(database, `
      SELECT concat_ws('|', c."enabled", c."activeVersion", c."draftVersion",
        c."defaultCredentialId" IS NOT NULL, cr."enabled", cr."activeVersionId" IS NULL,
        cr."draftSecretEnvelope" LIKE 'v2.%')
      FROM "ProviderConnection" c
      JOIN "ProviderCredential" cr ON cr."id" = c."defaultCredentialId"
      WHERE c."templateKey" = 'openai';
    `), "f|0|2|t|f|t|t");
    assert.equal(scalar(database, `
      SELECT concat_ws('|', "enabled", "activeVersion", "draftVersion",
        "testedDraftVersion" IS NULL, "draftPasswordEnvelope" LIKE 'v2.%')
      FROM "SmtpControl" WHERE "id" = 'installation-smtp';
    `), "f|0|1|t|t");

    const second = JSON.parse(requireSuccess(
      runCutover(database, validEnvironment()),
      "rerun control-plane cutover"
    )) as {
      providers: { imported: string[]; skippedConfigured: string[] };
      smtp: { imported: boolean; skippedConfigured: boolean };
    };
    assert.deepEqual(second.providers, { imported: [], skippedConfigured: ["openai"] });
    assert.deepEqual(second.smtp, { imported: false, skippedConfigured: true });
  } finally {
    dropDatabase(database);
  }
}

function invalidInputRollsBackEverything(): void {
  const database = `aiqsa_control_rollback_${runId}`;
  createDatabase(database);
  try {
    applyMigrations(database);
    const result = runCutover(database, {
      AIQSA_SMTP_HOST: "smtp.example.test",
      OPENAI_API_KEY: "provider-secret-do-not-print"
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.trim(), "smtp_env_partial_configuration");
    assert(!result.stderr.includes("smtp.example.test"));
    assert(!result.stderr.includes("do-not-print"));
    assert.equal(scalar(database, `SELECT count(*) FROM "ProviderCredential";`), "0");
    assert.equal(scalar(database, `SELECT "draftVersion" FROM "SmtpControl";`), "0");
  } finally {
    dropDatabase(database);
  }
}

try {
  validAndIdempotent();
  invalidInputRollsBackEverything();
  process.stdout.write("Control-plane cutover contract: OK\n");
} finally {
  for (const database of databases) dropDatabase(database);
}
