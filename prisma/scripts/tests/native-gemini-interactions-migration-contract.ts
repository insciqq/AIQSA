import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260726160000_native_gemini_interactions";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;
const templateDatabase = `aiqsa_gemini_native_template_${runId}`;
const disposableDatabases = new Set<string>();

type CommandResult = Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}>;

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
    "read native Gemini migration contract state"
  );
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
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

function applyPreTargetMigrations(database: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  assert(migrations.length > 0, "expected migrations before native Gemini cutover");
  for (const migration of migrations) {
    requireSuccess(psql(database, migrationSql(migration)), `apply pre-target migration ${migration}`);
  }
}

const knownInstallationFixture = `
INSERT INTO "User" (
  "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
) VALUES (
  'gemini-contract-user', 'gemini-contract@example.test', 'Gemini contract user',
  'admin', 'active', '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "ProviderConnection" (
  "id", "displayName", "family", "enabled", "unassignedPolicy",
  "draftConfig", "draftVersion", "activeConfig", "activeVersion", "activatedAt",
  "updatedAt"
) VALUES (
  'gemini-contract-connection', 'Gemini contract', 'gemini', true, 'use_default',
  '{"apiRoot":"https://generativelanguage.googleapis.com/v1beta/openai","allowPrivateNetwork":false}'::jsonb,
  7,
  '{"apiRoot":"https://generativelanguage.googleapis.com/v1beta/openai","allowPrivateNetwork":false}'::jsonb,
  6, '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "ProviderModel" (
  "id", "connectionId", "provider", "modelId", "displayName", "contextWindow",
  "supportsVision", "supportsPdf", "supportsReasoning", "supportsNativeSearch",
  "draftConfig", "draftVersion", "activeConfig", "activeVersion", "activatedAt",
  "capabilities", "defaultParams", "updatedAt"
) VALUES (
  'gemini-contract-model', 'gemini-contract-connection', 'gemini',
  'gemini-contract-model-id', 'Gemini contract model', 1048576,
  true, true, true, false,
  '{"adapterKind":"openai_chat_completions_compatible","capabilities":{"streaming":true,"nativeSearch":false},"sentinel":"draft-preserved"}'::jsonb,
  9,
  '{"adapterKind":"openai_chat_completions_compatible","capabilities":{"streaming":true,"nativeSearch":false},"sentinel":"active-preserved"}'::jsonb,
  8, '2026-07-01T00:00:00.000Z'::timestamptz,
  '{"streaming":true,"nativeSearch":false,"sentinel":"column-preserved"}'::jsonb,
  '{"temperature":0.4,"sentinel":"params-preserved"}'::jsonb,
  CURRENT_TIMESTAMP
);

INSERT INTO "ProviderCredential" (
  "id", "connectionId", "label", "enabled", "draftSecretEnvelope", "draftVersion",
  "testedAt", "activatedAt", "updatedAt"
) VALUES (
  'gemini-contract-credential', 'gemini-contract-connection', 'Gemini key', true,
  'sealed-draft-envelope', 4, '2026-07-01T00:00:00.000Z'::timestamptz,
  '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "ProviderCredentialVersion" (
  "id", "credentialId", "version", "secretEnvelope", "testEvidence", "testedAt",
  "activatedAt", "createdAt"
) VALUES (
  'gemini-contract-version', 'gemini-contract-credential', 3, 'sealed-active-envelope',
  '{"catalogVisible":true,"sentinel":"evidence-preserved"}'::jsonb,
  '2026-07-01T00:00:00.000Z'::timestamptz,
  '2026-07-01T00:00:00.000Z'::timestamptz,
  '2026-07-01T00:00:00.000Z'::timestamptz
);

UPDATE "ProviderCredential"
SET "activeVersionId" = 'gemini-contract-version'
WHERE "id" = 'gemini-contract-credential';

UPDATE "ProviderConnection"
SET "defaultCredentialId" = 'gemini-contract-credential'
WHERE "id" = 'gemini-contract-connection';

INSERT INTO "ProviderUserCredentialAssignment" (
  "connectionId", "userId", "credentialId", "createdAt", "updatedAt"
) VALUES (
  'gemini-contract-connection', 'gemini-contract-user', 'gemini-contract-credential',
  '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "ProviderModelCredentialCheck" (
  "id", "connectionId", "providerModelId", "credentialId", "credentialVersionId",
  "connectionVersion", "modelVersion", "status", "evidence", "checkedAt",
  "createdAt", "updatedAt"
) VALUES (
  'gemini-contract-check', 'gemini-contract-connection', 'gemini-contract-model',
  'gemini-contract-credential', 'gemini-contract-version', 6, 8, 'available',
  '{"sentinel":"check-preserved"}'::jsonb,
  '2026-07-01T00:00:00.000Z'::timestamptz,
  '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "AccessGrant" (
  "id", "userId", "providerModelId", "enabled", "createdAt", "updatedAt"
) VALUES (
  'gemini-contract-grant', 'gemini-contract-user', 'gemini-contract-model', true,
  '2026-07-01T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
);

INSERT INTO "UserSettings" (
  "id", "userId", "defaultProviderModelId", "defaultControlValues", "updatedAt"
) VALUES (
  'gemini-contract-settings', 'gemini-contract-user', 'gemini-contract-model',
  '{"gemini-contract-model":{"temperature":0.4}}'::jsonb, CURRENT_TIMESTAMP
);

INSERT INTO "Chat" ("id", "userId", "title", "updatedAt") VALUES
  ('gemini-compatible-active-chat', 'gemini-contract-user', 'Compatible active', CURRENT_TIMESTAMP),
  ('gemini-native-active-chat', 'gemini-contract-user', 'Native active', CURRENT_TIMESTAMP),
  ('gemini-compatible-terminal-chat', 'gemini-contract-user', 'Compatible terminal', CURRENT_TIMESTAMP);

INSERT INTO "Message" (
  "id", "chatId", "role", "content", "status", "updatedAt"
) VALUES
  ('gemini-compatible-active-user', 'gemini-compatible-active-chat', 'user', '{"blocks":[{"type":"text","text":"active"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP),
  ('gemini-compatible-active-assistant', 'gemini-compatible-active-chat', 'assistant', '{"blocks":[]}'::jsonb, 'streaming', CURRENT_TIMESTAMP),
  ('gemini-native-active-user', 'gemini-native-active-chat', 'user', '{"blocks":[{"type":"text","text":"native"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP),
  ('gemini-native-active-assistant', 'gemini-native-active-chat', 'assistant', '{"blocks":[]}'::jsonb, 'streaming', CURRENT_TIMESTAMP),
  ('gemini-compatible-terminal-user', 'gemini-compatible-terminal-chat', 'user', '{"blocks":[{"type":"text","text":"terminal"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP),
  ('gemini-compatible-terminal-assistant', 'gemini-compatible-terminal-chat', 'assistant', '{"blocks":[{"type":"text","text":"done"}]}'::jsonb, 'complete', CURRENT_TIMESTAMP);

INSERT INTO "ModelRun" (
  "id", "chatId", "userId", "userMessageId", "assistantMessageId", "provider",
  "modelId", "status", "normalizedRequest", "providerRequestPreview",
  "providerResponseId", "finalProviderResponsePreview", "toolLoopState", "updatedAt"
) VALUES
  (
    'gemini-compatible-active-run', 'gemini-compatible-active-chat', 'gemini-contract-user',
    'gemini-compatible-active-user', 'gemini-compatible-active-assistant', 'gemini',
    'gemini-contract-model-id', 'in_progress', '{"sentinel":"request-active"}'::jsonb,
    '{"sentinel":"request-preview-active"}'::jsonb, 'compatible-active-response', NULL,
    '{"roundIndex":2,"sentinel":"old-loop-cleared"}'::jsonb, CURRENT_TIMESTAMP
  ),
  (
    'gemini-native-active-run', 'gemini-native-active-chat', 'gemini-contract-user',
    'gemini-native-active-user', 'gemini-native-active-assistant', 'gemini',
    'gemini-contract-model-id', 'in_progress', '{"sentinel":"request-native"}'::jsonb,
    '{"sentinel":"request-preview-native"}'::jsonb, 'native-active-response', NULL,
    '{"roundIndex":3,"thoughtSignature":"exact-private-signature"}'::jsonb, CURRENT_TIMESTAMP
  ),
  (
    'gemini-compatible-terminal-run', 'gemini-compatible-terminal-chat', 'gemini-contract-user',
    'gemini-compatible-terminal-user', 'gemini-compatible-terminal-assistant', 'gemini',
    'gemini-contract-model-id', 'complete', '{"sentinel":"request-terminal"}'::jsonb,
    '{"sentinel":"request-preview-terminal"}'::jsonb, 'compatible-terminal-response',
    '{"sentinel":"response-preview-terminal"}'::jsonb, NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "ProviderRunBinding" (
  "id", "modelRunId", "role", "credentialSource", "executionSnapshot", "recoverableUntil"
) VALUES
  (
    'gemini-compatible-active-binding', 'gemini-compatible-active-run', 'answer', 'default',
    '{"providerFamily":"gemini","model":{"adapterKind":"openai_chat_completions_compatible"},"sentinel":{"snapshot":"active-compatible"}}'::jsonb,
    '2026-08-01T00:00:00.000Z'::timestamptz
  ),
  (
    'gemini-native-active-binding', 'gemini-native-active-run', 'answer', 'default',
    '{"providerFamily":"gemini","model":{"adapterKind":"gemini_interactions_native"},"sentinel":{"snapshot":"active-native"}}'::jsonb,
    '2026-08-01T00:00:00.000Z'::timestamptz
  ),
  (
    'gemini-compatible-terminal-binding', 'gemini-compatible-terminal-run', 'answer', 'default',
    '{"providerFamily":"gemini","model":{"adapterKind":"openai_chat_completions_compatible"},"sentinel":{"snapshot":"terminal-compatible"}}'::jsonb,
    NULL
  );

INSERT INTO "ModelRunToolCall" (
  "id", "modelRunId", "roundIndex", "ordinal", "providerCallId", "toolName",
  "arguments", "state", "startedAt", "updatedAt"
) VALUES
  (
    'gemini-compatible-active-call', 'gemini-compatible-active-run', 1, 0,
    'compatible-active-call', 'fixture_tool', '{"input":"compatible"}'::jsonb,
    'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'gemini-native-active-call', 'gemini-native-active-run', 2, 0,
    'native-active-call', 'fixture_tool', '{"input":"native"}'::jsonb,
    'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
`;

const preservedControlPlaneSql = `
SELECT jsonb_build_object(
  'credential', (SELECT to_jsonb(row_value) FROM "ProviderCredential" row_value WHERE "id" = 'gemini-contract-credential'),
  'version', (SELECT to_jsonb(row_value) FROM "ProviderCredentialVersion" row_value WHERE "id" = 'gemini-contract-version'),
  'assignment', (SELECT to_jsonb(row_value) FROM "ProviderUserCredentialAssignment" row_value WHERE "connectionId" = 'gemini-contract-connection'),
  'check', (SELECT to_jsonb(row_value) FROM "ProviderModelCredentialCheck" row_value WHERE "id" = 'gemini-contract-check'),
  'grant', (SELECT to_jsonb(row_value) FROM "AccessGrant" row_value WHERE "id" = 'gemini-contract-grant'),
  'settings', (SELECT to_jsonb(row_value) FROM "UserSettings" row_value WHERE "id" = 'gemini-contract-settings')
)::text;
`;

const preservedSnapshotsSql = `
SELECT jsonb_object_agg("id", "executionSnapshot" ORDER BY "id")::text
FROM "ProviderRunBinding"
WHERE "id" LIKE 'gemini-%-binding';
`;

function runEmptyDatabaseCase(): void {
  const database = `aiqsa_gemini_native_empty_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "migrate empty installation");
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'Message'
              AND column_name IN ('groundedAt', 'groundingProvider', 'groundingStrategy')),
          (SELECT count(*) FROM "SearchStrategy"
            WHERE "strategyId" = 'gemini-google-search'
              AND "kind" = 'gemini_google_search'
              AND "providerModelId" IS NULL
              AND "config" = '{"tool":"google_search","liveOnly":true}'::jsonb)
        );
      `),
      "3|1",
      "fresh migrated schema must expose grounding provenance and the native search strategy"
    );
  } finally {
    dropDatabase(database);
  }
}

function runExistingInstallationCase(): void {
  const database = `aiqsa_gemini_native_existing_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, knownInstallationFixture), "insert Gemini cutover fixture");
    const preservedControlPlane = scalar(database, preservedControlPlaneSql);
    const preservedSnapshots = scalar(database, preservedSnapshotsSql);

    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "migrate existing Gemini installation");

    assert.equal(
      scalar(database, preservedControlPlaneSql),
      preservedControlPlane,
      "credentials, envelopes, assignments, checks, grants, and user defaults must be byte-stable"
    );
    assert.equal(
      scalar(database, preservedSnapshotsSql),
      preservedSnapshots,
      "terminal and active execution snapshots must not be rewritten"
    );
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT "draftConfig" ->> 'apiRoot' FROM "ProviderConnection" WHERE "id" = 'gemini-contract-connection'),
          (SELECT "activeConfig" ->> 'apiRoot' FROM "ProviderConnection" WHERE "id" = 'gemini-contract-connection'),
          (SELECT "draftVersion" FROM "ProviderConnection" WHERE "id" = 'gemini-contract-connection'),
          (SELECT "activeVersion" FROM "ProviderConnection" WHERE "id" = 'gemini-contract-connection'),
          (SELECT "defaultCredentialId" FROM "ProviderConnection" WHERE "id" = 'gemini-contract-connection'),
          (SELECT "draftConfig" ->> 'adapterKind' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "activeConfig" ->> 'adapterKind' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "draftConfig" #>> '{capabilities,nativeSearch}' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "activeConfig" #>> '{capabilities,nativeSearch}' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "capabilities" ->> 'nativeSearch' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "draftConfig" ->> 'sentinel' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "activeConfig" ->> 'sentinel' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "defaultParams" ->> 'sentinel' FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "draftVersion" FROM "ProviderModel" WHERE "id" = 'gemini-contract-model'),
          (SELECT "activeVersion" FROM "ProviderModel" WHERE "id" = 'gemini-contract-model')
        );
      `),
      [
        "https://generativelanguage.googleapis.com/v1",
        "https://generativelanguage.googleapis.com/v1",
        "7",
        "6",
        "gemini-contract-credential",
        "gemini_interactions_native",
        "gemini_interactions_native",
        "true",
        "true",
        "true",
        "draft-preserved",
        "active-preserved",
        "params-preserved",
        "9",
        "8"
      ].join("|"),
      "Gemini conversion must only replace the protocol schema and enable native search"
    );
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT "status" FROM "ModelRun" WHERE "id" = 'gemini-compatible-active-run'),
          (SELECT "errorPayload" ->> 'code' FROM "ModelRun" WHERE "id" = 'gemini-compatible-active-run'),
          (SELECT ("toolLoopState" IS NULL)::text FROM "ModelRun" WHERE "id" = 'gemini-compatible-active-run'),
          (SELECT "status" FROM "Message" WHERE "id" = 'gemini-compatible-active-assistant'),
          (SELECT "state" FROM "ModelRunToolCall" WHERE "id" = 'gemini-compatible-active-call'),
          (SELECT "status" FROM "ModelRun" WHERE "id" = 'gemini-native-active-run'),
          (SELECT "toolLoopState" ->> 'thoughtSignature' FROM "ModelRun" WHERE "id" = 'gemini-native-active-run'),
          (SELECT "state" FROM "ModelRunToolCall" WHERE "id" = 'gemini-native-active-call'),
          (SELECT "status" FROM "ModelRun" WHERE "id" = 'gemini-compatible-terminal-run'),
          (SELECT "finalProviderResponsePreview" ->> 'sentinel' FROM "ModelRun" WHERE "id" = 'gemini-compatible-terminal-run')
        );
      `),
      "error|gemini_native_cutover_retry_required|true|error|cancelled|in_progress|exact-private-signature|running|complete|response-preview-terminal",
      "only old non-terminal compatible runs must be settled"
    );

    requireSuccess(
      psql(database, `
        UPDATE "Message"
        SET "groundedAt" = CURRENT_TIMESTAMP,
            "groundingProvider" = 'gemini',
            "groundingStrategy" = 'gemini-google-search'
        WHERE "id" = 'gemini-compatible-terminal-assistant';
      `),
      "accept valid assistant grounding provenance"
    );
    const invalidGrounding = psql(database, `
      UPDATE "Message"
      SET "groundedAt" = CURRENT_TIMESTAMP,
          "groundingProvider" = 'gemini',
          "groundingStrategy" = 'gemini-google-search'
      WHERE "id" = 'gemini-compatible-terminal-user';
    `);
    assert.notEqual(invalidGrounding.status, 0, "grounding provenance unexpectedly accepted a user message");
    assert.match(`${invalidGrounding.stdout}\n${invalidGrounding.stderr}`, /Message_grounding_provenance_check/u);

    requireSuccess(
      psql(database, `
        INSERT INTO "ProviderConnection" (
          "id", "displayName", "family", "draftConfig", "updatedAt"
        ) VALUES (
          'custom-no-auth-contract', 'Custom no-auth contract', 'openai_compatible',
          '{"apiRoot":"http://127.0.0.1:1234/v1","allowPrivateNetwork":true,"authenticationMode":"none"}'::jsonb,
          CURRENT_TIMESTAMP
        );
        INSERT INTO "ProviderCredential" (
          "id", "connectionId", "label", "draftVersion", "updatedAt"
        ) VALUES (
          'custom-no-auth-credential', 'custom-no-auth-contract', 'No authentication', 1,
          CURRENT_TIMESTAMP
        );
        INSERT INTO "ProviderCredentialVersion" (
          "id", "credentialId", "version", "secretEnvelope", "testEvidence",
          "testedAt", "activatedAt"
        ) VALUES (
          'custom-no-auth-version', 'custom-no-auth-credential', 1, NULL,
          '{"authenticationMode":"none","tested":true}'::jsonb,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      `),
      "accept an explicitly tested no-auth credential version"
    );
    const implicitNoAuth = psql(database, `
      INSERT INTO "ProviderCredentialVersion" (
        "id", "credentialId", "version", "secretEnvelope", "testEvidence",
        "testedAt", "activatedAt"
      ) VALUES (
        'custom-implicit-no-auth-version', 'custom-no-auth-credential', 2, NULL,
        '{"authenticationMode":"bearer"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    assert.notEqual(implicitNoAuth.status, 0, "a null bearer secret unexpectedly passed the DB fence");
    assert.match(`${implicitNoAuth.stdout}\n${implicitNoAuth.stderr}`, /ProviderCredentialVersion_secret_check/u);
  } finally {
    dropDatabase(database);
  }
}

function runRejectedConfigurationCase(input: Readonly<{ fixture: string; label: string; expected: RegExp }>): void {
  const database = `aiqsa_gemini_native_reject_${input.label}_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, input.fixture), `insert rejected ${input.label} fixture`);
    const result = psql(database, migrationSql(TARGET_MIGRATION));
    assert.notEqual(result.status, 0, `${input.label} fixture unexpectedly migrated`);
    assert.match(`${result.stdout}\n${result.stderr}`, input.expected);
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'Message'
              AND column_name IN ('groundedAt', 'groundingProvider', 'groundingStrategy')),
          (SELECT count(*) FROM "SearchStrategy" WHERE "strategyId" = 'gemini-google-search'),
          (SELECT count(*) FROM pg_constraint
            WHERE conname = 'SearchStrategy_provider_model_check'
              AND pg_get_constraintdef(oid) LIKE '%gemini_google_search%'),
          (SELECT count(*) FROM pg_constraint
            WHERE conname = 'ProviderCredentialVersion_secret_check'
              AND pg_get_constraintdef(oid) LIKE '%authenticationMode%')
        );
      `),
      "0|0|0|0",
      "a rejected cutover must roll back every schema and data mutation"
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
    runEmptyDatabaseCase();
    runExistingInstallationCase();
    runRejectedConfigurationCase({
      expected: /unsupported Gemini connection configuration/u,
      fixture: `
        INSERT INTO "ProviderConnection" (
          "id", "displayName", "family", "draftConfig", "updatedAt"
        ) VALUES (
          'unsupported-gemini-connection', 'Unsupported Gemini connection', 'gemini',
          '{"apiRoot":"https://proxy.example.test/v1","allowPrivateNetwork":false}'::jsonb,
          CURRENT_TIMESTAMP
        );
      `,
      label: "connection"
    });
    runRejectedConfigurationCase({
      expected: /unsupported Gemini model configuration/u,
      fixture: `
        INSERT INTO "ProviderConnection" (
          "id", "displayName", "family", "draftConfig", "updatedAt"
        ) VALUES (
          'unsupported-gemini-model-connection', 'Unsupported Gemini model connection',
          'gemini', '{"apiRoot":"https://generativelanguage.googleapis.com/v1"}'::jsonb,
          CURRENT_TIMESTAMP
        );
        INSERT INTO "ProviderModel" (
          "id", "connectionId", "provider", "modelId", "displayName", "contextWindow",
          "draftConfig", "capabilities", "defaultParams", "updatedAt"
        ) VALUES (
          'unsupported-gemini-model', 'unsupported-gemini-model-connection', 'gemini',
          'unsupported-model', 'Unsupported model', 1048576,
          '{"adapterKind":"unknown_adapter","capabilities":{}}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
        );
      `,
      label: "model"
    });
    process.stdout.write(
      "AIQSA native Gemini migration contract ok: atomic rollback, empty bootstrap, native protocol conversion, live grounding provenance, Google Search strategy, immutable control-plane lineage, active-run settlement, terminal/native-run preservation, and explicit no-auth evidence fence verified.\n"
    );
  } finally {
    for (const database of [...disposableDatabases].reverse()) {
      dropDatabase(database);
    }
  }
}

main();
