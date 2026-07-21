import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260712210000_schema_integrity_hardening";
const POSTGRES_USER = "aiqsa";
const POSTGRES_SERVICE = "postgres";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;
const templateDatabase = `aiqsa_migration_contract_template_${runId}`;
const disposableDatabases = new Set<string>();

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type FailureScenario = {
  name: string;
  fixtureSql: string;
  expectedError: string;
};

function runDockerCompose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
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

function psql(database: string, sql: string): CommandResult {
  return runDockerCompose(
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
      database,
    ],
    sql,
  );
}

function psqlScalar(database: string, sql: string): string {
  return requireSuccess(
    runDockerCompose([
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
      sql,
    ]),
    "read disposable database contract state",
  );
}

function createDatabase(database: string, template?: string): void {
  const args = [
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "createdb",
    "--username",
    POSTGRES_USER,
  ];
  if (template) {
    args.push("--template", template);
  }
  args.push(database);

  requireSuccess(runDockerCompose(args), `create disposable database ${database}`);
  disposableDatabases.add(database);
}

function dropDatabase(database: string): void {
  const result = runDockerCompose([
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "dropdb",
    "--if-exists",
    "--force",
    "--username",
    POSTGRES_USER,
    database,
  ]);
  requireSuccess(result, `drop disposable database ${database}`);
  disposableDatabases.delete(database);
}

function migrationSql(migrationName: string): string {
  return readFileSync(join(migrationsRoot, migrationName, "migration.sql"), "utf8");
}

function applyPreTargetMigrations(database: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  assert(migrations.length > 0, "expected at least one migration before the target");
  for (const migration of migrations) {
    requireSuccess(
      psql(database, migrationSql(migration)),
      `apply pre-target migration ${migration}`,
    );
  }
}

const commonFixtureSql = `
INSERT INTO "User" ("id", "email", "displayName", "updatedAt") VALUES
  ('contract-user-a', 'contract-a@example.test', 'Contract A', CURRENT_TIMESTAMP),
  ('contract-user-b', 'contract-b@example.test', 'Contract B', CURRENT_TIMESTAMP);

INSERT INTO "Group" ("id", "name", "updatedAt")
VALUES ('contract-group', 'Contract group', CURRENT_TIMESTAMP);

INSERT INTO "Chat" (
  "id", "userId", "title", "defaultProvider", "defaultModelId", "updatedAt"
) VALUES
  ('contract-chat-a', 'contract-user-a', 'Contract chat A', 'fake', 'fake-model', CURRENT_TIMESTAMP),
  ('contract-chat-b', 'contract-user-b', 'Contract chat B', 'fake', 'fake-model', CURRENT_TIMESTAMP);

INSERT INTO "Message" (
  "id", "chatId", "role", "content", "status", "updatedAt"
) VALUES
  ('contract-message-a', 'contract-chat-a', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
  ('contract-message-b', 'contract-chat-b', 'user', '[]'::jsonb, 'complete', CURRENT_TIMESTAMP),
  ('contract-message-sentinel', 'contract-chat-a', 'assistant', '[]'::jsonb, 'in_progress', CURRENT_TIMESTAMP);
`;

const modelRunFixtureSql = `
INSERT INTO "ModelRun" (
  "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
  "normalizedRequest", "updatedAt"
) VALUES (
  'contract-model-run', 'contract-chat-a', 'contract-user-a', 'contract-message-a',
  'fake', 'fake-model', 'complete', '{}'::jsonb, CURRENT_TIMESTAMP
);
`;

const failureScenarios: FailureScenario[] = [
  {
    name: "cross-chat-parent",
    fixtureSql: `${commonFixtureSql}
UPDATE "Message"
SET "parentMessageId" = 'contract-message-a'
WHERE "id" = 'contract-message-b';
`,
    expectedError: "Message.parentMessageId crosses chat boundaries",
  },
  {
    name: "cross-chat-active-leaf",
    fixtureSql: `${commonFixtureSql}
UPDATE "Chat"
SET "activeLeafMessageId" = 'contract-message-a'
WHERE "id" = 'contract-chat-b';
`,
    expectedError: "Chat.activeLeafMessageId crosses chat boundaries",
  },
  {
    name: "grant-double-principal",
    fixtureSql: `${commonFixtureSql}
INSERT INTO "AccessGrant" (
  "id", "userId", "groupId", "provider", "updatedAt"
) VALUES (
  'contract-grant', 'contract-user-a', 'contract-group', 'fake', CURRENT_TIMESTAMP
);
`,
    expectedError: "AccessGrant must belong to exactly one user or group",
  },
  {
    name: "grant-ambiguous-target",
    fixtureSql: `${commonFixtureSql}
INSERT INTO "AccessGrant" (
  "id", "userId", "provider", "searchStrategy", "updatedAt"
) VALUES (
  'contract-grant', 'contract-user-a', 'fake', 'search-disabled', CURRENT_TIMESTAMP
);
`,
    expectedError: "AccessGrant has an empty or ambiguous provider/model/search target",
  },
  {
    name: "unknown-message-status",
    fixtureSql: `${commonFixtureSql}
UPDATE "Message" SET "status" = 'mystery' WHERE "id" = 'contract-message-a';
`,
    expectedError: "Message has unsupported statuses: mystery",
  },
  {
    name: "unknown-model-run-status",
    fixtureSql: `${commonFixtureSql}${modelRunFixtureSql}
UPDATE "ModelRun" SET "status" = 'mystery' WHERE "id" = 'contract-model-run';
`,
    expectedError: "ModelRun has unsupported statuses: mystery",
  },
  {
    name: "unknown-search-run-status",
    fixtureSql: `${commonFixtureSql}${modelRunFixtureSql}
INSERT INTO "SearchRun" (
  "id", "modelRunId", "strategyId", "provider", "requestPreview", "artifacts",
  "status", "updatedAt"
) VALUES (
  'contract-search-run', 'contract-model-run', 'search-disabled', 'fake',
  '{}'::jsonb, '[]'::jsonb, 'mystery', CURRENT_TIMESTAMP
);
`,
    expectedError: "SearchRun has unsupported statuses: mystery",
  },
  {
    name: "unknown-attachment-status",
    fixtureSql: `${commonFixtureSql}
INSERT INTO "Attachment" (
  "id", "userId", "chatId", "kind", "mimeType", "fileName", "storageKey",
  "status", "byteSize", "metadata"
) VALUES (
  'contract-attachment', 'contract-user-a', 'contract-chat-a', 'file',
  'text/plain', 'contract.txt', 'contract/contract.txt', 'mystery', 8, '{}'::jsonb
);
`,
    expectedError: "Attachment has unsupported statuses: mystery",
  },
];

function runFailureScenario(scenario: FailureScenario, index: number): void {
  const database = `aiqsa_migration_contract_${index}_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, scenario.fixtureSql), `load ${scenario.name} fixture`);

    const result = psql(database, migrationSql(TARGET_MIGRATION));
    assert.notEqual(result.status, 0, `${scenario.name} unexpectedly accepted dirty legacy data`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(
      output,
      new RegExp(scenario.expectedError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${scenario.name} failed without its actionable preflight error.\n${output}`,
    );

    const stateAfterFailure = psqlScalar(
      database,
      `SELECT concat_ws('|',
        (SELECT "status" FROM "Message" WHERE "id" = 'contract-message-sentinel'),
        (SELECT count(*) FROM pg_type WHERE typname IN (
          'MessageStatus', 'ModelRunStatus', 'SearchRunStatus', 'AttachmentStatus'
        )),
        (SELECT count(*) FROM pg_constraint WHERE conname IN (
          'Message_chatId_parentMessageId_fkey',
          'Chat_id_activeLeafMessageId_fkey',
          'AccessGrant_subject_check',
          'AccessGrant_target_check'
        ))
      );`,
    );
    assert.equal(
      stateAfterFailure,
      "in_progress|0|0",
      `${scenario.name} did not roll the failed migration back to the pre-migration state`,
    );
  } finally {
    dropDatabase(database);
  }
}

function runKnownBackfillScenario(): void {
  const database = `aiqsa_migration_contract_backfill_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(
      psql(
        database,
        `${commonFixtureSql}
UPDATE "Message" SET "status" = 'in_progress' WHERE "id" = 'contract-message-a';
`,
      ),
      "load known legacy Message.status fixture",
    );
    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "apply target migration");

    const persistedStatus = psqlScalar(
      database,
      `SELECT "status"::text FROM "Message" WHERE "id" = 'contract-message-a';`,
    );
    assert.equal(persistedStatus, "streaming");
  } finally {
    dropDatabase(database);
  }
}

function main(): void {
  const postgresState = requireSuccess(
    runDockerCompose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
    "inspect the Compose PostgreSQL service",
  );
  assert.equal(
    postgresState,
    POSTGRES_SERVICE,
    "Compose PostgreSQL must be running before this contract test",
  );

  createDatabase(templateDatabase);
  try {
    applyPreTargetMigrations(templateDatabase);
    failureScenarios.forEach(runFailureScenario);
    runKnownBackfillScenario();
  } finally {
    for (const database of [...disposableDatabases].reverse()) {
      dropDatabase(database);
    }
  }

  process.stdout.write(
    `AIQSA migration contract ok: ${failureScenarios.length} dirty legacy states failed closed and in_progress mapped to streaming.\n`,
  );
}

try {
  main();
} catch (error) {
  for (const database of [...disposableDatabases].reverse()) {
    try {
      dropDatabase(database);
    } catch {
      // Keep the original contract failure; best-effort cleanup has already run.
    }
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.exitCode = 1;
}
