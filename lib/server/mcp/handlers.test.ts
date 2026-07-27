import type {
  AdminMcpServer,
  McpDraftConfiguration,
  McpSlotValue,
  UserMcpServer
} from "@/lib/contracts/mcp";
import type { AuthenticatedSession, RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { describe, expect, it, vi } from "vitest";
import {
  createAdminMcpActivateHandler,
  createAdminMcpCatalogHandler,
  createAdminMcpCheckUpdateHandler,
  createAdminMcpCreateHandler,
  createAdminMcpDeleteHandler,
  createAdminMcpDraftTestHandler,
  createAdminMcpGrantHandler,
  createAdminMcpRebuildHandler,
  createAdminMcpRollbackHandler,
  createAdminMcpUpdateHandler,
  createUserMcpCatalogHandler,
  createUserMcpUpdateHandler
} from "./handlers";
import { McpEncryptionError } from "./encryption";
import { McpDraftValidationUnavailableError } from "./draftValidator";
import type {
  McpRepository,
  McpRepositoryError,
  McpRepositoryResult
} from "./repositoryContract";

const SERVER_ID = "mcp-1";
const NOW = "2026-07-22T18:00:00.000Z";
const routeContext = { params: Promise.resolve({ serverId: SERVER_ID }) };
const validationEvidence = {
  evidence: { protocolVersion: "2025-06-18" },
  testedAt: NOW,
  toolInventory: [{ description: "Create a task", name: "create_task" }]
};
const revision = {
  artifactStatus: "not_applicable" as const,
  createdAt: NOW,
  draftHash: "draft-hash-1",
  id: "revision-1",
  identityHash: "identity-hash-1",
  resolvedArtifact: { digest: "sha256:abc" },
  revisionNumber: 1,
  validationEvidence
};

const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
  slots: [{
    label: "API key",
    policy: { allowPersonalOverride: true, kind: "shared" },
    sensitive: true,
    slotKey: "api-key",
    target: { kind: "environment", name: "API_KEY" },
    valueType: "secret"
  }],
  source: {
    args: ["--stdio"],
    kind: "npm",
    packageName: "@example/mcp-server",
    versionSelector: "1.2.3"
  },
  transport: "stdio"
};

function adminServer(input: Partial<AdminMcpServer> = {}): AdminMcpServer {
  return {
    activePersonalSlots: draft.slots
      .filter((slot) => slot.policy.kind === "personal" ||
        (slot.policy.kind === "shared" && slot.policy.allowPersonalOverride))
      .map((slot) => ({ label: slot.label, slotKey: slot.slotKey })),
    activeRevision: revision,
    archivedAt: null,
    description: "Example MCP",
    draft,
    draftTest: {
      draftHash: revision.draftHash,
      identityHash: revision.identityHash,
      resolvedArtifact: revision.resolvedArtifact,
      ...validationEvidence
    },
    draftTested: true,
    enabled: true,
    grants: [],
    id: SERVER_ID,
    name: "Example",
    namespace: "example",
    revisions: [revision],
    sharedValues: {},
    updatedAt: NOW,
    validationOAuth: null,
    ...input,
    activation: input.activation ?? null
  };
}

function userServer(input: Partial<UserMcpServer> = {}): UserMcpServer {
  return {
    accountLabel: null,
    description: "Example MCP",
    enabled: true,
    errorCode: null,
    fields: [{
      configured: false,
      label: "API key",
      sensitive: true,
      slotKey: "api-key",
      source: "missing",
      valueType: "secret"
    }],
    id: SERVER_ID,
    knownToolCount: 1,
    name: "Example",
    oauthAvailable: false,
    oauthState: null,
    readiness: "needs_setup",
    tools: [{ description: "Create a task", name: "create_task" }],
    ...input
  };
}

class MemoryMcpRepository implements McpRepository {
  admin = adminServer();
  activateCalls: string[] = [];
  deleteCalls: string[] = [];
  entitledUserIds = new Set(["user-1"]);
  grants: Array<Parameters<McpRepository["setGrant"]>[0]> = [];
  personalValues = new Map<string, Record<string, McpSlotValue | null>>();
  sharedValues: Record<string, McpSlotValue | null> = {};
  createCalls: Array<Parameters<McpRepository["createServer"]>[0]> = [];
  rebuildCalls: Array<Parameters<McpRepository["rebuildRevision"]>[0]> = [];
  activationCalls: Array<Parameters<McpRepository["requestActivation"]>[0]> = [];
  rollbackCalls: Array<Parameters<McpRepository["rollbackServer"]>[0]> = [];
  testDraftCalls: Array<Parameters<McpRepository["testDraft"]>[0]> = [];
  updateCalls: Array<Parameters<McpRepository["updateServer"]>[0]> = [];
  userUpdateCalls: Array<Parameters<McpRepository["updateUserServer"]>[0]> = [];
  listAdminCalls = 0;
  listUserCalls: string[] = [];
  nextError: McpRepositoryError | null = null;
  nextThrownError: Error | null = null;

  private consumeFailure<T>(): McpRepositoryResult<T> | null {
    if (this.nextThrownError) {
      const error = this.nextThrownError;
      this.nextThrownError = null;
      throw error;
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return error;
    }
    return null;
  }

  private sharedValueSummary(): AdminMcpServer["sharedValues"] {
    return Object.fromEntries(Object.entries(this.sharedValues).map(([slotKey, value]) => [
      slotKey,
      { configured: value !== null, updatedAt: NOW }
    ]));
  }

  async activateDraft(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.activateCalls.push(serverId);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (serverId !== this.admin.id || this.admin.archivedAt) return { kind: "not_found" };
    this.admin = { ...this.admin, enabled: true };
    return { kind: "ok", value: this.admin };
  }

  async deleteServer(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.deleteCalls.push(serverId);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (serverId !== this.admin.id || this.admin.archivedAt) return { kind: "not_found" };
    this.admin = { ...this.admin, archivedAt: NOW, enabled: false };
    return { kind: "ok", value: this.admin };
  }

  async createServer(input: Parameters<McpRepository["createServer"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.createCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    this.sharedValues = { ...input.sharedValues };
    this.admin = adminServer({
      activeRevision: null,
      activation: input.activate ? {
        completedAt: null,
        errorCode: null,
        id: "activation-1",
        issues: [],
        requestedAt: NOW,
        stage: "queued",
        startedAt: null,
        updatedAt: NOW
      } : null,
      description: input.description,
      draft: input.draft,
      draftTest: null,
      draftTested: false,
      name: input.name,
      revisions: [],
      sharedValues: this.sharedValueSummary()
    });
    return { kind: "ok", value: this.admin };
  }

  async listAdminServers(): Promise<AdminMcpServer[]> {
    this.listAdminCalls += 1;
    this.consumeFailure<never>();
    return this.admin.archivedAt ? [] : [this.admin];
  }

  async listUserServers(userId: string): Promise<UserMcpServer[]> {
    this.listUserCalls.push(userId);
    this.consumeFailure<never>();
    if (!this.entitledUserIds.has(userId)) return [];
    const values = this.personalValues.get(userId) ?? {};
    const configured = Object.hasOwn(values, "api-key") && values["api-key"] !== null;
    return [userServer({
      fields: [{
        configured,
        label: "API key",
        sensitive: true,
        slotKey: "api-key",
        source: configured ? "personal" : "missing",
        valueType: "secret"
      }],
      readiness: configured ? "ready" : "needs_setup"
    })];
  }

  async rebuildRevision(input: Parameters<McpRepository["rebuildRevision"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.rebuildCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (input.serverId !== this.admin.id || input.revisionId !== revision.id) return { kind: "not_found" };
    return { kind: "ok", value: this.admin };
  }

  async requestActivation(
    input: Parameters<McpRepository["requestActivation"]>[0]
  ): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.activationCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    this.admin = {
      ...this.admin,
      activation: {
        completedAt: null,
        errorCode: null,
        id: "activation-1",
        issues: [],
        requestedAt: NOW,
        stage: "queued",
        startedAt: null,
        updatedAt: NOW
      }
    };
    return { kind: "ok", value: this.admin };
  }

  async rollbackServer(input: Parameters<McpRepository["rollbackServer"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.rollbackCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (input.serverId !== this.admin.id || input.revisionId !== revision.id) return { kind: "not_found" };
    this.admin = { ...this.admin, activeRevision: revision };
    return { kind: "ok", value: this.admin };
  }

  async setGrant(input: Parameters<McpRepository["setGrant"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.grants.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    return { kind: "ok", value: this.admin };
  }

  async testDraft(input: Parameters<McpRepository["testDraft"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.testDraftCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (input.serverId !== this.admin.id) return { kind: "not_found" };
    this.admin = {
      ...this.admin,
      draftTest: {
        draftHash: revision.draftHash,
        identityHash: revision.identityHash,
        resolvedArtifact: revision.resolvedArtifact,
        ...validationEvidence
      },
      draftTested: true
    };
    return { kind: "ok", value: this.admin };
  }

  async updateServer(input: Parameters<McpRepository["updateServer"]>[0]): Promise<McpRepositoryResult<AdminMcpServer>> {
    this.updateCalls.push(input);
    const failure = this.consumeFailure<AdminMcpServer>();
    if (failure) return failure;
    if (input.serverId !== this.admin.id) return { kind: "not_found" };
    if (input.sharedValues) this.sharedValues = { ...this.sharedValues, ...input.sharedValues };
    this.admin = {
      ...this.admin,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.draft ? { draft: input.draft, draftTest: null, draftTested: false } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      sharedValues: this.sharedValueSummary()
    };
    return { kind: "ok", value: this.admin };
  }

  async updateUserServer(input: Parameters<McpRepository["updateUserServer"]>[0]): Promise<McpRepositoryResult<UserMcpServer>> {
    this.userUpdateCalls.push(input);
    const failure = this.consumeFailure<UserMcpServer>();
    if (failure) return failure;
    if (!this.entitledUserIds.has(input.userId) || input.serverId !== SERVER_ID) {
      return { kind: "not_found" };
    }
    const values = { ...(this.personalValues.get(input.userId) ?? {}), ...(input.values ?? {}) };
    this.personalValues.set(input.userId, values);
    const configured = Object.hasOwn(values, "api-key") && values["api-key"] !== null;
    return {
      kind: "ok",
      value: userServer({
        enabled: input.enabled ?? true,
        fields: [{
          configured,
          label: "API key",
          sensitive: true,
          slotKey: "api-key",
          source: configured ? "personal" : "missing",
          valueType: "secret"
        }],
        readiness: configured ? "ready" : "needs_setup"
      })
    };
  }
}

function session(userId: string, role: "admin" | "user", status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-07-23T18:00:00.000Z"),
    id: `session-${userId}`,
    user: {
      displayName: userId,
      email: `${userId}@example.test`,
      id: userId,
      role,
      status
    },
    userId
  };
}

const sessions = new Map([
  ["admin", session("admin", "admin")],
  ["disabled-admin", session("disabled-admin", "admin", "disabled")],
  ["user-1", session("user-1", "user")],
  ["user-2", session("user-2", "user")]
]);

const resolveAuth: RequestAuthResolver = async (request) =>
  sessions.get(request.headers.get("x-test-user") ?? "") ?? null;

function request(input: {
  body?: unknown;
  contentType?: string;
  method?: string;
  user?: string;
} = {}): Request {
  const headers = new Headers();
  if (input.user) headers.set("x-test-user", input.user);
  if (input.contentType) headers.set("content-type", input.contentType);
  return new Request("https://aiqsa.example.test/api/mcp", {
    ...(typeof input.body !== "undefined" ? { body: JSON.stringify(input.body) } : {}),
    headers,
    method: input.method ?? (typeof input.body === "undefined" ? "GET" : "POST")
  });
}

function deps(repository: McpRepository) {
  return { repository, resolveAuth };
}

describe("MCP handler authorization", () => {
  it("separates anonymous, ordinary-user, inactive-admin, and active-admin catalog access", async () => {
    const repository = new MemoryMcpRepository();
    const GET = createAdminMcpCatalogHandler(deps(repository));

    const anonymous = await GET(request());
    const ordinary = await GET(request({ user: "user-1" }));
    const inactiveAdmin = await GET(request({ user: "disabled-admin" }));
    const admin = await GET(request({ user: "admin" }));

    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toEqual({ error: "unauthorized" });
    expect(ordinary.status).toBe(403);
    await expect(ordinary.json()).resolves.toEqual({ error: "forbidden" });
    expect(inactiveAdmin.status).toBe(403);
    await expect(inactiveAdmin.json()).resolves.toEqual({ error: "forbidden" });
    expect(admin.status).toBe(200);
    await expect(admin.json()).resolves.toMatchObject({ servers: [{ id: SERVER_ID }] });
    expect(repository.listAdminCalls).toBe(1);
  });

  it("allows an authenticated ordinary user to see only their entitled MCP catalog", async () => {
    const repository = new MemoryMcpRepository();
    const GET = createUserMcpCatalogHandler(deps(repository));

    const anonymous = await GET(request());
    const entitled = await GET(request({ user: "user-1" }));
    const unentitled = await GET(request({ user: "user-2" }));

    expect(anonymous.status).toBe(401);
    expect(entitled.status).toBe(200);
    await expect(entitled.json()).resolves.toMatchObject({
      servers: [{ id: SERVER_ID, tools: [{ name: "create_task" }] }]
    });
    await expect(unentitled.json()).resolves.toEqual({ servers: [] });
    expect(repository.listUserCalls).toEqual(["user-1", "user-2"]);
  });

  it("allows only active administrators to run MCP revision lifecycle actions", async () => {
    const lifecycleHandlers = [
      {
        call: (repository: McpRepository, user: string) => createAdminMcpDraftTestHandler(deps(repository))(
          request({ body: {}, contentType: "application/json", user }),
          routeContext
        ),
        calls: (repository: MemoryMcpRepository) => repository.testDraftCalls.length
      },
      {
        call: (repository: McpRepository, user: string) => createAdminMcpCheckUpdateHandler(deps(repository))(
          request({ body: {}, contentType: "application/json", user }),
          routeContext
        ),
        calls: (repository: MemoryMcpRepository) => repository.testDraftCalls.length
      },
      {
        call: (repository: McpRepository, user: string) => createAdminMcpActivateHandler(deps(repository))(
          request({ method: "POST", user }),
          routeContext
        ),
        calls: (repository: MemoryMcpRepository) => repository.activateCalls.length
      },
      {
        call: (repository: McpRepository, user: string) => createAdminMcpRebuildHandler(deps(repository))(
          request({
            body: { revisionId: revision.id },
            contentType: "application/json",
            user
          }),
          routeContext
        ),
        calls: (repository: MemoryMcpRepository) => repository.rebuildCalls.length
      },
      {
        call: (repository: McpRepository, user: string) => createAdminMcpRollbackHandler(deps(repository))(
          request({
            body: { revisionId: revision.id },
            contentType: "application/json",
            user
          }),
          routeContext
        ),
        calls: (repository: MemoryMcpRepository) => repository.rollbackCalls.length
      }
    ];

    for (const lifecycle of lifecycleHandlers) {
      const repository = new MemoryMcpRepository();
      expect((await lifecycle.call(repository, "")).status).toBe(401);
      expect((await lifecycle.call(repository, "user-1")).status).toBe(403);
      expect((await lifecycle.call(repository, "disabled-admin")).status).toBe(403);
      expect(lifecycle.calls(repository)).toBe(0);
      expect((await lifecycle.call(repository, "admin")).status).toBe(200);
      expect(lifecycle.calls(repository)).toBe(1);
    }
  });

  it("allows only an active administrator to irreversibly remove a server from the catalog", async () => {
    const repository = new MemoryMcpRepository();
    const remove = createAdminMcpDeleteHandler(deps(repository));
    const catalog = createAdminMcpCatalogHandler(deps(repository));

    expect((await remove(request({ method: "DELETE" }), routeContext)).status).toBe(401);
    expect((await remove(request({ method: "DELETE", user: "user-1" }), routeContext)).status).toBe(403);
    expect((await remove(request({ method: "DELETE", user: "disabled-admin" }), routeContext)).status).toBe(403);
    expect(repository.deleteCalls).toEqual([]);

    const deleted = await remove(request({ method: "DELETE", user: "admin" }), routeContext);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      server: { archivedAt: NOW, enabled: false, id: SERVER_ID }
    });
    expect(repository.deleteCalls).toEqual([SERVER_ID]);

    const afterDelete = await catalog(request({ user: "admin" }));
    await expect(afterDelete.json()).resolves.toEqual({ servers: [] });
    expect((await remove(request({ method: "DELETE", user: "admin" }), routeContext)).status).toBe(404);
  });
});

describe("MCP handler input validation", () => {
  it("requires JSON media types and accepts structured +json media types", async () => {
    const repository = new MemoryMcpRepository();
    const create = createAdminMcpCreateHandler(deps(repository));
    const updateUser = createUserMcpUpdateHandler(deps(repository));
    const createBody = { draft, name: "Example", sharedValues: {} };

    const wrongType = await create(request({
      body: createBody,
      contentType: "text/plain",
      user: "admin"
    }));
    const acceptedType = await updateUser(request({
      body: { enabled: false },
      contentType: "application/merge-patch+json; charset=utf-8",
      method: "PATCH",
      user: "user-1"
    }), routeContext);

    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toEqual({ error: "json_required" });
    expect(repository.createCalls).toEqual([]);
    expect(acceptedType.status).toBe(200);
    expect(repository.userUpdateCalls).toHaveLength(1);
  });

  it("returns bounded draft validation issues before calling the repository", async () => {
    const repository = new MemoryMcpRepository();
    const create = createAdminMcpCreateHandler(deps(repository));
    const response = await create(request({
      body: {
        draft: { ...draft, source: { args: [], image: "bad image", kind: "oci" } },
        name: "Broken"
      },
      contentType: "application/json",
      user: "admin"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_draft",
      issues: expect.arrayContaining([{ code: "oci_image_invalid", path: "source.image" }])
    });
    expect(repository.createCalls).toEqual([]);
  });

  it("accepts shared and personal secrets without returning either plaintext value", async () => {
    const repository = new MemoryMcpRepository();
    const create = createAdminMcpCreateHandler(deps(repository));
    const updateUser = createUserMcpUpdateHandler(deps(repository));
    const sharedSecret = "shared-secret-must-not-echo";
    const personalSecret = "personal-secret-must-not-echo";

    const created = await create(request({
      body: {
        draft,
        name: "Secrets",
        sharedValues: { "api-key": sharedSecret }
      },
      contentType: "application/json",
      user: "admin"
    }));
    const createdText = await created.text();

    const updated = await updateUser(request({
      body: { values: { "api-key": personalSecret } },
      contentType: "application/json",
      method: "PATCH",
      user: "user-1"
    }), routeContext);
    const updatedText = await updated.text();

    expect(created.status).toBe(201);
    expect(repository.sharedValues["api-key"]).toBe(sharedSecret);
    expect(createdText).not.toContain(sharedSecret);
    expect(JSON.parse(createdText)).toMatchObject({
      server: { sharedValues: { "api-key": { configured: true } } }
    });
    expect(updated.status).toBe(200);
    expect(repository.personalValues.get("user-1")?.["api-key"]).toBe(personalSecret);
    expect(updatedText).not.toContain(personalSecret);
    expect(JSON.parse(updatedText)).toMatchObject({
      server: { fields: [{ configured: true, slotKey: "api-key" }] }
    });
  });

  it("accepts an empty description when creating or clearing a server description", async () => {
    const repository = new MemoryMcpRepository();
    const create = createAdminMcpCreateHandler(deps(repository));
    const update = createAdminMcpUpdateHandler(deps(repository));

    const created = await create(request({
      body: { description: "", draft, name: "No description", sharedValues: {} },
      contentType: "application/json",
      user: "admin"
    }));
    const updated = await update(request({
      body: { description: "" },
      contentType: "application/json",
      method: "PATCH",
      user: "admin"
    }), routeContext);

    expect(created.status).toBe(201);
    expect(repository.createCalls[0]?.description).toBe("");
    expect(updated.status).toBe(200);
    expect(repository.updateCalls[0]?.description).toBe("");
  });

  it("accepts only an exact direct-user or group grant shape", async () => {
    const repository = new MemoryMcpRepository();
    const grant = createAdminMcpGrantHandler(deps(repository));
    const send = (body: Record<string, unknown>) => grant(request({
      body,
      contentType: "application/json",
      method: "PUT",
      user: "admin"
    }), routeContext);

    expect((await send({
      canUse: false,
      personalSlotKeys: ["api-key"],
      userId: "user-1"
    })).status).toBe(200);
    expect((await send({
      canUse: true,
      groupId: "group-1",
      personalSlotKeys: []
    })).status).toBe(200);

    const invalidBodies: Record<string, unknown>[] = [
      { canUse: true },
      { canUse: true, groupId: "group-1", userId: "user-1" },
      { canUse: true, groupId: "group-1", personalSlotKeys: ["api-key"] },
      { canUse: true, personalSlotKeys: "api-key", userId: "user-1" },
      { canUse: true, personalSlotKeys: ["api-key", 42], userId: "user-1" },
      { canUse: true, personalSlotKeys: ["api-key", "api-key"], userId: "user-1" },
      { canUse: true, groupId: "group-1", userId: " " },
      { canUse: "yes", userId: "user-1" }
    ];
    for (const body of invalidBodies) {
      const response = await send(body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_grant" });
    }

    expect(repository.grants).toEqual([
      {
        canUse: false,
        groupId: null,
        personalSlotKeys: ["api-key"],
        serverId: SERVER_ID,
        userId: "user-1"
      },
      {
        canUse: true,
        groupId: "group-1",
        personalSlotKeys: [],
        serverId: SERVER_ID,
        userId: null
      }
    ]);
  });

  it("returns the repository refusal when a system-group MCP grant is immutable", async () => {
    const repository = new MemoryMcpRepository();
    repository.nextError = {
      issues: [{ code: "system_group_grant_immutable", path: "groupId" }],
      kind: "invalid_grant"
    };
    const grant = createAdminMcpGrantHandler(deps(repository));
    const response = await grant(request({
      body: { canUse: false, groupId: "group-full-access" },
      contentType: "application/json",
      method: "PUT",
      user: "admin"
    }), routeContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      issues: [{ code: "system_group_grant_immutable", path: "groupId" }]
    });
    expect(repository.grants).toEqual([{
      canUse: false,
      groupId: "group-full-access",
      personalSlotKeys: [],
      serverId: SERVER_ID,
      userId: null
    }]);
  });

  it("forwards optional one-time draft-test values without echoing them", async () => {
    const repository = new MemoryMcpRepository();
    const testDraft = createAdminMcpDraftTestHandler(deps(repository));
    const oneTimeSecret = "one-time-secret-must-not-echo";
    const response = await testDraft(request({
      body: { oneTimeValues: { "api-key": oneTimeSecret } },
      contentType: "application/json",
      user: "admin"
    }), routeContext);
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(repository.testDraftCalls).toEqual([{
      oneTimeValues: { "api-key": oneTimeSecret },
      serverId: SERVER_ID,
      validationUserId: "admin"
    }]);
    expect(responseText).not.toContain(oneTimeSecret);
    expect(JSON.parse(responseText)).toMatchObject({
      server: {
        draftTest: {
          toolInventory: [{ name: "create_task" }]
        },
        draftTested: true
      }
    });

    const optionalValues = await testDraft(request({
      body: {},
      contentType: "application/json",
      user: "admin"
    }), routeContext);
    expect(optionalValues.status).toBe(200);
    expect(repository.testDraftCalls[1]).toEqual({
      oneTimeValues: {},
      serverId: SERVER_ID,
      validationUserId: "admin"
    });
  });

  it("activates and rolls back through explicit lifecycle actions", async () => {
    const repository = new MemoryMcpRepository();
    const activate = createAdminMcpActivateHandler(deps(repository));
    const rollback = createAdminMcpRollbackHandler(deps(repository));

    expect((await activate(request({ method: "POST", user: "admin" }), routeContext)).status).toBe(200);
    expect((await rollback(request({
      body: { revisionId: revision.id },
      contentType: "application/json",
      user: "admin"
    }), routeContext)).status).toBe(200);
    expect(repository.activateCalls).toEqual([SERVER_ID]);
    expect(repository.rollbackCalls).toEqual([{ revisionId: revision.id, serverId: SERVER_ID }]);
  });

  it("acknowledges atomic create-and-activate immediately and kicks background work", async () => {
    const repository = new MemoryMcpRepository();
    const onActivationRequested = vi.fn();
    const create = createAdminMcpCreateHandler({
      onActivationRequested,
      repository,
      resolveAuth
    });
    const response = await create(request({
      body: {
        activate: true,
        draft,
        name: "Async MCP",
        sharedValues: { "api-key": "persisted-secret" }
      },
      contentType: "application/json",
      user: "admin"
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      server: { activation: { stage: "queued" } }
    });
    expect(repository.createCalls[0]).toMatchObject({
      activate: true,
      validationUserId: "admin"
    });
    expect(onActivationRequested).toHaveBeenCalledOnce();
  });

  it("queues an untested draft from Activate without a second activation request", async () => {
    const repository = new MemoryMcpRepository();
    const onActivationRequested = vi.fn();
    repository.nextError = { kind: "revision_required" };
    const activate = createAdminMcpActivateHandler({
      onActivationRequested,
      repository,
      resolveAuth
    });
    const response = await activate(request({ method: "POST", user: "admin" }), routeContext);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      server: { activation: { stage: "queued" } }
    });
    expect(repository.activationCalls).toEqual([{
      serverId: SERVER_ID,
      validationUserId: "admin"
    }]);
    expect(onActivationRequested).toHaveBeenCalledOnce();
  });

  it("checks for package updates and rebuilds a selected revision through explicit actions", async () => {
    const repository = new MemoryMcpRepository();
    const checkUpdate = createAdminMcpCheckUpdateHandler(deps(repository));
    const rebuild = createAdminMcpRebuildHandler(deps(repository));
    const oneTimeSecret = "rebuild-one-time-secret";

    expect((await checkUpdate(request({
      body: {},
      contentType: "application/json",
      user: "admin"
    }), routeContext)).status).toBe(200);
    const rebuilt = await rebuild(request({
      body: {
        oneTimeValues: { "api-key": oneTimeSecret },
        replaceDraft: true,
        revisionId: revision.id
      },
      contentType: "application/json",
      user: "admin"
    }), routeContext);
    const responseText = await rebuilt.text();

    expect(rebuilt.status).toBe(200);
    expect(repository.testDraftCalls).toEqual([{
      oneTimeValues: {},
      serverId: SERVER_ID,
      validationUserId: "admin"
    }]);
    expect(repository.rebuildCalls).toEqual([{
      oneTimeValues: { "api-key": oneTimeSecret },
      replaceDraft: true,
      revisionId: revision.id,
      serverId: SERVER_ID,
      validationUserId: "admin"
    }]);
    expect(responseText).not.toContain(oneTimeSecret);
  });
});

describe("MCP repository error mapping", () => {
  const cases: Array<[McpRepositoryError, number, Record<string, unknown>]> = [
    [{ kind: "not_found" }, 404, { error: "mcp_not_found" }],
    [{ kind: "artifact_missing" }, 409, { error: "mcp_artifact_missing" }],
    [{ kind: "draft_changed" }, 409, { error: "mcp_draft_changed" }],
    [{ kind: "revision_required" }, 409, { error: "mcp_revision_required" }],
    [{
      issues: [{ code: "connection_failed", path: "transport" }],
      kind: "draft_validation_failed"
    }, 422, {
      error: "mcp_draft_test_failed",
      issues: [{ code: "connection_failed", path: "transport" }]
    }],
    [{
      issues: [{ code: "unknown_slot", path: "personalSlotKeys.0" }],
      kind: "invalid_grant"
    }, 400, {
      error: "invalid_grant",
      issues: [{ code: "unknown_slot", path: "personalSlotKeys.0" }]
    }],
    [{
      issues: [{ code: "slot_value_invalid", path: "values.api-key" }],
      kind: "invalid_values"
    }, 400, {
      error: "invalid_mcp_values",
      issues: [{ code: "slot_value_invalid", path: "values.api-key" }]
    }]
  ];

  it.each(cases)("maps %o to its stable response", async (repositoryError, status, body) => {
    const repository = new MemoryMcpRepository();
    repository.nextError = repositoryError;
    const update = createAdminMcpUpdateHandler(deps(repository));
    const response = await update(request({
      body: { enabled: false },
      contentType: "application/json",
      method: "PATCH",
      user: "admin"
    }), routeContext);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
  });

  it("maps unavailable encryption to a service error without exposing its cause", async () => {
    const repository = new MemoryMcpRepository();
    repository.nextThrownError = new McpEncryptionError("mcp_encryption_invalid_key");
    const GET = createAdminMcpCatalogHandler(deps(repository));
    const response = await GET(request({ user: "admin" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "mcp_encryption_unavailable" });
  });

  it("maps an unavailable live draft validator to a service error", async () => {
    const repository = new MemoryMcpRepository();
    repository.nextThrownError = new McpDraftValidationUnavailableError();
    const testDraft = createAdminMcpDraftTestHandler(deps(repository));
    const response = await testDraft(request({
      body: {},
      contentType: "application/json",
      user: "admin"
    }), routeContext);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "mcp_validation_unavailable" });
  });
});
