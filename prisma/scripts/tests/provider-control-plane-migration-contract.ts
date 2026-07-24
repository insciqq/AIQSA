import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260723230000_provider_control_plane_foundation";
const CONTEXT_REPAIR_MIGRATION = "20260724120000_repair_provider_model_context_windows";
const RUN_PROFILE_MIGRATION = "20260724190000_admin_run_profiles";
const POSTGRES_USER = "aiqsa";
const POSTGRES_SERVICE = "postgres";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;
const templateDatabase = `aiqsa_provider_template_${runId}`;
const disposableDatabases = new Set<string>();

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
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

function psql(database: string, sql: string): CommandResult {
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

function scalar(database: string, sql: string): string {
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
    "read provider migration contract state"
  );
}

function createDatabase(database: string, template?: string): void {
  const args = ["exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER];
  if (template) args.push("--template", template);
  args.push(database);
  requireSuccess(compose(args), `create disposable database ${database}`);
  disposableDatabases.add(database);
}

function dropDatabase(database: string): void {
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
    `drop disposable database ${database}`
  );
  disposableDatabases.delete(database);
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function applyPreTargetMigrations(database: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  assert(migrations.length > 0, "expected migrations before provider foundation");
  for (const migration of migrations) {
    requireSuccess(psql(database, migrationSql(migration)), `apply pre-target migration ${migration}`);
  }
}

const knownFixture = `
INSERT INTO "User" ("id", "email", "displayName", "updatedAt")
VALUES ('provider-user', 'provider@example.test', 'Provider user', CURRENT_TIMESTAMP);

INSERT INTO "Group" ("id", "name", "updatedAt")
VALUES ('provider-group', 'Provider group', CURRENT_TIMESTAMP);

INSERT INTO "ProviderModel" (
  "id", "provider", "modelId", "displayName", "contextWindow", "capabilities",
  "defaultParams", "updatedAt"
) VALUES
  (
    'provider-model-fake', 'fake', 'fake-qsa', 'Fake QSA', 8192,
    '{"streaming":true}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
  ),
  (
    'provider-model-openai', 'openai', 'gpt-contract', 'GPT Contract', 128000,
    '{"nativeBackground":true,"streaming":true}'::jsonb,
    '{"background":true}'::jsonb, CURRENT_TIMESTAMP
  ),
  (
    'provider-model-openrouter', 'openrouter', 'perplexity/contract',
    'Perplexity Contract', 128000, '{"streaming":true}'::jsonb,
    '{}'::jsonb, CURRENT_TIMESTAMP
  );

INSERT INTO "SearchStrategy" (
  "id", "strategyId", "provider", "modelId", "displayName", "kind",
  "description", "config", "updatedAt"
) VALUES
  (
    'search-none', 'search-disabled', 'fake', NULL, 'No search', 'none',
    'No search', '{}'::jsonb, CURRENT_TIMESTAMP
  ),
  (
    'search-native', 'openai-native-web-search', 'openai', 'gpt-contract',
    'Native search', 'openai_native_web_search', 'Native search', '{}'::jsonb,
    CURRENT_TIMESTAMP
  ),
  (
    'search-provider', 'perplexity-tool-search', 'openrouter',
    'perplexity/contract', 'Provider search', 'perplexity_tool_search',
    'Provider search', '{}'::jsonb, CURRENT_TIMESTAMP
  );

INSERT INTO "UserSettings" (
  "id", "userId", "defaultProvider", "defaultModelId", "defaultControlValues", "updatedAt"
) VALUES (
  'provider-settings', 'provider-user', 'openai', 'gpt-contract',
  '{"openai:gpt-contract":{"temperature":0.25},"unknown:stale":{"temperature":0.5}}'::jsonb,
  CURRENT_TIMESTAMP
);

INSERT INTO "Chat" (
  "id", "userId", "title", "defaultProvider", "defaultModelId", "updatedAt"
) VALUES (
  'provider-chat', 'provider-user', 'Provider chat', 'openai', 'gpt-contract',
  CURRENT_TIMESTAMP
);

INSERT INTO "AccessGrant" (
  "id", "groupId", "provider", "modelId", "updatedAt"
) VALUES
  ('provider-grant-model', 'provider-group', 'openai', 'gpt-contract', CURRENT_TIMESTAMP),
  ('provider-grant-family', 'provider-group', 'openrouter', NULL, CURRENT_TIMESTAMP);

INSERT INTO "AccessGrant" (
  "id", "groupId", "searchStrategy", "updatedAt"
) VALUES (
  'provider-grant-search', 'provider-group', 'perplexity-tool-search', CURRENT_TIMESTAMP
);

INSERT INTO "Message" (
  "id", "chatId", "role", "content", "status", "updatedAt"
) VALUES (
  'provider-message', 'provider-chat', 'user', '{"blocks":[]}'::jsonb,
  'complete', CURRENT_TIMESTAMP
);

INSERT INTO "ModelRun" (
  "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
  "normalizedRequest", "updatedAt"
) VALUES (
  'provider-run', 'provider-chat', 'provider-user', 'provider-message', 'openai',
  'gpt-contract', 'complete', '{}'::jsonb, CURRENT_TIMESTAMP
);
`;

function expectMigrationFailure(label: string, fixture: string, expected: RegExp): void {
  const database = `aiqsa_provider_fail_${label}_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, fixture), `load ${label} fixture`);
    const result = psql(database, migrationSql(TARGET_MIGRATION));
    assert.notEqual(result.status, 0, `${label} unexpectedly passed provider migration`);
    assert.match(`${result.stdout}\n${result.stderr}`, expected);
    assert.equal(
      scalar(database, `SELECT to_regclass('"ProviderConnection"') IS NULL;`),
      "t",
      `${label} did not roll back the failed provider migration`
    );
  } finally {
    dropDatabase(database);
  }
}

function expectDatabaseRejection(database: string, label: string, sql: string, expected: RegExp): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly passed database lineage checks`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function runValidMigrationAndLineageChecks(): void {
  const database = `aiqsa_provider_valid_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, knownFixture), "load valid provider fixture");
    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "apply provider foundation migration");

    assert.equal(
      scalar(
        database,
        `SELECT concat_ws('|',
          (SELECT "id" FROM "ProviderModel" WHERE "provider" = 'openai'),
          (SELECT "enabled"::text || ':' || "activeVersion"::text FROM "ProviderModel" WHERE "provider" = 'openai'),
          (SELECT "enabled"::text || ':' || "activeVersion"::text FROM "ProviderModel" WHERE "provider" = 'fake'),
          (SELECT "defaultProviderModelId" FROM "UserSettings" WHERE "id" = 'provider-settings'),
          (SELECT "defaultProviderModelId" FROM "Chat" WHERE "id" = 'provider-chat'),
          (SELECT "providerModelId" FROM "SearchStrategy" WHERE "id" = 'search-provider'),
          COALESCE((SELECT "providerModelId" FROM "SearchStrategy" WHERE "id" = 'search-native'), 'null'),
          (SELECT "providerModelId" FROM "AccessGrant" WHERE "id" = 'provider-grant-model'),
          (SELECT "providerConnectionId" FROM "AccessGrant" WHERE "id" = 'provider-grant-family'),
          (SELECT "defaultControlValues" ->
             '00000000-0000-4000-8000-000000001102:provider-model-openai' ->> 'temperature'
           FROM "UserSettings" WHERE "id" = 'provider-settings'),
          COALESCE((SELECT "defaultControlValues" -> 'openai:gpt-contract'
                    FROM "UserSettings" WHERE "id" = 'provider-settings')::text, 'null'),
          (SELECT "defaultControlValues" -> 'unknown:stale' ->> 'temperature'
           FROM "UserSettings" WHERE "id" = 'provider-settings'),
          (SELECT count(*)::text
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (
               (table_name = 'AccessGrant' AND column_name IN ('provider', 'modelId'))
               OR (table_name IN ('UserSettings', 'Chat')
                   AND column_name IN ('defaultProvider', 'defaultModelId'))
             )),
          COALESCE(to_regclass('public."AccessGrant_provider_modelId_idx"')::text, 'null')
        );`
      ),
      [
        "provider-model-openai",
        "false:0",
        "true:1",
        "provider-model-openai",
        "provider-model-openai",
        "provider-model-openrouter",
        "null",
        "provider-model-openai",
        "00000000-0000-4000-8000-000000001104",
        "0.25",
        "null",
        "0.5",
        "0",
        "null"
      ].join("|")
    );

    requireSuccess(
      psql(
        database,
        `UPDATE "ProviderModel"
         SET
           "activeConfig" = "draftConfig",
           "activeVersion" = 1,
           "activatedAt" = CURRENT_TIMESTAMP,
           "contextWindow" = 1,
           "enabled" = true,
           "templateKey" = 'openai:gpt-5.5'
         WHERE "id" = 'provider-model-openai';

         UPDATE "ProviderModel"
         SET "contextWindow" = 1, "templateKey" = NULL
         WHERE "id" = 'provider-model-openrouter';`
      ),
      "prepare provider context repair fixture"
    );
    requireSuccess(
      psql(database, migrationSql(CONTEXT_REPAIR_MIGRATION)),
      "apply provider context repair migration"
    );
    assert.equal(
      scalar(
        database,
        `SELECT concat_ws('|',
          (SELECT "contextWindow"::text FROM "ProviderModel" WHERE "id" = 'provider-model-openai'),
          (SELECT "draftConfig" #>> '{capabilities,contextWindow}' FROM "ProviderModel" WHERE "id" = 'provider-model-openai'),
          (SELECT "activeConfig" #>> '{capabilities,contextWindow}' FROM "ProviderModel" WHERE "id" = 'provider-model-openai'),
          (SELECT "draftConfig" #>> '{capabilities,contextWindow}' FROM "ProviderModel" WHERE "id" = 'provider-model-fake'),
          (SELECT "activeConfig" #>> '{capabilities,contextWindow}' FROM "ProviderModel" WHERE "id" = 'provider-model-fake'),
          COALESCE((SELECT "draftConfig" #>> '{capabilities,contextWindow}' FROM "ProviderModel" WHERE "id" = 'provider-model-openrouter'), 'null')
        );`
      ),
      "1050000|1050000|1050000|8192|8192|null"
    );

    requireSuccess(
      psql(
        database,
        `UPDATE "ProviderModel"
         SET "templateKey" = 'openai:gpt-5.6-sol', "modelId" = 'gpt-5.6-sol',
             "displayName" = 'GPT-5.6 Sol'
         WHERE "id" = 'provider-model-openai';

         INSERT INTO "ProviderModel" (
           "id", "connectionId", "templateKey", "provider", "modelId", "displayName",
           "contextWindow", "inputTokenPriceMicros", "outputTokenPriceMicros",
           "supportsVision", "supportsPdf", "supportsReasoning", "supportsNativeSearch",
           "enabled", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
           "activatedAt", "capabilities", "defaultParams", "createdAt", "updatedAt"
         )
         SELECT
           variant."id", source."connectionId", variant."templateKey", source."provider",
           variant."modelId", variant."displayName", source."contextWindow",
           source."inputTokenPriceMicros", source."outputTokenPriceMicros",
           source."supportsVision", source."supportsPdf", source."supportsReasoning",
           source."supportsNativeSearch", source."enabled", source."draftConfig",
           source."draftVersion", source."activeConfig", source."activeVersion",
           source."activatedAt", source."capabilities", source."defaultParams",
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         FROM "ProviderModel" AS source
         CROSS JOIN (VALUES
           ('provider-model-luna', 'openai:gpt-5.6-luna', 'gpt-5.6-luna', 'GPT-5.6 Luna'),
           ('provider-model-terra', 'openai:gpt-5.6-terra', 'gpt-5.6-terra', 'GPT-5.6 Terra')
         ) AS variant("id", "templateKey", "modelId", "displayName")
         WHERE source."id" = 'provider-model-openai';`
      ),
      "prepare run profile migration fixture"
    );
    requireSuccess(
      psql(database, migrationSql(RUN_PROFILE_MIGRATION)),
      "apply run profile migration"
    );
    assert.equal(
      scalar(
        database,
        `SELECT string_agg(
           "id" || ':' || "enabled"::text || ':' || "providerModelId" || ':' ||
           "reasoningMode" || ':' || "reasoningEffort",
           '|' ORDER BY CASE "id" WHEN 'fast' THEN 1 WHEN 'balanced' THEN 2 ELSE 3 END
         ) FROM "RunProfile";`
      ),
      [
        "fast:true:provider-model-luna:standard:medium",
        "balanced:true:provider-model-terra:standard:medium",
        "deep:true:provider-model-openai:pro:max"
      ].join("|")
    );
    expectDatabaseRejection(
      database,
      "unknown run profile slot",
      `INSERT INTO "RunProfile" (
         "id", "description", "enabled", "providerModelId", "reasoningEffort", "reasoningMode"
       ) VALUES ('custom', 'Custom', false, NULL, 'medium', 'standard');`,
      /RunProfile_id_check/u
    );
    expectDatabaseRejection(
      database,
      "inconsistent run profile target",
      `UPDATE "RunProfile" SET "enabled" = false WHERE "id" = 'fast';`,
      /RunProfile_enabled_target_check/u
    );
    expectDatabaseRejection(
      database,
      "delete configured run profile model",
      `DELETE FROM "ProviderModel" WHERE "id" = 'provider-model-luna';`,
      /RunProfile_providerModelId_fkey/u
    );

    requireSuccess(
      psql(
        database,
        `INSERT INTO "ProviderCredential" (
          "id", "connectionId", "label", "enabled", "updatedAt"
        ) VALUES
          ('credential-openai', '00000000-0000-4000-8000-000000001102', 'OpenAI key', true, CURRENT_TIMESTAMP),
          ('credential-openrouter', '00000000-0000-4000-8000-000000001104', 'OpenRouter key', true, CURRENT_TIMESTAMP);

        INSERT INTO "ProviderCredentialVersion" (
          "id", "credentialId", "version", "secretEnvelope", "testEvidence",
          "testedAt", "activatedAt"
        ) VALUES
          ('version-openai', 'credential-openai', 1, 'v2.test.openai', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('version-openrouter', 'credential-openrouter', 1, 'v2.test.openrouter', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        UPDATE "ProviderCredential"
        SET "activeVersionId" = 'version-openai', "activatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 'credential-openai';`
      ),
      "create valid credential lineage fixture"
    );

    expectDatabaseRejection(
      database,
      "cross-connection default credential",
      `UPDATE "ProviderConnection"
       SET "defaultCredentialId" = 'credential-openrouter'
       WHERE "id" = '00000000-0000-4000-8000-000000001102';`,
      /ProviderConnection_defaultCredential_fkey/u
    );
    expectDatabaseRejection(
      database,
      "cross-credential active version",
      `UPDATE "ProviderCredential"
       SET "activeVersionId" = 'version-openrouter', "activatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = 'credential-openai';`,
      /ProviderCredential_activeVersion_fkey/u
    );
    expectDatabaseRejection(
      database,
      "cross-connection group assignment",
      `INSERT INTO "ProviderGroupCredentialAssignment" (
         "connectionId", "groupId", "credentialId", "updatedAt"
       ) VALUES (
         '00000000-0000-4000-8000-000000001102', 'provider-group',
         'credential-openrouter', CURRENT_TIMESTAMP
       );`,
      /ProviderGroupAssignment_credential_fkey/u
    );
    expectDatabaseRejection(
      database,
      "cross-connection active check",
      `INSERT INTO "ProviderModelCredentialCheck" (
         "id", "connectionId", "providerModelId", "credentialId",
         "credentialVersionId", "connectionVersion", "modelVersion", "status",
         "checkedAt", "updatedAt"
       ) VALUES (
         'check-cross', '00000000-0000-4000-8000-000000001102',
         'provider-model-openrouter', 'credential-openai', 'version-openai', 1, 1,
         'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       );`,
      /ProviderModelCredentialCheck_model_fkey/u
    );
    expectDatabaseRejection(
      database,
      "partial provider binding",
      `INSERT INTO "ProviderRunBinding" (
         "id", "modelRunId", "role", "connectionId", "credentialSource",
         "executionSnapshot"
       ) VALUES (
         'binding-partial', 'provider-run', 'answer',
         '00000000-0000-4000-8000-000000001102', 'default', '{}'::jsonb
       );`,
      /ProviderRunBinding_live_or_detached_check/u
    );
    requireSuccess(
      psql(
        database,
        `INSERT INTO "ProviderRunBinding" (
           "id", "modelRunId", "role", "connectionId", "providerModelId",
           "credentialSource", "executionSnapshot"
         ) VALUES (
           'binding-fake', 'provider-run', 'answer',
           '00000000-0000-4000-8000-000000001101', 'provider-model-fake',
           'default', '{}'::jsonb
         );`
      ),
      "accept credential-free Fake provider binding"
    );
  } finally {
    dropDatabase(database);
  }
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect development PostgreSQL"
    ),
    POSTGRES_SERVICE,
    "development PostgreSQL must be running"
  );

  createDatabase(templateDatabase);
  try {
    applyPreTargetMigrations(templateDatabase);

    expectMigrationFailure(
      "unknown",
      `INSERT INTO "ProviderModel" (
        "id", "provider", "modelId", "displayName", "contextWindow", "capabilities",
        "defaultParams", "updatedAt"
      ) VALUES (
        'unknown-model', 'unknown', 'unknown/model', 'Unknown', 1024, '{}'::jsonb,
        '{}'::jsonb, CURRENT_TIMESTAMP
      );`,
      /unsupported model providers: unknown/u
    );

    expectMigrationFailure(
      "default",
      `${knownFixture}
       UPDATE "UserSettings" SET "defaultModelId" = 'missing-model'
       WHERE "id" = 'provider-settings';`,
      /unresolved UserSettings provider\/model defaults/u
    );

    expectMigrationFailure(
      "grant",
      `${knownFixture}
       UPDATE "AccessGrant" SET "modelId" = 'missing-model'
       WHERE "id" = 'provider-grant-model';`,
      /unresolved access-grant providers\/models/u
    );

    expectMigrationFailure(
      "search",
      `${knownFixture}
       UPDATE "SearchStrategy" SET "modelId" = 'missing-model'
       WHERE "id" = 'search-provider';`,
      /unresolved provider-backed search model/u
    );

    runValidMigrationAndLineageChecks();
  } finally {
    for (const database of [...disposableDatabases].reverse()) {
      dropDatabase(database);
    }
  }

  process.stdout.write(
    "AIQSA provider migration contract ok: fail-closed legacy conversion, context repair, run-profile mapping, and composite lineage verified.\n"
  );
}

try {
  main();
} catch (error) {
  for (const database of [...disposableDatabases].reverse()) {
    try {
      dropDatabase(database);
    } catch {
      // Preserve the first contract failure after best-effort cleanup.
    }
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.exitCode = 1;
}
