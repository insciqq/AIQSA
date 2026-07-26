import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MIGRATION = "20260726150000_full_access_system_group";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const runId = `${process.pid}_${Date.now()}`;
const templateDatabase = `aiqsa_full_access_template_${runId}`;
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
    "read Full access migration contract state"
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

  assert(migrations.length > 0, "expected migrations before Full access group");
  for (const migration of migrations) {
    requireSuccess(psql(database, migrationSql(migration)), `apply pre-target migration ${migration}`);
  }
}

function insertAdmin(database: string, input: Readonly<{ createdAt: string; id: string; status: string }>): void {
  requireSuccess(
    psql(database, `
      INSERT INTO "User" (
        "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
      ) VALUES (
        '${input.id}', '${input.id}@example.test', '${input.id}', 'admin', '${input.status}',
        '${input.createdAt}'::timestamptz, CURRENT_TIMESTAMP
      );
    `),
    `insert administrator ${input.id}`
  );
}

function insertMcpServer(database: string, id: string, namespace: string): void {
  requireSuccess(
    psql(database, `
      INSERT INTO "McpServer" ("id", "namespace", "displayName", "updatedAt")
      VALUES ('${id}', '${namespace}', '${namespace}', CURRENT_TIMESTAMP);
    `),
    `insert MCP server ${id}`
  );
}

function expectProtected(database: string, label: string, sql: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly mutated the built-in group`);
  assert.match(`${result.stdout}\n${result.stderr}`, /built-in group/);
}

function expectIdentityConstraint(database: string, label: string, sql: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly accepted an invalid group identity`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Group_full_access_identity_check/);
}

function expectPromotionRejection(database: string, sql: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, "ordinary group promotion unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, /cannot be promoted/);
}

function runEmptyDatabaseCase(): void {
  const database = `aiqsa_full_access_empty_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "migrate empty database");
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT count(*) FROM "Group"),
          (SELECT count(*) FROM pg_trigger WHERE tgname IN (
            'aiqsa_protect_full_access_group',
            'aiqsa_grant_full_access_to_new_mcp_server'
          )),
          (SELECT count(*) FROM pg_indexes WHERE indexname = 'Group_systemRole_key')
        );
      `),
      "0|2|1",
      "an empty migrated database must stay empty for installation bootstrap"
    );
    expectIdentityConstraint(
      database,
      "invalid system insert",
      `INSERT INTO "Group" ("id", "name", "systemRole", "updatedAt") VALUES ('invalid-system-group', 'Wrong name', 'full_access', CURRENT_TIMESTAMP);`
    );
    expectIdentityConstraint(
      database,
      "reserved ordinary name",
      `INSERT INTO "Group" ("id", "name", "updatedAt") VALUES ('reserved-ordinary-group', ' FULL ACCESS ', CURRENT_TIMESTAMP);`
    );
    requireSuccess(
      psql(database, `INSERT INTO "Group" ("id", "name", "updatedAt") VALUES ('promotion-source', 'Ordinary group', CURRENT_TIMESTAMP);`),
      "insert ordinary promotion source"
    );
    expectPromotionRejection(
      database,
      `UPDATE "Group" SET "systemRole" = 'full_access', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'promotion-source';`
    );
    expectPromotionRejection(
      database,
      `UPDATE "Group" SET "name" = 'Full access', "systemRole" = 'full_access', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'promotion-source';`
    );
  } finally {
    dropDatabase(database);
  }
}

function runExistingInstallationCase(): void {
  const database = `aiqsa_full_access_existing_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    insertAdmin(database, {
      createdAt: "2026-07-02T00:00:00.000Z",
      id: "later-active-admin",
      status: "active"
    });
    insertAdmin(database, {
      createdAt: "2026-07-01T00:00:00.000Z",
      id: "earliest-disabled-admin",
      status: "disabled"
    });
    requireSuccess(
      psql(database, `
        WITH candidate AS (
          SELECT md5('aiqsa:full-access-system-group:v1:0') AS value
        )
        INSERT INTO "Group" ("id", "name", "updatedAt")
        SELECT
          substr(value, 1, 8) || '-' || substr(value, 9, 4) || '-4' ||
            substr(value, 14, 3) || '-8' || substr(value, 18, 3) || '-' ||
            substr(value, 21, 12),
          'Collision fixture',
          CURRENT_TIMESTAMP
        FROM candidate;
      `),
      "insert deterministic id collision"
    );
    insertMcpServer(database, "existing-mcp", "existing_mcp");
    requireSuccess(
      psql(database, `
        WITH grant_hash AS (
          SELECT md5('aiqsa:full-access-mcp-grant:v1:existing-mcp:0') AS value
        )
        INSERT INTO "McpGrant" (
          "id", "serverId", "userId", "canUse", "personalSlotKeys", "updatedAt"
        )
        SELECT
          substr(value, 1, 8) || '-' || substr(value, 9, 4) || '-4' ||
            substr(value, 14, 3) || '-8' || substr(value, 18, 3) || '-' ||
            substr(value, 21, 12),
          'existing-mcp',
          'later-active-admin',
          true,
          ARRAY[]::TEXT[],
          CURRENT_TIMESTAMP
        FROM grant_hash;
      `),
      "insert deterministic MCP grant id collision"
    );

    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "migrate existing installation");

    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT count(*) FROM "Group" WHERE "systemRole" = 'full_access'),
          (SELECT "name" FROM "Group" WHERE "systemRole" = 'full_access'),
          (SELECT count(*) FROM "UserGroup" AS membership
             JOIN "Group" AS group_row ON group_row."id" = membership."groupId"
            WHERE group_row."systemRole" = 'full_access'
              AND membership."userId" = 'earliest-disabled-admin'
              AND membership."role" = 'owner'),
          (SELECT count(*) FROM "UserGroup" AS membership
             JOIN "Group" AS group_row ON group_row."id" = membership."groupId"
            WHERE group_row."systemRole" = 'full_access'
              AND membership."userId" = 'later-active-admin'),
          (SELECT count(*) FROM "McpGrant" AS grant_row
             JOIN "Group" AS group_row ON group_row."id" = grant_row."groupId"
            WHERE group_row."systemRole" = 'full_access'
              AND grant_row."serverId" = 'existing-mcp'
              AND grant_row."canUse"
              AND cardinality(grant_row."personalSlotKeys") = 0),
          (SELECT count(*) FROM "McpGrant"
            WHERE "serverId" = 'existing-mcp'
              AND "userId" = 'later-active-admin')
        );
      `),
      "1|Full access|1|0|1|1"
    );

    insertMcpServer(database, "future-mcp", "future_mcp");
    assert.equal(
      scalar(database, `
        SELECT count(*)
        FROM "McpGrant" AS grant_row
        JOIN "Group" AS group_row ON group_row."id" = grant_row."groupId"
        WHERE group_row."systemRole" = 'full_access'
          AND grant_row."serverId" = 'future-mcp'
          AND grant_row."canUse"
          AND cardinality(grant_row."personalSlotKeys") = 0;
      `),
      "1",
      "the MCP insert trigger must grant future servers exactly once"
    );

    expectProtected(
      database,
      "rename",
      `UPDATE "Group" SET "name" = 'Renamed', "updatedAt" = CURRENT_TIMESTAMP WHERE "systemRole" = 'full_access';`
    );
    expectProtected(
      database,
      "archive",
      `UPDATE "Group" SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "systemRole" = 'full_access';`
    );
    expectProtected(
      database,
      "delete",
      `DELETE FROM "Group" WHERE "systemRole" = 'full_access';`
    );
    requireSuccess(
      psql(database, `
        INSERT INTO "Group" ("id", "name", "updatedAt")
        VALUES ('ordinary-deletable-group', 'Ordinary deletable group', CURRENT_TIMESTAMP);
        DELETE FROM "Group" WHERE "id" = 'ordinary-deletable-group';
      `),
      "delete an ordinary group through the protection trigger"
    );
    assert.equal(
      scalar(database, `SELECT count(*) FROM "Group" WHERE "id" = 'ordinary-deletable-group';`),
      "0",
      "the lifecycle trigger must not cancel ordinary group deletion"
    );
  } finally {
    dropDatabase(database);
  }
}

function runAtomicRollbackCase(): void {
  const database = `aiqsa_full_access_rollback_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    insertAdmin(database, {
      createdAt: "2026-07-01T00:00:00.000Z",
      id: "rollback-admin",
      status: "active"
    });
    requireSuccess(
      psql(database, `
        CREATE FUNCTION reject_full_access_contract_fixture()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW."name" = 'Full access' THEN
            RAISE EXCEPTION 'contract fixture rejection';
          END IF;
          RETURN NEW;
        END;
        $$;

        CREATE TRIGGER reject_full_access_contract_fixture
        BEFORE INSERT ON "Group"
        FOR EACH ROW
        EXECUTE FUNCTION reject_full_access_contract_fixture();
      `),
      "install atomic rollback failure fixture"
    );

    const result = psql(database, migrationSql(TARGET_MIGRATION));
    assert.notEqual(result.status, 0, "failure fixture unexpectedly accepted Full access migration");
    assert.match(`${result.stdout}\n${result.stderr}`, /contract fixture rejection/);
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT count(*) FROM pg_type WHERE typname = 'GroupSystemRole'),
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'Group' AND column_name = 'systemRole'),
          (SELECT count(*) FROM pg_proc WHERE proname IN (
            'aiqsa_full_access_mcp_grant_id',
            'aiqsa_protect_full_access_group',
            'aiqsa_grant_full_access_to_new_mcp_server'
          ))
        );
      `),
      "0|0|0",
      "a failed migration must roll back its enum, column, and functions atomically"
    );
  } finally {
    dropDatabase(database);
  }
}

function runNamedGroupIsolationCase(): void {
  const database = `aiqsa_full_access_adopt_${runId}`;
  createDatabase(database, templateDatabase);
  try {
    insertAdmin(database, {
      createdAt: "2026-07-01T00:00:00.000Z",
      id: "adoption-admin",
      status: "active"
    });
    requireSuccess(
      psql(database, `
        INSERT INTO "User" (
          "id", "email", "displayName", "role", "status", "createdAt", "updatedAt"
        ) VALUES (
          'existing-custom-member', 'custom-member@example.test', 'Custom member', 'user', 'active',
          '2026-07-02T00:00:00.000Z'::timestamptz, CURRENT_TIMESTAMP
        );

        INSERT INTO "Group" ("id", "name", "updatedAt")
        VALUES ('existing-custom-suffix', 'Full access (custom)', CURRENT_TIMESTAMP);

        INSERT INTO "Group" ("id", "name", "archivedAt", "createdAt", "updatedAt")
        VALUES (
          'existing-full-access-name', 'Full access', CURRENT_TIMESTAMP,
          '2026-07-02T00:00:00.000Z', CURRENT_TIMESTAMP
        );

        INSERT INTO "Group" ("id", "name", "createdAt", "updatedAt") VALUES
          ('reserved-variant-one', ' full ACCESS ', '2026-07-03T00:00:00.000Z', CURRENT_TIMESTAMP),
          ('reserved-variant-two', 'FULL ACCESS', '2026-07-04T00:00:00.000Z', CURRENT_TIMESTAMP);

        INSERT INTO "UserGroup" ("userId", "groupId", "role")
        VALUES ('existing-custom-member', 'existing-full-access-name', 'member');
      `),
      "insert same-name custom group and member"
    );
    insertMcpServer(database, "adoption-mcp", "adoption_mcp");
    requireSuccess(
      psql(database, `
        INSERT INTO "McpGrant" (
          "id", "serverId", "groupId", "canUse", "personalSlotKeys", "updatedAt"
        ) VALUES (
          'existing-custom-mcp-grant', 'adoption-mcp', 'existing-full-access-name', true,
          ARRAY[]::TEXT[], CURRENT_TIMESTAMP
        );
      `),
      "insert same-name custom group MCP grant"
    );

    requireSuccess(psql(database, migrationSql(TARGET_MIGRATION)), "migrate same-name group safely");
    assert.equal(
      scalar(database, `
        SELECT concat_ws('|',
          (SELECT ("id" <> 'existing-full-access-name')::text FROM "Group" WHERE "systemRole" = 'full_access'),
          (SELECT ("archivedAt" IS NULL)::text FROM "Group" WHERE "systemRole" = 'full_access'),
          (SELECT count(*) FROM "Group" WHERE "name" = 'Full access'),
          (SELECT "name" FROM "Group" WHERE "id" = 'existing-full-access-name'),
          (SELECT "name" FROM "Group" WHERE "id" = 'reserved-variant-one'),
          (SELECT "name" FROM "Group" WHERE "id" = 'reserved-variant-two'),
          (SELECT count(*) FROM "Group" WHERE "systemRole" IS NULL AND lower(btrim("name")) = 'full access'),
          (SELECT ("archivedAt" IS NOT NULL)::text FROM "Group" WHERE "id" = 'existing-full-access-name'),
          (SELECT count(*) FROM "UserGroup" WHERE "groupId" = 'existing-full-access-name' AND "userId" = 'existing-custom-member'),
          (SELECT count(*) FROM "UserGroup" AS membership
             JOIN "Group" AS group_row ON group_row."id" = membership."groupId"
            WHERE group_row."systemRole" = 'full_access' AND membership."userId" = 'existing-custom-member'),
          (SELECT count(*) FROM "UserGroup" AS membership
             JOIN "Group" AS group_row ON group_row."id" = membership."groupId"
            WHERE group_row."systemRole" = 'full_access'
              AND membership."userId" = 'adoption-admin'
              AND membership."role" = 'owner'),
          (SELECT count(*) FROM "McpGrant" WHERE "serverId" = 'adoption-mcp'),
          (SELECT count(*) FROM "McpGrant" WHERE "id" = 'existing-custom-mcp-grant' AND "groupId" = 'existing-full-access-name')
        );
      `),
      "true|true|1|Full access (custom 2)|Full access (custom 3)|Full access (custom 4)|0|true|1|0|1|2|1",
      "the exact-name custom group must be losslessly isolated from the new system group"
    );
  } finally {
    dropDatabase(database);
  }
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect Compose PostgreSQL service"
    ),
    POSTGRES_SERVICE
  );

  createDatabase(templateDatabase);
  try {
    applyPreTargetMigrations(templateDatabase);
    runEmptyDatabaseCase();
    runExistingInstallationCase();
    runAtomicRollbackCase();
    runNamedGroupIsolationCase();
    process.stdout.write(
      "AIQSA Full access migration contract ok: atomic rollback, empty bootstrap handoff, safe name-collision isolation, earliest-admin membership, identity constraints, MCP backfill/future grants, collision handling, and lifecycle protection verified.\n"
    );
  } finally {
    for (const database of [...disposableDatabases].reverse()) {
      dropDatabase(database);
    }
  }
}

main();
