import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLEANUP_MIGRATION = "20260806210000_prompt_preset_stock_cleanup";
const ASSISTANTS_MIGRATION = "20260806211000_reusable_assistants_v1";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const STOCK_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const database = `aiqsa_assistants_contract_${process.pid}_${Date.now()}`;
let databaseCreated = false;

type CommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input,
      maxBuffer: 16 * 1024 * 1024
    }
  );

  if (result.error) {
    throw result.error;
  }

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

function scalar(sql: string): string {
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
    "read reusable-assistants migration contract state"
  );
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function dropDatabase(): void {
  if (!databaseCreated) {
    return;
  }

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
    "drop reusable-assistants migration contract database"
  );
  databaseCreated = false;
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect development PostgreSQL service"
    ),
    POSTGRES_SERVICE
  );
  requireSuccess(
    compose([
      "exec",
      "-T",
      POSTGRES_SERVICE,
      "createdb",
      "--username",
      POSTGRES_USER,
      database
    ]),
    "create reusable-assistants migration contract database"
  );
  databaseCreated = true;

  const preTargetMigrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < CLEANUP_MIGRATION)
    .map((entry) => entry.name)
    .sort();

  for (const migration of preTargetMigrations) {
    requireSuccess(psql(migrationSql(migration)), `apply pre-target migration ${migration}`);
  }

  requireSuccess(
    psql(`
      INSERT INTO "User" ("id", "email", "displayName", "role", "status", "updatedAt")
      VALUES
        ('user-a', 'a@contract.test', 'Owner A', 'admin', 'active', CURRENT_TIMESTAMP),
        ('user-b', 'b@contract.test', 'Owner B', 'user', 'active', CURRENT_TIMESTAMP);
      INSERT INTO "PromptPreset" ("id", "userId", "name", "systemPrompt", "developerPrompt", "isDefault", "updatedAt")
      VALUES ('prompt-a', 'user-a', 'Helpful Assistant', '${STOCK_SYSTEM_PROMPT}', NULL, true, CURRENT_TIMESTAMP);
      INSERT INTO "UserSettings" ("id", "userId", "defaultPromptPresetId", "updatedAt")
      VALUES ('settings-a', 'user-a', 'prompt-a', CURRENT_TIMESTAMP);
      INSERT INTO "Chat" ("id", "userId", "title", "defaultPromptPresetId", "updatedAt")
      VALUES ('chat-a', 'user-a', 'Contract chat', 'prompt-a', CURRENT_TIMESTAMP);
      INSERT INTO "Message" ("id", "chatId", "role", "content", "promptPresetId", "updatedAt")
      VALUES ('message-a', 'chat-a', 'user', '{"blocks":[]}', 'prompt-a', CURRENT_TIMESTAMP);
    `),
    "seed pre-cleanup fixture data"
  );

  // Fail-closed preflight: an unexpected non-stock row aborts without mutation.
  requireSuccess(
    psql(`
      INSERT INTO "PromptPreset" ("id", "userId", "name", "systemPrompt", "developerPrompt", "isDefault", "updatedAt")
      VALUES ('prompt-custom', 'user-b', 'My custom prompt', 'Custom text', NULL, true, CURRENT_TIMESTAMP);
    `),
    "seed unexpected custom prompt preset"
  );
  const blockedByCustom = psql(migrationSql(CLEANUP_MIGRATION));
  assert.notEqual(blockedByCustom.status, 0, "cleanup unexpectedly accepted a custom preset");
  assert.match(
    `${blockedByCustom.stdout}\n${blockedByCustom.stderr}`,
    /prompt_preset_stock_cleanup_blocked/
  );
  assert.equal(
    scalar(`
      SELECT concat_ws('|',
        (SELECT count(*) FROM "PromptPreset"),
        (SELECT count(*) FROM "UserSettings" WHERE "defaultPromptPresetId" IS NOT NULL),
        (SELECT count(*) FROM "Chat" WHERE "defaultPromptPresetId" IS NOT NULL),
        (SELECT count(*) FROM "Message" WHERE "promptPresetId" IS NOT NULL)
      );
    `),
    "2|1|1|1",
    "blocked cleanup must not delete or mutate any row"
  );

  // Fail-closed preflight: more than one preset per owner also aborts, before
  // the per-row signature check reports anything.
  requireSuccess(
    psql(`
      UPDATE "PromptPreset"
      SET "userId" = 'user-a', "isDefault" = false
      WHERE "id" = 'prompt-custom';
    `),
    "move the unexpected preset onto an owner that already holds the stock row"
  );
  const blockedByDuplicate = psql(migrationSql(CLEANUP_MIGRATION));
  assert.notEqual(blockedByDuplicate.status, 0, "cleanup unexpectedly accepted a multi-preset owner");
  assert.match(
    `${blockedByDuplicate.stdout}\n${blockedByDuplicate.stderr}`,
    /prompt_preset_stock_cleanup_blocked/
  );

  requireSuccess(
    psql(`DELETE FROM "PromptPreset" WHERE "id" = 'prompt-custom';`),
    "remove the unexpected preset after operator investigation"
  );

  requireSuccess(psql(migrationSql(CLEANUP_MIGRATION)), "apply prompt preset stock cleanup");
  assert.equal(
    scalar(`
      SELECT concat_ws('|',
        (SELECT count(*) FROM "PromptPreset"),
        (SELECT count(*) FROM "UserSettings" WHERE "defaultPromptPresetId" IS NOT NULL),
        (SELECT count(*) FROM "Chat" WHERE "defaultPromptPresetId" IS NOT NULL),
        (SELECT count(*) FROM "Message" WHERE "promptPresetId" IS NOT NULL),
        (SELECT count(*) FROM "Message"),
        (SELECT count(*) FROM "Chat")
      );
    `),
    "0|0|0|0|1|1",
    "cleanup must remove stock rows and clear references without touching chats/messages"
  );

  requireSuccess(psql(migrationSql(CLEANUP_MIGRATION)), "re-apply cleanup idempotently");

  requireSuccess(psql(migrationSql(ASSISTANTS_MIGRATION)), "apply reusable assistants v1 migration");
  assert.equal(
    scalar(`
      SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('PromptPreset', 'RunProfile')),
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name = 'Message' AND column_name = 'promptPresetId')
              OR (table_name = 'Chat' AND column_name = 'defaultPromptPresetId')
              OR (table_name = 'UserSettings' AND column_name = 'defaultPromptPresetId')
            )),
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('AssistantDefinition', 'AssistantRevision', 'AssistantPublication', 'AssistantPin')),
        (SELECT count(*) FROM pg_constraint WHERE conname = 'AssistantPublication_scope_group_check'),
        (SELECT count(*) FROM pg_constraint WHERE conname = 'ModelRun_assistant_pair_check'),
        (SELECT count(*) FROM pg_indexes WHERE indexname = 'AssistantPublication_installation_key'),
        (SELECT count(*) FROM pg_constraint WHERE conname = 'AssistantRevision_providerModelId_fkey'),
        (SELECT count(*) FROM pg_constraint WHERE conname = 'ModelRun_assistantRevision_fkey')
      );
    `),
    "0|0|4|1|1|1|1|1"
  );

  requireSuccess(
    psql(`
      INSERT INTO "ProviderConnection" ("id", "displayName", "family", "updatedAt")
      VALUES ('connection-contract', 'Contract provider', 'fake', CURRENT_TIMESTAMP);
      INSERT INTO "ProviderModel" (
        "id", "connectionId", "provider", "modelId", "displayName", "contextWindow",
        "capabilities", "defaultParams", "updatedAt"
      )
      VALUES (
        'model-contract', 'connection-contract', 'fake', 'contract-model', 'Contract model',
        128000, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP
      );
      INSERT INTO "AssistantDefinition" ("id", "ownerUserId", "updatedAt")
      VALUES ('assistant-a', 'user-a', CURRENT_TIMESTAMP);
      INSERT INTO "AssistantRevision" (
        "id", "assistantId", "revisionNumber", "name", "avatar", "providerModelId",
        "systemPrompt", "searchPlan"
      )
      VALUES (
        'revision-a', 'assistant-a', 1, 'Contract Assistant',
        '{"kind":"generated"}'::jsonb, 'model-contract', 'Prompt',
        '{"mode":"all_selected","optionIds":[]}'::jsonb
      );
      UPDATE "AssistantDefinition" SET "currentRevisionId" = 'revision-a' WHERE "id" = 'assistant-a';
      INSERT INTO "Group" ("id", "name", "updatedAt")
      VALUES ('group-a', 'Contract group', CURRENT_TIMESTAMP);
      INSERT INTO "AssistantPublication" ("id", "assistantId", "revisionId", "scope", "groupId", "updatedAt")
      VALUES
        ('publication-group', 'assistant-a', 'revision-a', 'group', 'group-a', CURRENT_TIMESTAMP),
        ('publication-install', 'assistant-a', 'revision-a', 'installation', NULL, CURRENT_TIMESTAMP);
    `),
    "insert assistant aggregate fixtures"
  );

  const invalidScope = psql(`
    INSERT INTO "AssistantPublication" ("id", "assistantId", "revisionId", "scope", "groupId", "updatedAt")
    VALUES ('publication-bad', 'assistant-a', 'revision-a', 'installation', 'group-a', CURRENT_TIMESTAMP);
  `);
  assert.notEqual(invalidScope.status, 0, "installation publication with a group unexpectedly accepted");
  assert.match(`${invalidScope.stdout}\n${invalidScope.stderr}`, /AssistantPublication_scope_group_check/);

  const duplicateInstallation = psql(`
    INSERT INTO "AssistantPublication" ("id", "assistantId", "revisionId", "scope", "groupId", "updatedAt")
    VALUES ('publication-dup', 'assistant-a', 'revision-a', 'installation', NULL, CURRENT_TIMESTAMP);
  `);
  assert.notEqual(duplicateInstallation.status, 0, "second installation publication unexpectedly accepted");
  assert.match(
    `${duplicateInstallation.stdout}\n${duplicateInstallation.stderr}`,
    /AssistantPublication_installation_key/
  );

  const halfPair = psql(`
    INSERT INTO "ModelRun" (
      "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
      "normalizedRequest", "assistantId", "updatedAt"
    )
    VALUES (
      'run-bad', 'chat-a', 'user-a', 'message-a', 'fake', 'fake-model', 'complete',
      '{}'::jsonb, 'assistant-a', CURRENT_TIMESTAMP
    );
  `);
  assert.notEqual(halfPair.status, 0, "half-populated assistant provenance unexpectedly accepted");
  assert.match(`${halfPair.stdout}\n${halfPair.stderr}`, /ModelRun_assistant_pair_check/);

  requireSuccess(
    psql(`
      INSERT INTO "ModelRun" (
        "id", "chatId", "userId", "userMessageId", "provider", "modelId", "status",
        "normalizedRequest", "assistantId", "assistantRevisionId", "updatedAt"
      )
      VALUES (
        'run-good', 'chat-a', 'user-a', 'message-a', 'fake', 'fake-model', 'complete',
        '{}'::jsonb, 'assistant-a', 'revision-a', CURRENT_TIMESTAMP
      );
    `),
    "insert complete assistant run provenance"
  );

  const strandedModel = psql(`
    DELETE FROM "ProviderModel" WHERE "id" = 'model-contract';
  `);
  assert.notEqual(strandedModel.status, 0, "provider-model deletion unexpectedly stranded an assistant revision");
  assert.match(`${strandedModel.stdout}\n${strandedModel.stderr}`, /AssistantRevision_providerModelId_fkey/);

  process.stdout.write(
    "AIQSA reusable-assistants migration contract ok: fail-closed stock cleanup, idempotent re-run, contract drops, assistant aggregate constraints, run provenance integrity, and the provider-model deletion guard hold.\n"
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.exitCode = 1;
} finally {
  try {
    dropDatabase();
  } catch (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    process.stderr.write(`reusable-assistants migration contract cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
