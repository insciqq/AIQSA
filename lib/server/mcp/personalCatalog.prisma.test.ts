import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_RUN_PLAN_LIMITS, type McpDraftConfiguration } from "@/lib/contracts/mcp";
import { startMutableMcpEndpoint, type MutableMcpEndpoint, type MutableMcpTool } from "@/tests/e2e/support/mutableMcpEndpoint";
import { prisma } from "../prisma";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { prepareMcpRunPlan } from "./runPlan";
import { loadMcpCapabilityCatalog, loadMcpRunPlanRecordsForServers } from "./runPlanRepository";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch } from "./safeFetch";

const key = Buffer.alloc(32, 9);
const userIds: string[] = [];
const serverIds: string[] = [];
const clientIds: string[] = [];
const redirectUri = (serverId: string) => `https://app.example.test/api/me/mcp/${serverId}/oauth/callback`;

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
    displayName: "Personal catalog fixture", email: `mcp-catalog-${randomUUID()}@example.test`, status: "active"
  } });
  userIds.push(created.id);
  return created.id;
}

function tool(name: string): MutableMcpTool {
  return { description: `${name} fixture`, inputSchema: { type: "object" }, name };
}

/**
 * A personal no-auth server on a loopback peer that changes its tools while
 * the runtime stays connected. Loopback permission is injected into these
 * test dependencies only; the personal HTTP API never accepts it.
 */
async function connectedPersonalServer(endpoint: MutableMcpEndpoint) {
  const ownerId = await user();
  const fetch = createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true });
  const storage = createPrismaMcpRepository({
    draftValidator: createRemoteMcpDraftValidator({ fetch }), encryptionKey: () => key, oauthRedirectUri: redirectUri, prisma
  });
  const configuration: McpDraftConfiguration = {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
    slots: [],
    source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url },
    transport: "streamable_http"
  };
  const created = await storage.createPersonalServer!({ description: "", draft: configuration, name: "Mutable fixture", userId: ownerId, values: {} });
  if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
  const serverId = created.value.id;
  serverIds.push(serverId);
  const runtime = new McpRuntimeCoordinator({
    repository: createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma }),
    sessions: createMcpClientSessionFactory({ fetch, limits: { ...MCP_INVENTORY_SESSION_LIMITS, maxToolArgumentBytes: getMcpRequestMaxBytes() } })
  });
  const preference = () => prisma.mcpUserServer.findUniqueOrThrow({
    include: { desiredRuntimeGeneration: true }, where: { userId_serverId: { serverId, userId: ownerId } }
  });
  const catalogNames = async () => (await loadMcpCapabilityCatalog(ownerId, prisma)).servers
    .flatMap((server) => server.tools.map((entry) => entry.originalName));
  const settingsNames = async () => (await storage.listUserServers(ownerId))
    .find((server) => server.id === serverId)?.availableTools?.map((entry) => entry.name);
  /**
   * Every dispatch site rebuilds this plan; without names it is Load all for
   * the server. A list_changed refresh briefly marks the generation starting,
   * so only that transient state is waited out.
   */
  const plan = (namespacedNames?: readonly string[]) => vi.waitFor(async () => {
    const result = await prepareMcpRunPlan({
      allowedServerIds: [serverId],
      ...(namespacedNames ? { allowedToolNames: namespacedNames } : {}),
      isGenerationLive: (generationId) => runtime.hasLiveGeneration(generationId),
      load: () => loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma),
      reconcile: () => runtime.reconcileNow(ownerId)
    });
    if (!result.ok && result.issues.some((issue) => issue.readiness === "starting" || issue.readiness === "restarting")) {
      throw new Error("plan_runtime_refreshing");
    }
    return result;
  }, { interval: 100, timeout: 10_000 });
  const autoTools = async (names: readonly string[]) => (await loadMcpCapabilityCatalog(ownerId, prisma)).servers
    .flatMap((server) => server.tools).filter((entry) => names.includes(entry.originalName)).map((entry) => entry.namespacedName);
  /** list_changed reaches the session over its notification stream; resend until the runtime observed it. */
  const observe = async (names: readonly string[]) => {
    await vi.waitFor(async () => {
      const generation = (await preference()).desiredRuntimeGeneration;
      const current = (generation?.inventory as { tools?: { name: string }[] } | null)?.tools?.map((entry) => entry.name).sort();
      const observed = JSON.stringify(current) === JSON.stringify([...names].sort());
      if (observed && generation?.state === "ready") return;
      if (!observed) await endpoint.notify();
      throw new Error("inventory_not_observed");
    }, { interval: 250, timeout: 30_000 });
  };
  const switchTool = (name: string, enabled: boolean) =>
    storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled, name }, userId: ownerId });
  return { autoTools, catalogNames, created: created.value, observe, ownerId, plan, preference, runtime, serverId, settingsNames, switchTool };
}

describe("personal MCP live catalog on a changing peer", () => {
  it("follows upstream additions and removals, and keeps switch-offs across a tool's return without a new generation", async () => {
    const endpoint = await startMutableMcpEndpoint([tool("read"), tool("write")]);
    const fixture = await connectedPersonalServer(endpoint);
    try {
      // Before any runtime is ready, the validator's listing feeds Settings and Auto.
      expect(fixture.created.availableTools?.map((entry) => entry.name)).toEqual(["read", "write"]);
      expect(await fixture.catalogNames()).toEqual(["read", "write"]);

      await fixture.runtime.ensureUserServersReady(fixture.ownerId, [fixture.serverId]);
      const generationId = (await fixture.preference()).desiredRuntimeGenerationId!;
      expect(fixture.runtime.hasLiveGeneration(generationId)).toBe(true);

      // An upstream addition reaches Auto and dispatch after list_changed, without user action.
      await endpoint.setTools([tool("read"), tool("write"), tool("added")]);
      await fixture.observe(["read", "write", "added"]);
      expect(await fixture.catalogNames()).toEqual(["read", "write", "added"]);
      expect(await fixture.settingsNames()).toEqual(["added", "read", "write"]);
      const added = await fixture.plan(await fixture.autoTools(["added"]));
      expect(added).toMatchObject({ ok: true, bindings: [{ runtimeGenerationId: generationId }] });
      await expect(fixture.runtime.callTool({ arguments: {}, generationId, inputSchema: { type: "object" }, name: "added" }))
        .resolves.toMatchObject({ isError: false });
      expect(endpoint.calls("added")).toBe(1);

      // An observed removal leaves Settings and Auto, and Auto keeps working with the rest.
      await endpoint.setTools([tool("read"), tool("added")]);
      await fixture.observe(["read", "added"]);
      expect(await fixture.catalogNames()).toEqual(["read", "added"]);
      expect(await fixture.settingsNames()).toEqual(["added", "read"]);
      await expect(fixture.plan(await fixture.autoTools(["read", "added", "write"]))).resolves.toMatchObject({ ok: true });
      await expect(fixture.plan()).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ originalName: "read" }, { originalName: "added" }] } });

      // A tool switched off stays off while it is gone and after it returns.
      await expect(fixture.switchTool("read", false)).resolves.toMatchObject({ kind: "ok", value: { userDisabledToolNames: ["read"] } });
      await endpoint.setTools([tool("added")]);
      await fixture.observe(["added"]);
      await endpoint.setTools([tool("read"), tool("added")]);
      await fixture.observe(["read", "added"]);
      expect(await fixture.catalogNames()).toEqual(["added"]);
      expect(await fixture.settingsNames()).toEqual(["added", "read"]);
      expect((await fixture.preference()).userDisabledToolNames).toEqual(["read"]);

      // No upstream change or switch replaced the runtime.
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      expect(await prisma.mcpRuntimeGeneration.count({ where: { userServer: { serverId: fixture.serverId } } })).toBe(1);
    } finally {
      await fixture.runtime.stop();
      await endpoint.close();
    }
  });

  it("switches a tool off and on with no new generation, refuses its dispatch plan meanwhile and keeps the desired runtime", async () => {
    const endpoint = await startMutableMcpEndpoint([tool("read"), tool("write")]);
    const fixture = await connectedPersonalServer(endpoint);
    try {
      await fixture.runtime.ensureUserServersReady(fixture.ownerId, [fixture.serverId]);
      const generationId = (await fixture.preference()).desiredRuntimeGenerationId!;
      const write = await fixture.autoTools(["write"]);
      await expect(fixture.plan(write)).resolves.toMatchObject({ ok: true });

      await expect(fixture.switchTool("write", false)).resolves.toMatchObject({ kind: "ok", value: { userDisabledToolNames: ["write"] } });
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      // What the routes fire in the background selects the same generation again.
      await fixture.runtime.ensureUserServersReady(fixture.ownerId, [fixture.serverId]);
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      expect(await fixture.catalogNames()).toEqual(["read"]);
      await expect(fixture.plan(write)).resolves.toMatchObject({ ok: false, issues: [{ errorCode: "mcp_tool_not_available" }] });
      await expect(fixture.plan()).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ originalName: "read" }] } });

      await expect(fixture.switchTool("write", true)).resolves.toMatchObject({ kind: "ok", value: { userDisabledToolNames: [] } });
      await expect(fixture.plan(write)).resolves.toMatchObject({ ok: true, bindings: [{ runtimeGenerationId: generationId }] });
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      expect(fixture.runtime.hasLiveGeneration(generationId)).toBe(true);
      expect(await prisma.mcpRuntimeGeneration.count({ where: { userServer: { serverId: fixture.serverId } } })).toBe(1);
    } finally {
      await fixture.runtime.stop();
      await endpoint.close();
    }
  });

  it("refuses Load all over the tool limit while Auto materializes from the same server", async () => {
    const endpoint = await startMutableMcpEndpoint([tool("read")]);
    const fixture = await connectedPersonalServer(endpoint);
    try {
      await fixture.runtime.ensureUserServersReady(fixture.ownerId, [fixture.serverId]);
      const names = Array.from({ length: MCP_RUN_PLAN_LIMITS.maxTools + 1 }, (_, index) => `tool_${index}`);
      await endpoint.setTools(names.map(tool));
      await fixture.observe(names);

      await expect(fixture.plan()).resolves.toMatchObject({ code: "mcp_plan_too_large", limit: "maxTools", ok: false });
      await expect(fixture.plan(await fixture.autoTools(["tool_0", "tool_128"]))).resolves.toMatchObject({ ok: true });
      await fixture.switchTool("tool_0", false);
      const loadAll = await fixture.plan();
      expect(loadAll.ok && loadAll.snapshot.tools).toHaveLength(MCP_RUN_PLAN_LIMITS.maxTools);
    } finally {
      await fixture.runtime.stop();
      await endpoint.close();
    }
  });
});

describe("personal OAuth catalog identity", () => {
  it("keeps a same-connection restart in Auto and shows only the reconnected account's inventory", async () => {
    const ownerId = await user();
    const validate = vi.fn();
    const storage = createPrismaMcpRepository({ draftValidator: { validate }, encryptionKey: () => key, oauthRedirectUri: redirectUri, prisma });
    const created = await storage.createPersonalServer!({ description: "", draft: {
      auth: { allowedAuthorizationServerOrigins: ["https://auth.example.test"], mode: "oauth", scopes: [] },
      runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    }, name: "OAuth fixture", userId: ownerId, values: {} });
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    const serverId = created.value.id;
    serverIds.push(serverId);
    expect(validate).not.toHaveBeenCalled();
    expect(created.value.availableTools).toEqual([]);

    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = { redirectUri: redirectUri(serverId), serverId, userId: ownerId };
    const policy = await oauth.loadPolicy({ ...query, purpose: "user" });
    if (!policy) throw new Error("fixture_policy_missing");
    const client = await oauth.saveClient({
      clientInformation: { client_id: `fixture-${randomUUID()}` }, clientMetadata: { redirect_uris: [query.redirectUri] },
      registrationKey: randomUUID(), discoveryState: { authorizationServerUrl: "https://auth.example.test" }
    });
    clientIds.push(client.id);
    const connect = async (accessToken: string) => {
      const connection = await oauth.createConnection({ ...query, purpose: "user", clientId: client.clientInformation.client_id,
        configurationIdentity: policy.configurationIdentity, externalAccountLabel: null, oauthClientId: client.id,
        policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id), resource: policy.resource,
        tokens: { access_token: accessToken, token_type: "Bearer" }
      });
      if (connection.kind !== "ok") throw new Error("fixture_authorization_failed");
      return connection.value.id;
    };
    const runtimeRepository = createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma });
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    const { activeRevisionId } = await prisma.mcpServer.findUniqueOrThrow({ select: { activeRevisionId: true }, where: { id: serverId } });
    /** A runtime generation the coordinator would start for this connection; ready ones persist discovery. */
    const generation = async (oauthConnectionId: string, ready?: readonly string[]) => {
      const created = await prisma.mcpRuntimeGeneration.create({ data: {
        fingerprint: randomUUID(), oauthConnectionId, revisionId: activeRevisionId!, state: "starting", userServerId: preference.id
      } });
      await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: created.id }, where: { id: preference.id } });
      if (ready) {
        const tools = ready.map((name) => ({ definitionHash: "d".repeat(64), description: `${name} fixture`, inputSchema: { type: "object" }, name }));
        await expect(runtimeRepository.markReady({
          discoveredInventory: { tools: tools.map(({ description, name }) => ({ description, name })), version: 1 },
          fingerprint: created.fingerprint, generationId: created.id, inventory: { exclusions: [], tools, version: 1 }, now: new Date()
        })).resolves.toBe(true);
      }
      return created.id;
    };
    const catalogNames = async () => (await loadMcpCapabilityCatalog(ownerId, prisma)).servers
      .flatMap((server) => server.tools.map((entry) => entry.originalName));
    const settingsNames = async () => (await storage.listUserServers(ownerId))
      .find((server) => server.id === serverId)?.availableTools?.map((entry) => entry.name);

    const first = await connect("synthetic-first-account");
    await generation(first, ["mail.read"]);
    expect(await catalogNames()).toEqual(["mail.read"]);

    // A restart that keeps the connection (new generation starting, then idle eviction) keeps the tools.
    await generation(first);
    expect(await catalogNames()).toEqual(["mail.read"]);
    expect(await settingsNames()).toEqual(["mail.read"]);
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: null }, where: { id: preference.id } });
    expect(await catalogNames()).toEqual(["mail.read"]);

    // Reconnecting with another account drops everything observed with the first one.
    const second = await connect("synthetic-second-account");
    expect(await catalogNames()).toEqual([]);
    expect(await settingsNames()).toEqual([]);
    await generation(second);
    expect(await catalogNames()).toEqual([]);
    await generation(second, ["drive.read"]);
    expect(await catalogNames()).toEqual(["drive.read"]);
    expect(await settingsNames()).toEqual(["drive.read"]);
    expect(await prisma.mcpUserServer.findUniqueOrThrow({ where: { id: preference.id } }))
      .toMatchObject({ discoveredOAuthConnectionId: second });
  });
});
