// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/client";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_RUN_PLAN_LIMITS,
  PERSONAL_MCP_CONNECTION_LIMIT,
  type McpDraftConfiguration,
  type McpSlotValue
} from "@/lib/contracts/mcp";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { textMessageContent } from "../../domain/content";
import { listAdminDashboard } from "../auth/adminDashboardQueries";
import { createPrismaAdminRepository } from "../auth/adminRepository";
import { ensureFullAccessGroup } from "../auth/fullAccessGroup";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { knowledgeObservationOwner } from "../knowledge/observationOwner";
import { prisma } from "../prisma";
import { createToolObservationRepository } from "../toolObservations/repository";
import { createToolObservationService } from "../toolObservations/service";
import { createObservationSourceOwners } from "../toolObservations/sourceOwners";
import { captureMcpObservation } from "../toolObservations/sourceAdapters";
import { createUserMcpUpdateHandler } from "./handlers";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { createPrismaMcpOAuthRepository, type McpOAuthRepository } from "./oauthRepository";
import { MCP_OAUTH_REVOCATION_ABANDON_MS, McpOAuthService } from "./oauthService";
import { createPersonalMcpCreateHandler, createPersonalMcpUpdateHandler } from "./personalHandlers";
import { createPrismaMcpRepository } from "./prismaRepository";
import { namespacedMcpToolName } from "./runPlan";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";

/** Runtime and observation bindings carry SHA-256 fingerprints. */
const hexFingerprint = () => createHash("sha256").update(randomUUID()).digest("hex");
/** Rate limiting is covered by the handler unit tests; these cases exercise the limits. */
const allowAll = { check: async () => ({ allowed: true, retryAfterSeconds: 0 }) };

// Synthetic users and servers only; each test removes exactly the rows it made.
const key = Buffer.alloc(32, 11);
const owned = {
  chats: [] as string[],
  clients: [] as string[],
  groups: [] as string[],
  projects: [] as string[],
  servers: [] as string[],
  users: [] as string[]
};
const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};
const oauthDraft: McpDraftConfiguration = {
  ...draft,
  auth: { allowedAuthorizationServerOrigins: ["https://auth.example.test"], mode: "oauth", scopes: [] }
};
const staticDraft: McpDraftConfiguration = {
  ...draft,
  auth: { mode: "static" },
  slots: [{
    label: "Authorization header",
    policy: { kind: "personal", required: true },
    sensitive: true,
    slotKey: "authorization",
    target: { kind: "header", name: "Authorization" },
    valueType: "secret"
  }]
};
const redirectUri = (serverId: string) => `https://app.example.test/api/me/mcp/${serverId}/oauth/callback`;
const boundary = /personal MCP owner boundary/u;

afterEach(async () => {
  const serverIds = owned.servers.splice(0);
  const chatIds = owned.chats.splice(0);
  const userIds = owned.users.splice(0);
  if (chatIds.length) {
    const observations = await prisma.toolObservation.findMany({
      select: { storageKey: true },
      where: { modelRun: { chatId: { in: chatIds } } }
    });
    await prisma.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.updateMany({ data: { activeLeafMessageId: null }, where: { id: { in: chatIds } } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { targetId: { in: chatIds }, userId: { in: userIds } } });
    await prisma.attachmentDeletionJob.deleteMany({
      where: { storageKey: { in: observations.flatMap((row) => row.storageKey ? [row.storageKey] : []) } }
    });
  }
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { OR: [
    { revision: { serverId: { in: serverIds } } },
    { userServer: { serverId: { in: serverIds } } }
  ] } });
  await prisma.projectMcpBinding.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: owned.clients.splice(0) } } });
  await prisma.project.deleteMany({ where: { id: { in: owned.projects.splice(0) } } });
  await prisma.group.deleteMany({ where: { id: { in: owned.groups.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function user(role: "admin" | "user" = "user"): Promise<string> {
  const created = await prisma.user.create({ data: {
    displayName: "Personal MCP integrity fixture",
    email: `mcp-integrity-${randomUUID()}@example.test`,
    role,
    status: "active"
  } });
  owned.users.push(created.id);
  return created.id;
}

function okValidator() {
  return vi.fn(async () => ({
    evidence: { protocol: "fixture" },
    kind: "ok" as const,
    resolvedArtifact: null,
    toolInventory: [{ description: "Read fixture", name: "read" }]
  }));
}

function storage(validate = okValidator()) {
  return createPrismaMcpRepository({ draftValidator: { validate }, encryptionKey: () => key, oauthRedirectUri: redirectUri, prisma });
}

async function personalServer(
  ownerId: string,
  input: Readonly<{ draft?: McpDraftConfiguration; values?: Record<string, McpSlotValue> }> = {}
): Promise<string> {
  const created = await storage().createPersonalServer!({
    description: "",
    draft: input.draft ?? draft,
    name: "Personal integrity fixture",
    userId: ownerId,
    values: input.values ?? {}
  });
  if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
  owned.servers.push(created.value.id);
  return created.value.id;
}

function namespace(): string {
  return `integrity_${randomUUID().replaceAll("-", "")}`;
}

/** Visible to `userId` like a granted installation server; no preference row yet. */
async function installationServer(userId?: string): Promise<string> {
  const server = await prisma.mcpServer.create({
    data: { displayName: "Installation integrity fixture", draft: draft as Prisma.InputJsonValue, enabled: true, namespace: namespace() },
    select: { id: true }
  });
  owned.servers.push(server.id);
  if (userId) {
    const revision = await prisma.mcpRevision.create({ data: {
      configuration: draft as Prisma.InputJsonValue,
      draftHash: "a".repeat(64),
      identityHash: "b".repeat(64),
      revisionNumber: 1,
      serverId: server.id,
      validationEvidence: { evidence: {}, testedAt: new Date().toISOString(), toolInventory: [] }
    } });
    await prisma.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
    await prisma.mcpGrant.create({ data: { canUse: true, serverId: server.id, userId } });
  }
  return server.id;
}

/**
 * Runs finalization the way the runtime drain does. It works in batches, so
 * archived rows another run left behind may precede ours: repeat while ours
 * remain and a pass still finalizes something.
 */
async function finalizeArchived(serverIds: readonly string[]): Promise<void> {
  const runtime = createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma });
  for (let pass = 0; pass < 20; pass += 1) {
    if (!await prisma.mcpServer.count({ where: { id: { in: [...serverIds] } } })) return;
    if (!await runtime.finalizeDeletedServers()) return;
  }
}

/** Fires the deferred constraint triggers inside the probe's own transaction. */
async function expectRejected(operation: (tx: Prisma.TransactionClient) => Promise<unknown>, pattern: RegExp) {
  await expect(prisma.$transaction(async (tx) => {
    await operation(tx);
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  })).rejects.toThrow(pattern);
}

/** The global eligibility sweep and listing would touch other tests' connections. */
function scopedOAuthRepository(base: McpOAuthRepository, connectionIds: readonly string[]): McpOAuthRepository {
  return {
    ...base,
    async listDisconnectingConnectionIds() {
      return (await base.listDisconnectingConnectionIds()).filter((id) => connectionIds.includes(id));
    },
    async requestDisconnectForIneligibleConnections() {
      return 0;
    }
  };
}

function sessionFor(userId: string): RequestAuthResolver {
  return (async () => ({ user: { id: userId, role: "user", status: "active" }, userId })) as unknown as RequestAuthResolver;
}

function jsonRequest(method: "PATCH" | "POST", body: unknown): Request {
  return new Request("https://aiqsa.example.test/api/me/mcp", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("personal MCP Full access isolation", () => {
  it("gives Full access no grant on personal servers, including across bootstrap reruns", async () => {
    const [definition] = await prisma.$queryRaw<Array<{ body: string }>>`
      SELECT pg_get_functiondef('public.aiqsa_grant_full_access_to_new_mcp_server()'::regprocedure) AS body
    `;
    expect(definition?.body).toContain('NEW."ownerUserId" IS NOT NULL');

    const adminId = await user("admin");
    const ownerId = await user();
    const rollback = new Error("full_access_probe_rollback");
    // ensureFullAccessGroup touches the installation-wide group: probe it in a
    // transaction that never commits.
    await expect(prisma.$transaction(async (tx) => {
      const group = await ensureFullAccessGroup(tx, adminId);
      const installation = await tx.mcpServer.create({
        data: { displayName: "Installation probe", namespace: namespace() }, select: { id: true }
      });
      const personal = await tx.mcpServer.create({
        data: { displayName: "Personal probe", namespace: namespace(), ownerUserId: ownerId }, select: { id: true }
      });
      expect(await tx.mcpGrant.count({ where: { groupId: group.id, serverId: installation.id } })).toBe(1);
      expect(await tx.mcpGrant.count({ where: { serverId: personal.id } })).toBe(0);
      await ensureFullAccessGroup(tx, adminId);
      expect(await tx.mcpGrant.count({ where: { serverId: personal.id } })).toBe(0);
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);

    const serverId = await personalServer(ownerId);
    expect(await prisma.mcpGrant.findMany({ select: { groupId: true, userId: true }, where: { serverId } }))
      .toEqual([{ groupId: null, userId: ownerId }]);
  });
});

describe("personal MCP tenant fence", () => {
  it("rejects non-owner and installation-only children of a personal server and any owner change", async () => {
    const ownerId = await user();
    const otherId = await user();
    const serverId = await personalServer(ownerId);
    const group = await prisma.group.create({ data: { name: `Integrity fence ${randomUUID()}` } });
    owned.groups.push(group.id);
    const project = await prisma.project.create({ data: {
      createdByDisplayName: "Personal MCP integrity fixture",
      createdByUserId: ownerId,
      grants: { create: { role: "OWNER", userId: ownerId } },
      name: "Personal MCP integrity fixture"
    } });
    owned.projects.push(project.id);

    await expectRejected((tx) => tx.mcpUserServer.create({ data: { serverId, userId: otherId } }), boundary);
    await expectRejected((tx) => tx.mcpOAuthConnection.create({ data: {
      policyFingerprint: "integrity-fence", purpose: "user", serverId, userId: otherId
    } }), boundary);
    await expectRejected((tx) => tx.mcpGrant.create({ data: { canUse: true, serverId, userId: otherId } }), boundary);
    await expectRejected((tx) => tx.mcpGrant.create({ data: { canUse: true, groupId: group.id, serverId } }), boundary);
    await expectRejected((tx) => tx.projectMcpBinding.create({ data: { projectId: project.id, serverId } }), boundary);
    await expectRejected((tx) => tx.mcpSharedRuntime.create({ data: { serverId } }), boundary);
    await expectRejected((tx) => tx.mcpToolAccessPolicy.create({ data: { serverId, toolName: "read" } }), boundary);
    await expectRejected((tx) => tx.mcpActivationJob.create({ data: {
      draftHash: "integrity-fence", serverId, sharedConfigVersion: 0, workloadToken: randomUUID().replaceAll("-", "")
    } }), boundary);
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    await expectRejected((tx) => tx.mcpUserServer.update({ data: { userId: otherId }, where: { id: preference.id } }), boundary);
    await expectRejected((tx) => tx.mcpServer.update({ data: { ownerUserId: otherId }, where: { id: serverId } }),
      /McpServer ownership is immutable/u);
    await expectRejected((tx) => tx.mcpServer.update({ data: { ownerUserId: null }, where: { id: serverId } }),
      /McpServer ownership is immutable/u);
    const installationId = await installationServer();
    await expectRejected((tx) => tx.mcpServer.update({ data: { ownerUserId: ownerId }, where: { id: installationId } }),
      /McpServer ownership is immutable/u);

    // The owner's own rows, an unchanged owner and installation children stay valid.
    await prisma.mcpOAuthConnection.create({ data: { policyFingerprint: "integrity-owner", purpose: "user", serverId, userId: ownerId } });
    await prisma.mcpServer.update({ data: { ownerUserId: ownerId }, where: { id: serverId } });
    await prisma.mcpToolAccessPolicy.create({ data: { serverId: installationId, toolName: "read" } });
    await prisma.projectMcpBinding.create({ data: { projectId: project.id, serverId: installationId } });
    expect(await prisma.mcpGrant.count({ where: { serverId, OR: [{ groupId: { not: null } }, { userId: { not: ownerId } }] } })).toBe(0);
  });
});

describe("personal MCP disconnect", () => {
  it("wipes stored values, discovered evidence and draft evidence at once and keeps the token for revocation", async () => {
    const ownerId = await user();
    const serverId = await personalServer(ownerId, { draft: staticDraft, values: { authorization: "Bearer synthetic-integrity-secret" } });
    const revision = await prisma.mcpRevision.findFirstOrThrow({ where: { serverId } });
    const client = await prisma.mcpOAuthClient.create({ data: {
      clientId: `integrity-${randomUUID()}`, clientMetadata: {}, registrationKey: randomUUID()
    } });
    owned.clients.push(client.id);
    const connection = await prisma.mcpOAuthConnection.create({ data: {
      oauthClientId: client.id, policyFingerprint: "integrity-wipe", purpose: "user", serverId,
      tokenEnvelope: "synthetic-integrity-envelope", tokenGeneration: 1, userId: ownerId
    } });
    await prisma.mcpUserServer.update({
      data: {
        discoveredInventory: { tools: [], version: 1 },
        discoveredOAuthConnectionId: connection.id,
        discoveredRevisionId: revision.id
      },
      where: { userId_serverId: { serverId, userId: ownerId } }
    });
    const before = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    expect(before.personalConfigEnvelope).not.toBeNull();
    expect((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).draftTestEvidence).not.toBeNull();

    expect(await storage().deletePersonalServer!({ serverId, userId: ownerId })).toMatchObject({ kind: "ok" });

    expect(await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } })).toMatchObject({
      desiredRuntimeGenerationId: null,
      discoveredInventory: null,
      discoveredOAuthConnectionId: null,
      discoveredRevisionId: null,
      enabled: false,
      personalConfigEnvelope: null
    });
    expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).toMatchObject({
      archivedAt: expect.any(Date), draftTestEvidence: null, enabled: false
    });
    expect(await prisma.mcpOAuthConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({
      disconnectRequestedAt: expect.any(Date), state: "disconnecting", tokenEnvelope: "synthetic-integrity-envelope"
    });
  });
});

describe("bounded revocation before finalization", () => {
  it("keeps a personal server and its token while revocation fails, then wipes it at the bound and finalizes", async () => {
    const ownerId = await user();
    const serverId = await personalServer(ownerId, { draft: oauthDraft });
    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = { redirectUri: redirectUri(serverId), serverId, userId: ownerId };
    const policy = await oauth.loadPolicy({ ...query, purpose: "user" });
    if (!policy) throw new Error("fixture_policy_missing");
    const client = await oauth.saveClient({
      clientInformation: { client_id: `integrity-${randomUUID()}` },
      clientMetadata: { redirect_uris: [query.redirectUri] },
      discoveryState: {
        authorizationServerMetadata: {
          authorization_endpoint: "https://auth.example.test/authorize",
          issuer: "https://auth.example.test",
          response_types_supported: ["code"],
          revocation_endpoint: "https://auth.example.test/revoke",
          revocation_endpoint_auth_methods_supported: ["none"],
          token_endpoint: "https://auth.example.test/token"
        },
        authorizationServerUrl: "https://auth.example.test"
      },
      registrationKey: randomUUID()
    });
    owned.clients.push(client.id);
    const connected = await oauth.createConnection({
      ...query,
      clientId: client.clientInformation.client_id,
      configurationIdentity: policy.configurationIdentity,
      externalAccountLabel: null,
      oauthClientId: client.id,
      policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id),
      purpose: "user",
      resource: policy.resource,
      tokens: { access_token: "synthetic-integrity-access", token_type: "Bearer" }
    });
    if (connected.kind !== "ok") throw new Error("fixture_authorization_failed");
    const connectionId = connected.value.id;
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      createdAt: new Date(Date.now() - 5 * 60_000),
      fingerprint: hexFingerprint(),
      oauthConnectionId: connectionId,
      revisionId: policy.configurationIdentity,
      state: "ready",
      userServerId: preference.id
    } });
    expect(await storage().deletePersonalServer!({ serverId, userId: ownerId })).toMatchObject({ kind: "ok" });

    const runtime = createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma });
    expect(await runtime.listDrainedGenerationIds()).toContain(generation.id);
    expect(await runtime.deleteDrainedGeneration(generation.id)).toBe(true);
    await finalizeArchived([serverId]);
    expect(await prisma.mcpServer.findUnique({ where: { id: serverId } })).not.toBeNull();

    let clock = new Date();
    const revocations: string[] = [];
    const failingRevocation: FetchLike = async (input) => {
      revocations.push(new URL(input.toString()).pathname);
      return new Response(null, { status: 503 });
    };
    const service = new McpOAuthService({
      fetchForPolicy: () => failingRevocation,
      now: () => clock,
      repository: scopedOAuthRepository(oauth, [connectionId])
    });
    await service.reconcileDisconnecting();
    expect(revocations).toContain("/revoke");
    expect(await prisma.mcpOAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({
      state: "disconnecting", tokenEnvelope: expect.any(String)
    });
    await finalizeArchived([serverId]);
    expect(await prisma.mcpServer.findUnique({ where: { id: serverId } })).not.toBeNull();

    clock = new Date(Date.now() + MCP_OAUTH_REVOCATION_ABANDON_MS + 60_000);
    await service.reconcileDisconnecting();
    expect(await prisma.mcpOAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({
      state: "disconnected", tokenEnvelope: null
    });
    await finalizeArchived([serverId]);
    expect(await prisma.mcpServer.findUnique({ where: { id: serverId } })).toBeNull();
    expect(await prisma.mcpOAuthConnection.findUnique({ where: { id: connectionId } })).toBeNull();
  });

  it("records the revocation obligation when an installation server is deleted and never drops its token silently", async () => {
    const userId = await user();
    const serverId = await installationServer(userId);
    const client = await prisma.mcpOAuthClient.create({ data: {
      clientId: `integrity-${randomUUID()}`, clientMetadata: {}, registrationKey: randomUUID()
    } });
    owned.clients.push(client.id);
    // Undecryptable on purpose: revocation cannot even start, the bound still applies.
    const connection = await prisma.mcpOAuthConnection.create({ data: {
      oauthClientId: client.id, policyFingerprint: "integrity-installation", purpose: "user", serverId,
      state: "ready", tokenEnvelope: "synthetic-undecryptable-envelope", tokenGeneration: 1, userId
    } });
    expect(await storage().deleteServer(serverId)).toMatchObject({ kind: "ok" });
    expect(await prisma.mcpOAuthConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({
      disconnectRequestedAt: expect.any(Date), state: "disconnecting", tokenEnvelope: "synthetic-undecryptable-envelope"
    });
    await finalizeArchived([serverId]);
    expect(await prisma.mcpServer.findUnique({ where: { id: serverId } })).not.toBeNull();

    let clock = new Date();
    const service = new McpOAuthService({
      fetchForPolicy: () => async () => new Response(null, { status: 503 }),
      now: () => clock,
      repository: scopedOAuthRepository(createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma }), [connection.id])
    });
    await service.reconcileDisconnecting();
    await finalizeArchived([serverId]);
    expect(await prisma.mcpOAuthConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({
      state: "disconnecting", tokenEnvelope: "synthetic-undecryptable-envelope"
    });

    clock = new Date(Date.now() + MCP_OAUTH_REVOCATION_ABANDON_MS + 60_000);
    await service.reconcileDisconnecting();
    await finalizeArchived([serverId]);
    expect(await prisma.mcpServer.findUnique({ where: { id: serverId } })).toBeNull();
  });
});

describe("account deletion with personal MCP", () => {
  it("archives live personal servers, stays pending until finalization, then deletes the account", async () => {
    const ownerId = await user();
    const liveId = await personalServer(ownerId);
    const archivedId = await personalServer(ownerId);
    expect(await storage().deletePersonalServer!({ serverId: archivedId, userId: ownerId })).toMatchObject({ kind: "ok" });
    await prisma.user.update({ data: { status: "disabled" }, where: { id: ownerId } });
    const actingAdminUserId = `admin-${randomUUID()}`;

    const dashboard = await listAdminDashboard(prisma, { actingAdminUserId });
    expect(dashboard.users.find((row) => row.id === ownerId)?.deletion).toEqual({
      canDelete: true,
      reason: null,
      summary: "2 private Memory, Knowledge or personal MCP records will be fenced and durably purged before the account is removed."
    });

    const kick = vi.fn();
    const admin = createPrismaAdminRepository(prisma, { accountMcpDeletionKick: kick });
    await expect(admin.deleteStaleUser({ actingAdminUserId, userId: ownerId })).resolves.toBe("deletion_pending");
    expect(kick).toHaveBeenCalledOnce();
    expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: liveId } })).toMatchObject({
      archivedAt: expect.any(Date), draftTestEvidence: null, enabled: false
    });
    expect(await prisma.user.findUnique({ where: { id: ownerId } })).not.toBeNull();

    // The kicked runtime drain runs exactly this finalization.
    await finalizeArchived([liveId, archivedId]);
    expect(await prisma.mcpServer.count({ where: { ownerUserId: ownerId } })).toBe(0);
    await expect(admin.deleteStaleUser({ actingAdminUserId, userId: ownerId })).resolves.toBe("deleted");
    expect(await prisma.user.findUnique({ where: { id: ownerId } })).toBeNull();
  });
});

describe("personal MCP limits", () => {
  it("admits at most the cap of live personal connections under concurrent creates", async () => {
    const ownerId = await user();
    const live = Array.from({ length: PERSONAL_MCP_CONNECTION_LIMIT - 1 }, () => randomUUID());
    const archived = randomUUID();
    await prisma.mcpServer.createMany({ data: [
      ...live.map((id) => ({ displayName: "Live cap fixture", id, namespace: namespace(), ownerUserId: ownerId })),
      { archivedAt: new Date(), displayName: "Archived cap fixture", id: archived, namespace: namespace(), ownerUserId: ownerId }
    ] });
    owned.servers.push(...live, archived);

    const repository = storage();
    const results = await Promise.all([0, 1, 2].map(() => repository.createPersonalServer!({
      description: "", draft, name: "Concurrent cap fixture", userId: ownerId, values: {}
    })));
    for (const result of results) if (result.kind === "ok") owned.servers.push(result.value.id);
    expect(results.filter((result) => result.kind === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "personal_mcp_limit_reached")).toHaveLength(2);
    expect(await prisma.mcpServer.count({ where: { archivedAt: null, ownerUserId: ownerId } })).toBe(PERSONAL_MCP_CONNECTION_LIMIT);

    const validate = okValidator();
    const prepareOAuthDraft = vi.fn(async (value: McpDraftConfiguration) => ({ authorizationOrigins: [], draft: value }));
    const response = await createPersonalMcpCreateHandler({ rateLimiter: allowAll,
      prepareOAuthDraft, repository: storage(validate), resolveAuth: sessionFor(ownerId)
    })(jsonRequest("POST", { auth: { mode: "oauth" }, name: "Over the cap", url: "https://mcp.example.test/mcp" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "personal_mcp_limit_reached" });
    expect(prepareOAuthDraft).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("enforces the enabled-server limit across installation and personal servers on every route", async () => {
    const userId = await user();
    const enabledPersonal = await personalServer(userId);
    const disabledPersonal = await personalServer(userId);
    const repository = storage();
    expect(await repository.updateUserServer({ enabled: false, personalOnly: true, serverId: disabledPersonal, userId }))
      .toMatchObject({ kind: "ok" });
    const installation = Array.from({ length: MCP_RUN_PLAN_LIMITS.maxEnabledServers - 1 }, () => randomUUID());
    await prisma.mcpServer.createMany({ data: installation.map((id) => ({
      displayName: "Enabled installation fixture", enabled: true, id, namespace: namespace()
    })) });
    owned.servers.push(...installation);
    await prisma.mcpUserServer.createMany({ data: installation.map((serverId) => ({ enabled: true, serverId, userId })) });
    expect(await prisma.mcpUserServer.count({ where: { enabled: true, userId } })).toBe(MCP_RUN_PLAN_LIMITS.maxEnabledServers);

    const personalPatch = await createPersonalMcpUpdateHandler({ repository, resolveAuth: sessionFor(userId) })(
      jsonRequest("PATCH", { enabled: true }), { params: { connectionId: disabledPersonal } });
    expect(personalPatch.status).toBe(409);
    await expect(personalPatch.json()).resolves.toEqual({ error: "mcp_enabled_server_limit_reached" });

    const grantedId = await installationServer(userId);
    const installationPatch = await createUserMcpUpdateHandler({ repository, resolveAuth: sessionFor(userId) })(
      jsonRequest("PATCH", { enabled: true }), { params: { serverId: grantedId } });
    expect(installationPatch.status).toBe(409);
    await expect(installationPatch.json()).resolves.toEqual({ error: "mcp_enabled_server_limit_reached" });

    const validate = okValidator();
    const create = await createPersonalMcpCreateHandler({ rateLimiter: allowAll, repository: storage(validate), resolveAuth: sessionFor(userId) })(
      jsonRequest("POST", { name: "Over the enabled limit", url: "https://mcp.example.test/mcp" }));
    expect(create.status).toBe(409);
    await expect(create.json()).resolves.toEqual({ error: "mcp_enabled_server_limit_reached" });
    expect(validate).not.toHaveBeenCalled();

    // Re-enabling an already-enabled row (the OAuth settle) is no transition.
    expect(await repository.updateUserServer({ enabled: true, serverId: enabledPersonal, userId })).toMatchObject({ kind: "ok" });
    await prisma.mcpUserServer.updateMany({ data: { enabled: false }, where: { serverId: installation[0]!, userId } });
    expect(await repository.updateUserServer({ enabled: true, personalOnly: true, serverId: disabledPersonal, userId }))
      .toMatchObject({ kind: "ok", value: { enabled: true } });
    expect(await prisma.mcpUserServer.count({ where: { enabled: true, userId } })).toBe(MCP_RUN_PLAN_LIMITS.maxEnabledServers);
  });
});

describe("personal MCP tool observations", () => {
  it("lets the owner reread an accepted personal MCP result", async () => {
    const ownerId = await user();
    const serverId = await personalServer(ownerId);
    const server = await prisma.mcpServer.findUniqueOrThrow({ select: { activeRevisionId: true, namespace: true }, where: { id: serverId } });
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      fingerprint: hexFingerprint(), revisionId: server.activeRevisionId!, state: "ready", userServerId: preference.id
    } });
    const chat = await prisma.chat.create({ data: { title: "Personal MCP observation fixture", userId: ownerId } });
    owned.chats.push(chat.id);
    const question = await prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent("Read the accepted result"), role: "user", status: "complete"
    } });
    const answer = await prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "streaming"
    } });
    const run = await prisma.modelRun.create({ data: {
      assistantMessageId: answer.id, chatId: chat.id, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "in_progress", userId: ownerId, userMessageId: question.id
    } });
    const binding = await prisma.mcpRunBinding.create({ data: {
      modelRunId: run.id, runtimeGenerationFingerprint: generation.fingerprint, runtimeGenerationId: generation.id
    } });
    const name = namespacedMcpToolName(server.namespace, "read");
    const call = await prisma.modelRunToolCall.create({ data: {
      arguments: {}, mcpRunBindingId: binding.id, modelRunId: run.id, ordinal: 0, providerCallId: randomUUID(),
      roundIndex: 1, state: "running", toolName: name
    } });
    const service = createToolObservationService({
      repository: createToolObservationRepository({ prisma, ...createObservationSourceOwners(knowledgeObservationOwner) }),
      storage: createMemoryStorageAdapter()
    });
    const actor = { runId: run.id, userId: ownerId };
    const result = await captureMcpObservation({ producer: { ...actor, toolCallId: call.id }, service }, {
      arguments: {}, id: "provider-call", name
    }, {
      fingerprint: generation.fingerprint, originalName: "read", revisionId: server.activeRevisionId!, serverId, source: "mcp", version: 1
    }, async () => ({ isError: false, structuredContent: null, text: ["exact personal MCP bytes"], unsupportedContentTypes: [] }));
    await prisma.modelRunToolCall.update({ data: { state: "complete" }, where: { id: call.id } });

    expect((await service.read(actor, { handle: result.observation!.handle })).fragment).toContain("exact personal MCP bytes");
  });
});
