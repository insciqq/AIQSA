/**
 * The migration contract on disposable databases: the committed history deploys in order from an empty database
 * and again as a no-op, `migrate status` agrees, the reviewed SQL-only schema delta holds, and fresh and adopted
 * bootstrap, seed and integrity pass. Forward adoption proofs cover only migrations no release has shipped; each
 * goes in the release after both installations run the one that contains its migration (agent_docs/PERSISTENCE.md).
 * Released migration directories are frozen by `released-migrations.test.ts`, which needs no database.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDisposableStatefulDatabaseUrl } from "../../../scripts/stateful-test-target";
import { DROP_OLD_MEMORY_MIGRATION, dropOldMemoryFixtureSql, dropOldMemoryProofSql } from "./drop-old-memory-adoption";
import {
  DROP_REMOVED_FEATURE_STORAGE_MIGRATION, dropRemovedFeatureStorageFixtureSql, dropRemovedFeatureStorageProofSql
} from "./drop-removed-feature-storage-adoption";
import {
  MEMORY_NOTE_ADOPTION_MIGRATION, memoryNoteAdoptionBareFixtureSql, memoryNoteAdoptionBareProofSql,
  memoryNoteAdoptionBareRepeatProofSql, memoryNoteAdoptionFixtureSql, memoryNoteAdoptionProofSql,
  memoryNoteAdoptionRepeatProofSql
} from "./memory-note-adoption";

const BASELINE = "20260815000000_baseline";
const BASELINE_SHA256 = "71c210d018bf2c56c4003a0a74f5c84dfdea939336c889b04b786444461f5b33";
const EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256 =
  "e7028e14cba69df65ef41b829563a4ae927c7fe4b28899fa0a09df947cf37750";
const POSTGRES_USER = "aiqsa";
const POSTGRES_SERVICE = "postgres";
const APP_SERVICE = "app";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const composeFile = join(repositoryRoot, "docker-compose.dev.yml");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;

type DatabaseRole = "shadow" | "smoke";
type CommandResult = Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}>;

/** Refuses the removed full mode by name, so a stale caller learns what replaced it before any database changes. */
function migrationModeError(args: readonly string[]): string | undefined {
  if (args.length === 1 && args[0] === "--mode=smoke") return undefined;
  if (args.includes("--mode=full")) {
    return "The migration contract's full mode was removed (2026-11-22): run `npm run db:migration:smoke`. "
      + "It deploys the whole history from an empty database and proves bootstrap, seed and integrity; "
      + "released migrations are checked by prisma/scripts/tests/released-migrations.test.ts.";
  }
  return "The migration contract takes exactly one argument, --mode=smoke (`npm run db:migration:smoke`).";
}

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
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

function databaseName(role: DatabaseRole): string {
  return `aiqsa_migration_${role}_${runId}`;
}

function assertDisposableDatabase(database: string): void {
  assert.match(
    database,
    /^aiqsa_migration_(?:smoke|shadow)_[0-9]+_[0-9]+$/u,
    `refusing unsafe database target: ${database}`,
  );
}

let disposableDatabaseUrlTemplate: URL | undefined;

function databaseUrlTemplate(): URL {
  if (disposableDatabaseUrlTemplate) {
    return disposableDatabaseUrlTemplate;
  }

  const value = requireSuccess(
    compose([
      "exec",
      "-T",
      APP_SERVICE,
      "node",
      "-e",
      "process.stdout.write(process.env.DATABASE_URL ?? '')",
    ]),
    "read disposable app database target",
  );
  assert.equal(
    isDisposableStatefulDatabaseUrl(value),
    true,
    "the disposable app DATABASE_URL does not match the fail-closed stateful target contract",
  );
  disposableDatabaseUrlTemplate = new URL(value);
  return disposableDatabaseUrlTemplate;
}

function databaseUrl(database: string): string {
  assertDisposableDatabase(database);
  const url = new URL(databaseUrlTemplate());
  url.pathname = `/${database}`;
  return url.toString();
}

function postgres(args: string[], operation: string, input?: string): string {
  return requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, ...args], input),
    operation,
  );
}

function createDatabase(database: string): void {
  assertDisposableDatabase(database);
  postgres(
    ["createdb", "--username", POSTGRES_USER, database],
    `create disposable database ${database}`,
  );
}

function dropDatabase(database: string): void {
  assertDisposableDatabase(database);
  postgres(
    ["dropdb", "--if-exists", "--force", "--username", POSTGRES_USER, database],
    `drop disposable database ${database}`,
  );
}

function psqlScalar(database: string, sql: string): string {
  assertDisposableDatabase(database);
  return postgres(
    [
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
    ],
    `query disposable database ${database}`,
  );
}

function app(
  database: string,
  command: string[],
  extraEnvironment: Record<string, string> = {},
): string {
  assertDisposableDatabase(database);
  const environment = {
    DATABASE_URL: databaseUrl(database),
    ...extraEnvironment,
  };
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => [
    "-e",
    `${name}=${value}`,
  ]);
  return requireSuccess(
    compose(["exec", "-T", ...environmentArgs, APP_SERVICE, ...command]),
    `${command.join(" ")} against ${database}`,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function committedMigrations(): string[] {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(migrations.length > 0, "committed migration history is empty");
  assert.equal(migrations[0], BASELINE, "the clean baseline must remain the first migration");
  assert.equal(
    sha256(readFileSync(join(migrationsRoot, BASELINE, "migration.sql"))),
    BASELINE_SHA256,
    "the frozen pre-production baseline changed; add an append-only migration instead",
  );
  for (const migration of migrations) {
    assert.match(
      migration,
      /^\d{14}_[A-Za-z0-9][A-Za-z0-9_-]*$/u,
      `invalid migration directory ${migration}`,
    );
    assert.equal(
      existsSync(join(migrationsRoot, migration, "migration.sql")),
      true,
      `migration ${migration} has no migration.sql`,
    );
  }
  return migrations;
}

function deployedMigrations(database: string): string[] {
  const value = psqlScalar(
    database,
    `SELECT COALESCE(
       string_agg(migration_name, E'\\n' ORDER BY migration_name),
       ''
     )
     FROM "_prisma_migrations"
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
  );
  return value === "" ? [] : value.split("\n");
}

function assertDeployedMigrations(database: string, expected: readonly string[]): void {
  assert.deepEqual(
    deployedMigrations(database),
    expected,
    "clean install did not record the complete ordered committed migration set",
  );
  assert.equal(
    psqlScalar(database, 'SELECT count(*) FROM "_prisma_migrations";'),
    String(expected.length),
    "clean install recorded failed, rolled-back, or unexpected migrations",
  );
}

function deployAndVerify(
  database: string,
  migrations: readonly string[],
  shadowDatabase: string,
): void {
  app(database, ["npx", "prisma", "migrate", "deploy"]);
  assertDeployedMigrations(database, migrations);
  const beforeRepeat = deployedMigrations(database);
  app(database, ["npx", "prisma", "migrate", "deploy"]);
  assert.deepEqual(
    deployedMigrations(database),
    beforeRepeat,
    "repeated migrate deploy changed the applied migration set",
  );
  assert.match(
    app(database, ["npx", "prisma", "migrate", "status"]),
    /Database schema is up to date!/u,
  );
  const schemaDatamodelDiff = app(database, [
    "npx",
    "prisma",
    "migrate",
    "diff",
    "--from-migrations",
    "prisma/migrations",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--shadow-database-url",
    databaseUrl(shadowDatabase),
    "--script",
  ]);
  const schemaDatamodelDiffSha256 = sha256(schemaDatamodelDiff);
  if (
    schemaDatamodelDiffSha256 !== EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256 &&
    process.env.AIQSA_PRINT_SCHEMA_DATAMODEL_DIFF === "1"
  ) {
    process.stderr.write("Reviewed SQL-only schema/datamodel delta:\n" +
      schemaDatamodelDiff + "\n");
  }
  assert.equal(
    schemaDatamodelDiffSha256,
    EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256,
    `the reviewed SQL-only schema/datamodel delta changed; received sha256=${schemaDatamodelDiffSha256}`,
  );
}

function runIntegrityProof(database: string): void {
  const unvalidatedConstraints = psqlScalar(database, `
    SELECT COALESCE(
      string_agg(
        table_relation.relname || '.' || constraint_catalog.conname,
        E'\\n'
        ORDER BY table_relation.relname, constraint_catalog.conname
      ),
      ''
    )
    FROM pg_constraint AS constraint_catalog
    INNER JOIN pg_class AS table_relation
      ON table_relation.oid = constraint_catalog.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = constraint_catalog.connamespace
    WHERE namespace.nspname = current_schema()
      AND NOT constraint_catalog.convalidated;
  `);
  assert.equal(
    unvalidatedConstraints,
    "",
    "clean install retained an unvalidated constraint",
  );
  app(database, ["npx", "tsx", "prisma/schema-integrity-smoke.ts"]);
}

function runSeedProof(database: string): void {
  const testEnvironment = {
    AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
    AIQSA_TEST_MODE: "1",
    NODE_ENV: "development",
  };
  app(database, ["npx", "prisma", "db", "seed"], testEnvironment);
  app(database, ["npx", "prisma", "db", "seed"], testEnvironment);
  app(
    database,
    ["npx", "tsx", "prisma/seed-smoke.ts", "--expect-empty-workspace"],
    testEnvironment,
  );
  runIntegrityProof(database);
}

function bootstrapFoundationDigest(database: string): string {
  return psqlScalar(
    database,
    `SELECT md5(jsonb_build_object(
      'users', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, email, "displayName", role, status) ORDER BY id)
        FROM "User"
      ), '[]'::jsonb),
      'identities', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "userId", provider, "providerAccountId", "normalizedEmail", "emailVerifiedAt" IS NOT NULL) ORDER BY id)
        FROM "AuthIdentity"
      ), '[]'::jsonb),
      'groups', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, name, "systemRole", "archivedAt") ORDER BY id)
        FROM "Group"
      ), '[]'::jsonb),
      'memberships', COALESCE((
        SELECT jsonb_agg(jsonb_build_array("userId", "groupId", role) ORDER BY "userId", "groupId")
        FROM "UserGroup"
      ), '[]'::jsonb),
      'settings', COALESCE((
        SELECT jsonb_agg(to_jsonb(settings) - 'createdAt' - 'updatedAt' ORDER BY settings."userId")
        FROM "UserSettings" AS settings
      ), '[]'::jsonb),
      'mcp_grants', COALESCE((
        SELECT jsonb_agg(jsonb_build_array("serverId", "userId", "groupId", "canUse", "personalSlotKeys") ORDER BY "serverId", id)
        FROM "McpGrant"
      ), '[]'::jsonb),
      'model_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(
          id,
          "defaultProviderModelId",
          "maxToolCalls",
          "maxToolRounds",
          "toolObservationPolicy",
          version,
          "updatedByUserId"
        ) ORDER BY id)
        FROM "ModelPolicy"
      ), '[]'::jsonb),
      'system_model_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "providerModelId", "reasoningEffort", version, "updatedByUserId") ORDER BY id)
        FROM "SystemModelPolicy"
      ), '[]'::jsonb),
      'workspace_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, enabled, "internetEnabled", version, "updatedByUserId") ORDER BY id)
        FROM "WorkspacePolicy"
      ), '[]'::jsonb),
      'mcp_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "personalLocalNetworkEnabled", version) ORDER BY id)
        FROM "McpPolicy"
      ), '[]'::jsonb),
      'usage_limit_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, "monthlyCapMicros", "monthlyBudgetMicros", "messagesPerHour",
          "messagesPerDay", version, "updatedByUserId") ORDER BY id)
        FROM "UsageLimitPolicy"
      ), '[]'::jsonb),
      'connect_policy', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, enabled, version, "updatedByUserId") ORDER BY id)
        FROM "ConnectPolicy"
      ), '[]'::jsonb),
      'telegram_control', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, enabled, restricted, "tokenEnvelope" IS NOT NULL, "tokenGeneration",
          "botId", "botUsername", version, "updatedByUserId") ORDER BY id)
        FROM "TelegramBotControl"
      ), '[]'::jsonb),
      'telegram_groups', COALESCE((
        SELECT jsonb_agg("groupId" ORDER BY "groupId")
        FROM "TelegramBotGroup"
      ), '[]'::jsonb),
      'discord_control', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(id, enabled, "tokenEnvelope" IS NOT NULL, "tokenGeneration", "guildId",
          "channelMode", "channelIds", "dmEnabled", "serviceUserId", "assistantId", "perAuthorHourly", "perAuthorDaily",
          "perThreadHourly", "parallelThreads", "sessionId" IS NOT NULL, "callNames", version, "updatedByUserId") ORDER BY id)
        FROM "DiscordBotControl"
      ), '[]'::jsonb)
    )::text);`,
  );
}

function runBootstrapProof(database: string): void {
  assert.equal(psqlScalar(database, `SELECT "toolLimitsEnabled" FROM "ModelPolicy" WHERE id = 'installation';`),
    "f", "fresh installation must answer without tool limits");
  assert.equal(psqlScalar(database, `SELECT "maxToolCalls" || ':' || "maxToolRounds" FROM "ModelPolicy" WHERE id = 'installation';`),
    "80:32", "fresh installation must keep the tool limits turning them on applies");
  assert.equal(
    psqlScalar(database, `SELECT enabled FROM "WorkspacePolicy" WHERE id = 'installation';`),
    "t",
    "fresh migration history must permit Workspace before bootstrap",
  );
  assert.equal(
    psqlScalar(database, `SELECT CASE WHEN "personalLocalNetworkEnabled" THEN 'on' ELSE 'off' END || ':' || version::text FROM "McpPolicy" WHERE id = 'installation';`),
    "on:1",
    "fresh migration history must allow personal MCP local network access before bootstrap",
  );
  assert.equal(
    psqlScalar(database, `SELECT CASE WHEN enabled THEN 'on' ELSE 'off' END || ':' || version::text FROM "ConnectPolicy" WHERE id = 'installation';`),
    "off:1",
    "fresh migration history must keep AIQSA Connect off before bootstrap",
  );
  assert.equal(
    psqlScalar(database, `SELECT CASE WHEN enabled THEN 'on' ELSE 'off' END || ':' || CASE WHEN restricted THEN 'groups' ELSE 'everyone' END
      || ':' || ("tokenEnvelope" IS NULL)::text || ':' || "tokenGeneration"::text || ':' || version::text
      FROM "TelegramBotControl" WHERE id = 'installation';`),
    "off:everyone:true:0:1",
    "fresh migration history must leave the Telegram bot off and unconfigured before bootstrap",
  );
  assert.equal(
    psqlScalar(database, `SELECT CASE WHEN enabled THEN 'on' ELSE 'off' END || ':' || "channelMode"::text
      || ':' || ("tokenEnvelope" IS NULL)::text || ':' || "tokenGeneration"::text || ':' || cardinality("channelIds")::text
      || ':' || "perAuthorHourly"::text || '/' || "perAuthorDaily"::text || '/' || "perThreadHourly"::text
      || '/' || "parallelThreads"::text || ':' || cardinality("callNames")::text || ':' || version::text
      FROM "DiscordBotControl" WHERE id = 'installation';`),
    "off:only_listed:true:0:0:20/100/60/16:0:1",
    "fresh migration history must leave the Discord bot off, unconfigured, listing no channel and no call name before bootstrap",
  );
  const bootstrapEnvironment = {
    AIQSA_INITIAL_ADMIN_DISPLAY_NAME: "Baseline Administrator",
    AIQSA_INITIAL_ADMIN_EMAIL: "baseline-admin@example.invalid",
    AIQSA_INITIAL_ADMIN_PASSWORD: "Baseline-contract-password-123!",
    NODE_ENV: "production",
  };
  const first = app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.match(first, /"code":"installation_created"/u);
  assert.equal(psqlScalar(database, `SELECT count(*) FROM "UserSettings" s JOIN "User" u ON u.id = s."userId"
    WHERE u.email = 'baseline-admin@example.invalid' AND s."defaultSearchPlan" IS NULL;`), "1",
    "initial administrator inherits organization Search");
  psqlScalar(database, `UPDATE "UserSettings" SET "defaultSearchPlan" = '{"mode":"all_selected","optionIds":[]}';`);
  assert.equal(psqlScalar(database, `SELECT "mcpAutoDiscoveryMaxOutputTokens" FROM "ModelPolicy" WHERE id = 'installation';`), "");
  assert.equal(psqlScalar(database, `SELECT "toolObservationPolicy" FROM "ModelPolicy" WHERE id = 'installation';`), "v1",
    "a fresh installation enables observations and compaction without an administrator action");
  assert.equal(psqlScalar(database, `SELECT "toolLimitsEnabled" FROM "ModelPolicy" WHERE id = 'installation';`), "f",
    "bootstrap must leave a fresh installation without tool limits");
  psqlScalar(database, `UPDATE "ModelPolicy" SET "mcpAutoDiscoveryMaxOutputTokens" = 4096, "toolObservationPolicy" = 'off', "toolLimitsEnabled" = true WHERE id = 'installation';`);
  assert.equal(psqlScalar(database, `SELECT count(*) FROM "UserSettings" s JOIN "User" u ON u.id = s."userId"
    WHERE u.email = 'baseline-admin@example.invalid' AND s."memoryEnabled" AND s."pastChatSearchEnabled"
      AND s."memorySuggestionsEnabled";`), "1", "initial administrator Memory defaults");
  psqlScalar(database, `UPDATE "UserSettings" SET "memorySuggestionsEnabled" = false;`);
  assert.equal(
    psqlScalar(database, `SELECT CASE WHEN enabled THEN 'on' ELSE 'off' END || ':' || version::text FROM "ConnectPolicy" WHERE id = 'installation';`),
    "off:1",
    "fresh bootstrap must keep AIQSA Connect off",
  );
  const freshDigest = bootstrapFoundationDigest(database);
  // Adoption recreates missing usage limits, AIQSA Connect, Telegram and Discord singletons exactly as the migrations inserted them.
  psqlScalar(database, `DELETE FROM "UsageLimitPolicy"; DELETE FROM "ConnectPolicy"; DELETE FROM "TelegramBotControl";
    DELETE FROM "DiscordBotControl";`);
  const repeat = app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.match(repeat, /"code":"installation_already_adopted"/u);
  assert.equal(psqlScalar(database, `SELECT count(*) FROM "UserSettings" WHERE "memorySuggestionsEnabled";`), "0",
    "bootstrap adoption must preserve later Memory opt-outs");
  assert.equal(psqlScalar(database, `SELECT "mcpAutoDiscoveryMaxOutputTokens" FROM "ModelPolicy" WHERE id = 'installation';`), "4096", "bootstrap must retain the operator's MCP output allowance");
  assert.equal(psqlScalar(database, `SELECT "toolObservationPolicy" FROM "ModelPolicy" WHERE id = 'installation';`), "off", "bootstrap must retain the operator's observation kill switch");
  assert.equal(psqlScalar(database, `SELECT "toolLimitsEnabled" FROM "ModelPolicy" WHERE id = 'installation';`), "t", "bootstrap must retain the operator's tool limits");
  assert.equal(
    bootstrapFoundationDigest(database),
    freshDigest,
    "adopted bootstrap changed the settled fresh-install foundation",
  );
  psqlScalar(database, `UPDATE "WorkspacePolicy" SET enabled = false, version = version + 1 WHERE id = 'installation';
    UPDATE "McpPolicy" SET "personalLocalNetworkEnabled" = false, version = version + 1 WHERE id = 'installation';
    UPDATE "UsageLimitPolicy" SET "monthlyCapMicros" = 5000000, "messagesPerHour" = 0, version = version + 1 WHERE id = 'installation';
    UPDATE "ConnectPolicy" SET enabled = true, version = version + 1 WHERE id = 'installation';
    UPDATE "TelegramBotControl" SET restricted = true, version = version + 1 WHERE id = 'installation';
    INSERT INTO "TelegramBotGroup" ("groupId") SELECT id FROM "Group" ORDER BY id LIMIT 1;
    UPDATE "DiscordBotControl" SET "guildId" = 900000000000000001, "channelMode" = 'all_except',
      "channelIds" = ARRAY[900000000000000002]::BIGINT[], "dmEnabled" = true, "perAuthorHourly" = 5,
      "parallelThreads" = 4, "callNames" = ARRAY['Agent']::TEXT[], version = version + 1 WHERE id = 'installation';`);
  const disabledDigest = bootstrapFoundationDigest(database);
  app(database, ["npx", "tsx", "prisma/bootstrap.ts"], bootstrapEnvironment);
  assert.equal(
    bootstrapFoundationDigest(database),
    disabledDigest,
    "bootstrap adoption must preserve an administrator's saved Workspace, personal MCP local network Off, usage limits, AIQSA Connect On, Telegram access and Discord choices",
  );
  assert.equal(
    psqlScalar(
      database,
      `SELECT count(*) FROM "User"
       WHERE email = 'baseline-admin@example.invalid'
         AND role = 'admin' AND status = 'active';`,
    ),
    "1",
    "bootstrap did not preserve one active administrator",
  );
}

/** Keeps a prefix of the committed history in the disposable app container's /tmp. */
function migrationPrefixTree(database: string, migrations: readonly string[]): string {
  const root = app(database, ["node", "-e", `
    const fs = require('node:fs'), path = require('node:path');
    const root = fs.mkdtempSync('/tmp/aiqsa-forward-adoption-');
    fs.copyFileSync('prisma/schema.prisma', path.join(root, 'schema.prisma'));
    fs.mkdirSync(path.join(root, 'migrations'));
    fs.copyFileSync('prisma/migrations/migration_lock.toml', path.join(root, 'migrations/migration_lock.toml'));
    for (const name of ${JSON.stringify(migrations)}) {
      fs.cpSync(path.join('prisma/migrations', name), path.join(root, 'migrations', name), { recursive: true });
    }
    process.stdout.write(root);
  `]);
  assert.match(root, /^\/tmp\/aiqsa-forward-adoption-[a-zA-Z0-9]+$/u);
  return root;
}

/**
 * Writes the fixture against the predecessors of `migration`, then proves the
 * deployed history twice. A proof that reads storage a later migration drops
 * passes `proofBefore`: it then proves its own release's schema, and the rest
 * of the history must still deploy over its rows.
 */
function runForwardAdoptionProof(
  database: string, committed: readonly string[], migration: string, fixture: string, proof: string,
  repeatProof?: string, proofBefore?: string
): void {
  const index = committed.indexOf(migration);
  assert.ok(index > 0, "forward adoption migration is missing");
  const proofEnd = proofBefore === undefined ? committed.length : committed.indexOf(proofBefore);
  assert.ok(proofEnd > index, "forward adoption proof bound must follow its migration");
  dropDatabase(database);
  createDatabase(database);
  const trees: string[] = [];
  const deployPrefix = (end: number): string[] => {
    if (end === committed.length) return ["npx", "prisma", "migrate", "deploy"];
    const root = migrationPrefixTree(database, committed.slice(0, end));
    trees.push(root);
    return ["npx", "prisma", "migrate", "deploy", "--schema", `${root}/schema.prisma`];
  };
  try {
    app(database, deployPrefix(index));
    psqlScalar(database, fixture);
    const deployProofSchema = deployPrefix(proofEnd);
    app(database, deployProofSchema);
    psqlScalar(database, proof);
    app(database, deployProofSchema);
    if (repeatProof) psqlScalar(database, repeatProof);
    if (proofEnd < committed.length) app(database, ["npx", "prisma", "migrate", "deploy"]);
    assertDeployedMigrations(database, committed);
  } finally {
    for (const root of trees) {
      app(database, ["node", "-e", "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", root]);
    }
  }
}

/** Adoption proofs of migrations no release has shipped yet; delete each once both installations run its release. */
function runUnreleasedAdoptionProofs(database: string, migrations: readonly string[]): void {
  // Personal Memory becomes the note: switches, saved and automatic facts, the embedding role, inbound Memory MCP
  // grants and finished chat deletions carry over once, and an installation without Memory data invents nothing.
  // Both proofs read the old Memory tables and run the body again, so they end before the drop of those tables.
  runForwardAdoptionProof(database, migrations, MEMORY_NOTE_ADOPTION_MIGRATION,
    memoryNoteAdoptionFixtureSql, memoryNoteAdoptionProofSql, memoryNoteAdoptionRepeatProofSql, DROP_OLD_MEMORY_MIGRATION);
  runForwardAdoptionProof(database, migrations, MEMORY_NOTE_ADOPTION_MIGRATION,
    memoryNoteAdoptionBareFixtureSql, memoryNoteAdoptionBareProofSql, memoryNoteAdoptionBareRepeatProofSql,
    DROP_OLD_MEMORY_MIGRATION);
  // The old subsystem goes with its data: runs it left preparing end interrupted, runs at a PDF or Workspace gate keep
  // waiting, and the note, the past-chat index, the worker's tables, settings, roles, inbound OAuth, other chats, runs
  // and usage stay as they were. Nothing named after it is left in the catalog. Its proof reads usage and settings
  // columns the next drop removes, so it ends before that drop.
  runForwardAdoptionProof(database, migrations, DROP_OLD_MEMORY_MIGRATION,
    dropOldMemoryFixtureSql, dropOldMemoryProofSql, dropOldMemoryProofSql, DROP_REMOVED_FEATURE_STORAGE_MIGRATION);
  // The removed features' storage goes with its retired values: the old core's active runs end once, Agent approval
  // cards become model cards, retired Telegram buttons go, the Knowledge row and retired decision features leave
  // stored overrides, and usage keeps every row and purpose. Nothing that stays names what went.
  runForwardAdoptionProof(database, migrations, DROP_REMOVED_FEATURE_STORAGE_MIGRATION,
    dropRemovedFeatureStorageFixtureSql, dropRemovedFeatureStorageProofSql, dropRemovedFeatureStorageProofSql);
}

function main(database: string, shadowDatabase: string): void {
  const migrations = committedMigrations();

  for (const target of [database, shadowDatabase]) {
    dropDatabase(target);
    createDatabase(target);
  }

  app(database, ["npx", "prisma", "generate"]);
  deployAndVerify(database, migrations, shadowDatabase);
  runUnreleasedAdoptionProofs(shadowDatabase, migrations);
  runBootstrapProof(database);
  runSeedProof(database);

  process.stdout.write(
    `AIQSA migration smoke ok: baseline_sha256=${BASELINE_SHA256} schema_datamodel_diff_sha256=${EXPECTED_SCHEMA_DATAMODEL_DIFF_SHA256} migrations=${migrations.length}: ordered and repeated deploy, status, reviewed SQL-only schema delta, unreleased adoptions (${MEMORY_NOTE_ADOPTION_MIGRATION}, ${DROP_OLD_MEMORY_MIGRATION}, ${DROP_REMOVED_FEATURE_STORAGE_MIGRATION}), fresh/adopted bootstrap, seed and integrity.\n`,
  );
}

const modeError = migrationModeError(process.argv.slice(2));
if (modeError) {
  process.stderr.write(`${modeError}\n`);
  process.exit(2);
}

const smokeDatabase = databaseName("smoke");
const shadowDatabase = databaseName("shadow");

try {
  main(smokeDatabase, shadowDatabase);
} finally {
  for (const database of [smokeDatabase, shadowDatabase]) {
    try {
      dropDatabase(database);
    } catch (error) {
      process.stderr.write(
        `migration contract cleanup failed for ${database}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
