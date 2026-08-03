import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260729113000_search_control_plane";
const PREFERENCE_MIGRATION = "20260731183000_inherited_search_preferences";
const LOGICAL_OPTION_REPAIR_MIGRATION = "20260802185000_prepare_logical_search_route_collapse";
const LOGICAL_OPTION_MIGRATION = "20260802190000_logical_search_options";
const PROVIDER_NEUTRAL_BACKFILL_MIGRATION =
  "20260803120000_activate_provider_neutral_search_routes";
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

function providerNeutralDraftHash(input: Readonly<{
  maxResults: number;
  providerModelId: string;
  queryMaxCharacters: number;
  timeoutMs: number;
}>): string {
  const canonical = JSON.stringify({
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxResults: input.maxResults,
    protocol: "openai_responses_web_search",
    providerModelId: input.providerModelId,
    queryMaxCharacters: input.queryMaxCharacters,
    timeoutMs: input.timeoutMs
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
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

function applyLogicalOptionMigration(): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name > PREFERENCE_MIGRATION &&
      entry.name <= LOGICAL_OPTION_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert(migrations.some((migration) => migration === LOGICAL_OPTION_MIGRATION),
    "expected logical Search option migration");
  assert(migrations.some((migration) => migration === LOGICAL_OPTION_REPAIR_MIGRATION),
    "expected logical Search legacy-route repair migration");
  assert(
    migrations.indexOf(LOGICAL_OPTION_REPAIR_MIGRATION) <
      migrations.indexOf(LOGICAL_OPTION_MIGRATION),
    "legacy-route repair must run before logical Search option collapse"
  );
  for (const migration of migrations) {
    requireSuccess(psql(migrationSql(migration)), `apply post-preference migration ${migration}`);
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

  requireSuccess(psql(`
    INSERT INTO "ProviderConnection" (
      "id", "templateKey", "displayName", "family", "enabled", "unassignedPolicy",
      "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "activatedAt", "createdAt", "updatedAt"
    ) VALUES
      (
        'search-custom-single', NULL, 'Codex gateway', 'openai_compatible', true,
        'require_assignment',
        '{"apiRoot":"https://single.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        1,
        '{"apiRoot":"https://single.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-custom-multiple', NULL, 'Multi gateway', 'openai_compatible', true,
        'require_assignment',
        '{"apiRoot":"https://multiple.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        1,
        '{"apiRoot":"https://multiple.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-gemini-sentinel', 'gemini', 'Gemini sentinel', 'gemini', true,
        'require_assignment',
        '{"apiRoot":"https://gemini.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        7,
        '{"apiRoot":"https://gemini.example.test/v1","allowPrivateNetwork":false}'::jsonb,
        6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

    UPDATE "ProviderConnection"
    SET
      "enabled" = true,
      "activeConfig" = "draftConfig",
      "activeVersion" = 1,
      "activatedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "templateKey" = 'openai';

    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName",
      "contextWindow", "supportsNativeSearch", "enabled", "draftConfig",
      "draftVersion", "activeConfig", "activeVersion", "activatedAt",
      "capabilities", "defaultParams", "createdAt", "updatedAt"
    ) VALUES
      (
        'search-custom-single-model', 'search-custom-single', 'openai_compatible',
        'custom-sol', 'Custom Sol', 128000, true, true,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-sol","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-sol","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1, CURRENT_TIMESTAMP, '{"nativeSearch":true}'::jsonb, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-custom-single-model-secondary', 'search-custom-single', 'openai_compatible',
        'custom-gpt-5.5', 'Custom GPT-5.5', 128000, true, true,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-gpt-5.5","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-gpt-5.5","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1, CURRENT_TIMESTAMP, '{"nativeSearch":true}'::jsonb, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-custom-multiple-model-a', 'search-custom-multiple', 'openai_compatible',
        'custom-a', 'Custom A', 128000, true, true,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-a","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-a","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1, CURRENT_TIMESTAMP, '{"nativeSearch":true}'::jsonb, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-custom-multiple-model-b', 'search-custom-multiple', 'openai_compatible',
        'custom-b', 'Custom B', 128000, true, true,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-b","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1,
        '{"adapterKind":"openai_responses_compatible","upstreamModelId":"custom-b","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
        1, CURRENT_TIMESTAMP, '{"nativeSearch":true}'::jsonb, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-gemini-sentinel-model', 'search-gemini-sentinel', 'gemini',
        'gemini-sentinel', 'Gemini sentinel model', 64000, true, false,
        '{"adapterKind":"gemini_interactions_native","upstreamModelId":"gemini-sentinel","capabilities":{"nativeSearch":true},"defaultParams":{"sentinel":"draft"}}'::jsonb,
        9,
        '{"adapterKind":"gemini_interactions_native","upstreamModelId":"gemini-sentinel","capabilities":{"nativeSearch":true},"defaultParams":{"sentinel":"active"}}'::jsonb,
        8, CURRENT_TIMESTAMP, '{"nativeSearch":true,"sentinel":"capabilities"}'::jsonb,
        '{"sentinel":"legacy-defaults"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName",
      "contextWindow", "supportsNativeSearch", "enabled", "draftConfig",
      "draftVersion", "activeConfig", "activeVersion", "activatedAt",
      "capabilities", "defaultParams", "createdAt", "updatedAt"
    )
    SELECT
      'search-official-openai-model', connection."id", 'openai',
      'official-search-model', 'Official Search model', 128000, true, true,
      '{"adapterKind":"openai_responses_native","upstreamModelId":"official-search-model","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
      1,
      '{"adapterKind":"openai_responses_native","upstreamModelId":"official-search-model","capabilities":{"nativeSearch":true},"defaultParams":{}}'::jsonb,
      1, CURRENT_TIMESTAMP, '{"nativeSearch":true}'::jsonb, '{}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "ProviderConnection" connection
    WHERE connection."templateKey" = 'openai';

    INSERT INTO "SearchStrategy" (
      "id", "strategyId", "provider", "modelId", "providerModelId",
      "displayName", "kind", "description", "enabled", "config",
      "adapterKind", "credentialMode", "draft", "draftVersion",
      "testedDraftHash", "draftTestEvidence", "createdAt", "updatedAt"
    )
    SELECT
      'system-openai-provider-web-search', 'openai-provider-web-search', 'openai',
      model."modelId", model."id", 'OpenAI Search (provider-neutral)',
      'provider_model_web_search', 'Query-only OpenAI route', true,
      '{"sentinel":"provider-route"}'::jsonb, 'provider_model_client',
      'provider_model',
      jsonb_build_object(
        'adapterKind', 'provider_model_client',
        'credentialMode', 'provider_model',
        'maxResults', 8,
        'protocol', 'openai_responses_web_search',
        'providerModelId', model."id",
        'queryMaxCharacters', 500,
        'timeoutMs', 300000
      ),
      1, 'search-contract-provider-draft',
      '{"method":"contract","status":"available"}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "ProviderModel" model
    WHERE model."id" = 'search-custom-single-model';

    INSERT INTO "SearchIntegrationRevision" (
      "id", "searchStrategyId", "revisionNumber", "adapterKind",
      "credentialMode", "configuration", "providerModelId",
      "validationEvidence", "draftHash", "createdAt"
    )
    SELECT
      'search-contract-openai-provider-revision', strategy."id", 1,
      strategy."adapterKind", strategy."credentialMode", strategy."draft",
      strategy."providerModelId", strategy."draftTestEvidence",
      strategy."testedDraftHash", CURRENT_TIMESTAMP
    FROM "SearchStrategy" strategy
    WHERE strategy."strategyId" = 'openai-provider-web-search';

    UPDATE "SearchStrategy"
    SET
      "activeRevisionId" = 'search-contract-openai-provider-revision',
      "activatedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "strategyId" = 'openai-provider-web-search';

    INSERT INTO "SearchStrategy" (
      "id", "strategyId", "provider", "modelId", "providerModelId",
      "displayName", "kind", "description", "enabled", "config",
      "adapterKind", "credentialMode", "draft", "draftVersion",
      "testedDraftHash", "draftTestEvidence", "createdAt", "updatedAt"
    )
    SELECT
      'search-contract-custom-secondary', 'custom-secondary-web-search',
      'openai_compatible', model."modelId", model."id", 'Secondary custom Search',
      'provider_model_web_search', 'Second physical route for one exact source', false,
      '{"sentinel":"secondary-provider-route"}'::jsonb, 'provider_model_client',
      'provider_model',
      jsonb_build_object(
        'adapterKind', 'provider_model_client',
        'credentialMode', 'provider_model',
        'maxResults', 6,
        'protocol', 'openai_responses_web_search',
        'providerModelId', model."id",
        'queryMaxCharacters', 420,
        'timeoutMs', 240000
      ),
      1, 'search-contract-secondary-draft',
      '{"method":"contract","status":"available"}'::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "ProviderModel" model
    WHERE model."id" = 'search-custom-single-model-secondary';

    INSERT INTO "SearchIntegrationRevision" (
      "id", "searchStrategyId", "revisionNumber", "adapterKind",
      "credentialMode", "configuration", "providerModelId",
      "validationEvidence", "draftHash", "createdAt"
    )
    SELECT
      'search-contract-custom-secondary-revision', strategy."id", 1,
      strategy."adapterKind", strategy."credentialMode", strategy."draft",
      strategy."providerModelId", strategy."draftTestEvidence",
      strategy."testedDraftHash", CURRENT_TIMESTAMP
    FROM "SearchStrategy" strategy
    WHERE strategy."id" = 'search-contract-custom-secondary';

    UPDATE "SearchStrategy"
    SET
      "activeRevisionId" = 'search-contract-custom-secondary-revision',
      "activatedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'search-contract-custom-secondary';

    UPDATE "UserSettings"
    SET
      "defaultProviderModelId" = 'search-custom-single-model',
      "defaultSearchStrategyId" = 'openai-native-web-search',
      "defaultSearchPlan" = '{"mode":"model_choice","optionIds":["openai-native-web-search","openai-provider-web-search","perplexity-tool-search"]}'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'search-contract-settings';

    UPDATE "SearchPolicy"
    SET
      "defaultPlan" = '{"mode":"all_selected","optionIds":["perplexity-tool-search","openai-provider-web-search","openai-native-web-search"]}'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'installation';

    INSERT INTO "User" (
      "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-ambiguous-user', 'search-ambiguous@example.test',
      'Search ambiguous user', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "UserSettings" (
      "id", "userId", "defaultProviderModelId", "defaultSearchStrategyId",
      "defaultSearchPlan", "defaultControlValues", "updatedAt"
    ) VALUES (
      'search-contract-ambiguous-settings', 'search-contract-ambiguous-user', NULL,
      'openai-native-web-search',
      '{"mode":"all_selected","optionIds":["openai-native-web-search"]}'::jsonb,
      '{}'::jsonb, CURRENT_TIMESTAMP
    );

    INSERT INTO "AccessGrant" (
      "id", "userId", "searchStrategy", "enabled", "createdAt", "updatedAt"
    ) VALUES
      (
        'search-contract-provider-grant', 'search-contract-user',
        'openai-provider-web-search', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-contract-ambiguous-native-grant', 'search-contract-ambiguous-user',
        'openai-native-web-search', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'search-contract-secondary-grant', 'search-contract-user',
        'custom-secondary-web-search', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

    INSERT INTO "AccessGrant" (
      "id", "userId", "providerModelId", "enabled", "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-custom-answer-grant', 'search-contract-user',
      'search-custom-single-model', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "SearchRunBinding" (
      "id", "modelRunId", "searchStrategyId", "revisionId", "optionId",
      "ordinal", "mode", "technicalBindingKey", "createdAt"
    )
    SELECT
      'search-contract-provider-run-binding', 'search-contract-run', strategy."id",
      revision."id", 'openai-provider-web-search', 1, 'model_choice',
      'search:openai-provider-web-search', CURRENT_TIMESTAMP
    FROM "SearchStrategy" strategy
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
    WHERE strategy."strategyId" = 'openai-provider-web-search';

    INSERT INTO "SearchRunBinding" (
      "id", "modelRunId", "searchStrategyId", "revisionId", "optionId",
      "ordinal", "mode", "technicalBindingKey", "createdAt"
    )
    SELECT
      'search-contract-secondary-run-binding', 'search-contract-run', strategy."id",
      revision."id", 'custom-secondary-web-search', 2, 'model_choice', NULL,
      CURRENT_TIMESTAMP
    FROM "SearchStrategy" strategy
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
    WHERE strategy."id" = 'search-contract-custom-secondary';
  `), "insert logical Search option migration fixtures");

  const providerModelCountBeforeLogicalMigration = scalar(`
    SELECT count(*)::text FROM "ProviderModel";
  `);
  const geminiModelBeforeLogicalMigration = scalar(`
    SELECT row_to_json(model)::text
    FROM "ProviderModel" model
    WHERE model."id" = 'search-gemini-sentinel-model';
  `);
  const secondaryBindingBeforeLogicalMigration = scalar(`
    SELECT row_to_json(binding)::text
    FROM "SearchRunBinding" binding
    WHERE binding."id" = 'search-contract-secondary-run-binding';
  `);
  const logicalMigrationSql = migrationSql(LOGICAL_OPTION_MIGRATION);
  const logicalRepairMigrationSql = migrationSql(LOGICAL_OPTION_REPAIR_MIGRATION);
  assert.doesNotMatch(
    logicalMigrationSql,
    /\b(?:INSERT\s+INTO|UPDATE)\s+"ProviderModel"\b/iu,
    "logical Search migration must not backfill or mutate ProviderModel"
  );
  assert.doesNotMatch(
    logicalRepairMigrationSql,
    /\b(?:INSERT\s+INTO|UPDATE)\s+"ProviderModel"\b/iu,
    "logical Search legacy-route repair must not mutate ProviderModel"
  );

  requireSuccess(psql(`
    INSERT INTO "SearchStrategy" (
      "id", "strategyId", "provider", "modelId", "providerModelId",
      "displayName", "kind", "description", "enabled", "config",
      "adapterKind", "credentialMode", "draft", "draftVersion",
      "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-ambiguous-source', 'ambiguous-source-search', 'custom',
      NULL, NULL, 'Ambiguous source', 'openai_native_web_search',
      'Missing exact provider source', false, '{}'::jsonb,
      'answer_provider_hosted', 'answer_provider',
      '{"adapterKind":"answer_provider_hosted","credentialMode":"answer_provider","maxResults":8,"protocol":"openai_responses_web_search","providerModelId":null,"queryMaxCharacters":500,"timeoutMs":300000}'::jsonb,
      1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "insert ambiguous source preflight fixture");
  const ambiguousSource = psql(logicalMigrationSql);
  assert.notEqual(ambiguousSource.status, 0, "ambiguous source migration must fail closed");
  assert.match(
    ambiguousSource.stderr,
    /Logical Search option migration found an ambiguous legacy route source/u
  );
  assert.equal(scalar(`SELECT to_regclass('public."SearchOption"') IS NULL;`), 't');
  requireSuccess(psql(`
    DELETE FROM "SearchStrategy" WHERE "id" = 'search-contract-ambiguous-source';
  `), "remove ambiguous source preflight fixture");

  requireSuccess(psql(`
    INSERT INTO "SearchStrategy" (
      "id", "strategyId", "provider", "modelId", "providerModelId",
      "displayName", "kind", "description", "enabled", "config",
      "adapterKind", "credentialMode", "draft", "draftVersion",
      "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-ambiguous-off', 'another-off', 'none', NULL, NULL,
      'Another Off', 'none', 'Ambiguous connectionless Off', true, '{}'::jsonb,
      'answer_provider_hosted', 'answer_provider', '{} '::jsonb, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "insert ambiguous Off preflight fixture");
  const ambiguousOff = psql(logicalMigrationSql);
  assert.notEqual(ambiguousOff.status, 0, "ambiguous Off migration must fail closed");
  assert.match(
    ambiguousOff.stderr,
    /Logical Search option migration found an ambiguous connectionless Off route/u
  );
  assert.equal(scalar(`SELECT to_regclass('public."SearchOption"') IS NULL;`), 't');
  requireSuccess(psql(`
    DELETE FROM "SearchStrategy" WHERE "id" = 'search-contract-ambiguous-off';
  `), "remove ambiguous Off preflight fixture");

  const ambiguousRoutes = psql(logicalMigrationSql);
  assert.notEqual(ambiguousRoutes.status, 0, "duplicate active routes must fail closed");
  assert.match(
    ambiguousRoutes.stderr,
    /Logical Search option migration found ambiguous active physical routes/u
  );
  assert.equal(scalar(`SELECT to_regclass('public."SearchOption"') IS NULL;`), 't');

  requireSuccess(psql(`
    UPDATE "SearchStrategy"
    SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'search-contract-custom-secondary';
  `), "make both exact-source legacy routes enabled");
  const ambiguousRepair = psql(logicalRepairMigrationSql);
  assert.notEqual(ambiguousRepair.status, 0,
    "legacy-route repair must reject multiple enabled exact-source routes");
  assert.match(
    ambiguousRepair.stderr,
    /Logical Search legacy route repair found multiple or missing enabled routes for one exact source/u
  );
  assert.equal(scalar(`
    SELECT count(*)::text
    FROM "SearchStrategy"
    WHERE "id" IN (
      'system-openai-provider-web-search',
      'search-contract-custom-secondary'
    ) AND "archivedAt" IS NULL;
  `), '2');
  requireSuccess(psql(`
    UPDATE "SearchStrategy"
    SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'search-contract-custom-secondary';
  `), "restore the disabled legacy route fixture");

  const strategyCountBeforeRepair = scalar(`
    SELECT count(*)::text FROM "SearchStrategy";
  `);
  const enabledStrategyBeforeRepair = scalar(`
    SELECT row_to_json(strategy)::text
    FROM "SearchStrategy" strategy
    WHERE strategy."id" = 'system-openai-provider-web-search';
  `);
  const disabledStrategyBeforeRepair = scalar(`
    SELECT (to_jsonb(strategy) - 'archivedAt' - 'updatedAt')::text
    FROM "SearchStrategy" strategy
    WHERE strategy."id" = 'search-contract-custom-secondary';
  `);
  const revisionsBeforeRepair = scalar(`
    SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."id")::text
    FROM "SearchIntegrationRevision" revision
    WHERE revision."id" IN (
      'search-contract-openai-provider-revision',
      'search-contract-custom-secondary-revision'
    );
  `);
  const bindingsBeforeRepair = scalar(`
    SELECT jsonb_agg(to_jsonb(binding) ORDER BY binding."id")::text
    FROM "SearchRunBinding" binding
    WHERE binding."id" IN (
      'search-contract-provider-run-binding',
      'search-contract-secondary-run-binding'
    );
  `);

  requireSuccess(psql(logicalRepairMigrationSql),
    "archive only the redundant disabled legacy route");
  assert.equal(scalar(`SELECT count(*)::text FROM "SearchStrategy";`),
    strategyCountBeforeRepair,
    "legacy-route repair must preserve every physical strategy row");
  assert.equal(scalar(`
    SELECT row_to_json(strategy)::text
    FROM "SearchStrategy" strategy
    WHERE strategy."id" = 'system-openai-provider-web-search';
  `), enabledStrategyBeforeRepair,
  "legacy-route repair must leave the enabled route byte-for-field unchanged");
  assert.equal(scalar(`
    SELECT (to_jsonb(strategy) - 'archivedAt' - 'updatedAt')::text
    FROM "SearchStrategy" strategy
    WHERE strategy."id" = 'search-contract-custom-secondary';
  `), disabledStrategyBeforeRepair,
  "legacy-route repair may change only archivedAt and updatedAt on the disabled route");
  assert.equal(scalar(`
    SELECT concat_ws('|', "enabled", "archivedAt" IS NULL, "activeRevisionId")
    FROM "SearchStrategy"
    WHERE "id" = 'system-openai-provider-web-search';
  `), 't|t|search-contract-openai-provider-revision');
  assert.equal(scalar(`
    SELECT concat_ws('|', "enabled", "archivedAt" IS NOT NULL, "activeRevisionId")
    FROM "SearchStrategy"
    WHERE "id" = 'search-contract-custom-secondary';
  `), 'f|t|search-contract-custom-secondary-revision');
  assert.equal(scalar(`
    SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."id")::text
    FROM "SearchIntegrationRevision" revision
    WHERE revision."id" IN (
      'search-contract-openai-provider-revision',
      'search-contract-custom-secondary-revision'
    );
  `), revisionsBeforeRepair,
  "legacy-route repair must preserve immutable revisions byte-for-field");
  assert.equal(scalar(`
    SELECT jsonb_agg(to_jsonb(binding) ORDER BY binding."id")::text
    FROM "SearchRunBinding" binding
    WHERE binding."id" IN (
      'search-contract-provider-run-binding',
      'search-contract-secondary-run-binding'
    );
  `), bindingsBeforeRepair,
  "legacy-route repair must preserve historical physical bindings byte-for-field");

  applyLogicalOptionMigration();

  assert.equal(
    scalar(`SELECT count(*)::text FROM "ProviderModel";`),
    providerModelCountBeforeLogicalMigration,
    "logical Search migration must preserve ProviderModel row count"
  );
  assert.equal(
    scalar(`
      SELECT row_to_json(model)::text
      FROM "ProviderModel" model
      WHERE model."id" = 'search-gemini-sentinel-model';
    `),
    geminiModelBeforeLogicalMigration,
    "logical Search migration must leave the Gemini ProviderModel byte-for-field unchanged"
  );

  assert.equal(scalar(`
    SELECT concat_ws('|', "defaultSearchStrategyId", "defaultSearchPlan"::text)
    FROM "UserSettings" WHERE "id" = 'search-contract-settings';
  `), 'custom-web-search:search-custom-single|{"mode": "model_choice", "optionIds": ["custom-web-search:search-custom-single", "perplexity-tool-search"]}');
  assert.equal(scalar(`
    SELECT "defaultPlan"::text FROM "SearchPolicy" WHERE "id" = 'installation';
  `), '{"mode": "all_selected", "optionIds": ["perplexity-tool-search", "custom-web-search:search-custom-single"]}');
  assert.equal(scalar(`
    SELECT concat_ws('|', count(*), bool_or("enabled"), min("searchStrategy"))
    FROM "AccessGrant"
    WHERE "userId" = 'search-contract-user'
      AND "searchStrategy" = 'custom-web-search:search-custom-single';
  `), '1|t|custom-web-search:search-custom-single');
  assert.equal(scalar(`
    SELECT concat_ws('|', "defaultSearchStrategyId", "defaultSearchPlan"::text)
    FROM "UserSettings" WHERE "id" = 'search-contract-ambiguous-settings';
  `), 'search-disabled|{"mode": "all_selected", "optionIds": []}');
  assert.equal(scalar(`
    SELECT concat_ws('|', "searchStrategy", "enabled")
    FROM "AccessGrant" WHERE "id" = 'search-contract-ambiguous-native-grant';
  `), 'openai-native-web-search|f');
  assert.equal(scalar(`
    SELECT concat_ws('|', "providerModelId", "enabled")
    FROM "AccessGrant" WHERE "id" = 'search-contract-custom-answer-grant';
  `), 'search-custom-single-model|t');
  assert.equal(scalar(`
    SELECT concat_ws('|', option_row."optionId", option_row."displayName",
      option_row."kind", connection."templateKey", count(strategy."id"))
    FROM "SearchOption" option_row
    LEFT JOIN "ProviderConnection" connection
      ON connection."id" = option_row."sourceConnectionId"
    LEFT JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = option_row."id"
    WHERE option_row."templateKey" = 'search:openai'
    GROUP BY option_row."optionId", option_row."displayName", option_row."kind",
      connection."templateKey";
  `), 'openai-native-web-search|OpenAI Search|web_search|openai|1');
  assert.equal(scalar(`
    SELECT concat_ws('|', option_row."optionId", option_row."enabled",
      option_row."sourceConnectionId", hosted."enabled",
      hosted."activeRevisionId" IS NOT NULL, client."enabled",
      client."activeRevisionId" IS NULL, client."providerModelId")
    FROM "SearchOption" option_row
    JOIN "SearchStrategy" hosted
      ON hosted."searchOptionId" = option_row."id"
     AND hosted."strategyId" = 'custom-web-search-hosted:search-custom-single'
    JOIN "SearchStrategy" client
      ON client."searchOptionId" = option_row."id"
     AND client."strategyId" = 'openai-provider-web-search'
    WHERE option_row."optionId" = 'custom-web-search:search-custom-single';
  `), 'custom-web-search:search-custom-single|t|search-custom-single|t|t|t|f|search-custom-single-model');
  assert.equal(scalar(`
    SELECT concat_ws('|', count(*),
      bool_and(strategy."searchOptionId" = 'custom-web-search-option:search-custom-single'),
      string_agg(strategy."strategyId", ',' ORDER BY strategy."strategyId"))
    FROM "SearchStrategy" strategy
    WHERE strategy."id" IN (
      'system-openai-provider-web-search',
      'search-contract-custom-secondary',
      'custom-web-search-hosted:search-custom-single'
    );
  `), '3|t|custom-secondary-web-search,custom-web-search-hosted:search-custom-single,openai-provider-web-search');
  assert.equal(scalar(`
    SELECT concat_ws('|',
      count(*) FILTER (WHERE strategy."strategyId" LIKE 'custom-web-search-hosted:%'),
      count(*) FILTER (WHERE strategy."strategyId" LIKE 'custom-web-search-client:%'))
    FROM "SearchOption" option_row
    LEFT JOIN "SearchStrategy" strategy ON strategy."searchOptionId" = option_row."id"
    WHERE option_row."optionId" = 'custom-web-search:search-custom-multiple';
  `), '1|0');
  assert.equal(scalar(`
    SELECT concat_ws('|', "searchStrategy", "enabled")
    FROM "AccessGrant"
    WHERE "searchStrategy" LIKE 'custom-web-search:%';
  `), 'custom-web-search:search-custom-single|t');
  assert.equal(scalar(`
    SELECT count(*)::text
    FROM "SearchStrategy" strategy
    LEFT JOIN "SearchOption" option_row ON option_row."id" = strategy."searchOptionId"
    WHERE option_row."id" IS NULL;
  `), '0');
  assert.equal(scalar(`
    SELECT string_agg("optionId", ',' ORDER BY "ordinal")
    FROM "SearchRunBinding" WHERE "modelRunId" = 'search-contract-run';
  `), 'openai-native-web-search,openai-provider-web-search,custom-secondary-web-search');
  assert.equal(scalar(`
    SELECT row_to_json(binding)::text
    FROM "SearchRunBinding" binding
    WHERE binding."id" = 'search-contract-secondary-run-binding';
  `), secondaryBindingBeforeLogicalMigration,
  "logical parent collapse must leave historical physical bindings byte-for-field unchanged");
  assert.equal(scalar(`
    SELECT jsonb_agg(to_jsonb(binding) ORDER BY binding."id")::text
    FROM "SearchRunBinding" binding
    WHERE binding."id" IN (
      'search-contract-provider-run-binding',
      'search-contract-secondary-run-binding'
    );
  `), bindingsBeforeRepair,
  "logical parent collapse must preserve both production-shaped historical bindings");
  assert.equal(scalar(`
    SELECT string_agg(concat_ws('|', revision."id", revision."searchStrategyId",
      revision."providerModelId"), ',' ORDER BY revision."id")
    FROM "SearchIntegrationRevision" revision
    WHERE revision."id" IN (
      'search-contract-openai-provider-revision',
      'search-contract-custom-secondary-revision'
    );
  `), 'search-contract-custom-secondary-revision|search-contract-custom-secondary|search-custom-single-model-secondary,search-contract-openai-provider-revision|system-openai-provider-web-search|search-custom-single-model');
  assert.match(scalar(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'SearchOption_sourceConnectionId_kind_key';
  `), /UNIQUE INDEX.*sourceConnectionId.*kind/);
  assert.match(scalar(`
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'SearchOption_source_check';
  `), /kind.*none.*optionId.*search-disabled.*sourceConnectionId.*IS NULL.*kind.*<>.*none.*sourceConnectionId.*IS NOT NULL/);
  assert.match(scalar(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'SearchStrategy_searchOptionId_adapterKind_active_key';
  `), /UNIQUE INDEX.*searchOptionId.*adapterKind.*WHERE.*archivedAt.*IS NULL/);
  assert.equal(scalar(`
    SELECT count(*)::text FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'SearchIntegrationRevision_strategy_draftHash_key';
  `), '0');
  assert.match(scalar(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'SearchIntegrationRevision_strategy_draft_validation_key';
  `), /UNIQUE INDEX.*searchStrategyId.*draftHash.*validationFingerprint/);
  assert.equal(scalar(`
    SELECT concat_ws('|', count(*) > 0, bool_and("validationFingerprint" = 'legacy'))
    FROM "SearchIntegrationRevision";
  `), 't|t');
  assert.match(scalar(`
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'SearchStrategy_searchOptionId_fkey';
  `), /FOREIGN KEY.*searchOptionId.*SearchOption/);

  requireSuccess(psql(`
    INSERT INTO "SearchStrategy" (
      "id", "searchOptionId", "strategyId", "provider", "modelId",
      "providerModelId", "displayName", "kind", "description", "enabled",
      "config", "adapterKind", "credentialMode", "draft", "draftVersion",
      "createdAt", "updatedAt"
    )
    SELECT
      'openai-search-client:' || connection."id",
      '00000000-0000-4000-8000-000000001402',
      'openai-search-client:' || connection."id",
      'openai', model."modelId", model."id", 'OpenAI Search',
      'provider_model_web_search', 'Official collision-free client route', false,
      '{}'::jsonb, 'provider_model_client', 'provider_model',
      jsonb_build_object(
        'adapterKind', 'provider_model_client',
        'credentialMode', 'provider_model',
        'maxResults', 8,
        'protocol', 'openai_responses_web_search',
        'providerModelId', model."id",
        'queryMaxCharacters', 500,
        'timeoutMs', 300000
      ),
      1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "ProviderConnection" connection
    INNER JOIN LATERAL (
      SELECT candidate."id", candidate."modelId"
      FROM "ProviderModel" candidate
      WHERE candidate."connectionId" = connection."id"
      ORDER BY candidate."id"
      LIMIT 1
    ) model ON true
    WHERE connection."templateKey" = 'openai';
  `), "create official collision-free Search route beside retained custom alias");
  assert.equal(scalar(`
    SELECT concat_ws('|',
      custom_route."strategyId", custom_option."optionId",
      official_route."strategyId", official_option."optionId")
    FROM "SearchStrategy" custom_route
    INNER JOIN "SearchOption" custom_option
      ON custom_option."id" = custom_route."searchOptionId"
    INNER JOIN "ProviderConnection" official_connection
      ON official_connection."templateKey" = 'openai'
    INNER JOIN "SearchStrategy" official_route
      ON official_route."strategyId" = 'openai-search-client:' || official_connection."id"
    INNER JOIN "SearchOption" official_option
      ON official_option."id" = official_route."searchOptionId"
    WHERE custom_route."id" = 'system-openai-provider-web-search';
  `), 'openai-provider-web-search|custom-web-search:search-custom-single|openai-search-client:00000000-0000-4000-8000-000000001102|openai-native-web-search');

  const postLogicalRouteHash = scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy;
  `);
  requireSuccess(psql(logicalRepairMigrationSql),
    "repeat legacy-route repair after logical Search migration");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy;
  `), postLogicalRouteHash,
  "legacy-route repair must no-op when logical Search options already exist");

  const providerNeutralBackfillSql = migrationSql(PROVIDER_NEUTRAL_BACKFILL_MIGRATION);
  assert.doesNotMatch(
    providerNeutralBackfillSql,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+"ProviderModel"\b/iu,
    "provider-neutral Search backfill must not mutate ProviderModel"
  );
  assert.doesNotMatch(
    providerNeutralBackfillSql,
    /"(?:ProviderCredential|ProviderCredentialVersion|ProviderDraftCheck|ProviderModelCredentialCheck)"/u,
    "provider-neutral Search backfill must not read credential or provider-check state"
  );
  assert.doesNotMatch(
    providerNeutralBackfillSql,
    /"supportsNativeSearch"/u,
    "active normalized capability must not be double-gated by the legacy Search flag"
  );
  const validationFingerprint = createHash("sha256")
    .update(JSON.stringify(["configuration"]), "utf8")
    .digest("hex");

  // Shape representative v0.1.16 states after the logical-parent migration:
  // an inactive official fallback, an existing custom client whose provider
  // proof failed after a model change, and an intentionally disabled,
  // unarchived multi-model custom source with no client route at all.
  requireSuccess(psql(`
    UPDATE "SearchStrategy" strategy
    SET
      "provider" = model."provider",
      "modelId" = model."modelId",
      "providerModelId" = model."id",
      "enabled" = false,
      "config" = '{"sentinel":"old-active-config"}'::jsonb,
      "draft" = jsonb_build_object(
        'adapterKind', 'provider_model_client',
        'credentialMode', 'provider_model',
        'maxResults', 11,
        'protocol', 'openai_responses_web_search',
        'providerModelId', model."id",
        'queryMaxCharacters', 321,
        'timeoutMs', 123000
      ),
      "draftVersion" = 4,
      "testedDraftHash" = NULL,
      "draftTestEvidence" = '{
        "checkedAt":"2026-08-02T12:00:00.000Z",
        "method":"provider_search",
        "normalizedSourceCount":0,
        "protocol":"openai_responses_web_search",
        "status":"unavailable"
      }'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM "ProviderModel" model
    WHERE strategy."id" = 'system-openai-provider-web-search'
      AND model."id" = 'search-custom-single-model-secondary';

    UPDATE "SearchIntegrationRevision"
    SET
      "validationEvidence" = '{
        "checkedAt":"2026-08-02T11:59:00.000Z",
        "method":"provider_search",
        "normalizedSourceCount":1,
        "probeBinding":{
          "connectionId":"search-custom-single",
          "connectionVersion":1,
          "credentialId":"search-contract-old-credential",
          "credentialVersionId":"search-contract-old-credential-version",
          "modelVersion":1,
          "providerModelId":"search-custom-single-model"
        },
        "protocol":"openai_responses_web_search",
        "status":"available"
      }'::jsonb,
      "validationFingerprint" = 'search-contract-obsolete-probe-fingerprint'
    WHERE "id" = 'search-contract-openai-provider-revision';

    -- Legacy denormalized capability flags can drift. The active normalized
    -- model declaration remains the migration authority.
    UPDATE "ProviderModel"
    SET "supportsNativeSearch" = false, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'search-custom-multiple-model-a';

    UPDATE "SearchOption"
    SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "optionId" = 'custom-web-search:search-custom-multiple';

    UPDATE "SearchStrategy" strategy
    SET
      "enabled" = false,
      "config" = '{}'::jsonb,
      "draft" = jsonb_build_object(
        'adapterKind', 'answer_provider_hosted',
        'credentialMode', 'answer_provider',
        'maxResults', 99,
        'protocol', 'openai_responses_web_search',
        'providerModelId', NULL,
        'queryMaxCharacters', 1,
        'timeoutMs', 1
      ),
      "draftVersion" = 3,
      "testedDraftHash" = NULL,
      "draftTestEvidence" = '{
        "checkedAt":"2026-08-02T12:01:00.000Z",
        "method":"provider_search",
        "normalizedSourceCount":0,
        "protocol":"openai_responses_web_search",
        "status":"unavailable"
      }'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM "ProviderConnection" connection
    WHERE strategy."strategyId" = 'openai-search-client:' || connection."id"
      AND connection."templateKey" = 'openai';
  `), "shape v0.1.16 provider-neutral Search repair fixtures");

  // The current physical client must belong to the logical source's exact
  // connection. A cross-owned row is corruption and the transaction must make
  // no partial repair before failing.
  requireSuccess(psql(`
    UPDATE "SearchStrategy" strategy
    SET "providerModelId" = 'search-custom-multiple-model-a'
    FROM "ProviderConnection" connection
    WHERE strategy."strategyId" = 'openai-search-client:' || connection."id"
      AND connection."templateKey" = 'openai';
  `), "insert cross-owned current client fixture");
  const corruptOwnership = psql(providerNeutralBackfillSql);
  assert.notEqual(corruptOwnership.status, 0,
    "cross-owned current client route must fail closed");
  assert.match(
    corruptOwnership.stderr,
    /Provider-neutral Search backfill found a client route owned by another source/u
  );
  assert.equal(scalar(`
    SELECT count(*)::text
    FROM "SearchIntegrationRevision"
    WHERE "validationFingerprint" = '${validationFingerprint}';
  `), '0', "failed ownership preflight must not publish a revision");
  requireSuccess(psql(`
    UPDATE "SearchStrategy" strategy
    SET "providerModelId" = 'search-official-openai-model'
    FROM "ProviderConnection" connection
    WHERE strategy."strategyId" = 'openai-search-client:' || connection."id"
      AND connection."templateKey" = 'openai';
  `), "restore exact official Search ownership");

  // Exercise the migration's duplicate guard independently of the steady-state
  // partial unique index, then restore that schema invariant before success.
  requireSuccess(psql(`
    DROP INDEX "SearchStrategy_searchOptionId_adapterKind_active_key";
    INSERT INTO "SearchStrategy" (
      "id", "searchOptionId", "strategyId", "provider", "modelId",
      "providerModelId", "displayName", "kind", "description", "enabled",
      "config", "adapterKind", "credentialMode", "draft", "draftVersion",
      "createdAt", "updatedAt"
    ) VALUES (
      'search-contract-duplicate-current-client',
      '00000000-0000-4000-8000-000000001402',
      'search-contract-duplicate-current-client',
      'openai', 'official-search-model', 'search-official-openai-model',
      'Duplicate OpenAI Search', 'provider_model_web_search',
      'Corrupt duplicate current route', false, '{}'::jsonb,
      'provider_model_client', 'provider_model',
      '{
        "adapterKind":"provider_model_client",
        "credentialMode":"provider_model",
        "maxResults":8,
        "protocol":"openai_responses_web_search",
        "providerModelId":"search-official-openai-model",
        "queryMaxCharacters":500,
        "timeoutMs":300000
      }'::jsonb,
      1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `), "insert duplicate current client fixture");
  const duplicateCurrentRoute = psql(providerNeutralBackfillSql);
  assert.notEqual(duplicateCurrentRoute.status, 0,
    "duplicate current client routes must fail closed");
  assert.match(
    duplicateCurrentRoute.stderr,
    /Provider-neutral Search backfill found duplicate current client routes/u
  );
  requireSuccess(psql(`
    DELETE FROM "SearchStrategy"
    WHERE "id" = 'search-contract-duplicate-current-client';
    CREATE UNIQUE INDEX "SearchStrategy_searchOptionId_adapterKind_active_key"
    ON "SearchStrategy"("searchOptionId", "adapterKind")
    WHERE "archivedAt" IS NULL;
  `), "remove duplicate client fixture and restore route uniqueness");

  const strategyCountBeforeProviderNeutralBackfill = scalar(`
    SELECT count(*)::text FROM "SearchStrategy";
  `);
  const revisionCountBeforeProviderNeutralBackfill = scalar(`
    SELECT count(*)::text FROM "SearchIntegrationRevision";
  `);
  const providerModelsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(model.*)::text, E'\\n' ORDER BY model."id"))
    FROM "ProviderModel" model;
  `);
  const searchOptionsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(option_row.*)::text, E'\\n' ORDER BY option_row."id"))
    FROM "SearchOption" option_row;
  `);
  const hostedRoutesBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy
    WHERE strategy."adapterKind" <> 'provider_model_client';
  `);
  const grantsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(grant_row.*)::text, E'\\n' ORDER BY grant_row."id"))
    FROM "AccessGrant" grant_row;
  `);
  const settingsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(settings.*)::text, E'\\n' ORDER BY settings."id"))
    FROM "UserSettings" settings;
  `);
  const policyBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(policy.*)::text, E'\\n' ORDER BY policy."id"))
    FROM "SearchPolicy" policy;
  `);
  const historicalRevisionsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(revision.*)::text, E'\\n' ORDER BY revision."id"))
    FROM "SearchIntegrationRevision" revision
    WHERE revision."validationFingerprint" <> '${validationFingerprint}';
  `);
  const historicalBindingsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(binding.*)::text, E'\\n' ORDER BY binding."id"))
    FROM "SearchRunBinding" binding;
  `);
  const providerBindingsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(binding.*)::text, E'\\n' ORDER BY binding."id"))
    FROM "ProviderRunBinding" binding;
  `);
  const acceptedRunsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(run.*)::text, E'\\n' ORDER BY run."id"))
    FROM "ModelRun" run;
  `);
  const searchRunsBeforeProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(run.*)::text, E'\\n' ORDER BY run."id"))
    FROM "SearchRun" run;
  `);

  requireSuccess(psql(providerNeutralBackfillSql),
    "activate provider-neutral Search routes without a provider probe");

  assert.equal(scalar(`
    SELECT concat_ws('|', "enabled", "archivedAt" IS NULL)
    FROM "SearchOption"
    WHERE "optionId" = 'custom-web-search:search-custom-multiple';
  `), 'f|t',
  "backfill must prepare a disabled source without changing its parent lifecycle");

  assert.equal(
    scalar(`SELECT count(*)::text FROM "SearchStrategy";`),
    String(Number(strategyCountBeforeProviderNeutralBackfill) + 1),
    "only the missing multi-model custom client route should be created"
  );
  assert.equal(
    scalar(`SELECT count(*)::text FROM "SearchIntegrationRevision";`),
    String(Number(revisionCountBeforeProviderNeutralBackfill) + 3),
    "each repaired/created client route should receive one configuration revision"
  );

  assert.equal(scalar(`
    SELECT string_agg(concat_ws('|',
      option_row."optionId",
      strategy."id",
      strategy."strategyId",
      strategy."providerModelId",
      strategy."enabled",
      strategy."activeRevisionId" IS NOT NULL,
      strategy."draftVersion",
      strategy."draft" ->> 'maxResults',
      strategy."draft" ->> 'queryMaxCharacters',
      strategy."draft" ->> 'timeoutMs',
      strategy."draftTestEvidence" ->> 'method',
      strategy."draftTestEvidence" ->> 'status',
      revision."revisionNumber",
      revision."validationFingerprint",
      strategy."config" = strategy."draft",
      revision."configuration" = strategy."draft",
      NOT (revision."validationEvidence" ? 'probeBinding')
    ), E'\\n' ORDER BY option_row."optionId")
    FROM "SearchOption" option_row
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = option_row."id"
     AND strategy."adapterKind" = 'provider_model_client'
     AND strategy."archivedAt" IS NULL
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
     AND revision."searchStrategyId" = strategy."id"
    WHERE option_row."optionId" IN (
      'openai-native-web-search',
      'custom-web-search:search-custom-single',
      'custom-web-search:search-custom-multiple'
    );
  `), [
    `custom-web-search:search-custom-multiple|custom-web-search-client:search-custom-multiple|custom-web-search-client:search-custom-multiple|search-custom-multiple-model-a|t|t|1|8|500|300000|configuration|available|1|${validationFingerprint}|t|t|t`,
    `custom-web-search:search-custom-single|system-openai-provider-web-search|openai-provider-web-search|search-custom-single-model-secondary|t|t|4|11|321|123000|configuration|available|2|${validationFingerprint}|t|t|t`,
    `openai-native-web-search|openai-search-client:00000000-0000-4000-8000-000000001102|openai-search-client:00000000-0000-4000-8000-000000001102|search-official-openai-model|t|t|4|8|500|300000|configuration|available|1|${validationFingerprint}|t|t|t`
  ].join("\n"));

  assert.equal(scalar(`
    SELECT "testedDraftHash"
    FROM "SearchStrategy"
    WHERE "strategyId" = 'openai-search-client:00000000-0000-4000-8000-000000001102';
  `), providerNeutralDraftHash({
    maxResults: 8,
    providerModelId: "search-official-openai-model",
    queryMaxCharacters: 500,
    timeoutMs: 300_000
  }), "migration draft digest must match the application canonical SHA-256");
  assert.equal(scalar(`
    SELECT "testedDraftHash"
    FROM "SearchStrategy"
    WHERE "id" = 'system-openai-provider-web-search';
  `), providerNeutralDraftHash({
    maxResults: 11,
    providerModelId: "search-custom-single-model-secondary",
    queryMaxCharacters: 321,
    timeoutMs: 123_000
  }), "valid current client bounds and model selection should be preserved");

  assert.equal(scalar(`
    SELECT md5(string_agg(row(model.*)::text, E'\\n' ORDER BY model."id"))
    FROM "ProviderModel" model;
  `), providerModelsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must not mutate ProviderModel rows");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(option_row.*)::text, E'\\n' ORDER BY option_row."id"))
    FROM "SearchOption" option_row;
  `), searchOptionsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve logical source rows");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy
    WHERE strategy."adapterKind" <> 'provider_model_client';
  `), hostedRoutesBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve hosted routes byte-for-field");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(grant_row.*)::text, E'\\n' ORDER BY grant_row."id"))
    FROM "AccessGrant" grant_row;
  `), grantsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve grants");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(settings.*)::text, E'\\n' ORDER BY settings."id"))
    FROM "UserSettings" settings;
  `), settingsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve user preferences");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(policy.*)::text, E'\\n' ORDER BY policy."id"))
    FROM "SearchPolicy" policy;
  `), policyBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve installation policy");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(revision.*)::text, E'\\n' ORDER BY revision."id"))
    FROM "SearchIntegrationRevision" revision
    WHERE revision."validationFingerprint" <> '${validationFingerprint}';
  `), historicalRevisionsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve immutable historical revisions");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(binding.*)::text, E'\\n' ORDER BY binding."id"))
    FROM "SearchRunBinding" binding;
  `), historicalBindingsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve historical Search bindings");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(binding.*)::text, E'\\n' ORDER BY binding."id"))
    FROM "ProviderRunBinding" binding;
  `), providerBindingsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve historical provider bindings");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(run.*)::text, E'\\n' ORDER BY run."id"))
    FROM "ModelRun" run;
  `), acceptedRunsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve accepted runs");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(run.*)::text, E'\\n' ORDER BY run."id"))
    FROM "SearchRun" run;
  `), searchRunsBeforeProviderNeutralBackfill,
  "provider-neutral Search backfill must preserve historical Search executions");

  const routesAfterProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy;
  `);
  const revisionsAfterProviderNeutralBackfill = scalar(`
    SELECT md5(string_agg(row(revision.*)::text, E'\\n' ORDER BY revision."id"))
    FROM "SearchIntegrationRevision" revision;
  `);
  requireSuccess(psql(providerNeutralBackfillSql),
    "repeat provider-neutral Search backfill");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(strategy.*)::text, E'\\n' ORDER BY strategy."id"))
    FROM "SearchStrategy" strategy;
  `), routesAfterProviderNeutralBackfill,
  "repeat provider-neutral Search backfill must preserve every route byte-for-field");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(revision.*)::text, E'\\n' ORDER BY revision."id"))
    FROM "SearchIntegrationRevision" revision;
  `), revisionsAfterProviderNeutralBackfill,
  "repeat provider-neutral Search backfill must preserve revisions byte-for-field");
  assert.equal(scalar(`
    SELECT md5(string_agg(row(option_row.*)::text, E'\\n' ORDER BY option_row."id"))
    FROM "SearchOption" option_row;
  `), searchOptionsBeforeProviderNeutralBackfill,
  "repeat backfill must preserve the disabled logical source byte-for-field");

  process.stdout.write("Search control-plane migration contract: OK\n");
} finally {
  compose([
    "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
    "--username", POSTGRES_USER, database
  ]);
}
