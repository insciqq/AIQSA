import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { prepareMcpRunPlan } from "./runPlan";
import { loadMcpRunPlanRecordsForProjectServers } from "./runPlanRepository";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch } from "./safeFetch";

/**
 * A real stateful, unauthenticated MCP peer on the official SDK. Notes live
 * in the MCP session that wrote them, as memory, sqlite or browser servers
 * keep per-session state; a counter is shared by the whole server process.
 */
async function startStatefulMcpPeer() {
  const sessionIds: string[] = [];
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  let processWrites = 0;
  const tools: Tool[] = [
    { description: "Remember a note", inputSchema: { properties: { note: { type: "string" } }, required: ["note"], type: "object" }, name: "remember" },
    { description: "Recall remembered notes", inputSchema: { type: "object" }, name: "recall" },
    { description: "Count notes written through every session", inputSchema: { type: "object" }, name: "count_all" }
  ];
  const openSession = async () => {
    const notes: string[] = [];
    const server = new Server({ name: "aiqsa-stateful-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request) => {
      if (request.params.name === "remember") {
        notes.push(String(request.params.arguments?.note));
        processWrites += 1;
        return { content: [{ text: "remembered", type: "text" }] };
      }
      const text = request.params.name === "recall" ? notes.join(",") || "(none)" : String(processWrites);
      return { content: [{ text, type: "text" }] };
    });
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      onsessionclosed: (sessionId) => { transports.delete(sessionId); },
      onsessioninitialized: (sessionId) => {
        sessionIds.push(sessionId);
        transports.set(sessionId, transport);
      },
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    return transport;
  };
  const http: HttpServer = createServer((request, response) => {
    void (async () => {
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const transport = sessionId
        ? transports.get(sessionId)
        : request.method === "POST" ? await openSession() : undefined;
      if (!transport) {
        response.statusCode = sessionId ? 404 : 400;
        response.end();
        return;
      }
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
    sessionIds,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
  };
}

const KEY = Buffer.alloc(32, 0x5a);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function projectFixture(url: string) {
  const suffix = randomUUID();
  const user = (label: string) => prisma.user.create({ data: {
    displayName: `Project runtime ${label}`, email: `project-runtime-${label}-${suffix}@example.test`, role: "user", status: "active"
  } });
  const memberA = await user("member-a");
  const memberB = await user("member-b");
  const outsiderC = await user("outsider-c");
  const configuration = {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 },
    slots: [],
    source: { allowPrivateNetwork: true, kind: "remote", url },
    transport: "streamable_http"
  };
  const server = await prisma.mcpServer.create({ data: {
    displayName: `Stateful tools ${suffix}`, draft: configuration, enabled: true, namespace: `project_runtime_${suffix.slice(0, 8)}`
  } });
  const revision = await prisma.mcpRevision.create({ data: {
    configuration,
    draftHash: `draft-${suffix}`,
    identityHash: `identity-${suffix}`,
    revisionNumber: 1,
    serverId: server.id,
    validationEvidence: {
      evidence: {}, testedAt: new Date().toISOString(),
      toolInventory: ["remember", "recall", "count_all"].map((name) => ({ description: null, name }))
    }
  } });
  await prisma.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
  // Member A also uses the server personally; member B has no personal grant.
  await prisma.mcpGrant.create({ data: { canUse: true, serverId: server.id, userId: memberA.id } });
  const preferenceA = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: server.id, userId: memberA.id } });
  const project = await prisma.project.create({ data: {
    createdByDisplayName: "Project runtime fixture",
    grants: { create: [{ role: "OWNER", userId: memberA.id }, { role: "CONTRIBUTOR", userId: memberB.id }] },
    name: `Stateful MCP ${suffix}`
  } });
  // Another Project linking the same server, sharing no member with the first.
  const otherProject = await prisma.project.create({ data: {
    createdByDisplayName: "Project runtime fixture",
    grants: { create: [{ role: "OWNER", userId: outsiderC.id }] },
    name: `Other stateful MCP ${suffix}`
  } });
  await prisma.projectMcpBinding.createMany({ data: [project.id, otherProject.id].map((projectId) => ({
    projectId, serverId: server.id
  })) });
  cleanups.push(async () => {
    await prisma.project.deleteMany({ where: { id: { in: [project.id, otherProject.id] } } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpSharedRuntime.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpServer.update({ data: { activeRevisionId: null }, where: { id: server.id } });
    await prisma.mcpGrant.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpRevision.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpServer.deleteMany({ where: { id: server.id } });
    await prisma.user.deleteMany({ where: { id: { in: [memberA.id, memberB.id, outsiderC.id] } } });
  });
  return {
    memberA: memberA.id, memberB: memberB.id, outsiderC: outsiderC.id, preferenceA: preferenceA.id, serverId: server.id
  };
}

function coordinator() {
  const runtime = new McpRuntimeCoordinator({
    repository: createPrismaMcpRuntimeRepository({ encryptionKey: () => KEY, prisma }),
    sessions: createMcpClientSessionFactory({
      fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }),
      limits: { ...MCP_INVENTORY_SESSION_LIMITS, maxToolArgumentBytes: getMcpRequestMaxBytes() }
    })
  });
  cleanups.push(() => runtime.stop());
  return runtime;
}

/** The composition of the default Project plan: shared runtime on demand, initiator's projection. */
async function projectPlan(runtime: McpRuntimeCoordinator, userId: string, serverId: string) {
  const ensureShared = () => runtime.ensureSharedServersReady([serverId]);
  await ensureShared();
  const plan = await prepareMcpRunPlan({
    allowedServerIds: [serverId],
    isGenerationLive: (generationId) => runtime.hasLiveGeneration(generationId),
    load: () => loadMcpRunPlanRecordsForProjectServers(userId, [serverId]),
    reconcile: ensureShared
  });
  if (!plan.ok) throw new Error(`project_plan_${plan.code}:${JSON.stringify(plan.issues)}`);
  return plan.bindings[0]!;
}

async function call(runtime: McpRuntimeCoordinator, generationId: string, name: string, note?: string) {
  const result = await runtime.callTool({
    arguments: note === undefined ? {} : { note }, generationId, inputSchema: { type: "object" }, name
  });
  return result.text.join("");
}

describe("Project MCP runtime authority and cold start", () => {
  it("keeps member and Project session state apart and survives cold start, member idle eviction and restart", async () => {
    const peer = await startStatefulMcpPeer();
    cleanups.push(() => peer.close());
    const f = await projectFixture(peer.url);
    let runtime = coordinator();

    // Cold process, no member has ever started the server: the Project run
    // starts the installation-owned runtime itself.
    const project = await projectPlan(runtime, f.memberB, f.serverId);
    const shared = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: project.runtimeGenerationId } });
    expect(shared).toMatchObject({ credentialSources: [], oauthConnectionId: null, sharedServerId: f.serverId, userServerId: null });
    await expect(prisma.mcpSharedRuntime.findUniqueOrThrow({ where: { serverId: f.serverId } }))
      .resolves.toMatchObject({ desiredRuntimeGenerationId: shared.id });
    // No member row was created, enabled or pointed at a runtime for the Project.
    await expect(prisma.mcpUserServer.findMany({ where: { serverId: f.serverId } })).resolves.toEqual([
      expect.objectContaining({ desiredRuntimeGenerationId: null, enabled: true, id: f.preferenceA })
    ]);

    // Member A's personal runtime of the same server is a separate generation and MCP session.
    await runtime.ensureUserServersReady(f.memberA, [f.serverId]);
    const personal = await prisma.mcpRuntimeGeneration.findFirstOrThrow({ where: { userServerId: f.preferenceA } });
    expect(personal.id).not.toBe(shared.id);
    expect(personal.fingerprint).not.toBe(shared.fingerprint);
    expect(await call(runtime, personal.id, "remember", "member-a-private-note")).toBe("remembered");
    // The state boundary is the runtime's MCP session: anything bound to the
    // member's generation reads its private state. Before this change a
    // Project plan selected exactly such a ready, no-auth member generation.
    expect(await call(runtime, personal.id, "recall")).toBe("member-a-private-note");
    // The Project plan never selects it, although it is ready, fresh and
    // no-auth and its member enabled it.
    expect((await projectPlan(runtime, f.memberB, f.serverId)).runtimeGenerationId).toBe(shared.id);
    expect(await call(runtime, shared.id, "recall")).toBe("(none)");
    expect(await call(runtime, shared.id, "remember", "project-b-note")).toBe("remembered");
    expect(await call(runtime, personal.id, "recall")).toBe("member-a-private-note");
    expect(await call(runtime, shared.id, "recall")).toBe("project-b-note");
    // The Project runtime is the installation's, one per server and revision:
    // a Project sharing no member with this one binds the same generation and
    // MCP session, so its runs see "project-b-note" too.
    expect((await projectPlan(runtime, f.outsiderC, f.serverId)).runtimeGenerationId).toBe(shared.id);
    expect(new Set(peer.sessionIds).size).toBe(2);
    // Process-wide upstream state is the server's own design and is shared by
    // every session; no runtime owner can isolate it.
    expect(await call(runtime, shared.id, "count_all")).toBe("2");

    // Member A goes idle: the periodic pass evicts A's runtime, never the Project's.
    await runtime.reconcileNow();
    await expect(prisma.mcpUserServer.findUniqueOrThrow({ where: { id: f.preferenceA } }))
      .resolves.toMatchObject({ desiredRuntimeGenerationId: null, enabled: true });
    const past = new Date(Date.now() - 2 * 60_000);
    await prisma.mcpRuntimeGeneration.updateMany({ data: { createdAt: past }, where: { id: { in: [personal.id, shared.id] } } });
    await runtime.reconcileNow();
    await expect(prisma.mcpRuntimeGeneration.findUnique({ where: { id: personal.id } })).resolves.toBeNull();
    expect(runtime.hasLiveGeneration(personal.id)).toBe(false);
    expect(runtime.hasLiveGeneration(shared.id)).toBe(true);
    expect((await projectPlan(runtime, f.memberB, f.serverId)).runtimeGenerationId).toBe(shared.id);

    // A stale inventory is refreshed by the Project run itself, whoever is online.
    await prisma.mcpRuntimeGeneration.update({
      data: { inventoryUpdatedAt: new Date(Date.now() - 10 * 60_000) }, where: { id: shared.id }
    });
    expect((await projectPlan(runtime, f.memberB, f.serverId)).runtimeGenerationId).toBe(shared.id);
    const refreshed = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: shared.id } });
    expect(Date.now() - refreshed.inventoryUpdatedAt!.getTime()).toBeLessThan(60_000);

    // App restart: the persisted ready row is not live in the new process until
    // the Project run starts it again on demand.
    await runtime.stop();
    runtime = coordinator();
    expect(runtime.hasLiveGeneration(shared.id)).toBe(false);
    expect((await projectPlan(runtime, f.memberB, f.serverId)).runtimeGenerationId).toBe(shared.id);
    expect(runtime.hasLiveGeneration(shared.id)).toBe(true);
    expect(new Set(peer.sessionIds).size).toBe(3);

    // Without Project demand the shared runtime drains; the next run starts it cold.
    await prisma.mcpSharedRuntime.update({
      data: { requestedAt: new Date(Date.now() - 16 * 60_000) }, where: { serverId: f.serverId }
    });
    await runtime.reconcileNow();
    await expect(prisma.mcpSharedRuntime.findUniqueOrThrow({ where: { serverId: f.serverId } }))
      .resolves.toMatchObject({ desiredRuntimeGenerationId: null });
    await expect(prisma.mcpRuntimeGeneration.findUnique({ where: { id: shared.id } })).resolves.toBeNull();
    expect(runtime.hasLiveGeneration(shared.id)).toBe(false);
    const restarted = await projectPlan(runtime, f.memberB, f.serverId);
    expect(restarted.fingerprint).toBe(shared.fingerprint);
    expect(runtime.hasLiveGeneration(restarted.runtimeGenerationId)).toBe(true);
    await expect(prisma.mcpUserServer.findMany({ where: { userId: f.memberB } })).resolves.toEqual([]);
  }, 90_000);
});
