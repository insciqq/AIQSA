import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
  OPENAI_PROVIDER_SEARCH_STRATEGY_ID
} from "../../../domain/search";
import { createPrismaCatalogDataLoader } from "../../catalog/prismaCatalogData";
import { loadEntitlementsForUser } from "../../auth/dbEntitlements";
import { resolveEntitlements } from "../../auth/entitlements";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { createPrismaAdminProviderQuickSetupRepository } from "./quickSetupPrismaRepository";
import type { AdminProviderQuickSetupCommitPlan } from "./quickSetupRepositoryContract";
import { searchDraftHash } from "../../search/configuration";

const enabled = process.env.AIQSA_PROVIDER_QUICK_SETUP_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const administrationDatabase = new PrismaClient();
let database: PrismaClient;
let sharedIntegrationDatabase: Awaited<ReturnType<typeof createIsolatedQuickSetupDatabase>> | null = null;
const policy = adminProviderQuickSetupPolicy("openai");
const terra = policy.candidates[0];
const luna = policy.candidates[1];
const sol = policy.candidates[2];
const OPENAI_SEARCH_OPTION_ID = "openai-native-web-search";

class RollbackFixture extends Error {}
class InjectedBoundaryFailure extends Error {}

const INITIAL_WRITE_BOUNDARIES = [
  "providerConnection.update#1",
  "providerModel.update#1",
  "providerCredential.create#1",
  "providerCredentialVersion.create#1",
  "providerCredential.update#1",
  "providerUserCredentialAssignment.upsert#1",
  "providerModelCredentialCheck.create#1",
  "accessGrant.create#1",
  "userSettings.update#1",
  "runProfile.update#1"
] as const;

const REPLACEMENT_WRITE_BOUNDARIES = [
  "providerCredentialVersion.create#1",
  "providerCredential.update#1",
  "providerUserCredentialAssignment.upsert#1",
  "providerModelCredentialCheck.create#1"
] as const;

const WRITE_DELEGATES = new Set([
  "accessGrant",
  "providerConnection",
  "providerCredential",
  "providerCredentialVersion",
  "providerDraftCheck",
  "providerModel",
  "providerModelCredentialCheck",
  "providerUserCredentialAssignment",
  "runProfile",
  "searchIntegrationRevision",
  "searchStrategy",
  "userSettings"
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "upsert"
]);

let savepointSequence = 0;

function nextSavepoint(): string {
  savepointSequence += 1;
  return `quick_setup_integration_${savepointSequence}`;
}

async function beginSavepoint(
  transaction: Prisma.TransactionClient,
  savepoint: string
): Promise<void> {
  await transaction.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
}

async function releaseSavepoint(
  transaction: Prisma.TransactionClient,
  savepoint: string
): Promise<void> {
  await transaction.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
}

async function rollbackSavepoint(
  transaction: Prisma.TransactionClient,
  savepoint: string
): Promise<void> {
  await transaction.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await releaseSavepoint(transaction, savepoint);
}

function transactionBackedClient(
  transaction: Prisma.TransactionClient,
  transactionView: Prisma.TransactionClient = transaction
): PrismaClientType {
  return new Proxy(transaction as unknown as PrismaClientType, {
    get(target, property) {
      if (property === "$transaction") {
        return async (operation: (tx: Prisma.TransactionClient) => unknown) => {
          const savepoint = nextSavepoint();
          await beginSavepoint(transaction, savepoint);
          try {
            const result = await operation(transactionView);
            await releaseSavepoint(transaction, savepoint);
            return result;
          } catch (error) {
            await rollbackSavepoint(transaction, savepoint);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function instrumentWrites(
  transaction: Prisma.TransactionClient,
  input: Readonly<{
    failAfter?: string;
    trace: string[];
  }>
): Prisma.TransactionClient {
  const occurrences = new Map<string, number>();
  const delegates = new Map<PropertyKey, unknown>();
  return new Proxy(transaction, {
    get(target, property) {
      if (WRITE_DELEGATES.has(String(property))) {
        const cached = delegates.get(property);
        if (cached) return cached;
        const delegate = Reflect.get(target, property, target) as object;
        const wrapped = new Proxy(delegate, {
          get(delegateTarget, method) {
            const value = Reflect.get(delegateTarget, method, delegateTarget);
            if (typeof value !== "function") return value;
            if (!WRITE_METHODS.has(String(method))) return value.bind(delegateTarget);
            return async (...args: unknown[]) => {
              const result = await value.apply(delegateTarget, args);
              const operation = `${String(property)}.${String(method)}`;
              const occurrence = (occurrences.get(operation) ?? 0) + 1;
              occurrences.set(operation, occurrence);
              const boundary = `${operation}#${occurrence}`;
              input.trace.push(boundary);
              if (input.failAfter === boundary) {
                throw new InjectedBoundaryFailure(boundary);
              }
              return result;
            };
          }
        });
        delegates.set(property, wrapped);
        return wrapped;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function forceCatalogUnavailable(
  transaction: Prisma.TransactionClient,
  onRead: () => void
): Prisma.TransactionClient {
  const providerModel = new Proxy(transaction.providerModel, {
    get(target, property) {
      if (property === "findMany") {
        return async () => {
          onRead();
          return [];
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(transaction, {
    get(target, property) {
      if (property === "providerModel") return providerModel;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function groupGraphSnapshot(transaction: Prisma.TransactionClient) {
  const [groups, userGroups, credentialAssignments, accessGrants] = await Promise.all([
    transaction.group.findMany({ orderBy: { id: "asc" } }),
    transaction.userGroup.findMany({ orderBy: [{ groupId: "asc" }, { userId: "asc" }] }),
    transaction.providerGroupCredentialAssignment.findMany({
      orderBy: [{ connectionId: "asc" }, { groupId: "asc" }]
    }),
    transaction.accessGrant.findMany({
      orderBy: { id: "asc" },
      where: { groupId: { not: null } }
    })
  ]);
  return { accessGrants, credentialAssignments, groups, userGroups };
}

async function quickGraphSnapshot(
  transaction: Prisma.TransactionClient,
  userId: string
) {
  const modelIds = policy.candidates.map((candidate) => candidate.modelId);
  const [
    connections,
    models,
    credentials,
    credentialVersions,
    activeChecks,
    draftChecks,
    credentialAssignments,
    accessGrants,
    settings,
    profiles,
    groups
  ] = await Promise.all([
    transaction.providerConnection.findMany({
      orderBy: { id: "asc" },
      where: {
        OR: [
          { family: policy.provider },
          { id: policy.connection.id },
          { templateKey: policy.connection.templateKey }
        ]
      }
    }),
    transaction.providerModel.findMany({
      orderBy: { id: "asc" },
      where: {
        OR: [
          { connection: { family: policy.provider } },
          { id: { in: modelIds } }
        ]
      }
    }),
    transaction.providerCredential.findMany({
      orderBy: { id: "asc" },
      where: { connection: { family: policy.provider } }
    }),
    transaction.providerCredentialVersion.findMany({
      orderBy: [{ credentialId: "asc" }, { version: "asc" }, { id: "asc" }],
      where: { credential: { connection: { family: policy.provider } } }
    }),
    transaction.providerModelCredentialCheck.findMany({
      orderBy: { id: "asc" },
      where: { connectionId: policy.connection.id }
    }),
    transaction.providerDraftCheck.findMany({
      orderBy: { id: "asc" },
      where: { connectionId: policy.connection.id }
    }),
    transaction.providerUserCredentialAssignment.findMany({
      orderBy: [{ connectionId: "asc" }, { userId: "asc" }],
      where: { connectionId: policy.connection.id }
    }),
    transaction.accessGrant.findMany({
      orderBy: { id: "asc" },
      where: {
        OR: [
          { providerConnection: { family: policy.provider } },
          { providerModel: { connection: { family: policy.provider } } }
        ]
      }
    }),
    transaction.userSettings.findUnique({ where: { userId } }),
    transaction.runProfile.findMany({ orderBy: { id: "asc" } }),
    groupGraphSnapshot(transaction)
  ]);
  return {
    accessGrants,
    activeChecks,
    connections,
    credentialAssignments,
    credentialVersions,
    credentials,
    draftChecks,
    groups,
    models,
    profiles,
    settings
  };
}

async function commitTraceRolledBack(
  transaction: Prisma.TransactionClient,
  commitPlan: AdminProviderQuickSetupCommitPlan
): Promise<string[]> {
  const trace: string[] = [];
  const savepoint = nextSavepoint();
  await beginSavepoint(transaction, savepoint);
  try {
    const repository = createPrismaAdminProviderQuickSetupRepository(
      transactionBackedClient(transaction, instrumentWrites(transaction, { trace }))
    );
    await expect(repository.commit(commitPlan)).resolves.toMatchObject({ status: "ready" });
  } finally {
    await rollbackSavepoint(transaction, savepoint);
  }
  return trace;
}

async function resetOpenAiToInitial(transaction: Prisma.TransactionClient): Promise<void> {
  const modelIds = policy.candidates.map((candidate) => candidate.modelId);
  const managedSearch = await transaction.searchStrategy.findUnique({
    where: { strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID }
  });
  await transaction.accessGrant.deleteMany({
    where: { searchStrategy: OPENAI_SEARCH_OPTION_ID }
  });
  if (managedSearch) {
    await transaction.searchStrategy.update({
      data: { activeRevisionId: null },
      where: { id: managedSearch.id }
    });
    await transaction.searchIntegrationRevision.deleteMany({
      where: { searchStrategyId: managedSearch.id }
    });
    await transaction.searchStrategy.delete({ where: { id: managedSearch.id } });
  }
  await transaction.userSettings.updateMany({
    data: { defaultProviderModelId: null },
    where: { defaultProviderModelId: { in: modelIds } }
  });
  await transaction.providerRunBinding.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  await transaction.providerDraftCheck.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  await transaction.providerModelCredentialCheck.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  await transaction.providerGroupCredentialAssignment.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  await transaction.providerUserCredentialAssignment.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  await transaction.accessGrant.deleteMany({
    where: {
      OR: [
        { providerConnectionId: policy.connection.id },
        { providerModelId: { in: modelIds } }
      ]
    }
  });
  await transaction.providerConnection.update({
    data: { defaultCredentialId: null },
    where: { id: policy.connection.id }
  });
  await transaction.providerCredential.updateMany({
    data: { activeVersionId: null },
    where: { connectionId: policy.connection.id }
  });
  await transaction.providerCredentialVersion.deleteMany({
    where: { credential: { connectionId: policy.connection.id } }
  });
  await transaction.providerCredential.deleteMany({
    where: { connectionId: policy.connection.id }
  });
  for (const candidate of policy.candidates) {
    await transaction.providerModel.update({
      data: {
        activeConfig: Prisma.DbNull,
        activeVersion: 0,
        activatedAt: null,
        draftConfig: candidate.configuration as Prisma.InputJsonValue,
        draftVersion: 1,
        enabled: false
      },
      where: { id: candidate.modelId }
    });
  }
  await transaction.providerConnection.update({
    data: {
      activeConfig: Prisma.DbNull,
      activeVersion: 0,
      activatedAt: null,
      defaultCredentialId: null,
      draftConfig: policy.connection.configuration as Prisma.InputJsonValue,
      draftVersion: 1,
      enabled: false,
      unassignedPolicy: "use_default"
    },
    where: { id: policy.connection.id }
  });
}

async function createActor(transaction: Prisma.TransactionClient, suffix: string) {
  const userId = `quick-setup-integration-user-${suffix}`;
  const sessionId = `quick-setup-integration-session-${suffix}`;
  await transaction.user.create({
    data: {
      displayName: "Quick setup integration administrator",
      id: userId,
      role: "admin",
      settings: { create: { defaultControlValues: {}, defaultProviderModelId: null } },
      status: "active"
    }
  });
  await transaction.authSession.create({
    data: {
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      id: sessionId,
      tokenHash: `quick-setup-integration-token-${suffix}`,
      userId
    }
  });
  return { sessionId, userId };
}

function plan(input: Readonly<{
  actor: Readonly<{ sessionId: string; userId: string }>;
  candidates?: AdminProviderQuickSetupCommitPlan["candidates"];
  credentialId: string;
  credentialIsNew?: boolean;
  credentialVersion: number;
  expectedFingerprint: string;
  grantId: string;
  mode: "initial" | "recovery" | "replacement";
  preservedModels: AdminProviderQuickSetupCommitPlan["preservedModels"];
  search?: Readonly<{
    idPrefix: string;
  }>;
  versionId: string;
}>): AdminProviderQuickSetupCommitPlan {
  const candidates = input.candidates ?? [terra];
  const searchDraft = {
    adapterKind: "provider_model_client" as const,
    credentialMode: "provider_model" as const,
    maxResults: 8,
    protocol: "openai_responses_web_search" as const,
    providerModelId: terra.modelId,
    queryMaxCharacters: 500,
    timeoutMs: 300_000
  };
  return {
    actor: input.actor,
    candidate: terra,
    candidates,
    checkedAt: new Date("2026-07-26T10:00:01.000Z"),
    credential: {
      draftVersion: input.credentialVersion,
      id: input.credentialId,
      isNew: input.credentialIsNew ?? input.mode === "initial",
      versionEnvelope: `v2.integration.${input.credentialVersion}`,
      versionId: input.versionId
    },
    expectedFingerprint: input.expectedFingerprint,
    grants: candidates.map((candidate, index) => ({
      id: index === 0 ? input.grantId : `${input.grantId}-${index + 1}`,
      modelId: candidate.modelId
    })),
    mode: input.mode,
    now: new Date("2026-07-26T10:00:02.000Z"),
    preservedModels: input.preservedModels,
    provider: "openai",
    ...(input.search ? {
      search: {
        draft: searchDraft,
        draftHash: searchDraftHash(searchDraft),
        evidence: {
          checkedAt: "2026-07-26T10:00:01.500Z",
          method: "configuration" as const,
          normalizedSourceCount: 0,
          protocol: "openai_responses_web_search" as const,
          status: "available" as const
        },
        grantId: `${input.search.idPrefix}-grant`,
        integrationId: OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
        revisionId: `${input.search.idPrefix}-revision`
      }
    } : {})
  };
}

const ISOLATED_TABLES = [
  "AccessGrant",
  "AuthSession",
  "Group",
  "ProviderConnection",
  "ProviderCredential",
  "ProviderCredentialVersion",
  "ProviderDraftCheck",
  "ProviderGroupCredentialAssignment",
  "ProviderUserCredentialAssignment",
  "ProviderModel",
  "ProviderModelCredentialCheck",
  "ProviderRunBinding",
  "PromptPreset",
  "RunProfile",
  "SearchIntegrationRevision",
  "SearchOption",
  "SearchPolicy",
  "SearchStrategy",
  "User",
  "UserGroup",
  "UserSettings"
] as const;

function quotedIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("quick_setup_integration_schema_invalid");
  }
  return `"${value}"`;
}

async function createIsolatedQuickSetupDatabase(): Promise<Readonly<{
  cleanup(): Promise<void>;
  client: PrismaClient;
}>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("quick_setup_integration_database_url_missing");
  const parsedUrl = new URL(databaseUrl);
  const sourceSchemaName = parsedUrl.searchParams.get("schema") ?? "public";
  const schemaName = `quick_setup_${randomUUID().replaceAll("-", "")}`;
  const sourceSchema = quotedIdentifier(sourceSchemaName);
  const schema = quotedIdentifier(schemaName);
  let client: PrismaClient | null = null;
  let cleaned = false;

  await administrationDatabase.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
  try {
    for (const table of ISOLATED_TABLES) {
      await administrationDatabase.$executeRawUnsafe(
        `CREATE TABLE ${schema}."${table}" ` +
        `(LIKE ${sourceSchema}."${table}" INCLUDING ALL)`
      );
    }
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."ProviderConnection" ` +
      `SELECT * FROM ${sourceSchema}."ProviderConnection" WHERE "id" = $1`,
      policy.connection.id
    );
    const modelPlaceholders = policy.candidates.map((_, index) => `$${index + 2}`).join(", ");
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."ProviderModel" ` +
      `SELECT * FROM ${sourceSchema}."ProviderModel" ` +
      `WHERE "connectionId" = $1 AND "id" IN (${modelPlaceholders})`,
      policy.connection.id,
      ...policy.candidates.map((candidate) => candidate.modelId)
    );
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."RunProfile" SELECT * FROM ${sourceSchema}."RunProfile"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."SearchOption" SELECT * FROM ${sourceSchema}."SearchOption"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."SearchIntegrationRevision" ` +
      `SELECT * FROM ${sourceSchema}."SearchIntegrationRevision"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."SearchStrategy" SELECT * FROM ${sourceSchema}."SearchStrategy"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `INSERT INTO ${schema}."SearchPolicy" SELECT * FROM ${sourceSchema}."SearchPolicy"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE TYPE ${schema}."UserRole" AS ENUM ('admin', 'user')`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE TYPE ${schema}."UserStatus" AS ENUM ('pending', 'active', 'disabled', 'denied')`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE TYPE ${schema}."ProviderUnassignedPolicy" ` +
      `AS ENUM ('use_default', 'require_assignment')`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE TYPE ${schema}."ProviderCredentialCheckStatus" ` +
      `AS ENUM ('available', 'unavailable')`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE TYPE ${schema}."GroupSystemRole" AS ENUM ('full_access')`
    );
    await administrationDatabase.$executeRawUnsafe(
      `ALTER TABLE ${schema}."Group" DROP CONSTRAINT IF EXISTS "Group_full_access_identity_check"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `DROP INDEX IF EXISTS ${schema}."Group_systemRole_key"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `ALTER TABLE ${schema}."Group" ALTER COLUMN "systemRole" ` +
      `TYPE ${schema}."GroupSystemRole" ` +
      `USING "systemRole"::text::${schema}."GroupSystemRole"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "Group_systemRole_key" ON ${schema}."Group"("systemRole")`
    );
    await administrationDatabase.$executeRawUnsafe(
      `ALTER TABLE ${schema}."Group" ADD CONSTRAINT "Group_full_access_identity_check" ` +
      `CHECK (("systemRole" = 'full_access'::${schema}."GroupSystemRole" ` +
      `AND "name" = 'Full access' AND "archivedAt" IS NULL) ` +
      `OR ("systemRole" IS NULL AND lower(btrim("name")) <> 'full access'))`
    );
    await administrationDatabase.$executeRawUnsafe(
      `ALTER TABLE ${schema}."User" ALTER COLUMN "role" DROP DEFAULT, ` +
      `ALTER COLUMN "role" TYPE ${schema}."UserRole" ` +
      `USING "role"::text::${schema}."UserRole", ` +
      `ALTER COLUMN "role" SET DEFAULT 'user'::${schema}."UserRole", ` +
      `ALTER COLUMN "status" DROP DEFAULT, ` +
      `ALTER COLUMN "status" TYPE ${schema}."UserStatus" ` +
      `USING "status"::text::${schema}."UserStatus", ` +
      `ALTER COLUMN "status" SET DEFAULT 'pending'::${schema}."UserStatus"`
    );
    await administrationDatabase.$executeRawUnsafe(
      `ALTER TABLE ${schema}."ProviderConnection" ` +
      `ALTER COLUMN "unassignedPolicy" DROP DEFAULT, ` +
      `ALTER COLUMN "unassignedPolicy" TYPE ${schema}."ProviderUnassignedPolicy" ` +
      `USING "unassignedPolicy"::text::${schema}."ProviderUnassignedPolicy", ` +
      `ALTER COLUMN "unassignedPolicy" ` +
      `SET DEFAULT 'use_default'::${schema}."ProviderUnassignedPolicy"`
    );
    for (const table of ["ProviderDraftCheck", "ProviderModelCredentialCheck"] as const) {
      await administrationDatabase.$executeRawUnsafe(
        `ALTER TABLE ${schema}."${table}" ALTER COLUMN "status" ` +
        `TYPE ${schema}."ProviderCredentialCheckStatus" ` +
        `USING "status"::text::${schema}."ProviderCredentialCheckStatus"`
      );
    }

    parsedUrl.searchParams.set("schema", schemaName);
    client = new PrismaClient({ datasources: { db: { url: parsedUrl.toString() } } });
    await client.$connect();
    const isolatedClient = client;
    return {
      client: isolatedClient,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await isolatedClient.$disconnect();
        await administrationDatabase.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    };
  } catch (error) {
    await client?.$disconnect();
    await administrationDatabase.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    throw error;
  }
}

integration("Prisma provider Quick setup atomic graph", () => {
  beforeAll(async () => {
    sharedIntegrationDatabase = await createIsolatedQuickSetupDatabase();
    database = sharedIntegrationDatabase.client;
  });

  afterAll(async () => {
    await sharedIntegrationDatabase?.cleanup();
    await administrationDatabase.$disconnect();
  });

  it("atomically provisions and reuses managed OpenAI Search across credential rotation", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        const suffix = randomUUID();
        const actor = await createActor(transaction, suffix);
        const repository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction)
        );
        const initial = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:00.000Z"),
          provider: "openai"
        });
        const credentialId = `quick-search-credential-${suffix}`;

        await expect(repository.commit(plan({
          actor,
          credentialId,
          credentialVersion: 1,
          expectedFingerprint: initial.fingerprint,
          grantId: `quick-search-model-grant-${suffix}`,
          mode: "initial",
          preservedModels: initial.preservedModels,
          search: {
            idPrefix: `quick-search-first-${suffix}`
          },
          versionId: `quick-search-version-one-${suffix}`
        }))).resolves.toMatchObject({
          search: "ready",
          status: "ready"
        });

        const integration = await transaction.searchStrategy.findUniqueOrThrow({
          include: { activeRevision: true, revisions: true },
          where: { strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID }
        });
        expect(integration).toMatchObject({
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          enabled: true,
          kind: "provider_model_web_search",
          providerModelId: terra.modelId
        });
        expect(integration.activeRevision).toMatchObject({
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          providerModelId: terra.modelId
        });
        expect(integration.revisions).toHaveLength(1);
        const firstRevision = integration.activeRevision!;
        const firstRevisionBytes = Buffer.from(JSON.stringify(firstRevision), "utf8");
        expect(await transaction.accessGrant.findMany({
          where: {
            searchStrategy: OPENAI_SEARCH_OPTION_ID,
            userId: actor.userId
          }
        })).toEqual([expect.objectContaining({ enabled: true })]);

        const ready = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:03.000Z"),
          provider: "openai"
        });
        await expect(repository.commit(plan({
          actor,
          credentialId,
          credentialIsNew: false,
          credentialVersion: 2,
          expectedFingerprint: ready.fingerprint,
          grantId: `unused-search-model-grant-${suffix}`,
          mode: "replacement",
          preservedModels: ready.preservedModels,
          search: {
            idPrefix: `unused-search-replacement-${suffix}`
          },
          versionId: `quick-search-version-two-${suffix}`
        }))).resolves.toMatchObject({ search: "ready" });
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { id: integration.id }
        })).toMatchObject({
          draftTestEvidence: expect.objectContaining({
            method: "configuration",
            status: "available"
          }),
          enabled: true
        });
        const rotatedIntegration = await transaction.searchStrategy.findUniqueOrThrow({
          include: {
            activeRevision: true,
            revisions: { orderBy: { revisionNumber: "asc" } }
          },
          where: { id: integration.id }
        });
        expect(rotatedIntegration.revisions).toHaveLength(1);
        expect(rotatedIntegration.revisions[0]).toEqual(firstRevision);
        expect(Buffer.from(JSON.stringify(rotatedIntegration.revisions[0]), "utf8"))
          .toEqual(firstRevisionBytes);
        expect(rotatedIntegration.activeRevision).toMatchObject({
          revisionNumber: 1,
          validationEvidence: expect.objectContaining({
            method: "configuration",
            status: "available"
          })
        });
        expect(JSON.stringify(rotatedIntegration.activeRevision)).not.toContain("probeBinding");
        expect(await transaction.accessGrant.count({
          where: {
            searchStrategy: OPENAI_SEARCH_OPTION_ID,
            userId: actor.userId
          }
        })).toBe(1);

        const replacementReady = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:04.000Z"),
          provider: "openai"
        });
        await expect(repository.commit(plan({
          actor,
          credentialId,
          credentialIsNew: false,
          credentialVersion: 3,
          expectedFingerprint: replacementReady.fingerprint,
          grantId: `unused-failed-search-model-grant-${suffix}`,
          mode: "replacement",
          preservedModels: replacementReady.preservedModels,
          search: {
            idPrefix: `unused-search-second-rotation-${suffix}`
          },
          versionId: `quick-search-version-three-${suffix}`
        }))).resolves.toMatchObject({
          search: "ready",
          status: "ready"
        });
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { id: integration.id }
        })).toMatchObject({ enabled: true });
        expect(await transaction.searchIntegrationRevision.count({
          where: { searchStrategyId: integration.id }
        })).toBe(1);
        expect(await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:05.000Z"),
          provider: "openai"
        })).toMatchObject({ state: "ready" });
        expect(await transaction.providerCredentialVersion.count({
          where: { credentialId }
        })).toBe(3);

        throw new RollbackFixture("provider_neutral_search_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
        RollbackFixture
      );
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("moves to the collision-free managed route when the preferred route is archived", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        const suffix = randomUUID();
        const actor = await createActor(transaction, suffix);
        const repository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction)
        );
        const initial = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:00.000Z"),
          provider: "openai"
        });
        const credentialId = `archived-route-credential-${suffix}`;

        await expect(repository.commit(plan({
          actor,
          credentialId,
          credentialVersion: 1,
          expectedFingerprint: initial.fingerprint,
          grantId: `archived-route-model-grant-${suffix}`,
          mode: "initial",
          preservedModels: initial.preservedModels,
          search: {
            idPrefix: `archived-route-first-${suffix}`
          },
          versionId: `archived-route-version-one-${suffix}`
        }))).resolves.toMatchObject({ search: "ready", status: "ready" });

        const preferred = await transaction.searchStrategy.findUniqueOrThrow({
          where: { strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID }
        });
        const archivedAt = new Date("2026-07-26T10:00:03.000Z");
        await transaction.searchStrategy.update({
          data: { archivedAt, enabled: false },
          where: { id: preferred.id }
        });

        const replacement = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:04.000Z"),
          provider: "openai"
        });
        await expect(repository.commit(plan({
          actor,
          credentialId,
          credentialIsNew: false,
          credentialVersion: 2,
          expectedFingerprint: replacement.fingerprint,
          grantId: `unused-archived-route-grant-${suffix}`,
          mode: "replacement",
          preservedModels: replacement.preservedModels,
          search: {
            idPrefix: `archived-route-second-${suffix}`
          },
          versionId: `archived-route-version-two-${suffix}`
        }))).resolves.toMatchObject({ search: "ready", status: "ready" });

        const fallbackId = `openai-search-client:${policy.connection.id}`;
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { strategyId: fallbackId }
        })).toMatchObject({
          archivedAt: null,
          enabled: true,
          providerModelId: terra.modelId,
          searchOptionId: "00000000-0000-4000-8000-000000001402"
        });
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { id: preferred.id }
        })).toMatchObject({ archivedAt, enabled: false });
        expect(await transaction.searchStrategy.count({
          where: {
            adapterKind: "provider_model_client",
            archivedAt: null,
            searchOptionId: "00000000-0000-4000-8000-000000001402"
          }
        })).toBe(1);

        throw new RollbackFixture("archived_preferred_search_route_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
        RollbackFixture
      );
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("leaves a reserved Search alias untouched and reports Search needs attention", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        const suffix = randomUUID();
        const actor = await createActor(transaction, suffix);
        const manual = await transaction.searchStrategy.create({
          data: {
            adapterKind: "provider_model_client",
            config: {},
            credentialMode: "provider_model",
            description: "Web search provided by OpenAI.",
            displayName: "OpenAI Search",
            draft: {},
            enabled: false,
            id: `operator-search-${suffix}`,
            kind: "provider_model_web_search",
            modelId: terra.configuration.upstreamModelId,
            provider: "openai",
            providerModelId: terra.modelId,
            searchOptionId: "00000000-0000-4000-8000-000000001402",
            strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID
          }
        });
        const repository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction)
        );
        const initial = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:00.000Z"),
          provider: "openai"
        });
        await expect(repository.commit(plan({
          actor,
          credentialId: `manual-row-credential-${suffix}`,
          credentialVersion: 1,
          expectedFingerprint: initial.fingerprint,
          grantId: `manual-row-model-grant-${suffix}`,
          mode: "initial",
          preservedModels: initial.preservedModels,
          search: {
            idPrefix: `must-not-write-search-${suffix}`
          },
          versionId: `manual-row-version-${suffix}`
        }))).resolves.toMatchObject({
          search: "needs_attention",
          status: "ready"
        });
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { id: manual.id }
        })).toEqual(manual);
        expect(await transaction.accessGrant.count({
          where: {
            searchStrategy: OPENAI_SEARCH_OPTION_ID,
            userId: actor.userId
          }
        })).toBe(0);
        expect(await transaction.searchStrategy.findUnique({
          where: { strategyId: `openai-search-client:${policy.connection.id}` }
        })).toBeNull();
        expect(await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:03.000Z"),
          provider: "openai"
        })).toMatchObject({ state: "ready" });
        throw new RollbackFixture("manual_search_row_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
        RollbackFixture
      );
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("leaves a non-owned managed Search id untouched and reports Search needs attention", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        const suffix = randomUUID();
        const actor = await createActor(transaction, suffix);
        const manual = await transaction.searchStrategy.create({
          data: {
            adapterKind: "provider_model_client",
            config: {},
            credentialMode: "provider_model",
            description: "Operator-owned Search integration.",
            displayName: "Operator Search",
            draft: {},
            enabled: false,
            id: OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
            kind: "provider_model_web_search",
            modelId: terra.configuration.upstreamModelId,
            provider: "openai",
            providerModelId: terra.modelId,
            searchOptionId: "00000000-0000-4000-8000-000000001402",
            strategyId: `operator-search-${suffix}`
          }
        });
        const repository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction)
        );
        const initial = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:00.000Z"),
          provider: "openai"
        });
        await expect(repository.commit(plan({
          actor,
          credentialId: `manual-id-credential-${suffix}`,
          credentialVersion: 1,
          expectedFingerprint: initial.fingerprint,
          grantId: `manual-id-model-grant-${suffix}`,
          mode: "initial",
          preservedModels: initial.preservedModels,
          search: {
            idPrefix: `must-not-write-managed-id-${suffix}`
          },
          versionId: `manual-id-version-${suffix}`
        }))).resolves.toMatchObject({
          search: "needs_attention",
          status: "ready"
        });
        expect(await transaction.searchStrategy.findUniqueOrThrow({
          where: { id: manual.id }
        })).toEqual(manual);
        expect(await transaction.searchStrategy.count({
          where: { strategyId: OPENAI_PROVIDER_SEARCH_STRATEGY_ID }
        })).toBe(0);
        expect(await transaction.searchStrategy.findUnique({
          where: { strategyId: `openai-search-client:${policy.connection.id}` }
        })).toBeNull();
        expect(await transaction.accessGrant.count({
          where: {
            searchStrategy: OPENAI_SEARCH_OPTION_ID,
            userId: actor.userId
          }
        })).toBe(0);
        throw new RollbackFixture("manual_search_primary_id_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
        RollbackFixture
      );
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("commits a catalog-visible personal graph without group writes and preserves it on replacement", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      await transaction.runProfile.update({
        data: {
          enabled: false,
          providerModelId: null,
          updatedByUserId: null,
          version: 1
        },
        where: { id: "balanced" }
      });
      const groupGraphBefore = await groupGraphSnapshot(transaction);
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      expect(initial).toMatchObject({ mode: "initial", state: "not_configured" });
      const credentialId = `quick-credential-${suffix}`;
      const firstVersionId = `quick-version-one-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        candidates: [terra, luna, sol],
        credentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: firstVersionId
      }))).resolves.toEqual({
        defaultChanged: true,
        profilesFilled: ["balanced"],
        status: "ready"
      });

      const ready = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      });
      expect(ready).toMatchObject({
        mode: "replacement",
        model: { id: terra.modelId, templateKey: terra.templateKey },
        state: "ready"
      });
      const directGrant = await transaction.accessGrant.findMany({
        where: { providerModelId: terra.modelId, userId: actor.userId }
      });
      expect(directGrant).toHaveLength(1);
      expect(directGrant[0]).toMatchObject({
        enabled: true,
        groupId: null,
        providerConnectionId: null,
        searchStrategy: null
      });
      expect(await transaction.accessGrant.findMany({
        orderBy: { providerModelId: "asc" },
        select: { enabled: true, providerModelId: true },
        where: {
          providerModelId: { in: [terra.modelId, luna.modelId, sol.modelId] },
          userId: actor.userId
        }
      })).toEqual([terra, luna, sol]
        .map(({ modelId }) => ({ enabled: true, providerModelId: modelId }))
        .sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)));
      expect(await transaction.providerModelCredentialCheck.count({
        where: {
          credentialVersionId: firstVersionId,
          providerModelId: { in: [terra.modelId, luna.modelId, sol.modelId] },
          status: "available"
        }
      })).toBe(3);
      expect(await transaction.providerModel.count({
        where: {
          enabled: true,
          id: { in: [terra.modelId, luna.modelId, sol.modelId] }
        }
      })).toBe(3);
      expect(await transaction.providerUserCredentialAssignment.findUnique({
        where: {
          connectionId_userId: {
            connectionId: policy.connection.id,
            userId: actor.userId
          }
        }
      })).toMatchObject({ credentialId });
      expect(await transaction.providerConnection.findUniqueOrThrow({
        where: { id: policy.connection.id }
      })).toMatchObject({ defaultCredentialId: null });
      expect(await groupGraphSnapshot(transaction)).toEqual(groupGraphBefore);

      const entitlementRows = await transaction.accessGrant.findMany({
        include: { providerModel: { select: { connectionId: true } } },
        where: { userId: actor.userId }
      });
      const catalog = await createPrismaCatalogDataLoader({
        env: {},
        loadEntitlements: async () => resolveEntitlements(actor.userId, [], entitlementRows.map(
          (grant) => ({
            ...grant,
            providerModelConnectionId: grant.providerModel?.connectionId ?? null
          })
        )),
        prisma: transaction as unknown as PrismaClientType
      })(actor.userId);
      expect(catalog?.models.some((model) => model.modelId === terra.modelId)).toBe(true);

      const [
        connectionBefore,
        modelBefore,
        grantBefore,
        settingsBefore,
        profileBefore,
        firstVersionBefore,
        replacementGroupGraphBefore
      ] =
        await Promise.all([
          transaction.providerConnection.findUniqueOrThrow({ where: { id: policy.connection.id } }),
          transaction.providerModel.findUniqueOrThrow({ where: { id: terra.modelId } }),
          transaction.accessGrant.findUniqueOrThrow({ where: { id: directGrant[0].id } }),
          transaction.userSettings.findUniqueOrThrow({ where: { userId: actor.userId } }),
          transaction.runProfile.findUniqueOrThrow({ where: { id: "balanced" } }),
          transaction.providerCredentialVersion.findUniqueOrThrow({
            where: { id: firstVersionId }
          }),
          groupGraphSnapshot(transaction)
        ]);
      const firstVersionBytesBefore = Buffer.from(JSON.stringify(firstVersionBefore), "utf8");
      const secondVersionId = `quick-version-two-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        candidates: [terra, luna, sol],
        credentialId,
        credentialVersion: 2,
        expectedFingerprint: ready.fingerprint,
        grantId: `unused-grant-${suffix}`,
        mode: "replacement",
        preservedModels: ready.preservedModels,
        versionId: secondVersionId
      }))).resolves.toEqual({ defaultChanged: false, profilesFilled: [], status: "ready" });

      const [connectionAfter, modelAfter, grantAfter, settingsAfter, profileAfter] =
        await Promise.all([
          transaction.providerConnection.findUniqueOrThrow({ where: { id: policy.connection.id } }),
          transaction.providerModel.findUniqueOrThrow({ where: { id: terra.modelId } }),
          transaction.accessGrant.findUniqueOrThrow({ where: { id: directGrant[0].id } }),
          transaction.userSettings.findUniqueOrThrow({ where: { userId: actor.userId } }),
          transaction.runProfile.findUniqueOrThrow({ where: { id: "balanced" } })
        ]);
      expect(connectionAfter).toEqual(connectionBefore);
      expect(modelAfter).toEqual(modelBefore);
      expect(grantAfter).toEqual(grantBefore);
      expect(settingsAfter).toEqual(settingsBefore);
      expect(profileAfter).toEqual(profileBefore);
      const firstVersionAfter = await transaction.providerCredentialVersion.findUniqueOrThrow({
        where: { id: firstVersionId }
      });
      expect(firstVersionAfter).toEqual(firstVersionBefore);
      expect(Buffer.from(JSON.stringify(firstVersionAfter), "utf8")).toEqual(
        firstVersionBytesBefore
      );
      expect(await transaction.providerCredentialVersion.count({
        where: { credentialId }
      })).toBe(2);
      expect(await transaction.providerCredential.findUniqueOrThrow({
        where: { id: credentialId }
      })).toMatchObject({ activeVersionId: secondVersionId, draftVersion: 2 });
      expect(await transaction.providerModelCredentialCheck.findMany({
        orderBy: { providerModelId: "asc" },
        select: { providerModelId: true, status: true },
        where: {
          credentialVersionId: secondVersionId,
          providerModelId: { in: [terra.modelId, luna.modelId, sol.modelId] }
        }
      })).toEqual([terra, luna, sol]
        .map(({ modelId }) => ({ providerModelId: modelId, status: "available" }))
        .sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)));
      expect(await transaction.accessGrant.findMany({
        orderBy: { providerModelId: "asc" },
        select: { enabled: true, providerModelId: true },
        where: {
          providerModelId: { in: [terra.modelId, luna.modelId, sol.modelId] },
          userId: actor.userId
        }
      })).toEqual([terra, luna, sol]
        .map(({ modelId }) => ({ enabled: true, providerModelId: modelId }))
        .sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)));
      expect(await transaction.accessGrant.count({
        where: { id: { startsWith: `unused-grant-${suffix}` } }
      })).toBe(0);
      expect(await groupGraphSnapshot(transaction)).toEqual(replacementGroupGraphBefore);
      throw new RollbackFixture("success_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
        RollbackFixture
      );
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("keeps the Quick model grant while wildcard-preserving every credential-available model", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      const fullAccessGroup = await transaction.group.upsert({
        create: {
          name: "Full access",
          systemRole: "full_access"
        },
        update: {},
        where: { systemRole: "full_access" }
      });
      await transaction.userGroup.create({
        data: {
          groupId: fullAccessGroup.id,
          userId: actor.userId
        }
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      expect(initial).toMatchObject({ mode: "initial", state: "not_configured" });

      const credentialId = `quick-full-access-credential-${suffix}`;
      const firstVersionId = `quick-full-access-version-one-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-full-access-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: firstVersionId
      }))).resolves.toMatchObject({ status: "ready" });
      expect(await transaction.accessGrant.findMany({
        select: { providerModelId: true },
        where: { userId: actor.userId }
      })).toEqual([{ providerModelId: terra.modelId }]);

      await transaction.providerModel.update({
        data: {
          activeConfig: luna.configuration as Prisma.InputJsonValue,
          activeVersion: 1,
          activatedAt: new Date("2026-07-26T10:00:03.000Z"),
          enabled: true
        },
        where: { id: luna.modelId }
      });
      await transaction.providerModelCredentialCheck.create({
        data: {
          checkedAt: new Date("2026-07-26T10:00:03.000Z"),
          connectionId: policy.connection.id,
          connectionVersion: 1,
          credentialId,
          credentialVersionId: firstVersionId,
          evidence: { method: "models_catalog", upstreamModelId: luna.configuration.upstreamModelId },
          modelVersion: 1,
          providerModelId: luna.modelId,
          status: "available"
        }
      });

      const twoModelsReady = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:04.000Z"),
        provider: "openai"
      });
      expect(twoModelsReady).toMatchObject({ mode: "replacement", state: "ready" });
      expect(twoModelsReady.preservedModels).toEqual([
        { id: terra.modelId, upstreamModelId: terra.configuration.upstreamModelId },
        { id: luna.modelId, upstreamModelId: luna.configuration.upstreamModelId }
      ].sort((left, right) => left.id.localeCompare(right.id)));

      const secondVersionId = `quick-full-access-version-two-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 2,
        expectedFingerprint: twoModelsReady.fingerprint,
        grantId: `unused-full-access-grant-${suffix}`,
        mode: "replacement",
        preservedModels: twoModelsReady.preservedModels,
        versionId: secondVersionId
      }))).resolves.toMatchObject({ status: "ready" });
      expect(await transaction.accessGrant.findMany({
        select: { providerModelId: true },
        where: { userId: actor.userId }
      })).toEqual([{ providerModelId: terra.modelId }]);
      expect(await transaction.providerModelCredentialCheck.findMany({
        orderBy: { providerModelId: "asc" },
        select: { providerModelId: true },
        where: { credentialVersionId: secondVersionId }
      })).toEqual([
        { providerModelId: terra.modelId },
        { providerModelId: luna.modelId }
      ].sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)));

      await transaction.userGroup.delete({
        where: {
          userId_groupId: {
            groupId: fullAccessGroup.id,
            userId: actor.userId
          }
        }
      });
      const afterMembershipRemoval = await createPrismaCatalogDataLoader({
        env: {},
        loadEntitlements: (userId) => loadEntitlementsForUser(userId, transaction),
        prisma: transaction as unknown as PrismaClientType
      })(actor.userId);
      expect(afterMembershipRemoval?.models.map((model) => model.modelId)).toContain(terra.modelId);
      expect(afterMembershipRemoval?.models.map((model) => model.modelId)).not.toContain(luna.modelId);

      const replaced = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:05.000Z"),
        provider: "openai"
      });
      await expect(repository.clearAssignment({
        actor,
        expectedFingerprint: replaced.fingerprint,
        now: new Date("2026-07-26T10:00:06.000Z"),
        provider: "openai"
      })).resolves.toEqual({ status: "cleared" });

      const catalog = await createPrismaCatalogDataLoader({
        env: {},
        loadEntitlements: (userId) => loadEntitlementsForUser(userId, transaction),
        prisma: transaction as unknown as PrismaClientType
      })(actor.userId);
      expect(catalog?.models.some((model) =>
        model.modelId === terra.modelId || model.modelId === luna.modelId
      )).toBe(false);

      throw new RollbackFixture("full_access_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  });

  it("preserves two available models on replacement and clears only the Quick assignment", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      const credentialId = `quick-multi-credential-${suffix}`;
      const firstVersionId = `quick-multi-version-one-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-multi-terra-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: firstVersionId
      }))).resolves.toMatchObject({ status: "ready" });

      await transaction.providerModel.update({
        data: {
          activeConfig: luna.configuration as Prisma.InputJsonValue,
          activeVersion: 1,
          activatedAt: new Date("2026-07-26T10:00:03.000Z"),
          enabled: true
        },
        where: { id: luna.modelId }
      });
      await transaction.accessGrant.create({
        data: {
          enabled: true,
          id: `quick-multi-luna-grant-${suffix}`,
          providerModelId: luna.modelId,
          userId: actor.userId
        }
      });
      await transaction.providerModelCredentialCheck.create({
        data: {
          checkedAt: new Date("2026-07-26T10:00:03.000Z"),
          connectionId: policy.connection.id,
          connectionVersion: 1,
          credentialId,
          credentialVersionId: firstVersionId,
          evidence: { method: "models_catalog", upstreamModelId: luna.configuration.upstreamModelId },
          modelVersion: 1,
          providerModelId: luna.modelId,
          status: "available"
        }
      });

      const twoModelsReady = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:04.000Z"),
        provider: "openai"
      });
      expect(twoModelsReady.preservedModels).toEqual([
        { id: terra.modelId, upstreamModelId: terra.configuration.upstreamModelId },
        { id: luna.modelId, upstreamModelId: luna.configuration.upstreamModelId }
      ].sort((left, right) => left.id.localeCompare(right.id)));

      const secondVersionId = `quick-multi-version-two-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 2,
        expectedFingerprint: twoModelsReady.fingerprint,
        grantId: `unused-quick-multi-grant-${suffix}`,
        mode: "replacement",
        preservedModels: twoModelsReady.preservedModels,
        versionId: secondVersionId
      }))).resolves.toMatchObject({ status: "ready" });
      expect(await transaction.providerModelCredentialCheck.findMany({
        orderBy: { providerModelId: "asc" },
        select: { providerModelId: true, status: true },
        where: { credentialVersionId: secondVersionId }
      })).toEqual([
        { providerModelId: terra.modelId, status: "available" },
        { providerModelId: luna.modelId, status: "available" }
      ].sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)));

      const replaced = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:05.000Z"),
        provider: "openai"
      });
      expect(replaced.preservedModels).toHaveLength(2);
      const [credentialBefore, grantsBefore, groupsBefore] = await Promise.all([
        transaction.providerCredential.findUniqueOrThrow({ where: { id: credentialId } }),
        transaction.accessGrant.findMany({
          orderBy: { id: "asc" },
          where: { userId: actor.userId }
        }),
        groupGraphSnapshot(transaction)
      ]);
      await expect(repository.clearAssignment({
        actor,
        expectedFingerprint: replaced.fingerprint,
        now: new Date("2026-07-26T10:00:06.000Z"),
        provider: "openai"
      })).resolves.toEqual({ status: "cleared" });
      expect(await transaction.providerUserCredentialAssignment.findUnique({
        where: {
          connectionId_userId: {
            connectionId: policy.connection.id,
            userId: actor.userId
          }
        }
      })).toBeNull();
      expect(await transaction.providerCredential.findUniqueOrThrow({
        where: { id: credentialId }
      })).toEqual(credentialBefore);
      expect(await transaction.providerCredentialVersion.count({
        where: { credentialId }
      })).toBe(2);
      expect(await transaction.accessGrant.findMany({
        orderBy: { id: "asc" },
        where: { userId: actor.userId }
      })).toEqual(grantsBefore);
      expect(await groupGraphSnapshot(transaction)).toEqual(groupsBefore);
      throw new RollbackFixture("multi_model_and_clear_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  });

  it("repairs only a bounded personal graph and leaves profiles and groups untouched", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      await transaction.runProfile.update({
        data: {
          enabled: false,
          providerModelId: null,
          updatedByUserId: null,
          version: 1
        },
        where: { id: "balanced" }
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      const credentialId = `quick-recovery-credential-${suffix}`;
      const firstVersionId = `quick-recovery-version-one-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-recovery-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: firstVersionId
      }))).resolves.toMatchObject({ status: "ready" });

      await Promise.all([
        transaction.providerConnection.update({
          data: { enabled: false },
          where: { id: policy.connection.id }
        }),
        transaction.userSettings.update({
          data: { defaultProviderModelId: null },
          where: { userId: actor.userId }
        }),
        transaction.runProfile.update({
          data: {
            enabled: false,
            providerModelId: null,
            updatedByUserId: null,
            version: 1
          },
          where: { id: "balanced" }
        })
      ]);
      const recovery = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      });
      expect(recovery).toMatchObject({
        mode: "recovery",
        model: { id: terra.modelId, templateKey: terra.templateKey },
        state: "disabled"
      });
      const [grantBefore, profileBefore, groupGraphBefore] = await Promise.all([
        transaction.accessGrant.findFirstOrThrow({
          where: { providerModelId: terra.modelId, userId: actor.userId }
        }),
        transaction.runProfile.findUniqueOrThrow({ where: { id: "balanced" } }),
        groupGraphSnapshot(transaction)
      ]);
      const secondVersionId = `quick-recovery-version-two-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 2,
        expectedFingerprint: recovery.fingerprint,
        grantId: `unused-recovery-grant-${suffix}`,
        mode: "recovery",
        preservedModels: recovery.preservedModels,
        versionId: secondVersionId
      }))).resolves.toEqual({
        defaultChanged: true,
        profilesFilled: [],
        status: "ready"
      });

      expect(await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:04.000Z"),
        provider: "openai"
      })).toMatchObject({ mode: "replacement", state: "ready" });
      expect(await transaction.accessGrant.findUniqueOrThrow({
        where: { id: grantBefore.id }
      })).toEqual(grantBefore);
      expect(await transaction.runProfile.findUniqueOrThrow({
        where: { id: "balanced" }
      })).toEqual(profileBefore);
      expect(await transaction.providerCredentialVersion.count({
        where: { credentialId }
      })).toBe(2);
      expect(await groupGraphSnapshot(transaction)).toEqual(groupGraphBefore);
      throw new RollbackFixture("recovery_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  });

  it("rolls back the exact graph after every actual initial and replacement write boundary", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      await transaction.runProfile.update({
        data: {
          enabled: false,
          providerModelId: null,
          updatedByUserId: null,
          version: 1
        },
        where: { id: "balanced" }
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      const initialPlan = plan({
        actor,
        credentialId: `quick-boundary-credential-${suffix}`,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-boundary-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: `quick-boundary-version-one-${suffix}`
      });
      const initialGraph = await quickGraphSnapshot(transaction, actor.userId);
      expect(await commitTraceRolledBack(transaction, initialPlan)).toEqual(
        INITIAL_WRITE_BOUNDARIES
      );
      expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(initialGraph);

      for (const [index, boundary] of INITIAL_WRITE_BOUNDARIES.entries()) {
        const trace: string[] = [];
        const failingRepository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction, instrumentWrites(transaction, {
            failAfter: boundary,
            trace
          }))
        );
        await expect(failingRepository.commit(initialPlan)).rejects.toMatchObject({
          message: boundary
        });
        expect(trace).toEqual(INITIAL_WRITE_BOUNDARIES.slice(0, index + 1));
        expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(initialGraph);
      }

      await expect(repository.commit(initialPlan)).resolves.toMatchObject({ status: "ready" });
      const ready = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      });
      const replacementPlan = plan({
        actor,
        credentialId: initialPlan.credential.id,
        credentialVersion: 2,
        expectedFingerprint: ready.fingerprint,
        grantId: `unused-boundary-grant-${suffix}`,
        mode: "replacement",
        preservedModels: ready.preservedModels,
        versionId: `quick-boundary-version-two-${suffix}`
      });
      const replacementGraph = await quickGraphSnapshot(transaction, actor.userId);
      expect(await commitTraceRolledBack(transaction, replacementPlan)).toEqual(
        REPLACEMENT_WRITE_BOUNDARIES
      );
      expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(replacementGraph);

      for (const [index, boundary] of REPLACEMENT_WRITE_BOUNDARIES.entries()) {
        const trace: string[] = [];
        const failingRepository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction, instrumentWrites(transaction, {
            failAfter: boundary,
            trace
          }))
        );
        await expect(failingRepository.commit(replacementPlan)).rejects.toMatchObject({
          message: boundary
        });
        expect(trace).toEqual(REPLACEMENT_WRITE_BOUNDARIES.slice(0, index + 1));
        expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(replacementGraph);
      }
      throw new RollbackFixture("boundary_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  }, 60_000);

  it("rolls a recovery graph back at its late default boundary", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      await transaction.runProfile.update({
        data: {
          enabled: false,
          providerModelId: null,
          updatedByUserId: null,
          version: 1
        },
        where: { id: "balanced" }
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      const credentialId = `quick-recovery-rollback-credential-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-recovery-rollback-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: `quick-recovery-rollback-version-one-${suffix}`
      }))).resolves.toMatchObject({ status: "ready" });
      await Promise.all([
        transaction.providerConnection.update({
          data: { enabled: false },
          where: { id: policy.connection.id }
        }),
        transaction.userSettings.update({
          data: { defaultProviderModelId: null },
          where: { userId: actor.userId }
        })
      ]);
      const recovery = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      });
      expect(recovery).toMatchObject({ mode: "recovery", state: "disabled" });
      const recoveryPlan = plan({
        actor,
        credentialId,
        credentialVersion: 2,
        expectedFingerprint: recovery.fingerprint,
        grantId: `unused-recovery-rollback-grant-${suffix}`,
        mode: "recovery",
        preservedModels: recovery.preservedModels,
        versionId: `quick-recovery-rollback-version-two-${suffix}`
      });
      const graphBefore = await quickGraphSnapshot(transaction, actor.userId);
      const trace: string[] = [];
      const failingRepository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction, instrumentWrites(transaction, {
          failAfter: "userSettings.update#1",
          trace
        }))
      );
      await expect(failingRepository.commit(recoveryPlan)).rejects.toMatchObject({
        message: "userSettings.update#1"
      });
      expect(trace).toEqual([
        "providerConnection.update#1",
        "providerCredentialVersion.create#1",
        "providerCredential.update#1",
        "providerUserCredentialAssignment.upsert#1",
        "providerModelCredentialCheck.create#1",
        "userSettings.update#1"
      ]);
      expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(graphBefore);
      throw new RollbackFixture("recovery_rollback_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  }, 30_000);

  it("rolls every write back when the transaction-local catalog cannot expose the model", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      await transaction.runProfile.update({
        data: {
          enabled: false,
          providerModelId: null,
          updatedByUserId: null,
          version: 1
        },
        where: { id: "balanced" }
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      const graphBefore = await quickGraphSnapshot(transaction, actor.userId);
      let catalogReads = 0;
      const unavailableRepository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction, forceCatalogUnavailable(transaction, () => {
          catalogReads += 1;
        }))
      );
      await expect(unavailableRepository.commit(plan({
        actor,
        credentialId: `quick-unavailable-credential-${suffix}`,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-unavailable-grant-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: `quick-unavailable-version-${suffix}`
      }))).resolves.toBe("catalog_unavailable");
      expect(catalogReads).toBe(1);
      expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(graphBefore);
      throw new RollbackFixture("catalog_unavailable_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  }, 30_000);

  it("rejects a reserved collision on a non-selected candidate before changing the Quick graph", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      await expect(isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        const suffix = randomUUID();
        const actor = await createActor(transaction, suffix);
        const foreignConnectionId = `quick-foreign-connection-${suffix}`;
        await transaction.providerConnection.create({
          data: {
            displayName: "Foreign provider connection",
            family: "anthropic",
            id: foreignConnectionId
          }
        });
        await transaction.providerModel.update({
          data: { connectionId: foreignConnectionId },
          where: { id: luna.modelId }
        });

        const repository = createPrismaAdminProviderQuickSetupRepository(
          transactionBackedClient(transaction)
        );
        const initial = await repository.inspect({
          ...actor,
          now: new Date("2026-07-26T10:00:00.000Z"),
          provider: "openai"
        });
        expect(initial).toMatchObject({ mode: "initial", state: "not_configured" });
        const graphBefore = await quickGraphSnapshot(transaction, actor.userId);
        const foreignConnectionBefore = await transaction.providerConnection.findUniqueOrThrow({
          where: { id: foreignConnectionId }
        });

        const credentialId = `quick-collision-credential-${suffix}`;
        const versionId = `quick-collision-version-${suffix}`;
        const grantId = `quick-collision-grant-${suffix}`;
        await expect(repository.commit(plan({
          actor,
          candidates: [terra, luna],
          credentialId,
          credentialVersion: 1,
          expectedFingerprint: initial.fingerprint,
          grantId,
          mode: "initial",
          preservedModels: initial.preservedModels,
          versionId
        }))).resolves.toBe("advanced_required");

        expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(graphBefore);
        expect(await transaction.providerConnection.findUniqueOrThrow({
          where: { id: foreignConnectionId }
        })).toEqual(foreignConnectionBefore);
        expect(await transaction.providerCredential.count({ where: { id: credentialId } }))
          .toBe(0);
        expect(await transaction.providerCredentialVersion.count({ where: { id: versionId } }))
          .toBe(0);
        expect(await transaction.accessGrant.count({
          where: { id: { startsWith: grantId } }
        })).toBe(0);
        throw new RollbackFixture("non_selected_collision_fixture_complete");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects
        .toBeInstanceOf(RollbackFixture);
    } finally {
      await isolated.cleanup();
    }
  }, 30_000);

  it("fences a raced team edit, then preserves it on a fresh Quick commit", async () => {
    await expect(database.$transaction(async (transaction) => {
      await resetOpenAiToInitial(transaction);
      const suffix = randomUUID();
      const actor = await createActor(transaction, suffix);
      const repository = createPrismaAdminProviderQuickSetupRepository(
        transactionBackedClient(transaction)
      );
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      expect(initial).toMatchObject({ mode: "initial", state: "not_configured" });

      const groupId = `quick-advanced-group-${suffix}`;
      const advancedCredentialId = `quick-advanced-credential-${suffix}`;
      const advancedGrantId = `quick-advanced-grant-${suffix}`;
      await transaction.group.create({
        data: { id: groupId, name: `Quick Advanced ${suffix}` }
      });
      await transaction.userGroup.create({
        data: { groupId, role: "member", userId: actor.userId }
      });
      await transaction.providerCredential.create({
        data: {
          connectionId: policy.connection.id,
          draftVersion: 0,
          enabled: false,
          id: advancedCredentialId,
          label: "Team credential"
        }
      });
      await transaction.providerGroupCredentialAssignment.create({
        data: {
          connectionId: policy.connection.id,
          credentialId: advancedCredentialId,
          groupId
        }
      });
      await transaction.accessGrant.create({
        data: {
          enabled: true,
          groupId,
          id: advancedGrantId,
          providerModelId: terra.modelId
        }
      });
      const advancedGraph = await quickGraphSnapshot(transaction, actor.userId);
      const advancedGroups = await groupGraphSnapshot(transaction);
      expect(advancedGroups.groups).toContainEqual(expect.objectContaining({ id: groupId }));
      expect(advancedGroups.userGroups).toContainEqual(expect.objectContaining({
        groupId,
        userId: actor.userId
      }));
      expect(advancedGroups.credentialAssignments).toContainEqual(expect.objectContaining({
        connectionId: policy.connection.id,
        credentialId: advancedCredentialId,
        groupId
      }));
      expect(advancedGroups.accessGrants).toContainEqual(expect.objectContaining({
        groupId,
        id: advancedGrantId
      }));

      const quickCredentialId = `quick-losing-credential-${suffix}`;
      const quickVersionId = `quick-losing-version-${suffix}`;
      const quickGrantId = `quick-losing-grant-${suffix}`;
      await expect(repository.commit(plan({
        actor,
        credentialId: quickCredentialId,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: quickGrantId,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: quickVersionId
      }))).resolves.toBe("stale");
      expect(await quickGraphSnapshot(transaction, actor.userId)).toEqual(advancedGraph);
      expect(await transaction.providerCredential.count({
        where: { id: quickCredentialId }
      })).toBe(0);
      expect(await transaction.providerCredentialVersion.count({
        where: { id: quickVersionId }
      })).toBe(0);
      expect(await transaction.accessGrant.count({ where: { id: quickGrantId } })).toBe(0);
      const fresh = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      });
      expect(fresh).toMatchObject({ mode: "recovery", state: "not_configured" });
      await expect(repository.commit(plan({
        actor,
        credentialId: quickCredentialId,
        credentialIsNew: true,
        credentialVersion: 1,
        expectedFingerprint: fresh.fingerprint,
        grantId: quickGrantId,
        mode: "recovery",
        preservedModels: fresh.preservedModels,
        versionId: quickVersionId
      }))).resolves.toMatchObject({ status: "ready" });
      expect(await groupGraphSnapshot(transaction)).toEqual(advancedGroups);
      expect(await transaction.providerUserCredentialAssignment.findUnique({
        where: {
          connectionId_userId: {
            connectionId: policy.connection.id,
            userId: actor.userId
          }
        }
      })).toMatchObject({ credentialId: quickCredentialId });
      throw new RollbackFixture("advanced_winner_fixture_complete");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toBeInstanceOf(
      RollbackFixture
    );
  }, 30_000);

  it("serializes concurrent Quick commits to one Ready result and one stale result", async () => {
    const isolated = await createIsolatedQuickSetupDatabase();
    try {
      const suffix = randomUUID();
      const actor = await isolated.client.$transaction(async (transaction) => {
        await resetOpenAiToInitial(transaction);
        await transaction.runProfile.update({
          data: {
            enabled: false,
            providerModelId: null,
            updatedByUserId: null,
            version: 1
          },
          where: { id: "balanced" }
        });
        return createActor(transaction, suffix);
      });
      const repository = createPrismaAdminProviderQuickSetupRepository(isolated.client);
      const initial = await repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:00.000Z"),
        provider: "openai"
      });
      expect(initial).toMatchObject({ mode: "initial", state: "not_configured" });
      const firstPlan = plan({
        actor,
        credentialId: `quick-concurrent-credential-one-${suffix}`,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-concurrent-grant-one-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: `quick-concurrent-version-one-${suffix}`
      });
      const secondPlan = plan({
        actor,
        credentialId: `quick-concurrent-credential-two-${suffix}`,
        credentialVersion: 1,
        expectedFingerprint: initial.fingerprint,
        grantId: `quick-concurrent-grant-two-${suffix}`,
        mode: "initial",
        preservedModels: initial.preservedModels,
        versionId: `quick-concurrent-version-two-${suffix}`
      });
      const outcomes = await Promise.all([
        repository.commit(firstPlan),
        repository.commit(secondPlan)
      ]);
      expect(outcomes.map((outcome) => typeof outcome === "object" ? "ready" : outcome).sort())
        .toEqual(["ready", "stale"]);
      expect(await isolated.client.accessGrant.findMany({
        where: {
          groupId: null,
          providerConnectionId: null,
          providerModelId: terra.modelId,
          searchStrategy: null,
          userId: actor.userId
        }
      })).toHaveLength(1);
      expect(await isolated.client.providerCredential.count({
        where: { connectionId: policy.connection.id }
      })).toBe(1);
      expect(await isolated.client.providerCredentialVersion.count()).toBe(1);
      expect(await isolated.client.providerModelCredentialCheck.count({
        where: { providerModelId: terra.modelId }
      })).toBe(1);
      await expect(repository.inspect({
        ...actor,
        now: new Date("2026-07-26T10:00:03.000Z"),
        provider: "openai"
      })).resolves.toMatchObject({ mode: "replacement", state: "ready" });
    } finally {
      await isolated.cleanup();
    }
  }, 60_000);
});
