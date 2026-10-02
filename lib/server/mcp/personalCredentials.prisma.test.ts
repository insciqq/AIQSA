// @vitest-environment node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { currentMcpDispatchFailure, mcpDispatchError } from "./dispatchStatus";
import type { McpDraftValidator } from "./draftValidator";
import { decryptMcpEnvelope, mcpPersonalConfigEnvelopeContext } from "./encryption";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { prepareMcpRunPlan } from "./runPlan";
import { loadMcpRunPlanRecordsForServers } from "./runPlanRepository";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch } from "./safeFetch";
import { dispatchMcpTool, resolveMcpRunTool } from "./toolExecutor";

// Synthetic users and a loopback static-auth MCP peer only; each test removes
// exactly the rows it created.
const key = Buffer.alloc(32, 13);
const userIds: string[] = [];
const serverIds: string[] = [];
const redirectUri = (serverId: string) => `https://app.example.test/api/me/mcp/${serverId}/oauth/callback`;

type PeerRequest = { header: string; method: string | null; token: string | null };

/**
 * A synthetic MCP server that checks a static credential on every HTTP
 * request and records which credential each JSON-RPC method arrived with.
 */
async function startStaticAuthPeer(initial: { accepted: string[]; header?: string }) {
  const state = { accepted: new Set(initial.accepted), header: (initial.header ?? "Authorization").toLowerCase() };
  const requests: PeerRequest[] = [];
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const tools: Tool[] = [
    { description: "Read fixture", inputSchema: { type: "object" }, name: "read" },
    { description: "Write fixture", inputSchema: { type: "object" }, name: "write" }
  ];
  const open = async () => {
    const server = new Server({ name: "aiqsa-static-auth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request) => ({ content: [{ text: `called ${request.params.name}`, type: "text" }] }));
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
  const readBody = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  };
  const http: HttpServer = createServer((request, response) => {
    void (async () => {
      const body = request.method === "POST" ? await readBody(request) : undefined;
      const value = request.headers[state.header];
      const token = Array.isArray(value) ? value[0] ?? null : value ?? null;
      for (const message of Array.isArray(body) ? body : body === undefined ? [] : [body]) {
        const method = message && typeof message === "object" && "method" in message && typeof message.method === "string" ? message.method : null;
        requests.push({ header: state.header, method, token });
      }
      if (!token || !state.accepted.has(token)) {
        response.statusCode = 401;
        response.setHeader("www-authenticate", "Bearer");
        response.end();
        return;
      }
      const sessionHeader = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      const transport = sessionId ? transports.get(sessionId) : request.method === "POST" ? await open() : undefined;
      if (!transport) { response.statusCode = sessionId ? 404 : 400; response.end(); return; }
      await transport.handleRequest(request, response, body);
    })().catch(() => { if (!response.headersSent) { response.statusCode = 500; response.end(); } });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  return {
    calls: (from = 0) => requests.slice(from).filter((request) => request.method === "tools/call"),
    close: async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
    requests,
    state,
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
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

async function user() {
  const created = await prisma.user.create({ data: {
    displayName: "Personal MCP credential fixture", email: `mcp-credentials-${randomUUID()}@example.test`, status: "active"
  } });
  userIds.push(created.id);
  return created.id;
}

/**
 * The loopback permission is injected into the test's draft and fetches only;
 * the personal HTTP API never accepts it.
 */
function staticDraft(url: string): McpDraftConfiguration {
  return {
    auth: { mode: "static" },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
    slots: [{
      label: "Authorization header",
      policy: { kind: "personal", required: true },
      sensitive: true,
      slotKey: "authorization",
      target: { kind: "header", name: "Authorization" },
      valueType: "secret"
    }],
    source: { allowPrivateNetwork: true, kind: "remote", url },
    transport: "streamable_http"
  };
}

const loopbackFetch = () => createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true });

async function setup(input: { accepted: string[]; draftValidator?: (remote: McpDraftValidator) => McpDraftValidator }) {
  const peer = await startStaticAuthPeer({ accepted: input.accepted });
  const ownerId = await user();
  const remote = createRemoteMcpDraftValidator({ fetch: loopbackFetch() });
  const storage = createPrismaMcpRepository({
    draftValidator: input.draftValidator ? input.draftValidator(remote) : remote,
    encryptionKey: () => key,
    oauthRedirectUri: redirectUri,
    prisma
  });
  const created = await storage.createPersonalServer!({
    description: "", draft: staticDraft(peer.url), name: "Static fixture", userId: ownerId, values: { authorization: input.accepted[0]! }
  });
  if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
  const serverId = created.value.id;
  serverIds.push(serverId);
  const runtime = new McpRuntimeCoordinator({
    repository: createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma }),
    sessions: createMcpClientSessionFactory({
      fetch: loopbackFetch(),
      limits: { ...MCP_INVENTORY_SESSION_LIMITS, maxToolArgumentBytes: getMcpRequestMaxBytes() }
    })
  });
  /** What a run's dispatch recheck sees: the readied, current exact plan. */
  const currentPlan = async (allowedToolNames?: readonly string[]) => {
    await runtime.ensureUserServersReady(ownerId, [serverId]);
    return prepareMcpRunPlan({
      allowedServerIds: [serverId],
      ...(allowedToolNames ? { allowedToolNames } : {}),
      isGenerationLive: (generationId) => runtime.hasLiveGeneration(generationId),
      load: () => loadMcpRunPlanRecordsForServers(ownerId, [serverId], prisma)
    });
  };
  /** One MCP call of a run that accepted `plan`, rechecked as run execution does. */
  const call = async (plan: Awaited<ReturnType<typeof currentPlan>>, name: string) => {
    if (!plan.ok) throw new Error("fixture_plan_not_ready");
    const route = resolveMcpRunTool(plan.snapshot, plan.snapshot.tools.find((tool) => tool.originalName === name)!.namespacedName)!;
    const generationId = plan.bindings[0]!.runtimeGenerationId;
    return dispatchMcpTool({
      arguments: {},
      assertCurrent: async () => {
        const failure = currentMcpDispatchFailure(await currentPlan([route.tool.namespacedName]), route, generationId);
        if (failure) throw mcpDispatchError(failure);
      },
      callTool: (request) => runtime.callTool(request),
      generationId,
      route
    });
  };
  const preference = () => prisma.mcpUserServer.findUniqueOrThrow({ where: { userId_serverId: { serverId, userId: ownerId } } });
  const storedAuthorization = async () => {
    const row = await preference();
    return (decryptMcpEnvelope<{ values: Record<string, unknown> }>(row.personalConfigEnvelope!, key,
      mcpPersonalConfigEnvelopeContext(row.id, row.personalConfigVersion))).values.authorization;
  };
  return { call, currentPlan, ownerId, peer, preference, runtime, serverId, storage, storedAuthorization };
}

describe("personal MCP static secret at rest", () => {
  it("stores the created token only inside the encrypted preference envelope", async () => {
    const secret = `synthetic-at-rest-${randomUUID()}`;
    const token = `Bearer ${secret}`;
    const fixture = await setup({ accepted: [token] });
    const { ownerId, peer, serverId } = fixture;
    try {
      const preference = await fixture.preference();
      expect(preference.personalConfigEnvelope).toEqual(expect.any(String));
      expect(await fixture.storedAuthorization()).toBe(token);
      const rows = {
        grants: await prisma.mcpGrant.findMany({ where: { serverId } }),
        preference,
        revisions: await prisma.mcpRevision.findMany({ where: { serverId } }),
        server: await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })
      };
      expect(rows.server.ownerUserId).toBe(ownerId);
      expect(rows.revisions).not.toHaveLength(0);
      const stored = JSON.stringify(rows);
      for (const form of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex")]) {
        expect(stored).not.toContain(form);
      }
    } finally {
      await fixture.runtime.stop();
      await peer.close();
    }
  });
});

describe("personal MCP credential replacement", () => {
  it("rotates a static token in place: future messages use it, an accepted run's later call never reaches upstream", async () => {
    const fixture = await setup({ accepted: ["Bearer token-a"] });
    const { call, currentPlan, ownerId, peer, serverId, storage } = fixture;
    try {
      expect(await storage.updateUserServer({ personalOnly: true, serverId, tool: { enabled: false, name: "write" }, userId: ownerId }))
        .toMatchObject({ kind: "ok" });
      const accepted = await currentPlan();
      expect(await call(accepted, "read")).toMatchObject({ text: ["called read"] });
      expect(peer.calls().map((request) => request.token)).toEqual(["Bearer token-a"]);
      const before = await fixture.preference();

      // An invalid replacement is refused with a field error and changes nothing.
      expect(await storage.replacePersonalCredentials!({ authorization: "Bearer wrong", serverId, userId: ownerId }))
        .toMatchObject({ issues: [expect.objectContaining({ code: "mcp_authorization_required" })], kind: "draft_validation_failed" });
      expect(await fixture.preference()).toMatchObject({ personalConfigVersion: before.personalConfigVersion });
      expect(await call(accepted, "read")).toMatchObject({ text: ["called read"] });

      // The upstream rotates: the old token is rejected from now on.
      peer.state.accepted = new Set(["Bearer token-b"]);
      const replaced = await storage.replacePersonalCredentials!({ authorization: "Bearer token-b", serverId, userId: ownerId });
      expect(replaced).toMatchObject({ kind: "ok", value: {
        authHeaderName: "Authorization", authMode: "static", id: serverId, userDisabledToolNames: ["write"]
      } });
      expect(JSON.stringify(replaced)).not.toContain("token-b");
      expect(await fixture.preference()).toMatchObject({
        desiredRuntimeGenerationId: null, id: before.id, personalConfigVersion: before.personalConfigVersion + 1, userDisabledToolNames: ["write"]
      });
      expect(await fixture.storedAuthorization()).toBe("Bearer token-b");
      expect(await prisma.mcpServer.count({ where: { archivedAt: null, ownerUserId: ownerId } })).toBe(1);
      expect(await prisma.mcpRevision.count({ where: { serverId } })).toBe(1);

      // The accepted run's later call is refused before any upstream request.
      const mark = peer.requests.length;
      await expect(call(accepted, "read")).rejects.toMatchObject({ code: "mcp_accepted_generation_changed" });
      expect(peer.calls(mark)).toEqual([]);

      // The next message uses a new generation with the new token.
      const next = await currentPlan();
      expect(next.ok && next.bindings[0]!.runtimeGenerationId).not.toBe(accepted.ok && accepted.bindings[0]!.runtimeGenerationId);
      expect(await call(next, "read")).toMatchObject({ text: ["called read"] });
      expect(peer.calls(mark).map((request) => request.token)).toEqual(["Bearer token-b"]);
    } finally {
      await fixture.runtime.stop();
      await peer.close();
    }
  });

  it("moves the credential to a new header in the next revision", async () => {
    const fixture = await setup({ accepted: ["Bearer token-a"] });
    const { call, currentPlan, ownerId, peer, serverId, storage } = fixture;
    try {
      const firstRevision = (await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).activeRevisionId;
      peer.state.header = "x-api-key";
      peer.state.accepted = new Set(["key-2"]);
      const replaced = await storage.replacePersonalCredentials!({ authorization: "key-2", headerName: "X-API-Key", serverId, userId: ownerId });
      expect(replaced).toMatchObject({ kind: "ok", value: { authHeaderName: "X-API-Key", authMode: "static", id: serverId } });
      const server = await prisma.mcpServer.findUniqueOrThrow({ include: { activeRevision: true }, where: { id: serverId } });
      expect(server.activeRevisionId).not.toBe(firstRevision);
      expect(server.activeRevision).toMatchObject({ revisionNumber: 2 });
      const mark = peer.requests.length;
      expect(await call(await currentPlan(), "read")).toMatchObject({ text: ["called read"] });
      expect(peer.calls(mark)).toEqual([{ header: "x-api-key", method: "tools/call", token: "key-2" }]);
    } finally {
      await fixture.runtime.stop();
      await peer.close();
    }
  });

  it("never commits two concurrent replacements out of order", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowValidated!: () => void;
    const slowReady = new Promise<void>((resolve) => { slowValidated = resolve; });
    const fixture = await setup({
      accepted: ["Bearer token-a", "Bearer token-slow", "Bearer token-fast"],
      draftValidator: (remote) => ({
        async validate(input) {
          const outcome = await remote.validate(input);
          if (input.values.authorization === "Bearer token-slow") { slowValidated(); await slowGate; }
          return outcome;
        }
      })
    });
    const { ownerId, peer, serverId, storage } = fixture;
    try {
      const before = await fixture.preference();
      const slow = storage.replacePersonalCredentials!({ authorization: "Bearer token-slow", serverId, userId: ownerId });
      await slowReady;
      expect(await storage.replacePersonalCredentials!({ authorization: "Bearer token-fast", serverId, userId: ownerId }))
        .toMatchObject({ kind: "ok" });
      releaseSlow();
      expect(await slow).toEqual({ kind: "credentials_changed" });
      expect(await fixture.preference()).toMatchObject({ personalConfigVersion: before.personalConfigVersion + 1 });
      expect(await fixture.storedAuthorization()).toBe("Bearer token-fast");
    } finally {
      releaseSlow();
      await fixture.runtime.stop();
      await peer.close();
    }
  });

  it("keeps a sync that read the row before a replacement from re-desiring the old-token generation", async () => {
    const fixture = await setup({ accepted: ["Bearer token-a", "Bearer token-b"] });
    const { ownerId, peer, serverId, storage } = fixture;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let rowsRead!: () => void;
    const read = new Promise<void>((resolve) => { rowsRead = resolve; });
    // Pauses the sync between reading the preference rows and accepting its candidate.
    const stalled = new Proxy(prisma, {
      get(target, property) {
        if (property === "mcpUserServer") {
          const delegate = target.mcpUserServer;
          return new Proxy(delegate, {
            get(inner, name) {
              if (name === "findMany") {
                return async (args: Parameters<typeof delegate.findMany>[0]) => {
                  const rows = await inner.findMany(args);
                  rowsRead();
                  await readGate;
                  return rows;
                };
              }
              const value = Reflect.get(inner, name, inner) as unknown;
              return typeof value === "function" ? value.bind(inner) : value;
            }
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as PrismaClient;
    try {
      const sync = createPrismaMcpRuntimeRepository({ encryptionKey: () => key, prisma: stalled })
        .synchronizeDesired({ now: new Date(), onDemand: true, serverIds: [serverId], userId: ownerId });
      await read;
      expect(await storage.replacePersonalCredentials!({ authorization: "Bearer token-b", serverId, userId: ownerId }))
        .toMatchObject({ kind: "ok" });
      releaseRead();
      expect(await sync).toEqual([]);
      expect((await fixture.preference()).desiredRuntimeGenerationId).toBeNull();

      const mark = peer.requests.length;
      expect(await fixture.call(await fixture.currentPlan(), "read")).toMatchObject({ text: ["called read"] });
      expect(peer.calls(mark).map((request) => request.token)).toEqual(["Bearer token-b"]);
    } finally {
      releaseRead();
      await fixture.runtime.stop();
      await peer.close();
    }
  });
});
