import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260729113000_search_control_plane";
const PREFERENCE_MIGRATION = "20260731183000_inherited_search_preferences";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_search_contract_${process.pid}_${Date.now()}`;

type CommandResult = Readonly<{ status: number; stderr: string; stdout: string }>;

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 24 * 1024 * 1024
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
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--set=ON_ERROR_STOP=1",
    "--username", POSTGRES_USER, "--dbname", database
  ], sql);
}

function scalar(sql: string): string {
  return requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER, "--dbname", database,
    "--command", sql
  ]), "read Search migration contract state");
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function applyPreTargetMigrations(): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert(migrations.length > 0, "expected migrations before Search control-plane migration");
  for (const migration of migrations) {
    requireSuccess(psql(migrationSql(migration)), `apply pre-target migration ${migration}`);
  }
}

function applyThroughPreferenceMigration(): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name > TARGET_MIGRATION &&
      entry.name <= PREFERENCE_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert(migrations.some((migration) => migration === PREFERENCE_MIGRATION),
    "expected inherited Search preference migration");
  for (const migration of migrations) {
    requireSuccess(psql(migrationSql(migration)), `apply post-Search migration ${migration}`);
  }
}

const legacyFixture = `
INSERT INTO "User" (
  "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
) VALUES (
  'search-contract-user', 'search-contract@example.test', 'Search contract user',
  'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "UserSettings" (
  "id", "userId", "defaultSearchStrategyId", "defaultControlValues", "updatedAt"
) VALUES (
  'search-contract-settings', 'search-contract-user', 'openai-native-web-search',
  '{"sentinel":"settings-preserved"}'::jsonb, CURRENT_TIMESTAMP
);

INSERT INTO "SearchStrategy" (
  "id", "strategyId", "provider", "modelId", "providerModelId", "displayName",
  "kind", "description", "enabled", "config", "createdAt", "updatedAt"
) VALUES
  (
    'search-contract-openai', 'openai-native-web-search', 'openai', NULL, NULL,
    'OpenAI web search', 'openai_native_web_search', 'Hosted search', true,
    '{"sentinel":"strategy-preserved"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'search-contract-off', 'search-disabled', 'none', NULL, NULL,
    'Off', 'none', 'No web search', true, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

INSERT INTO "AccessGrant" (
  "id", "userId", "searchStrategy", "enabled", "createdAt", "updatedAt"
) VALUES (
  'search-contract-grant', 'search-contract-user', 'openai-native-web-search', true,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "Chat" ("id", "userId", "title", "createdAt", "updatedAt")
VALUES ('search-contract-chat', 'search-contract-user', 'Search history', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Message" (
  "id", "chatId", "role", "content", "status", "createdAt", "updatedAt"
) VALUES
  ('search-contract-question', 'search-contract-chat', 'user',
    '{"blocks":[{"type":"text","text":"question"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('search-contract-answer', 'search-contract-chat', 'assistant',
    '{"blocks":[{"type":"text","text":"answer"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "ModelRun" (
  "id", "chatId", "userId", "userMessageId", "assistantMessageId", "provider",
  "modelId", "status", "normalizedRequest", "createdAt", "updatedAt"
) VALUES (
  'search-contract-run', 'search-contract-chat', 'search-contract-user',
  'search-contract-question', 'search-contract-answer', 'openai', 'legacy-model', 'complete',
  '{"searchStrategy":"openai-native-web-search","sentinel":"request-preserved"}'::jsonb,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "ProviderRunBinding" (
  "id", "modelRunId", "role", "credentialSource", "executionSnapshot", "createdAt"
) VALUES
  ('search-contract-answer-binding', 'search-contract-run', 'answer', 'default',
    '{"sentinel":"answer-binding"}'::jsonb, CURRENT_TIMESTAMP),
  ('search-contract-search-binding', 'search-contract-run', 'search', 'default',
    '{"sentinel":"search-binding"}'::jsonb, CURRENT_TIMESTAMP);

INSERT INTO "SearchRun" (
  "id", "modelRunId", "strategyId", "provider", "modelId", "requestPreview",
  "artifacts", "status", "createdAt", "updatedAt"
) VALUES (
  'search-contract-execution', 'search-contract-run', 'openai-native-web-search',
  'openai', 'legacy-search-model', '{"sentinel":"preview-preserved"}'::jsonb,
  '{"sentinel":"artifacts-preserved"}'::jsonb, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
`;

try {
  requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, database
  ]), `create disposable database ${database}`);
  applyPreTargetMigrations();
  requireSuccess(psql(legacyFixture), "insert legacy Search fixture");
  requireSuccess(psql(migrationSql(TARGET_MIGRATION)), "apply Search control-plane migration");

  assert.equal(scalar(`
    SELECT "defaultSearchPlan"::text
    FROM "UserSettings" WHERE "id" = 'search-contract-settings';
  `), '{"mode": "all_selected", "optionIds": ["openai-native-web-search"]}');
  assert.equal(scalar(`
    SELECT concat_ws('|', "searchStrategy", "enabled")
    FROM "AccessGrant" WHERE "id" = 'search-contract-grant';
  `), "openai-native-web-search|t");
  assert.equal(scalar(`
    SELECT string_agg("bindingKey", ',' ORDER BY "bindingKey")
    FROM "ProviderRunBinding" WHERE "modelRunId" = 'search-contract-run';
  `), "answer,search");
  assert.equal(scalar(`
    SELECT count(*)::text
    FROM "SearchStrategy" strategy
    JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
      AND revision."searchStrategyId" = strategy."id";
  `), scalar(`SELECT count(*)::text FROM "SearchStrategy";`));
  assert.equal(scalar(`
    SELECT concat_ws('|', "strategyId", "searchRevisionId" IS NULL,
      "invocationId" IS NULL, "query" IS NULL, "durationMs" IS NULL,
      "artifacts"->>'sentinel')
    FROM "SearchRun" WHERE "id" = 'search-contract-execution';
  `), "openai-native-web-search|t|t|t|t|artifacts-preserved");
  assert.match(scalar(`
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'SearchStrategy_provider_model_check';
  `), /provider_model_web_search/);

  applyThroughPreferenceMigration();
  assert.equal(scalar(`
    SELECT "defaultSearchPlan"::text
    FROM "UserSettings" WHERE "id" = 'search-contract-settings';
  `), '{"mode": "all_selected", "optionIds": ["openai-native-web-search"]}');
  assert.equal(scalar(`
    SELECT concat_ws('|', "id", "defaultPlan"::text, "version")
    FROM "SearchPolicy" WHERE "id" = 'installation';
  `), 'installation|{"mode": "all_selected", "optionIds": []}|1');
  assert.match(scalar(`
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'SearchPolicy_singleton_check';
  `), /id.*installation/);
  assert.equal(scalar(`
    SELECT concat_ws('|', is_nullable, COALESCE(column_default, 'NULL'))
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserSettings'
      AND column_name = 'defaultSearchPlan';
  `), "YES|NULL");
  requireSuccess(psql(`
    INSERT INTO "User" (
      "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-inheriting-user', 'search-inherit@example.test',
      'Search inheriting user', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "UserSettings" (
      "id", "userId", "defaultSearchStrategyId", "defaultControlValues", "updatedAt"
    ) VALUES (
      'search-contract-inheriting-settings', 'search-contract-inheriting-user',
      'search-disabled', '{}'::jsonb, CURRENT_TIMESTAMP
    );
  `), "insert inheriting Search preference fixture");
  assert.equal(scalar(`
    SELECT ("defaultSearchPlan" IS NULL)::text
    FROM "UserSettings" WHERE "id" = 'search-contract-inheriting-settings';
  `), "true");

  requireSuccess(psql(`
    INSERT INTO "ProviderRunBinding" (
      "id", "modelRunId", "bindingKey", "role", "credentialSource",
      "executionSnapshot", "createdAt"
    ) VALUES (
      'search-contract-second-technical-binding', 'search-contract-run',
      'search:second-option', 'search', 'default', '{"sentinel":"second-search"}'::jsonb,
      CURRENT_TIMESTAMP
    );

    INSERT INTO "SearchRunBinding" (
      "id", "modelRunId", "searchStrategyId", "revisionId", "optionId", "ordinal",
      "mode", "technicalBindingKey", "createdAt"
    )
    SELECT
      'search-contract-run-binding', 'search-contract-run', strategy."id", revision."id",
      strategy."strategyId", 0, 'model_choice', NULL, CURRENT_TIMESTAMP
    FROM "SearchStrategy" strategy
    JOIN "SearchIntegrationRevision" revision ON revision."id" = strategy."activeRevisionId"
    WHERE strategy."strategyId" = 'openai-native-web-search';
  `), "insert exact multi-binding fixtures");
  assert.equal(scalar(`
    SELECT concat_ws('|',
      (SELECT count(*) FROM "ProviderRunBinding" WHERE "modelRunId" = 'search-contract-run'),
      (SELECT count(*) FROM "SearchRunBinding" WHERE "modelRunId" = 'search-contract-run'));
  `), "3|1");

  process.stdout.write("Search control-plane migration contract: OK\n");
} finally {
  compose([
    "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
    "--username", POSTGRES_USER, database
  ]);
}
