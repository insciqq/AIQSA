import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpRuntimeErrorMessage, type McpDraftConfiguration, type UserMcpServer } from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { McpClientSessionError } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { createDefaultMcpDraftValidator } from "./defaultMcp";
import { applyPersonalMcpPolicyChange, personalMcpAddressPolicy } from "./defaultPersonalNetwork";
import { createDefaultMcpLaunchFetch } from "./defaultRuntime";
import { currentMcpDispatchFailure, mcpDispatchError } from "./dispatchStatus";
import { userServerProjection } from "./handlers";
import { createMcpOAuthStartHandler } from "./oauthHandlers";
import { buildMcpOAuthPolicy } from "./oauthPolicy";
import type { McpOAuthRepository } from "./oauthRepository";
import { McpOAuthError, McpOAuthService } from "./oauthService";
import { PERSONAL_MCP_EGRESS_HEADERS } from "./personalEgress";
import { createPersonalMcpCreateHandler } from "./personalHandlers";
import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  mcpDestinationSafeFetchOptions,
  type PersonalMcpAddressPolicyState,
  type PersonalMcpNetworkHost
} from "./personalNetworkPolicy";
import { createMcpPolicyHandlers } from "./policyHandlers";
import { preparePersonalMcpOAuthDraft } from "./personalOAuthDiscovery";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import type { McpRepository, McpUserServerState } from "./repositoryContract";
import {
  McpRuntimeCoordinator,
  type McpRuntimeCoordinatorRepository,
  type McpRuntimeGenerationLaunch,
  type McpRuntimeLaunch
} from "./runtimeCoordinator";
import {
  createMcpSafeFetch,
  type McpAddressDenialCode,
  type McpPinnedHttpRequest,
  type McpSafeFetchOptions
} from "./safeFetch";

const LIMITS = { maxListDurationMs: 10_000, maxToolArgumentBytes: 4_096, maxToolMetadataBytes: 8_192, maxTools: 16 };

function remoteDraft(url: string, auth: McpDraftConfiguration["auth"] = { mode: "none" }): McpDraftConfiguration {
  return {
    auth,
    runtime: { callTimeoutMs: 5_000, startupTimeoutMs: 5_000 },
    slots: [],
    source: { kind: "remote", url },
    transport: "streamable_http"
  };
}

/** A safe fetch whose address policy always answers `reason`; IP-literal URLs never reach DNS. */
function refusingFetch(reason: McpAddressDenialCode): FetchLike {
  return createMcpSafeFetch({
    addressPolicy: async () => reason,
    allowInsecureHttp: true,
    dispatch: async () => { throw new Error("dispatch must not run"); }
  });
}

function owner(): RequestAuthResolver {
  return (async () => ({ user: { id: "user-1", role: "user", status: "active" }, userId: "user-1" })) as unknown as RequestAuthResolver;
}

describe("personal MCP network policy at draft validation", () => {
  it("passes the personal marker to the transport and keeps the refusal reason as the issue code", async () => {
    const fetchForDraft = vi.fn((_draft: McpDraftConfiguration, destination: Readonly<{ personal: boolean }>) =>
      refusingFetch(destination.personal ? "mcp_local_network_disabled" : "mcp_http_address_forbidden"));
    const validator = createRemoteMcpDraftValidator({ fetch: refusingFetch("mcp_http_address_forbidden"), fetchForDraft, limits: LIMITS });

    const personal = await validator.validate({ draft: remoteDraft("http://192.168.1.20:8080/mcp"), personal: true, values: {} });
    expect(fetchForDraft).toHaveBeenLastCalledWith(expect.anything(), { personal: true });
    expect(personal).toEqual({
      issues: [expect.objectContaining({ code: "mcp_local_network_disabled", operation: "initialize", path: "source" })],
      kind: "invalid"
    });

    const installation = await validator.validate({ draft: remoteDraft("http://192.168.1.20:8080/mcp"), values: {} });
    expect(fetchForDraft).toHaveBeenLastCalledWith(expect.anything(), { personal: false });
    expect(installation).toEqual({
      issues: [expect.objectContaining({ code: "mcp_connection_forbidden" })],
      kind: "invalid"
    });
  });
});

describe("personal MCP network policy at create", () => {
  const created = vi.fn();
  const deps = (repository: Partial<McpRepository>, prepareOAuthDraft?: (draft: McpDraftConfiguration) => ReturnType<typeof preparePersonalMcpOAuthDraft>) => ({
    ...(prepareOAuthDraft ? { prepareOAuthDraft } : {}),
    rateLimiter: { check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) },
    repository: { createPersonalServer: created, personalCreationLimit: async () => null, ...repository } as unknown as McpRepository,
    resolveAuth: owner()
  });
  const create = (body: Record<string, unknown>) => new Request("https://aiqsa.test/api/me/mcp-connections", {
    body: JSON.stringify({ insecureHttpAcknowledged: true, name: "NAS tools", ...body }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  it("returns the validation issue code of a refused address", async () => {
    const validator = createRemoteMcpDraftValidator({ fetch: refusingFetch("mcp_internal_address_forbidden"), limits: LIMITS });
    const createPersonalServer = vi.fn(async ({ draft }: { draft: McpDraftConfiguration }) => {
      const outcome = await validator.validate({ draft, personal: true, values: {} });
      return outcome.kind === "invalid" ? { issues: outcome.issues, kind: "draft_validation_failed" as const } : { kind: "not_found" as const };
    });
    const response = await createPersonalMcpCreateHandler(deps({ createPersonalServer } as Partial<McpRepository>))(
      create({ url: "http://127.0.0.1:8080/mcp" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "mcp_draft_test_failed",
      issues: [{ code: "mcp_internal_address_forbidden", path: "source" }]
    });
  });

  it.each(["mcp_internal_address_forbidden", "mcp_local_network_disabled"] as const)(
    "passes the %s discovery refusal through instead of a generic discovery failure",
    async (reason) => {
      const addressPolicy = vi.fn(async () => reason);
      const response = await createPersonalMcpCreateHandler(deps({}, (draft) => preparePersonalMcpOAuthDraft(draft, { addressPolicy })))(
        create({ auth: { mode: "oauth" }, url: "http://10.0.0.5:8080/mcp" }));

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: reason, issues: [{ code: reason, path: "url" }] });
      expect(addressPolicy).toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
    }
  );
});

describe("personal MCP network policy at OAuth start", () => {
  function service(personal: boolean, personalAddressPolicy = vi.fn(async (): Promise<McpAddressDenialCode | null> => "mcp_local_network_disabled")) {
    const policy = buildMcpOAuthPolicy({
      configurationIdentity: "revision-1",
      draft: remoteDraft("http://192.168.1.20:8080/mcp", {
        allowedAuthorizationServerOrigins: ["http://192.168.1.20:8080"], mode: "oauth", scopes: []
      }),
      personal,
      purpose: "user",
      redirectUri: "https://aiqsa.test/api/me/mcp/server-1/oauth/callback",
      serverId: "server-1",
      userId: "user-1"
    });
    const repository = { loadPolicy: vi.fn(async () => policy) } as unknown as McpOAuthRepository;
    return { personalAddressPolicy, service: new McpOAuthService({ personalAddressPolicy, repository, requestTimeoutMs: 5_000 }) };
  }
  const start = (target: McpOAuthService) => target.startAuthorization({
    forceReconnect: false, purpose: "user", redirectUri: "https://aiqsa.test/api/me/mcp/server-1/oauth/callback",
    serverId: "server-1", sourceKind: "personal", state: "state-1", userId: "user-1"
  });

  it("applies the personal policy to a personal server and keeps its reason", async () => {
    const { personalAddressPolicy, service: personal } = service(true);
    await expect(start(personal)).rejects.toMatchObject({ code: "mcp_local_network_disabled", name: "McpOAuthError" });
    expect(personalAddressPolicy).toHaveBeenCalled();
  });

  it("keeps the installation rule for an installation server", async () => {
    const { personalAddressPolicy, service: installation } = service(false);
    await expect(start(installation)).rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(personalAddressPolicy).not.toHaveBeenCalled();
  });

  it.each(["mcp_internal_address_forbidden", "mcp_local_network_disabled"] as const)("answers %s with 422", async (reason) => {
    const handler = createMcpOAuthStartHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.test", configured: true, cookieSecure: true, sessionSecret: "s".repeat(64) }),
      rateLimiter: { check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) },
      resolveAuth: owner(),
      service: {
        completeAuthorization: vi.fn(),
        disconnect: vi.fn(),
        startAuthorization: vi.fn(async () => { throw new McpOAuthError(reason); })
      }
    }, { forceReconnect: false, purpose: "user", sourceKind: "personal" });
    const response = await handler(new Request("https://aiqsa.test/api/me/mcp-connections/server-1/oauth/connect", { method: "POST" }),
      { params: { serverId: "server-1" } });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: reason });
  });
});

type Fixture = Readonly<{ close(): Promise<void>; url: URL }>;

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

/** A real MCP server on loopback; every new client session gets its own transport. */
async function startFixture(): Promise<Fixture> {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const httpServer: HttpServer = createServer((request, response) => {
    void (async () => {
      const sessionId = request.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        const server = new Server({ name: "nas-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", async () => ({
          tools: [{ description: "Echo", inputSchema: { type: "object" }, name: "echo" }]
        }));
        server.setRequestHandler("tools/call", async (call) => ({ content: [{ text: call.params.name, type: "text" }] }));
        server.setRequestHandler("ping", async () => ({}));
        const created = new NodeStreamableHTTPServerTransport({
          enableJsonResponse: true,
          onsessioninitialized: (id) => { transports.set(id, created); },
          sessionIdGenerator: () => randomUUID()
        });
        await server.connect(created);
        transport = created;
      }
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  const fixture: Fixture = {
    async close() {
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    url: new URL(`http://127.0.0.1:${port}/mcp`)
  };
  fixtures.push(fixture);
  return fixture;
}

/** The app container: the NAS is on the LAN, outside every Compose network. */
const networkHost: PersonalMcpNetworkHost = {
  detectContainer: () => true,
  env: { AIQSA_OPENSEARCH_URL: "http://opensearch:9200" },
  interfaces: () => [{ address: "172.20.0.5", cidr: "172.20.0.5/16", internal: false, name: "eth0" }],
  lookupHostname: async (hostname) => {
    if (hostname === "host.docker.internal") return [{ address: "172.17.0.1", family: 4 }];
    throw new Error("ENOTFOUND");
  }
};

function runtimeRepository(...launches: McpRuntimeGenerationLaunch[]) {
  const failures: Array<Readonly<{ errorCode: string; generationId: string }>> = [];
  const repository: McpRuntimeCoordinatorRepository = {
    deleteDrainedGeneration: vi.fn(async () => false),
    finalizeDeletedServers: vi.fn(async () => 0),
    listDrainedGenerationIds: vi.fn(async () => []),
    loadAcceptedGeneration: vi.fn(async (generationId: string) =>
      launches.find((launch) => launch.generationId === generationId) ?? null),
    markFailed: vi.fn(async ({ errorCode, generationId }) => {
      failures.push({ errorCode, generationId });
      return { applied: true, retryAt: null };
    }),
    markReady: vi.fn(async () => true),
    markStarting: vi.fn(async () => true),
    synchronizeDesired: vi.fn(async () => launches),
    synchronizeShared: vi.fn(async () => []),
    touchLastUsed: vi.fn(async () => undefined)
  };
  return { failures, repository };
}

describe("personal MCP runtime under the local network policy", () => {
  it("records the refusal reason for the owner's connection state", async () => {
    const launch: McpRuntimeGenerationLaunch = {
      allowPrivateNetwork: false, callTimeoutMs: 5_000, fingerprint: "fingerprint-1", generationId: "generation-1",
      headers: {}, personalRuntime: true, publishedTools: { kind: "names", names: new Set() }, redactionValues: [],
      retryAt: null, startupTimeoutMs: 5_000, url: "http://nas.lan:8080/mcp"
    };
    const { failures, repository } = runtimeRepository(launch);
    const coordinator = new McpRuntimeCoordinator({
      repository,
      sessions: { create: async () => { throw new McpClientSessionError({ code: "mcp_internal_address_forbidden", operation: "initialize" }); } }
    });
    await coordinator.ensureUserServersReady("user-1", ["server-1"]);
    await coordinator.stop();
    expect(failures).toEqual([{ errorCode: "mcp_internal_address_forbidden", generationId: "generation-1" }]);

    const state = {
      accountLabel: null, description: "", enabled: true, errorCode: failures[0]!.errorCode, fields: [], id: "server-1",
      knownToolCount: 0, name: "NAS tools", oauthAvailable: false, oauthState: null, readiness: "unavailable",
      runtimeGenerationId: "generation-1", sourceType: "personal", tools: []
    } satisfies McpUserServerState & Pick<UserMcpServer, "sourceType">;
    expect(userServerProjection(state).runtimeErrorCode).toBe("mcp_internal_address_forbidden");
  });

  it("drains a live runtime and refuses its accepted dispatch without an upstream request once the switch is off", async () => {
    const fixture = await startFixture();
    let localNetworkEnabled = true;
    const policy = createPersonalMcpAddressPolicy({
      environment: () => buildPersonalMcpNetworkEnvironment(networkHost),
      readLocalNetworkEnabled: async () => localNetworkEnabled
    });
    const forwarded: string[] = [];
    // Calls, inventory and health checks are POSTs; the SDK's background SSE
    // GET may be dispatched at any time and is not a dispatch under test.
    const posts = () => forwarded.filter((entry) => entry.startsWith("POST ")).length;
    // The NAS resolves to a LAN address; the pinned request is served by the loopback fixture.
    const dispatch = async (request: McpPinnedHttpRequest) => {
      forwarded.push(`${request.method} ${request.address.address}`);
      return fetch(new URL(`${request.url.pathname}${request.url.search}`, fixture.url), {
        body: request.body ?? undefined, headers: request.headers, method: request.method, signal: request.signal
      });
    };
    const sessions = createMcpClientSessionFactory({
      fetch: refusingFetch("mcp_http_address_forbidden"),
      fetchForLaunch: (launch) => createMcpSafeFetch({
        ...mcpDestinationSafeFetchOptions({
          allowInsecureHttp: true,
          allowPrivateNetwork: launch.allowPrivateNetwork === true,
          personal: launch.personalRuntime === true
        }, policy.decide),
        dispatch,
        lookupHostname: async () => [{ address: "192.168.1.20", family: 4 }]
      }),
      limits: LIMITS
    });
    const launch: McpRuntimeGenerationLaunch = {
      allowPrivateNetwork: false, callTimeoutMs: 5_000, fingerprint: "fingerprint-1", generationId: "generation-1",
      headers: {}, personalRuntime: true, publishedTools: { kind: "names", names: new Set() }, redactionValues: [],
      retryAt: null, startupTimeoutMs: 5_000, url: "http://nas.lan:8080/mcp"
    };
    const { failures, repository } = runtimeRepository(launch);
    let now = Date.parse("2026-10-02T10:00:00.000Z");
    const coordinator = new McpRuntimeCoordinator({ now: () => new Date(now), repository, sessions });
    // The accepted definition is the one the runtime published when it became ready.
    const acceptedHash = () => vi.mocked(repository.markReady).mock.calls[0]?.[0].inventory.tools
      .find((tool) => tool.name === "echo")?.definitionHash ?? "missing";
    const call = () => coordinator.callTool({
      arguments: {}, definitionHash: acceptedHash(), generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    });
    try {
      await coordinator.ensureUserServersReady("user-1", ["server-1"]);
      expect(coordinator.hasLiveGeneration("generation-1")).toBe(true);
      await expect(call()).resolves.toMatchObject({ isError: false, text: ["echo"] });
      expect(forwarded.every((entry) => entry.endsWith(" 192.168.1.20"))).toBe(true);

      // The administrator switches local network access off.
      localNetworkEnabled = false;
      policy.invalidate();
      const reachedBefore = posts();
      await expect(call()).rejects.toMatchObject({ code: "mcp_local_network_disabled", name: "McpClientSessionError" });

      // The next health check drains the runtime with the stable reason.
      now += 31_000;
      coordinator.operationalStatus("generation-1");
      await vi.waitFor(() => expect(failures).toContainEqual({ errorCode: "mcp_local_network_disabled", generationId: "generation-1" }));
      expect(coordinator.hasLiveGeneration("generation-1")).toBe(false);

      // Reconnecting for the accepted run is refused with the same reason.
      await expect(coordinator.ensureAcceptedGeneration("generation-1")).resolves.toBe(false);
      expect(failures.at(-1)).toEqual({ errorCode: "mcp_local_network_disabled", generationId: "generation-1" });
      expect(posts()).toBe(reachedBefore);

      // Dispatch revalidation projects the failed runtime as the stable refusal.
      const route: Parameters<typeof currentMcpDispatchFailure>[1] = {
        fingerprint: "fingerprint-1", originalName: "echo", serverId: "server-1",
        tool: { definitionHash: "hash", description: "Echo", inputSchema: { type: "object" }, name: "echo",
          namespacedName: "nas__echo", originalName: "echo", serverId: "server-1", serverName: "NAS tools" }
      };
      const failure = currentMcpDispatchFailure({
        code: "mcp_not_ready",
        issues: [{ errorCode: failures.at(-1)!.errorCode, name: "NAS tools", readiness: "unavailable" }],
        ok: false
      }, route, "generation-1");
      expect(failure).toBe("mcp_local_network_disabled");
      expect(mcpDispatchError(failure!).message).toBe(mcpRuntimeErrorMessage("mcp_local_network_disabled"));

      // Switching it back on lets the accepted runtime reconnect.
      localNetworkEnabled = true;
      policy.invalidate();
      await expect(coordinator.ensureAcceptedGeneration("generation-1")).resolves.toBe(true);
      expect(posts()).toBeGreaterThan(reachedBefore);
    } finally {
      await coordinator.stop();
    }
  });
});

describe("default personal MCP transports", () => {
  it("validates a personal draft under the personal policy and leaves an installation draft unchanged", async () => {
    for (const reason of ["mcp_internal_address_forbidden", "mcp_local_network_disabled"] as const) {
      const personalAddressPolicy = vi.fn(async () => reason);
      const validator = createDefaultMcpDraftValidator({ personalAddressPolicy });
      await expect(validator.validate({ draft: remoteDraft("http://192.168.1.20:8080/mcp"), personal: true, values: {} }))
        .resolves.toEqual({ issues: [expect.objectContaining({ code: reason, path: "source" })], kind: "invalid" });
      await expect(validator.validate({ draft: remoteDraft("http://192.168.1.20:8080/mcp"), values: {} }))
        .resolves.toEqual({ issues: [expect.objectContaining({ code: "mcp_connection_forbidden" })], kind: "invalid" });
      expect(personalAddressPolicy).toHaveBeenCalledOnce();
    }
  });

  it("builds each launch transport from its destination", async () => {
    const personalAddressPolicy = vi.fn(async () => null);
    const created: McpSafeFetchOptions[] = [];
    const baseFetch = vi.fn() as unknown as FetchLike;
    const oauthFetch = vi.fn() as unknown as FetchLike;
    const oauthRuntimeFetch = vi.fn(async () => oauthFetch);
    const launchFetch = createDefaultMcpLaunchFetch({
      createSafeFetch: (options) => { created.push(options); return baseFetch; },
      oauthRuntimeFetch,
      personalAddressPolicy
    });
    const launch = (overrides: Partial<McpRuntimeLaunch>): McpRuntimeLaunch => ({
      callTimeoutMs: 5_000, fingerprint: "fingerprint", generationId: "generation", headers: {}, redactionValues: [],
      retryAt: null, startupTimeoutMs: 5_000, url: "http://nas.lan:8080/mcp", ...overrides
    });

    await expect(launchFetch(launch({ personalRuntime: true }))).resolves.toBe(baseFetch);
    await launchFetch(launch({ allowPrivateNetwork: true }));
    await expect(launchFetch(launch({ oauthConnectionId: "connection-1", personalRuntime: true }))).resolves.toBe(oauthFetch);
    expect(created).toEqual([
      { addressPolicy: personalAddressPolicy, allowInsecureHttp: true, egressHeaders: PERSONAL_MCP_EGRESS_HEADERS },
      { allowInsecureHttp: true, allowPrivateNetwork: true },
      { addressPolicy: personalAddressPolicy, allowInsecureHttp: true, egressHeaders: PERSONAL_MCP_EGRESS_HEADERS }
    ]);
    expect(oauthRuntimeFetch).toHaveBeenCalledExactlyOnceWith("connection-1", baseFetch, "http://nas.lan:8080/mcp");
  });

  it("refuses a personal launch before any request with the policy's reason", async () => {
    const launchFetch = createDefaultMcpLaunchFetch({ personalAddressPolicy: async () => "mcp_local_network_disabled" as const });
    const fetch = await launchFetch({
      callTimeoutMs: 5_000, fingerprint: "fingerprint", generationId: "generation", headers: {}, personalRuntime: true,
      redactionValues: [], retryAt: null, startupTimeoutMs: 5_000, url: "http://192.168.1.20:8080/mcp"
    });
    await expect(fetch("http://192.168.1.20:8080/mcp")).rejects.toMatchObject({ code: "mcp_local_network_disabled" });
  });
});

describe("switching personal local network access off", () => {
  type PolicyGlobal = typeof globalThis & { __aiqsaPersonalMcpAddressPolicy?: PersonalMcpAddressPolicyState };

  it("closes live personal runtimes at once and restarts only those the policy still allows", async () => {
    const scope = globalThis as PolicyGlobal;
    const previous = scope.__aiqsaPersonalMcpAddressPolicy;
    const fixture = await startFixture();
    let localNetworkEnabled = true;
    let version = 1;
    // The process-wide default policy, read through its injected setting.
    scope.__aiqsaPersonalMcpAddressPolicy = createPersonalMcpAddressPolicy({
      environment: () => buildPersonalMcpNetworkEnvironment(networkHost),
      readLocalNetworkEnabled: async () => localNetworkEnabled
    });
    const posts: string[] = [];
    const sessions = createMcpClientSessionFactory({
      fetch: refusingFetch("mcp_http_address_forbidden"),
      // The default launch transport; only the wire is a loopback fixture.
      fetchForLaunch: createDefaultMcpLaunchFetch({
        createSafeFetch: (options) => createMcpSafeFetch({
          ...options,
          dispatch: async (request) => {
            if (request.method === "POST") posts.push(request.address.address);
            return fetch(new URL(`${request.url.pathname}${request.url.search}`, fixture.url), {
              body: request.body ?? undefined, headers: request.headers, method: request.method, signal: request.signal
            });
          },
          lookupHostname: async (hostname) => [{ address: hostname === "nas.lan" ? "192.168.1.20" : "93.184.216.34", family: 4 }]
        })
      }),
      limits: LIMITS
    });
    const personalLaunch = (generationId: string, url: string): McpRuntimeGenerationLaunch => ({
      allowPrivateNetwork: false, callTimeoutMs: 5_000, fingerprint: `fingerprint-${generationId}`, generationId,
      headers: {}, personalRuntime: true, publishedTools: { kind: "names", names: new Set() }, redactionValues: [],
      retryAt: null, startupTimeoutMs: 5_000, url
    });
    const { failures, repository } = runtimeRepository(
      personalLaunch("generation-lan", "http://nas.lan:8080/mcp"),
      personalLaunch("generation-public", "http://tools.example.test:8080/mcp"),
      { ...personalLaunch("generation-installation", "http://tools.example.test:8080/mcp"), personalRuntime: undefined }
    );
    const coordinator = new McpRuntimeCoordinator({ repository, sessions });
    const handlers = createMcpPolicyHandlers({
      onUpdated: (policy) => applyPersonalMcpPolicyChange(policy, coordinator),
      repository: {
        read: async () => ({ personalLocalNetworkEnabled: localNetworkEnabled, version }),
        update: async (input) => {
          if (input.expectedVersion !== version) return { kind: "stale" };
          localNetworkEnabled = input.personalLocalNetworkEnabled;
          version += 1;
          return { kind: "ok", policy: { personalLocalNetworkEnabled: localNetworkEnabled, version } };
        }
      },
      resolveAuth: (async () => ({ user: { id: "admin-1", role: "admin", status: "active" }, userId: "admin-1" })) as unknown as RequestAuthResolver
    });
    const patch = (personalLocalNetworkEnabled: boolean) => handlers.PATCH(new Request("https://aiqsa.test/api/admin/mcp/policy", {
      body: JSON.stringify({ personalLocalNetworkEnabled, version }), headers: { "content-type": "application/json" }, method: "PATCH"
    }));
    const lan = { address: "192.168.1.20", family: 4 } as const;
    const nasUrl = new URL("http://nas.lan:8080/mcp");
    try {
      await coordinator.ensureUserServersReady("user-1", ["server-lan", "server-public", "server-installation"]);
      expect(coordinator.hasLiveGeneration("generation-lan")).toBe(true);
      expect(coordinator.hasLiveGeneration("generation-public")).toBe(true);
      expect(coordinator.hasLiveGeneration("generation-installation")).toBe(true);
      await expect(personalMcpAddressPolicy(lan, nasUrl)).resolves.toBeNull();
      const lanPostsBefore = posts.filter((address) => address === lan.address).length;

      await expect(patch(false)).resolves.toMatchObject({ status: 200 });
      // Both sessions close with the response, open streams included, and the
      // cached setting is gone at once.
      expect(coordinator.hasLiveGeneration("generation-lan")).toBe(false);
      expect(coordinator.hasLiveGeneration("generation-public")).toBe(false);
      expect(coordinator.hasLiveGeneration("generation-installation")).toBe(true);
      await expect(personalMcpAddressPolicy(lan, nasUrl)).resolves.toBe("mcp_local_network_disabled");

      // The resync restarts the public endpoint; the LAN one is refused before any request.
      await coordinator.reconcileNow();
      expect(coordinator.hasLiveGeneration("generation-public")).toBe(true);
      expect(coordinator.hasLiveGeneration("generation-lan")).toBe(false);
      expect(failures).toContainEqual({ errorCode: "mcp_local_network_disabled", generationId: "generation-lan" });
      expect(failures.filter((failure) => failure.generationId === "generation-public")).toEqual([]);
      expect(posts.filter((address) => address === lan.address)).toHaveLength(lanPostsBefore);

      // Switching back on lets the LAN runtime reconnect on the resync.
      await expect(patch(true)).resolves.toMatchObject({ status: 200 });
      await coordinator.reconcileNow();
      expect(coordinator.hasLiveGeneration("generation-lan")).toBe(true);
    } finally {
      await coordinator.stop();
      if (previous) scope.__aiqsaPersonalMcpAddressPolicy = previous;
      else delete scope.__aiqsaPersonalMcpAddressPolicy;
    }
  });
});
