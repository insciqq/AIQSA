import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { startMutableMcpEndpoint, type MutableMcpEndpoint, type MutableMcpTool } from "@/tests/e2e/support/mutableMcpEndpoint";
import { prisma } from "../prisma";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { currentMcpDispatchFailure } from "./dispatchStatus";
import type { McpDraftValidationOutcome } from "./draftValidator";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { prepareMcpRunPlan, type McpRunPlanResult } from "./runPlan";
import { loadMcpCapabilityCatalog, loadMcpRunPlanRecordsForServers } from "./runPlanRepository";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch } from "./safeFetch";
import { resolveMcpRunTool } from "./toolExecutor";

const key = Buffer.alloc(32, 11);
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

async function user(role: "admin" | "user" = "user") {
  const created = await prisma.user.create({ data: {
    displayName: "MCP continuity fixture", email: `mcp-continuity-${randomUUID()}@example.test`, role, status: "active"
  } });
  userIds.push(created.id);
  return created.id;
}

function tool(name: string, description = `${name} fixture`): MutableMcpTool {
  return { description, inputSchema: { type: "object" }, name };
}

type InventoryTool = { definitionHash: string; description: string | null; name: string };

/**
 * A personal no-auth server on a loopback peer whose tools change while the
 * runtime stays connected, as in the live catalog suite. Loopback permission
 * is injected into these test dependencies only.
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
  const created = await storage.createPersonalServer!({ description: "", draft: configuration, name: "Continuity fixture", userId: ownerId, values: {} });
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
  /** The exact plan every dispatch site rebuilds before calling one accepted tool. */
  const plan = (namespacedNames: readonly string[]) => prepareMcpRunPlan({
    allowedServerIds: [serverId],
    allowedToolNames: namespacedNames,
    isGenerationLive: (generationId) => runtime.hasLiveGeneration(generationId),
    load: () => loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma),
    reconcile: () => runtime.reconcileNow(ownerId)
  });
  const autoTool = async (name: string) => (await loadMcpCapabilityCatalog(ownerId, prisma)).servers
    .flatMap((server) => server.tools).find((entry) => entry.originalName === name)!.namespacedName;
  /** list_changed reaches the session over its notification stream; resend until the runtime persisted the change. */
  const observe = async (applied: (tools: InventoryTool[]) => boolean) => {
    await vi.waitFor(async () => {
      const generation = (await preference()).desiredRuntimeGeneration;
      const tools = (generation?.inventory as { tools?: InventoryTool[] } | null)?.tools ?? [];
      if (generation?.state === "ready" && applied(tools)) return;
      await endpoint.notify();
      throw new Error("inventory_not_observed");
    }, { interval: 250, timeout: 30_000 });
  };
  const update = (input: Readonly<{ enabled?: boolean; tool?: { enabled: boolean; name: string } }>) =>
    storage.updateUserServer({ ...input, personalOnly: true, serverId, userId: ownerId });
  return { autoTool, observe, ownerId, plan, preference, runtime, serverId, update };
}

describe("personal MCP continuity for accepted runs", () => {
  it("keeps an accepted tool through unrelated switches, a no-op enable and an unrelated upstream change, and names each refusal", async () => {
    const endpoint = await startMutableMcpEndpoint([tool("read"), tool("write")]);
    const fixture = await connectedPersonalServer(endpoint);
    try {
      await fixture.runtime.ensureUserServersReady(fixture.ownerId, [fixture.serverId]);
      const generationId = (await fixture.preference()).desiredRuntimeGenerationId!;
      const read = await fixture.autoTool("read");
      const accepted = await fixture.plan([read]);
      if (!accepted.ok) throw new Error(`fixture_plan_${accepted.code}`);
      const route = resolveMcpRunTool(accepted.snapshot, read)!;
      const failure = async () => currentMcpDispatchFailure(await fixture.plan([read]), route, generationId);
      const call = () => fixture.runtime.callTool({
        arguments: {}, definitionHash: route.tool.definitionHash, generationId, inputSchema: route.tool.inputSchema, name: "read"
      });

      // An unrelated switch and a no-op enable keep the binding and the call.
      await expect(fixture.update({ tool: { enabled: false, name: "write" } })).resolves.toMatchObject({ kind: "ok" });
      await expect(fixture.update({ enabled: true })).resolves.toMatchObject({ kind: "ok" });
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      await expect(failure()).resolves.toBeNull();
      await expect(fixture.update({ tool: { enabled: true, name: "write" } })).resolves.toMatchObject({ kind: "ok" });
      await expect(failure()).resolves.toBeNull();
      await expect(call()).resolves.toMatchObject({ isError: false });

      // An upstream change to another tool is applied to the same generation.
      const writeHash = (tools: InventoryTool[]) => tools.find((entry) => entry.name === "write")?.definitionHash;
      const before = writeHash(((await fixture.preference()).desiredRuntimeGeneration?.inventory as { tools: InventoryTool[] }).tools);
      await endpoint.setTools([tool("read"), tool("write", "write fixture, changed upstream")]);
      await fixture.observe((tools) => writeHash(tools) !== before);
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBe(generationId);
      await expect(failure()).resolves.toBeNull();
      await expect(call()).resolves.toMatchObject({ isError: false });
      expect(endpoint.calls("read")).toBe(2);

      // A change to the accepted tool itself is refused at the plan and in the runtime, before any request.
      await endpoint.setTools([tool("read", "read fixture, changed upstream"), tool("write", "write fixture, changed upstream")]);
      await fixture.observe((tools) => tools.find((entry) => entry.name === "read")?.definitionHash !== route.tool.definitionHash);
      // The runtime applies the persisted inventory once its refresh finishes.
      await vi.waitFor(() => expect(fixture.runtime.operationalStatus(generationId)).toBe("active"), { timeout: 10_000 });
      await expect(failure()).resolves.toBe("mcp_tool_definition_changed");
      await expect(call()).rejects.toMatchObject({ code: "mcp_tool_definition_changed" });
      expect(endpoint.calls("read")).toBe(2);

      // The owner's own switch-off and disabling the connection keep their causes.
      await fixture.update({ tool: { enabled: false, name: "read" } });
      await expect(failure()).resolves.toBe("mcp_tool_disabled");
      await fixture.update({ tool: { enabled: true, name: "read" } });
      await fixture.update({ enabled: false });
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBeNull();
      await expect(failure()).resolves.toBe("memory_egress_destination_revoked");
    } finally {
      await fixture.runtime.stop();
      await endpoint.close();
    }
  });

  it("names lost authorization of a personal OAuth connection at dispatch", async () => {
    const ownerId = await user();
    const storage = createPrismaMcpRepository({ draftValidator: { validate: vi.fn() }, encryptionKey: () => key, oauthRedirectUri: redirectUri, prisma });
    const created = await storage.createPersonalServer!({ description: "", draft: {
      auth: { allowedAuthorizationServerOrigins: ["https://auth.example.test"], mode: "oauth", scopes: [] },
      runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    }, name: "OAuth continuity fixture", userId: ownerId, values: {} });
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    const serverId = created.value.id;
    serverIds.push(serverId);
    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = { redirectUri: redirectUri(serverId), serverId, userId: ownerId };
    const policy = await oauth.loadPolicy({ ...query, purpose: "user" });
    if (!policy) throw new Error("fixture_policy_missing");
    const client = await oauth.saveClient({
      clientInformation: { client_id: `fixture-${randomUUID()}` }, clientMetadata: { redirect_uris: [query.redirectUri] },
      registrationKey: randomUUID(), discoveryState: { authorizationServerUrl: "https://auth.example.test" }
    });
    clientIds.push(client.id);
    const connected = await oauth.createConnection({ ...query, purpose: "user", clientId: client.clientInformation.client_id,
      configurationIdentity: policy.configurationIdentity, externalAccountLabel: null, oauthClientId: client.id,
      policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id), resource: policy.resource,
      tokens: { access_token: "synthetic-continuity-token", token_type: "Bearer" }
    });
    if (connected.kind !== "ok") throw new Error("fixture_authorization_failed");
    const connectionId = connected.value.id;
    // The generation the coordinator would run for this connection, ready with its inventory.
    const preference = await prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
    const { activeRevisionId } = await prisma.mcpServer.findUniqueOrThrow({ select: { activeRevisionId: true }, where: { id: serverId } });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      credentialSources: ["oauth"], fingerprint: randomUUID(), oauthConnectionId: connectionId, revisionId: activeRevisionId!,
      state: "starting", userServerId: preference.id
    } });
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
    const tools = [{ definitionHash: "d".repeat(64), description: "Read mail", inputSchema: { type: "object" }, name: "mail.read" }];
    await expect(createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma }).markReady({
      discoveredInventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 },
      fingerprint: generation.fingerprint, generationId: generation.id, inventory: { exclusions: [], tools, version: 1 }, now: new Date()
    })).resolves.toBe(true);
    const mailRead = (await loadMcpCapabilityCatalog(ownerId, prisma)).servers.flatMap((server) => server.tools)
      .find((entry) => entry.originalName === "mail.read")!.namespacedName;
    const plan = (): Promise<McpRunPlanResult> => prepareMcpRunPlan({
      allowedServerIds: [serverId], allowedToolNames: [mailRead], isGenerationLive: () => true,
      load: () => loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma)
    });
    const accepted = await plan();
    if (!accepted.ok) throw new Error(`fixture_plan_${accepted.code}`);
    const route = resolveMcpRunTool(accepted.snapshot, mailRead)!;

    await prisma.mcpOAuthConnection.update({ data: { state: "reauthorization_required" }, where: { id: connectionId } });
    await expect(loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma))
      .resolves.toMatchObject([{ catalogTools: [], readiness: "reauthorization_required" }]);
    expect(currentMcpDispatchFailure(await plan(), route, generation.id)).toBe("mcp_authorization_required");

    await prisma.mcpOAuthConnection.update({ data: { disconnectRequestedAt: new Date(), state: "disconnecting" }, where: { id: connectionId } });
    await expect(loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma)).resolves.toMatchObject([{ readiness: "needs_authorization" }]);
    expect(currentMcpDispatchFailure(await plan(), route, generation.id)).toBe("mcp_authorization_required");
    expect((await loadMcpCapabilityCatalog(ownerId, prisma)).servers).toEqual([]);
  });

  it("keeps an installation preference's runtime through a no-op enable and replaces it for new values", async () => {
    const adminId = await user("admin");
    const memberId = await user();
    const validate = vi.fn(async (): Promise<McpDraftValidationOutcome> => ({
      evidence: { protocol: "fixture" }, kind: "ok", resolvedArtifact: null,
      toolInventory: [{ description: "Search records", name: "search" }]
    }));
    const storage = createPrismaMcpRepository({ draftValidator: { validate }, encryptionKey: () => key, prisma });
    const draft: McpDraftConfiguration = {
      auth: { mode: "static" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [{
        label: "API key", policy: { allowPersonalOverride: true, kind: "shared" }, sensitive: true,
        slotKey: "api_key", target: { kind: "header", name: "X-Api-Key" }, valueType: "secret"
      }],
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    };
    const created = await storage.createServer({
      description: "Continuity fixture", draft, name: `Tools ${randomUUID()}`, sharedValues: { api_key: "synthetic-shared-key" }
    });
    if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
    const serverId = created.value.id;
    serverIds.push(serverId);
    const published = await storage.testDraft({
      expectedUpdatedAt: created.value.updatedAt, oneTimeValues: {}, publish: true, serverId, validationUserId: adminId
    });
    if (published.kind !== "ok") throw new Error(`fixture_publish_${published.kind}`);
    await expect(storage.setGrant({ canUse: true, groupId: null, personalSlotKeys: ["api_key"], serverId, userId: memberId }))
      .resolves.toMatchObject({ kind: "ok" });
    const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId, userId: memberId } });
    const patch = (values: Record<string, string>) =>
      storage.updateUserServer({ installationOnly: true, serverId, userId: memberId, values });
    await expect(patch({ api_key: "synthetic-member-key" })).resolves.toMatchObject({ kind: "ok" });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      credentialSources: ["personal"], fingerprint: randomUUID(), inventoryUpdatedAt: new Date(),
      inventory: { exclusions: [], tools: [{ definitionHash: "e".repeat(64), description: null, inputSchema: { type: "object" }, name: "search" }], version: 1 },
      revisionId: published.value.activeRevision!.id, state: "ready", userServerId: preference.id
    } });
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
    const desired = async () => (await prisma.mcpUserServer.findUniqueOrThrow({ where: { id: preference.id } })).desiredRuntimeGenerationId;

    await expect(storage.updateUserServer({ enabled: true, installationOnly: true, serverId, userId: memberId }))
      .resolves.toMatchObject({ kind: "ok", value: { enabled: true } });
    expect(await desired()).toBe(generation.id);

    await expect(patch({ api_key: "synthetic-member-key-2" })).resolves.toMatchObject({ kind: "ok" });
    expect(await desired()).toBeNull();
  });
});
