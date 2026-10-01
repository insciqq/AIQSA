import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { createMcpSafeFetch } from "./safeFetch";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { loadMcpCapabilityCatalog } from "./runPlanRepository";

const key = Buffer.alloc(32, 7);
const userIds: string[] = [];
const serverIds: string[] = [];
const clientIds: string[] = [];
const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "http://mcp.example.test/mcp" },
  transport: "streamable_http"
};
const redirectUri = (serverId: string) => `https://app.example.test/api/me/mcp/${serverId}/oauth/callback`;

async function startPersonalMcpPeer() {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const tools: Tool[] = [
    { description: "Read fixture", inputSchema: { type: "object" }, name: "read" },
    { description: "Write fixture", inputSchema: { type: "object" }, name: "write" }
  ];
  const open = async () => {
    const server = new Server({ name: "aiqsa-personal-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request) => ({
      content: [{ text: request.params.name === "write" ? "written" : "read", type: "text" }]
    }));
    let transport!: NodeStreamableHTTPServerTransport;
    transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      onsessionclosed: (id) => { transports.delete(id); },
      onsessioninitialized: (id) => { transports.set(id, transport); },
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    return transport;
  };
  const http: HttpServer = createServer((request, response) => {
    void (async () => {
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const transport = sessionId ? transports.get(sessionId) : request.method === "POST" ? await open() : undefined;
      if (!transport) { response.statusCode = sessionId ? 404 : 400; response.end(); return; }
      await transport.handleRequest(request, response);
    })().catch(() => { if (!response.headersSent) { response.statusCode = 500; response.end(); } });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  return {
    close: async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
  };
}

afterEach(async () => {
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { OR: [
    { revision: { serverId: { in: serverIds } } },
    { userServer: { serverId: { in: serverIds } } }
  ] } });
  await prisma.mcpUserServer.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpGrant.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds.splice(0) } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: clientIds.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

async function user() {
  const created = await prisma.user.create({ data: {
    displayName: "Personal MCP fixture", email: `mcp-personal-${randomUUID()}@example.test`, status: "active"
  } });
  userIds.push(created.id);
  return created.id;
}

function repository() {
  const validate = vi.fn(async () => ({
    kind: "ok" as const, evidence: { protocol: "fixture" }, resolvedArtifact: null,
    toolInventory: [{ name: "read", description: "Read fixture" }, { name: "write", description: "Write fixture" }]
  }));
  return { validate, storage: createPrismaMcpRepository({
    encryptionKey: () => key, prisma, draftValidator: { validate }, oauthRedirectUri: redirectUri
  }) };
}

describe("personal MCP persistence and isolation", () => {
  it("creates an enabled HTTP connection only in its owner's catalog and keeps switched-off tools listed for re-enabling", async () => {
    const ownerId = await user();
    const otherId = await user();
    const { storage, validate } = repository();
    const created = await storage.createPersonalServer!({ description: "", draft, name: "Personal fixture", userId: ownerId, values: {} });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    const serverId = created.value.id;
    serverIds.push(serverId);
    expect(validate).toHaveBeenCalledOnce();
    // The validator's listing seeds discovery: Settings lists tools before any runtime is ready.
    expect(created.value).toMatchObject({ enabled: true, knownToolCount: 2, sourceType: "personal", userDisabledToolNames: [], availableTools: [
      { name: "read", description: "Read fixture" }, { name: "write", description: "Write fixture" }
    ] });
    expect(await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } }))
      .toMatchObject({ discoveredOAuthConnectionId: null, discoveredRevisionId: expect.any(String), userDisabledToolNames: [] });
    expect(await storage.listAdminServers()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: serverId })]));
    expect(await storage.listUserServers(otherId)).toEqual([]);
    // Stray grants cannot publish a personal server into another user's catalog.
    await prisma.mcpGrant.create({ data: { canUse: true, serverId, userId: otherId } });
    expect(await storage.listUserServers(otherId)).toEqual([]);
    expect(await storage.updateUserServer({ enabled: true, personalOnly: true, serverId, userId: otherId })).toEqual({ kind: "not_found" });
    expect(await storage.deletePersonalServer!({ serverId, userId: otherId })).toEqual({ kind: "not_found" });
    expect(await storage.updateServer({ enabled: false, serverId })).toEqual({ kind: "not_found" });
    expect(await storage.deleteServer(serverId)).toEqual({ kind: "not_found" });
    expect(await storage.setGrant({ canUse: true, groupId: null, personalSlotKeys: [], serverId, userId: otherId })).toEqual({ kind: "not_found" });
    expect(await storage.activateDraft(serverId)).toEqual({ kind: "not_found" });
    const disabled = await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: false, name: "write" }, userId: ownerId });
    expect(disabled).toMatchObject({ kind: "ok", value: { knownToolCount: 1, userDisabledToolNames: ["write"], availableTools: [
      { name: "read" }, { name: "write" }
    ] } });
    expect(await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: false, name: "missing" }, userId: ownerId }))
      .toMatchObject({ kind: "invalid_values", issues: [{ code: "tool_not_available", path: "tool.name" }] });
    expect(await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: true, name: "write" }, userId: ownerId }))
      .toMatchObject({ kind: "ok", value: { userDisabledToolNames: [] } });
    expect(await storage.deletePersonalServer!({ serverId, userId: ownerId })).toMatchObject({ kind: "ok" });
    expect(await storage.listUserServers(ownerId)).toEqual([]);
  });

  it("runs a personal HTTP MCP through discovery and Auto, and switches tools on the same runtime generation", async () => {
    const peer = await startPersonalMcpPeer();
    const ownerId = await user();
    const otherId = await user();
    // This fixture injects loopback permission directly into test repository
    // dependencies. The personal HTTP API never accepts allowPrivateNetwork.
    const configuration: McpDraftConfiguration = {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
      slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: peer.url },
      transport: "streamable_http"
    };
    const validator = createRemoteMcpDraftValidator({
      fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true })
    });
    const storage = createPrismaMcpRepository({ encryptionKey: () => key, prisma, draftValidator: validator, oauthRedirectUri: redirectUri });
    const created = await storage.createPersonalServer!({ description: "Synthetic HTTP MCP", draft: configuration, name: "Loopback fixture", userId: ownerId, values: {} });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
    const serverId = created.value.id;
    serverIds.push(serverId);
    expect(created.value).toMatchObject({ availableTools: [{ name: "read" }, { name: "write" }], sourceType: "personal" });
    expect(await storage.listUserServers(otherId)).toEqual([]);
    const runtime = new McpRuntimeCoordinator({
      repository: createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma }),
      sessions: createMcpClientSessionFactory({
        fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }),
        limits: { ...MCP_INVENTORY_SESSION_LIMITS, maxToolArgumentBytes: getMcpRequestMaxBytes() }
      })
    });
    const desiredGeneration = async () => (await prisma.mcpUserServer.findUniqueOrThrow({
      where: { userId_serverId: { userId: ownerId, serverId } }
    })).desiredRuntimeGenerationId;
    const generationCount = () => prisma.mcpRuntimeGeneration.count({ where: { userServer: { serverId } } });
    const catalogNames = async () => (await loadMcpCapabilityCatalog(ownerId, prisma)).servers
      .flatMap((server) => server.tools.map((tool) => tool.originalName));
    try {
      await runtime.ensureUserServersReady(ownerId, [serverId]);
      const generationId = await desiredGeneration();
      const generation = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: generationId! } });
      expect(generation.state).toBe("ready");
      const catalog = await loadMcpCapabilityCatalog(ownerId, prisma);
      expect(catalog.servers).toEqual([expect.objectContaining({ serverId })]);
      expect(await catalogNames()).toEqual(["read", "write"]);
      const generations = await generationCount();

      expect(await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: false, name: "write" }, userId: ownerId }))
        .toMatchObject({ kind: "ok", value: { userDisabledToolNames: ["write"], availableTools: [{ name: "read" }, { name: "write" }] } });
      // A switch keeps the runtime: the desired generation stays and the on-demand sync selects it again.
      expect(await desiredGeneration()).toBe(generationId);
      await runtime.ensureUserServersReady(ownerId, [serverId]);
      expect(await desiredGeneration()).toBe(generationId);
      expect(await catalogNames()).toEqual(["read"]);

      expect(await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: false, name: "read" }, userId: ownerId }))
        .toMatchObject({ kind: "ok", value: { userDisabledToolNames: ["read", "write"] } });
      await runtime.ensureUserServersReady(ownerId, [serverId]);
      expect((await loadMcpCapabilityCatalog(ownerId, prisma)).servers.flatMap((server) => server.tools)).toEqual([]);

      await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: true, name: "read" }, userId: ownerId });
      await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: true, name: "write" }, userId: ownerId });
      await runtime.ensureUserServersReady(ownerId, [serverId]);
      expect(await catalogNames()).toEqual(["read", "write"]);
      expect(await desiredGeneration()).toBe(generationId);
      expect(await generationCount()).toBe(generations);
      expect(runtime.hasLiveGeneration(generationId!)).toBe(true);
      expect(await storage.updateUserServer({ enabled: true, personalOnly: true, serverId, userId: otherId })).toEqual({ kind: "not_found" });
      expect(await storage.deletePersonalServer!({ serverId, userId: ownerId })).toMatchObject({ kind: "ok" });
      expect(await storage.listUserServers(ownerId)).toEqual([]);
      expect(await storage.listUserServers(otherId)).toEqual([]);
    } finally {
      await runtime.stop();
      await peer.close();
    }
  });

  it("allows only owner OAuth, then re-enables a switched-off tool from the current OAuth inventory", async () => {
    const ownerId = await user();
    const otherId = await user();
    await prisma.user.update({ data: { role: "admin" }, where: { id: otherId } });
    const { storage, validate } = repository();
    const created = await storage.createPersonalServer!({ description: "", draft: {
      ...draft, auth: { mode: "oauth", allowedAuthorizationServerOrigins: ["https://auth.example.test"], scopes: [] }
    }, name: "OAuth fixture", userId: ownerId, values: {} });
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    const serverId = created.value.id;
    serverIds.push(serverId);
    expect(validate).not.toHaveBeenCalled();
    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = { redirectUri: redirectUri(serverId), serverId, userId: ownerId };
    const policy = await oauth.loadPolicy({ ...query, purpose: "user" });
    if (!policy) throw new Error("fixture_policy_missing");
    await expect(oauth.prepareValidationPolicy({ ...query, userId: otherId })).resolves.toBeNull();
    await expect(oauth.loadPolicy({ ...query, purpose: "validation", userId: otherId })).resolves.toBeNull();
    await prisma.mcpGrant.create({ data: { canUse: true, serverId, userId: otherId } });
    await expect(oauth.loadPolicy({ ...query, purpose: "user", userId: otherId })).resolves.toBeNull();
    const client = await oauth.saveClient({
      clientInformation: { client_id: `fixture-${randomUUID()}` }, clientMetadata: { redirect_uris: [query.redirectUri] },
      registrationKey: randomUUID(), discoveryState: { authorizationServerUrl: "https://auth.example.test" }
    });
    clientIds.push(client.id);
    const connection = await oauth.createConnection({ ...query, purpose: "user", clientId: client.clientInformation.client_id,
      configurationIdentity: policy.configurationIdentity, externalAccountLabel: null, oauthClientId: client.id,
      policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id), resource: policy.resource,
      tokens: { access_token: "synthetic-personal-access", token_type: "Bearer" }
    });
    if (connection.kind !== "ok") throw new Error("fixture_authorization_failed");
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { userId: ownerId, serverId } } });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      fingerprint: randomUUID(), oauthConnectionId: connection.value.id, revisionId: policy.configurationIdentity,
      userServerId: preference.id, state: "ready", inventory: { version: 1, tools: [
        { name: "read", description: "Read fixture", inputSchema: { type: "object" }, definitionHash: "a".repeat(64) },
        { name: "write", description: "Write fixture", inputSchema: { type: "object" }, definitionHash: "b".repeat(64) }
      ], exclusions: [] }
    } });
    await prisma.mcpUserServer.update({ where: { id: preference.id }, data: {
      desiredRuntimeGenerationId: generation.id, userDisabledToolNames: ["write"]
    } });
    const updated = await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: true, name: "write" }, userId: ownerId });
    expect(updated).toMatchObject({ kind: "ok", value: { userDisabledToolNames: [], availableTools: [
      { name: "read" }, { name: "write" }
    ] } });
    expect((await prisma.mcpUserServer.findUniqueOrThrow({ where: { id: preference.id } })).desiredRuntimeGenerationId)
      .toBe(generation.id);
  });
});
