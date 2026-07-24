import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  decryptMcpEnvelope,
  mcpOAuthClientSecretEnvelopeContext,
  mcpOAuthTokenEnvelopeContext,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext
} from "../../../lib/server/mcp/encryption";

const TARGET_MIGRATION = "20260723233000_mcp_envelope_v2_context";
const POSTGRES_USER = "aiqsa";
const POSTGRES_PASSWORD = "aiqsa-dev-password";
const POSTGRES_SERVICE = "postgres";
const KEY = Buffer.alloc(32, 0x47);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const cutoverScript = join(repositoryRoot, "prisma/scripts/mcp-envelope-v2-cutover.ts");
const runId = `${process.pid}_${Date.now()}`;
const disposableDatabases = new Set<string>();
let nonceCounter = 1;

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
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
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

function scalar(database: string, sql: string): string {
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
  ]), "read MCP envelope cutover state");
}

function createDatabase(database: string): void {
  requireSuccess(compose([
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "createdb",
    "--username",
    POSTGRES_USER,
    database
  ]), `create disposable database ${database}`);
  disposableDatabases.add(database);
}

function dropDatabase(database: string): void {
  requireSuccess(compose([
    "exec",
    "-T",
    POSTGRES_SERVICE,
    "dropdb",
    "--if-exists",
    "--force",
    "--username",
    POSTGRES_USER,
    database
  ]), `drop disposable database ${database}`);
  disposableDatabases.delete(database);
}

function applyMigrations(database: string): void {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name <= TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort();
  assert(migrations.includes(TARGET_MIGRATION), "MCP envelope v2 migration is missing");
  for (const migration of migrations) {
    requireSuccess(
      psql(database, readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8")),
      `apply migration ${migration}`
    );
  }
}

function legacyEnvelope(value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const nonce = Buffer.alloc(12, nonceCounter++);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url")
  ].join(".");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureSql(malformedToken = false): string {
  const shared = legacyEnvelope({ updatedAt: {}, values: { apiKey: "shared-secret" }, version: 1 });
  const personal = legacyEnvelope({ updatedAt: {}, values: { workspace: "personal-secret" }, version: 1 });
  const clientSecret = legacyEnvelope({ clientSecret: "client-secret", version: 1 });
  const token = malformedToken
    ? "v1.invalid.invalid.invalid"
    : legacyEnvelope({
        issuedAt: "2026-07-23T00:00:00.000Z",
        policy: { configurationIdentity: "revision-1" },
        tokens: { access_token: "oauth-secret", token_type: "Bearer" },
        version: 1
      });
  const runtime = legacyEnvelope({ plan: [], values: { runtime: "runtime-secret" }, version: 1 });
  return `
INSERT INTO "User" ("id", "email", "displayName", "updatedAt")
VALUES ('mcp-cutover-user', 'mcp-cutover@example.test', 'MCP Cutover', CURRENT_TIMESTAMP);

INSERT INTO "McpServer" (
  "id", "namespace", "displayName", "draft", "sharedConfigEnvelope",
  "sharedConfigVersion", "updatedAt"
) VALUES (
  'mcp-cutover-server', 'mcp_cutover', 'MCP Cutover', '{}'::jsonb,
  ${quote(shared)}, 4, CURRENT_TIMESTAMP
);

INSERT INTO "McpUserServer" (
  "id", "serverId", "userId", "personalConfigEnvelope",
  "personalConfigVersion", "updatedAt"
) VALUES (
  'mcp-cutover-user-server', 'mcp-cutover-server', 'mcp-cutover-user',
  ${quote(personal)}, 5, CURRENT_TIMESTAMP
);

INSERT INTO "McpOAuthClient" (
  "id", "registrationKey", "clientId", "clientMetadata",
  "clientSecretEnvelope", "clientSecretGeneration", "updatedAt"
) VALUES (
  'mcp-cutover-client', 'mcp-cutover-registration', 'upstream-client',
  '{}'::jsonb, ${quote(clientSecret)}, 6, CURRENT_TIMESTAMP
);

INSERT INTO "McpOAuthConnection" (
  "id", "serverId", "userId", "oauthClientId", "purpose",
  "policyFingerprint", "tokenEnvelope", "tokenGeneration", "updatedAt"
) VALUES (
  'mcp-cutover-connection', 'mcp-cutover-server', 'mcp-cutover-user',
  'mcp-cutover-client', 'user', 'policy-fingerprint', ${quote(token)}, 7,
  CURRENT_TIMESTAMP
);

INSERT INTO "McpRevision" (
  "id", "serverId", "revisionNumber", "configuration",
  "validationEvidence", "draftHash", "identityHash"
) VALUES (
  'mcp-cutover-revision', 'mcp-cutover-server', 1, '{}'::jsonb,
  '{}'::jsonb, 'draft-hash', 'identity-hash'
);

INSERT INTO "McpRuntimeGeneration" (
  "id", "userServerId", "revisionId", "fingerprint",
  "effectiveConfigEnvelope", "updatedAt"
) VALUES (
  'mcp-cutover-generation', 'mcp-cutover-user-server', 'mcp-cutover-revision',
  '${"f".repeat(64)}', ${quote(runtime)}, CURRENT_TIMESTAMP
);
`;
}

function runCutover(database: string): CommandResult {
  const result = spawnSync(
    join(repositoryRoot, "node_modules/.bin/tsx"),
    [cutoverScript],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AIQSA_ENCRYPTION_KEY: KEY.toString("base64"),
        DATABASE_URL: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${database}?schema=public`
      },
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function envelope(database: string, table: string, column: string, id: string): string {
  return scalar(database, `SELECT "${column}" FROM "${table}" WHERE "id" = '${id}';`);
}

function runValidCutover(): void {
  const database = `aiqsa_mcp_v2_valid_${runId}`;
  createDatabase(database);
  try {
    applyMigrations(database);
    requireSuccess(psql(database, fixtureSql()), "insert valid MCP v1 envelope fixture");
    const first = runCutover(database);
    requireSuccess(first, "convert MCP envelopes to v2");
    assert.deepEqual(JSON.parse(first.stdout), {
      convertedOAuthClientSecrets: 1,
      convertedOAuthTokens: 1,
      convertedPersonalConfigs: 1,
      convertedRuntimeConfigs: 1,
      convertedSharedConfigs: 1
    });

    const shared = envelope(database, "McpServer", "sharedConfigEnvelope", "mcp-cutover-server");
    const personal = envelope(
      database,
      "McpUserServer",
      "personalConfigEnvelope",
      "mcp-cutover-user-server"
    );
    const clientSecret = envelope(
      database,
      "McpOAuthClient",
      "clientSecretEnvelope",
      "mcp-cutover-client"
    );
    const token = envelope(
      database,
      "McpOAuthConnection",
      "tokenEnvelope",
      "mcp-cutover-connection"
    );
    const runtime = envelope(
      database,
      "McpRuntimeGeneration",
      "effectiveConfigEnvelope",
      "mcp-cutover-generation"
    );
    for (const converted of [shared, personal, clientSecret, token, runtime]) {
      assert.match(converted, /^v2\./u);
    }
    assert.deepEqual(
      decryptMcpEnvelope(
        shared,
        KEY,
        mcpSharedConfigEnvelopeContext("mcp-cutover-server", 4)
      ),
      { updatedAt: {}, values: { apiKey: "shared-secret" }, version: 1 }
    );
    assert.deepEqual(
      decryptMcpEnvelope(
        personal,
        KEY,
        mcpPersonalConfigEnvelopeContext("mcp-cutover-user-server", 5)
      ),
      { updatedAt: {}, values: { workspace: "personal-secret" }, version: 1 }
    );
    assert.deepEqual(
      decryptMcpEnvelope(
        clientSecret,
        KEY,
        mcpOAuthClientSecretEnvelopeContext("mcp-cutover-client", 6)
      ),
      { clientSecret: "client-secret", version: 1 }
    );
    assert.deepEqual(
      decryptMcpEnvelope(
        token,
        KEY,
        mcpOAuthTokenEnvelopeContext("mcp-cutover-connection", 7)
      ),
      {
        issuedAt: "2026-07-23T00:00:00.000Z",
        policy: { configurationIdentity: "revision-1" },
        tokens: { access_token: "oauth-secret", token_type: "Bearer" },
        version: 1
      }
    );
    assert.deepEqual(
      decryptMcpEnvelope(
        runtime,
        KEY,
        mcpRuntimeGenerationEnvelopeContext("mcp-cutover-generation", "f".repeat(64))
      ),
      { plan: [], values: { runtime: "runtime-secret" }, version: 1 }
    );
    assert.throws(() => decryptMcpEnvelope(
      shared,
      KEY,
      mcpSharedConfigEnvelopeContext("mcp-cutover-server", 5)
    ), /mcp_encryption_invalid_envelope/u);

    const repeated = runCutover(database);
    requireSuccess(repeated, "repeat completed MCP envelope cutover");
    assert.deepEqual(JSON.parse(repeated.stdout), {
      convertedOAuthClientSecrets: 0,
      convertedOAuthTokens: 0,
      convertedPersonalConfigs: 0,
      convertedRuntimeConfigs: 0,
      convertedSharedConfigs: 0
    });

    const invalidGeneration = psql(database, `
      UPDATE "McpOAuthConnection"
      SET "tokenGeneration" = 0
      WHERE "id" = 'mcp-cutover-connection';
    `);
    assert.notEqual(invalidGeneration.status, 0, "token envelope unexpectedly accepted generation zero");
    assert.match(`${invalidGeneration.stdout}\n${invalidGeneration.stderr}`, /token_generation_check/u);
  } finally {
    dropDatabase(database);
  }
}

function runAtomicFailure(): void {
  const database = `aiqsa_mcp_v2_fail_${runId}`;
  createDatabase(database);
  try {
    applyMigrations(database);
    requireSuccess(psql(database, fixtureSql(true)), "insert invalid MCP v1 envelope fixture");
    const before = envelope(database, "McpServer", "sharedConfigEnvelope", "mcp-cutover-server");
    const failed = runCutover(database);
    assert.notEqual(failed.status, 0, "invalid MCP v1 envelope unexpectedly converted");
    assert.match(failed.stderr, /mcp_envelope_cutover_invalid_v1/u);
    assert.equal(
      envelope(database, "McpServer", "sharedConfigEnvelope", "mcp-cutover-server"),
      before,
      "failed cutover did not roll back an earlier conversion"
    );
    assert.match(before, /^v1\./u);
  } finally {
    dropDatabase(database);
  }
}

try {
  runValidCutover();
  runAtomicFailure();
  process.stdout.write(
    "AIQSA MCP envelope cutover contract ok: contextual v2 conversion is atomic and v1 runtime fallback is absent.\n"
  );
} finally {
  for (const database of [...disposableDatabases]) dropDatabase(database);
}
