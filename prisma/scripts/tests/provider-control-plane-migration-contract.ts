import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260723230000_provider_control_plane_foundation";
const CONTEXT_REPAIR_MIGRATION = "20260724120000_repair_provider_model_context_windows";
const RUN_PROFILE_MIGRATION = "20260724190000_admin_run_profiles";
const USER_ASSIGNMENT_MIGRATION = "20260726140000_provider_user_credential_assignments";
const DISABLE_FAKE_MIGRATION = "20260731120000_disable_production_fake_provider";
const MODEL_POLICY_MIGRATION = "20260808120000_model_default_policy";
const SYSTEM_MODEL_POLICY_MIGRATION = "20260808130000_system_model_policy";
const EMBEDDING_MODEL_CLASS_MIGRATION = "20260808140000_embedding_model_class";
const SYSTEM_MODEL_REASONING_MIGRATION = "20260812193000_system_model_reasoning_effort";
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

function applyMigrationsBefore(database: string, target: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < target)
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    requireSuccess(psql(database, migrationSql(migration)), `apply pre-${target} migration ${migration}`);
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

    requireSuccess(
      psql(database, migrationSql(USER_ASSIGNMENT_MIGRATION)),
      "apply provider user credential assignment migration"
    );
    assert.equal(
      scalar(
        database,
        `SELECT concat_ws('|',
          to_regclass('public."ProviderUserCredentialAssignment"')::text,
          EXISTS (
            SELECT 1 FROM pg_enum AS enum_value
            JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
            WHERE enum_type.typname = 'ProviderCredentialSource'
              AND enum_value.enumlabel = 'user'
          )::text
        );`
      ),
      `"ProviderUserCredentialAssignment"|true`
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
      "cross-connection user assignment",
      `INSERT INTO "ProviderUserCredentialAssignment" (
         "connectionId", "userId", "credentialId", "updatedAt"
       ) VALUES (
         '00000000-0000-4000-8000-000000001102', 'provider-user',
         'credential-openrouter', CURRENT_TIMESTAMP
       );`,
      /ProviderUserAssignment_credential_fkey/u
    );
    requireSuccess(
      psql(
        database,
        `INSERT INTO "ProviderUserCredentialAssignment" (
           "connectionId", "userId", "credentialId", "updatedAt"
         ) VALUES (
           '00000000-0000-4000-8000-000000001102', 'provider-user',
           'credential-openai', CURRENT_TIMESTAMP
         );`
      ),
      "create valid direct user credential assignment"
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

    requireSuccess(
      psql(database, migrationSql(DISABLE_FAKE_MIGRATION)),
      "withdraw the production Fake provider publication"
    );
    assert.equal(
      scalar(
        database,
        `SELECT concat_ws('|',
          connection."enabled"::text,
          connection."activeVersion"::text,
          (connection."activeConfig" IS NULL)::text,
          model."enabled"::text,
          model."activeVersion"::text,
          (model."activeConfig" IS NULL)::text,
          EXISTS (
            SELECT 1 FROM "ProviderRunBinding" WHERE "id" = 'binding-fake'
          )::text
        )
        FROM "ProviderConnection" connection
        JOIN "ProviderModel" model ON model."id" = 'provider-model-fake'
        WHERE connection."id" = '00000000-0000-4000-8000-000000001101';`
      ),
      "false|0|true|false|0|true|true"
    );
  } finally {
    dropDatabase(database);
  }
}

function runModelPolicyMigrationChecks(): void {
  const database = `aiqsa_model_policy_${runId}`;
  createDatabase(database);
  try {
    applyMigrationsBefore(database, MODEL_POLICY_MIGRATION);
    requireSuccess(psql(database, `
      INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
      VALUES ('model-policy-user', 'model-policy@example.test', 'Policy user', 'admin', 'active', CURRENT_TIMESTAMP);

      INSERT INTO "ProviderConnection" (
        "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
        "activeConfig", "activeVersion", "activatedAt", "updatedAt"
      ) VALUES (
        'model-policy-connection', 'Policy connection', 'openai_compatible', true,
        '{}'::jsonb, 1, '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "ProviderModel" (
        "id", "connectionId", "provider", "modelId", "displayName", "contextWindow",
        "enabled", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
        "activatedAt", "capabilities", "defaultParams", "updatedAt"
      ) VALUES (
        'model-policy-model', 'model-policy-connection', 'openai_compatible',
        'policy-model', 'Policy model', 128000, true,
        '{"adapterKind":"openai_responses_compatible","answerSelectable":true}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","answerSelectable":true}'::jsonb,
        1, CURRENT_TIMESTAMP, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
      );

      INSERT INTO "UserSettings" (
        "id", "userId", "defaultProviderModelId", "defaultSearchStrategyId",
        "defaultControlValues", "updatedAt"
      ) VALUES (
        'model-policy-settings', 'model-policy-user', 'model-policy-model',
        'search-disabled', '{}'::jsonb, CURRENT_TIMESTAMP
      );

      INSERT INTO "Chat" (
        "id", "userId", "title", "defaultProviderModelId", "updatedAt"
      ) VALUES (
        'model-policy-chat', 'model-policy-user', 'Policy chat',
        'model-policy-model', CURRENT_TIMESTAMP
      );
    `), "load model policy preservation fixture");

    requireSuccess(
      psql(database, migrationSql(MODEL_POLICY_MIGRATION)),
      "apply model policy migration"
    );
    assert.equal(
      scalar(database, `SELECT concat_ws('|',
        policy."id",
        COALESCE(policy."defaultProviderModelId", 'null'),
        policy."version"::text,
        settings."defaultProviderModelId",
        chat."defaultProviderModelId"
      )
      FROM "ModelPolicy" policy
      JOIN "UserSettings" settings ON settings."id" = 'model-policy-settings'
      JOIN "Chat" chat ON chat."id" = 'model-policy-chat'
      WHERE policy."id" = 'installation';`),
      "installation|null|1|model-policy-model|model-policy-model"
    );

    expectDatabaseRejection(
      database,
      "second model policy singleton",
      `INSERT INTO "ModelPolicy" ("id", "defaultProviderModelId", "updatedAt")
       VALUES ('other', NULL, CURRENT_TIMESTAMP);`,
      /ModelPolicy_singleton_check/u
    );
    expectDatabaseRejection(
      database,
      "invalid model policy version",
      `UPDATE "ModelPolicy" SET "version" = 0 WHERE "id" = 'installation';`,
      /ModelPolicy_version_check/u
    );
    requireSuccess(psql(database, `
      UPDATE "ModelPolicy"
      SET "defaultProviderModelId" = 'model-policy-model', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'installation';
      UPDATE "UserSettings"
      SET "defaultProviderModelId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'model-policy-settings';
      UPDATE "Chat"
      SET "defaultProviderModelId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'model-policy-chat';
    `), "set model policy target");
    expectDatabaseRejection(
      database,
      "delete installation default model",
      `DELETE FROM "ProviderModel" WHERE "id" = 'model-policy-model';`,
      /ModelPolicy_defaultProviderModelId_fkey/u
    );
  } finally {
    dropDatabase(database);
  }
}

function runSystemModelPolicyMigrationChecks(): void {
  const database = `aiqsa_system_model_policy_${runId}`;
  createDatabase(database);
  try {
    applyMigrationsBefore(database, SYSTEM_MODEL_POLICY_MIGRATION);
    requireSuccess(psql(database, `
      INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
      VALUES (
        'system-policy-admin', 'system-policy@example.test',
        'System policy admin', 'admin', 'active', CURRENT_TIMESTAMP
      );

      INSERT INTO "ProviderConnection" (
        "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
        "activeConfig", "activeVersion", "activatedAt", "updatedAt"
      ) VALUES (
        'system-policy-connection', 'System policy connection', 'openai_compatible', true,
        '{}'::jsonb, 1, '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "ProviderModel" (
        "id", "connectionId", "provider", "modelId", "displayName", "contextWindow",
        "enabled", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
        "activatedAt", "capabilities", "defaultParams", "updatedAt"
      ) VALUES (
        'system-policy-model', 'system-policy-connection', 'openai_compatible',
        'system-model', 'System model', 128000, true,
        '{"adapterKind":"openai_responses_compatible","answerSelectable":true}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","answerSelectable":true}'::jsonb,
        1, CURRENT_TIMESTAMP, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
      );
    `), "load system model policy fixture");

    requireSuccess(
      psql(database, migrationSql(SYSTEM_MODEL_POLICY_MIGRATION)),
      "apply system model policy migration"
    );
    assert.equal(
      scalar(database, `SELECT concat_ws('|',
        "id", COALESCE("providerModelId", 'null'), "version"::text
      ) FROM "SystemModelPolicy" WHERE "id" = 'installation';`),
      "installation|null|1"
    );
    expectDatabaseRejection(
      database,
      "second system model policy singleton",
      `INSERT INTO "SystemModelPolicy" ("id", "providerModelId", "updatedAt")
       VALUES ('other', NULL, CURRENT_TIMESTAMP);`,
      /SystemModelPolicy_singleton_check/u
    );
    expectDatabaseRejection(
      database,
      "invalid system model policy version",
      `UPDATE "SystemModelPolicy" SET "version" = 0 WHERE "id" = 'installation';`,
      /SystemModelPolicy_version_check/u
    );
    requireSuccess(
      psql(database, migrationSql(SYSTEM_MODEL_REASONING_MIGRATION)),
      "apply system model reasoning migration"
    );
    assert.equal(
      scalar(database, `SELECT COALESCE("reasoningEffort", 'null')
        FROM "SystemModelPolicy" WHERE "id" = 'installation';`),
      "null"
    );
    expectDatabaseRejection(
      database,
      "system model reasoning without a target",
      `UPDATE "SystemModelPolicy" SET "reasoningEffort" = 'xhigh'
       WHERE "id" = 'installation';`,
      /SystemModelPolicy_reasoning_target_check/u
    );
    requireSuccess(psql(database, `
      UPDATE "SystemModelPolicy"
      SET "providerModelId" = 'system-policy-model',
          "reasoningEffort" = 'xhigh',
          "updatedByUserId" = 'system-policy-admin',
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'installation';
    `), "set system model target and reasoning effort");
    expectDatabaseRejection(
      database,
      "invalid system model reasoning effort",
      `UPDATE "SystemModelPolicy" SET "reasoningEffort" = ' xhigh'
       WHERE "id" = 'installation';`,
      /SystemModelPolicy_reasoningEffort_check/u
    );
    expectDatabaseRejection(
      database,
      "clear system model while reasoning remains selected",
      `UPDATE "SystemModelPolicy" SET "providerModelId" = NULL
       WHERE "id" = 'installation';`,
      /SystemModelPolicy_reasoning_target_check/u
    );
    requireSuccess(psql(database, `
      DELETE FROM "User" WHERE "id" = 'system-policy-admin';
    `), "delete the system model policy administrator");
    assert.equal(
      scalar(database, `SELECT concat_ws('|',
        "providerModelId", "reasoningEffort", COALESCE("updatedByUserId", 'null')
      ) FROM "SystemModelPolicy" WHERE "id" = 'installation';`),
      "system-policy-model|xhigh|null"
    );
    expectDatabaseRejection(
      database,
      "delete selected system model",
      `DELETE FROM "ProviderModel" WHERE "id" = 'system-policy-model';`,
      /SystemModelPolicy_providerModelId_fkey/u
    );
  } finally {
    dropDatabase(database);
  }
}

function runEmbeddingModelClassMigrationChecks(): void {
  const database = `aiqsa_embedding_model_class_${runId}`;
  createDatabase(database);
  try {
    applyMigrationsBefore(database, EMBEDDING_MODEL_CLASS_MIGRATION);
    requireSuccess(psql(database, `
      INSERT INTO "ProviderConnection" (
        "id", "displayName", "family", "draftConfig", "updatedAt"
      ) VALUES (
        'embedding-connection', 'Embedding connection', 'openrouter',
        '{}'::jsonb, CURRENT_TIMESTAMP
      );

      INSERT INTO "ProviderModel" (
        "id", "connectionId", "provider", "modelId", "displayName",
        "contextWindow", "draftConfig", "capabilities", "defaultParams",
        "updatedAt"
      ) VALUES (
        'legacy-answer-model', 'embedding-connection', 'openrouter',
        'vendor/answer', 'Legacy answer', 8192, '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, CURRENT_TIMESTAMP
      );
    `), "load embedding model-class preservation fixture");

    requireSuccess(
      psql(database, migrationSql(EMBEDDING_MODEL_CLASS_MIGRATION)),
      "apply embedding model-class migration"
    );
    assert.equal(
      scalar(database, `SELECT concat_ws('|',
        (SELECT "modelClass"::text FROM "ProviderModel" WHERE "id" = 'legacy-answer-model'),
        (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
         FROM pg_enum
         WHERE enumtypid = '"ProviderModelClass"'::regtype),
        COALESCE(to_regclass('public."ProviderModel_modelClass_enabled_idx"')::text, 'null')
      );`),
      'answer|answer,embedding|"ProviderModel_modelClass_enabled_idx"'
    );
    requireSuccess(psql(database, `
      INSERT INTO "ProviderModel" (
        "id", "connectionId", "provider", "modelId", "displayName",
        "modelClass", "contextWindow", "draftConfig", "capabilities",
        "defaultParams", "updatedAt"
      ) VALUES (
        'embedding-model', 'embedding-connection', 'openrouter',
        'qwen/qwen3-embedding-8b', 'Qwen3 Embedding 8B', 'embedding', 32768,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
      );
    `), "insert embedding-class deployment");
    assert.equal(
      scalar(database, `SELECT "modelClass"::text FROM "ProviderModel"
        WHERE "id" = 'embedding-model';`),
      "embedding"
    );
    expectDatabaseRejection(
      database,
      "unknown provider model class",
      `UPDATE "ProviderModel" SET "modelClass" = 'reranker'
       WHERE "id" = 'embedding-model';`,
      /invalid input value for enum "ProviderModelClass"/u
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
    runModelPolicyMigrationChecks();
    runSystemModelPolicyMigrationChecks();
    runEmbeddingModelClassMigrationChecks();
  } finally {
    for (const database of [...disposableDatabases].reverse()) {
      dropDatabase(database);
    }
  }

  process.stdout.write(
    "AIQSA provider migration contract ok: fail-closed legacy conversion, context repair, run-profile mapping, composite lineage, Fake withdrawal, installation model-policy and reasoning foundations, and embedding model classes verified.\n"
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
