import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type {
  FetchLike,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/client";
import { Server, type ListToolsResult } from "@modelcontextprotocol/server";
import { auth } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  bindMcpOAuthPolicyResource,
  type McpOAuthPolicy,
  type McpOAuthPurpose
} from "./oauthPolicy";
import type {
  McpOAuthRepository,
  McpOAuthRepositoryResult,
  McpOAuthStoredClient,
  McpOAuthStoredConnection
} from "./oauthRepository";
import { MCP_OAUTH_REVOCATION_ABANDON_MS, McpOAuthError, McpOAuthService } from "./oauthService";
import { McpClientSession } from "./clientSession";
import { createMcpSafeFetch } from "./safeFetch";

const SERVER_URL = "https://mcp.fixture.test/mcp";
const AUTH_ORIGIN = "https://auth.fixture.test";
const REDIRECT_URI = "https://aiqsa.fixture.test/api/me/mcp/server-1/oauth/callback";
const BROKER_SERVER_URL = "https://broker.fixture.test/mcp";
const BROKER_AUTH_ORIGIN = "https://broker-auth.fixture.test";
const HTTP_SERVER_URL = SERVER_URL.replace("https:", "http:");
const HTTP_AUTH_ORIGIN = AUTH_ORIGIN.replace("https:", "http:");
const HTTP_REDIRECT_URI = REDIRECT_URI.replace("https:", "http:");

function fixturePolicy(): McpOAuthPolicy {
  return {
    allowPrivateNetwork: false,
    allowedAuthorizationServerOrigins: [AUTH_ORIGIN],
    configurationIdentity: "revision-1",
    purpose: "user",
    redirectUri: REDIRECT_URI,
    requestedScopes: ["mcp.read", "mcp.write"],
    resource: SERVER_URL,
    resourceMode: "explicit",
    serverId: "server-1",
    serverUrl: SERVER_URL,
    userId: "user-1"
  };
}

function brokerPolicy(): McpOAuthPolicy {
  return {
    ...fixturePolicy(),
    allowedAuthorizationServerOrigins: [BROKER_AUTH_ORIGIN],
    requestedScopes: ["remote.read"],
    resource: BROKER_SERVER_URL,
    serverUrl: BROKER_SERVER_URL
  };
}

class MemoryOAuthRepository implements McpOAuthRepository {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly clients = new Map<string, McpOAuthStoredClient>();
  readonly connections = new Map<string, McpOAuthStoredConnection>();
  readonly disconnectRequestedAt = new Map<string, Date>();
  readonly ineligibleConnectionIds = new Set<string>();
  readonly policy: McpOAuthPolicy;
  activeBindings = false;
  clientSequence = 0;
  connectionSequence = 0;
  readonly loadPolicyInputs: Array<Parameters<McpOAuthRepository["loadPolicy"]>[0]> = [];
  readonly retiredClientIds: string[] = [];
  eligibilityReconcileCalls = 0;
  now = new Date("2026-07-22T12:00:00.000Z");
  policyAvailable = true;
  validationPrepareCalls = 0;

  constructor(
    policy: McpOAuthPolicy = fixturePolicy(),
    additionalUserIds: readonly string[] = []
  ) {
    this.policy = policy;
    this.allowedUserIds = new Set([policy.userId, ...additionalUserIds]);
  }

  async abandonRevocation(input: Parameters<McpOAuthRepository["abandonRevocation"]>[0]): Promise<boolean> {
    const connection = this.connections.get(input.connectionId);
    const requestedAt = this.disconnectRequestedAt.get(input.connectionId);
    if (connection?.state !== "disconnecting" || !requestedAt || requestedAt >= input.requestedBefore) return false;
    this.connections.set(input.connectionId, { ...connection, state: "disconnected" });
    return true;
  }

  async createConnection(input: Parameters<McpOAuthRepository["createConnection"]>[0]):
    Promise<McpOAuthRepositoryResult<McpOAuthStoredConnection>> {
    if (input.configurationIdentity !== this.policy.configurationIdentity) {
      return { kind: "configuration_changed" };
    }
    const connectionPolicy = this.policyForUser(input.userId);
    if (!connectionPolicy) return { kind: "not_found" };
    const resolvedPolicy = bindMcpOAuthPolicyResource(connectionPolicy, input.resource);
    if (!resolvedPolicy) return { kind: "configuration_changed" };
    for (const [id, connection] of this.connections) {
      if (connection.userId === input.userId && connection.purpose === input.purpose &&
        connection.state === "ready") {
        this.connections.set(id, { ...connection, state: "disconnecting" });
      }
    }
    const client = [...this.clients.values()].find((candidate) => candidate.id === input.oauthClientId);
    if (!client) return { kind: "not_found" };
    const id = `connection-${++this.connectionSequence}`;
    const value: McpOAuthStoredConnection = {
      client,
      expiresAt: input.tokens.expires_in
        ? new Date(this.now.getTime() + input.tokens.expires_in * 1_000)
        : null,
      externalAccountLabel: input.externalAccountLabel,
      id,
      policy: structuredClone(resolvedPolicy),
      policyFingerprint: input.policyFingerprint,
      purpose: input.purpose,
      scopes: input.tokens.scope?.split(" ") ?? this.policy.requestedScopes,
      state: "ready",
      tokens: input.tokens,
      tokenVersion: "version-1",
      userId: input.userId
    };
    this.connections.set(id, value);
    return { kind: "ok", value };
  }

  async finalizeDisconnected(input: Parameters<McpOAuthRepository["finalizeDisconnected"]>[0]):
    Promise<boolean> {
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.state !== "disconnecting" || this.activeBindings ||
      connection.tokenVersion !== input.tokenVersion) return false;
    this.connections.set(input.connectionId, { ...connection, state: "disconnected" });
    return true;
  }

  async findClient(registrationKey: string): Promise<McpOAuthStoredClient | null> {
    return this.clients.get(registrationKey) ?? null;
  }

  async findReadyConnection(input: Parameters<McpOAuthRepository["findReadyConnection"]>[0]):
    Promise<McpOAuthStoredConnection | null> {
    return [...this.connections.values()].find((connection) =>
      connection.state === "ready" &&
      connection.policyFingerprint === input.policyFingerprint &&
      connection.purpose === input.purpose &&
      connection.policy.serverId === input.serverId &&
      connection.userId === input.userId
    ) ?? null;
  }

  async findLatestReadyConnection(input: Parameters<McpOAuthRepository["findLatestReadyConnection"]>[0]):
    Promise<McpOAuthStoredConnection | null> {
    return [...this.connections.values()].reverse().find((connection) =>
      connection.state === "ready" && connection.purpose === input.purpose &&
      connection.policy.serverId === input.serverId && connection.userId === input.userId
    ) ?? null;
  }

  async hasActiveRunBindings(): Promise<boolean> {
    return this.activeBindings;
  }

  async listDisconnectingConnectionIds(): Promise<string[]> {
    return [...this.connections.values()]
      .filter((connection) => connection.state === "disconnecting")
      .map((connection) => connection.id);
  }

  async loadConnection(connectionId: string): Promise<McpOAuthStoredConnection | null> {
    const connection = this.connections.get(connectionId);
    // Finalization clears the encrypted tokens, so the durable repository no
    // longer serializes a disconnected connection.
    return connection && connection.state !== "disconnected" ? connection : null;
  }

  async prepareValidationPolicy(input: { redirectUri: string; serverId: string; userId: string }):
    Promise<McpOAuthPolicy | null> {
    this.validationPrepareCalls += 1;
    return this.policy.purpose === "validation" && input.redirectUri === this.policy.redirectUri &&
      input.serverId === this.policy.serverId
      ? this.policyForUser(input.userId)
      : null;
  }

  async loadPolicy(input: Parameters<McpOAuthRepository["loadPolicy"]>[0]):
    Promise<McpOAuthPolicy | null> {
    this.loadPolicyInputs.push(input);
    return this.policyAvailable && input.purpose === this.policy.purpose &&
      input.redirectUri === this.policy.redirectUri &&
      input.serverId === this.policy.serverId
      ? this.policyForUser(input.userId)
      : null;
  }

  async markReauthorizationRequired(input: Parameters<McpOAuthRepository["markReauthorizationRequired"]>[0]):
    Promise<boolean> {
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.tokenVersion !== input.tokenVersion) return false;
    this.connections.set(input.connectionId, { ...connection, state: "reauthorization_required" });
    return true;
  }

  async requestDisconnect(input: Parameters<McpOAuthRepository["requestDisconnect"]>[0]):
    Promise<McpOAuthStoredConnection | null> {
    const connection = [...this.connections.values()].reverse().find((candidate) =>
      candidate.policy.serverId === input.serverId && candidate.userId === input.userId &&
      candidate.purpose === input.purpose && candidate.state !== "disconnected"
    );
    if (!connection) return null;
    const updated: McpOAuthStoredConnection = { ...connection, state: "disconnecting" };
    this.connections.set(connection.id, updated);
    return updated;
  }

  async requestDisconnectForIneligibleConnections(): Promise<number> {
    this.eligibilityReconcileCalls += 1;
    let updated = 0;
    for (const id of this.ineligibleConnectionIds) {
      const connection = this.connections.get(id);
      if (!connection || !["ready", "reauthorization_required"].includes(connection.state)) continue;
      this.connections.set(id, { ...connection, state: "disconnecting" });
      this.disconnectRequestedAt.set(id, this.now);
      updated += 1;
    }
    return updated;
  }

  async retireClient(input: Parameters<McpOAuthRepository["retireClient"]>[0]): Promise<boolean> {
    const current = this.clients.get(input.registrationKey);
    if (!current || current.id !== input.id || current.clientInformation.client_id !== input.clientId) return false;
    // Existing connections keep their client; only lookup by key stops.
    this.clients.delete(input.registrationKey);
    this.retiredClientIds.push(input.id);
    return true;
  }

  async rotateTokens(input: Parameters<McpOAuthRepository["rotateTokens"]>[0]):
    Promise<McpOAuthStoredConnection | null> {
    const connection = await this.loadConnection(input.connectionId);
    if (!connection || connection.tokenVersion !== input.expectedTokenVersion ||
      !["ready", "disconnecting"].includes(connection.state)) {
      return connection;
    }
    const version = Number(connection.tokenVersion.split("-")[1] ?? "1") + 1;
    const tokens = {
      ...input.tokens,
      ...(input.tokens.refresh_token || !connection.tokens.refresh_token
        ? {}
        : { refresh_token: connection.tokens.refresh_token })
    };
    const updated: McpOAuthStoredConnection = {
      ...connection,
      expiresAt: tokens.expires_in
        ? new Date(this.now.getTime() + tokens.expires_in * 1_000)
        : null,
      tokens,
      tokenVersion: `version-${version}`
    };
    this.connections.set(connection.id, updated);
    return updated;
  }

  async saveClient(input: {
    clientInformation: OAuthClientInformationMixed;
    clientMetadata: OAuthClientMetadata;
    discoveryState: McpOAuthStoredClient["discoveryState"];
    registrationKey: string;
  }): Promise<McpOAuthStoredClient> {
    // Like the Prisma repository: an upsert by key keeps the row id, and the
    // SDK's issuer stamp is not part of the stored client information.
    const { issuer: _issuer, ...clientInformation } = input.clientInformation as OAuthClientInformationMixed & { issuer?: string };
    const client: McpOAuthStoredClient = {
      clientInformation,
      clientMetadata: input.clientMetadata,
      discoveryState: input.discoveryState,
      id: this.clients.get(input.registrationKey)?.id ?? `client-${++this.clientSequence}`,
      registrationKey: input.registrationKey
    };
    this.clients.set(input.registrationKey, client);
    return client;
  }

  private policyForUser(userId: string): McpOAuthPolicy | null {
    if (!this.allowedUserIds.has(userId)) return null;
    return userId === this.policy.userId ? this.policy : { ...this.policy, userId };
  }
}

class StandardsOAuthFixture {
  authorizationCodeVerifier: string | null = null;
  clientSecretPost = false;
  dcrCalls = 0;
  expectedRedirectUri = REDIRECT_URI;
  foreignTokenEndpoint = false;
  invalidRefresh = false;
  issuerResponseParameterSupported = false;
  metadataDocumentSupported = false;
  omitRefreshTokenOnRefresh = false;
  publicClient = false;
  publicClientId = "http://mcp.fixture.test/client-metadata";
  refreshCalls = 0;
  revokedHints: string[] = [];
  resource = SERVER_URL;
  tokenResponseOverride: ((body: URLSearchParams) => Response) | null = null;

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.origin === "https://mcp.fixture.test" &&
      url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        authorization_servers: [AUTH_ORIGIN],
        resource: this.resource,
        resource_name: "Fixture Workspace",
        scopes_supported: ["mcp.read", "mcp.write"]
      });
    }
    if (url.toString() === `${AUTH_ORIGIN}/.well-known/oauth-authorization-server`) {
      const clientAuthMethod = this.publicClient
        ? "none"
        : this.clientSecretPost ? "client_secret_post" : "client_secret_basic";
      return Response.json({
        authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
        client_id_metadata_document_supported: this.metadataDocumentSupported,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: AUTH_ORIGIN,
        authorization_response_iss_parameter_supported: this.issuerResponseParameterSupported,
        registration_endpoint: `${AUTH_ORIGIN}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${AUTH_ORIGIN}/revoke`,
        revocation_endpoint_auth_methods_supported: [clientAuthMethod],
        token_endpoint: this.foreignTokenEndpoint
          ? "https://unreviewed.example.test/token"
          : `${AUTH_ORIGIN}/token`,
        token_endpoint_auth_methods_supported: [clientAuthMethod]
      });
    }
    if (url.toString() === `${AUTH_ORIGIN}/register`) {
      this.dcrCalls += 1;
      const body = JSON.parse(String(init?.body)) as OAuthClientMetadata;
      expect(body.redirect_uris).toEqual([this.expectedRedirectUri]);
      expect(body.scope).toBe("mcp.read mcp.write");
      return Response.json({
        ...body,
        client_id: "fixture-client",
        client_secret: "fixture-client-secret",
        token_endpoint_auth_method: this.clientSecretPost
          ? "client_secret_post"
          : "client_secret_basic"
      }, { status: 201 });
    }
    if (url.toString() === `${AUTH_ORIGIN}/token`) {
      const body = new URLSearchParams(String(init?.body));
      if (this.publicClient) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(body.get("client_id")).toBe(this.publicClientId);
      } else if (this.clientSecretPost) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(body.get("client_id")).toBe("fixture-client");
        expect(body.get("client_secret")).toBe("fixture-client-secret");
      } else {
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
      }
      expect(body.get("resource")).toBe(this.resource);
      if (this.tokenResponseOverride) return this.tokenResponseOverride(body);
      if (body.get("grant_type") === "authorization_code") {
        expect(body.get("code")).toBe("fixture-code");
        expect(body.get("code_verifier")).toBe(this.authorizationCodeVerifier);
        return Response.json({
          access_token: "access-1",
          expires_in: 3_600,
          refresh_token: "refresh-1",
          scope: "mcp.read mcp.write",
          token_type: "Bearer"
        } satisfies OAuthTokens);
      }
      expect(body.get("grant_type")).toBe("refresh_token");
      this.refreshCalls += 1;
      if (this.invalidRefresh) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: `access-refresh-${this.refreshCalls}`,
        expires_in: 3_600,
        ...(this.omitRefreshTokenOnRefresh
          ? {}
          : { refresh_token: `refresh-${this.refreshCalls + 1}` }),
        scope: "mcp.read mcp.write",
        token_type: "Bearer"
      } satisfies OAuthTokens);
    }
    if (url.toString() === `${AUTH_ORIGIN}/revoke`) {
      const body = new URLSearchParams(String(init?.body));
      if (this.clientSecretPost) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(body.get("client_id")).toBe("fixture-client");
        expect(body.get("client_secret")).toBe("fixture-client-secret");
      }
      this.revokedHints.push(body.get("token_type_hint") ?? "");
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: "fixture_not_found" }, { status: 404 });
  };
}

function httpPolicy(overrides: Partial<McpOAuthPolicy> = {}): McpOAuthPolicy {
  return {
    ...fixturePolicy(),
    allowedAuthorizationServerOrigins: [HTTP_AUTH_ORIGIN],
    redirectUri: HTTP_REDIRECT_URI,
    resource: HTTP_SERVER_URL,
    serverUrl: HTTP_SERVER_URL,
    ...overrides
  };
}

function insecureHttpFixtureFetch(fixture: StandardsOAuthFixture) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const mapped = new URL(input.toString());
    expect(mapped.protocol).toBe("http:");
    mapped.protocol = "https:";
    const response = await fixture.fetch(mapped, init);
    if (mapped.pathname === "/token" || mapped.pathname === "/revoke") return response;
    const body = await response.text();
    return new Response(body ? body.replaceAll("https://", "http://") : null, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  };
}

const OWN_HOST_HTTP_AUTH_ORIGIN = "http://mcp.fixture.test:9000";

/** An acknowledged http MCP endpoint whose authorization server runs on the
 * same hostname on another port. */
function ownHostHttpFixtureFetch(fixture: StandardsOAuthFixture, requested: string[] = []) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    requested.push(url.toString());
    expect(url.protocol).toBe("http:");
    const mapped = url.origin === OWN_HOST_HTTP_AUTH_ORIGIN
      ? new URL(`${url.pathname}${url.search}`, AUTH_ORIGIN)
      : new URL(url.toString().replace("http:", "https:"));
    const response = await fixture.fetch(mapped, init);
    if (mapped.pathname === "/token" || mapped.pathname === "/revoke") return response;
    const body = await response.text();
    return new Response(body
      ? body.replaceAll(AUTH_ORIGIN, OWN_HOST_HTTP_AUTH_ORIGIN).replaceAll("https://", "http://")
      : null, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  };
}

async function startMappedHttpAuthorization(fixture: StandardsOAuthFixture) {
  fixture.expectedRedirectUri = HTTP_REDIRECT_URI;
  fixture.resource = HTTP_SERVER_URL;
  const repository = new MemoryOAuthRepository(httpPolicy());
  const service = new McpOAuthService({
    fetchForPolicy: () => insecureHttpFixtureFetch(fixture),
    now: () => repository.now,
    repository
  });
  const started = await service.startAuthorization({
    forceReconnect: false,
    purpose: "user",
    redirectUri: HTTP_REDIRECT_URI,
    serverId: "server-1",
    state: "mapped-http-state",
    userId: "user-1"
  });
  if (started.kind !== "redirect") throw new Error("expected redirect");
  fixture.authorizationCodeVerifier = started.flow.codeVerifier;
  return { repository, service, started };
}

async function startInsecureHttpOAuthServer(fixture: StandardsOAuthFixture) {
  const mcp = new Server(
    { name: "http-oauth-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  mcp.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
    tools: [{
      description: "Read HTTP fixture state",
      inputSchema: { type: "object" },
      name: "read_http_fixture"
    }]
  }));
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "http-oauth-session"
  });
  await mcp.connect(transport);
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
      if (requestUrl.pathname === "/mcp") {
        if (!/^Bearer access(?:-refresh-\d+)?$/u.test(request.headers.authorization ?? "")) {
          response.statusCode = 401;
          response.end();
          return;
        }
        await transport.handleRequest(request, response);
        return;
      }
      const upstreamOrigin = requestUrl.pathname.startsWith("/.well-known/oauth-protected-resource")
        ? new URL(SERVER_URL).origin
        : AUTH_ORIGIN;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const upstream = await fixture.fetch(new URL(requestUrl.pathname + requestUrl.search, upstreamOrigin), {
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        headers,
        method: request.method
      });
      const body = (await upstream.text())
        .replaceAll(new URL(SERVER_URL).origin, `http://${request.headers.host}`)
        .replaceAll(AUTH_ORIGIN, `http://${request.headers.host}`);
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(body);
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    async close() {
      await mcp.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    origin: `http://127.0.0.1:${address.port}`
  };
}

type BrokerAuthorizationCode = Readonly<{
  challenge: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  subject: string;
}>;

type BrokerUpstreamGrant = Readonly<{
  accessToken: string;
  refreshToken: string;
  subject: string;
}>;

class BrokeredOAuthFixture {
  readonly authorizationCodes = new Map<string, BrokerAuthorizationCode>();
  readonly downstreamTokens = new Set<string>();
  readonly readSubjects: string[] = [];
  readonly revokedDownstreamTokens: string[] = [];
  readonly upstreamGrants = new Map<string, BrokerUpstreamGrant>();
  readonly upstreamTokens = new Set<string>();
  dcrCalls = 0;
  refreshCalls = 0;
  sequence = 0;

  readonly #tokenToGrant = new Map<string, string>();

  approve(authorizationUrl: string, subject: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe(BROKER_AUTH_ORIGIN);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("broker-client");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("resource")).toBe(BROKER_SERVER_URL);
    expect(url.searchParams.get("scope")).toBe("remote.read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge");
    if (!state || !codeChallenge) throw new Error("invalid broker authorization request");
    const code = `broker-code-${++this.sequence}`;
    this.authorizationCodes.set(code, {
      challenge: codeChallenge,
      clientId: "broker-client",
      redirectUri: REDIRECT_URI,
      resource: BROKER_SERVER_URL,
      subject
    });
    return { code, state };
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === BROKER_SERVER_URL) {
      const authorization = new Headers(init?.headers).get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      const grantId = token ? this.#tokenToGrant.get(token) : undefined;
      const grant = grantId ? this.upstreamGrants.get(grantId) : undefined;
      if (!token || !grantId || !grant || !token.startsWith("broker-mcp-at-")) {
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }
      this.readSubjects.push(grant.subject);
      return Response.json({ open_issue_count: 2 });
    }
    if (url.origin === "https://broker.fixture.test" &&
      url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        authorization_servers: [BROKER_AUTH_ORIGIN],
        resource: BROKER_SERVER_URL,
        resource_name: "Brokered SaaS",
        scopes_supported: ["remote.read"]
      });
    }
    if (url.toString() === `${BROKER_AUTH_ORIGIN}/.well-known/oauth-authorization-server`) {
      return Response.json({
        authorization_endpoint: `${BROKER_AUTH_ORIGIN}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: BROKER_AUTH_ORIGIN,
        registration_endpoint: `${BROKER_AUTH_ORIGIN}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${BROKER_AUTH_ORIGIN}/revoke`,
        revocation_endpoint_auth_methods_supported: ["client_secret_basic"],
        token_endpoint: `${BROKER_AUTH_ORIGIN}/token`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"]
      });
    }
    if (url.toString() === `${BROKER_AUTH_ORIGIN}/register`) {
      this.dcrCalls += 1;
      const body = JSON.parse(String(init?.body)) as OAuthClientMetadata;
      expect(body.redirect_uris).toEqual([REDIRECT_URI]);
      expect(body.scope).toBe("remote.read");
      return Response.json({
        ...body,
        client_id: "broker-client",
        client_secret: "broker-client-secret",
        token_endpoint_auth_method: "client_secret_basic"
      }, { status: 201 });
    }
    if (url.toString() === `${BROKER_AUTH_ORIGIN}/token`) {
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(
        `Basic ${Buffer.from("broker-client:broker-client-secret", "utf8").toString("base64")}`
      );
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("resource")).toBe(BROKER_SERVER_URL);
      if (body.get("grant_type") === "authorization_code") {
        return this.exchangeAuthorizationCode(body);
      }
      if (body.get("grant_type") === "refresh_token") {
        return this.exchangeRefreshToken(body);
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.toString() === `${BROKER_AUTH_ORIGIN}/revoke`) {
      const body = new URLSearchParams(String(init?.body));
      const token = body.get("token");
      if (token) {
        this.revokedDownstreamTokens.push(token);
        const grantId = this.#tokenToGrant.get(token);
        if (grantId) this.#deleteGrant(grantId);
      }
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: "fixture_not_found" }, { status: 404 });
  };

  private exchangeAuthorizationCode(body: URLSearchParams): Response {
    const code = body.get("code");
    const verifier = body.get("code_verifier");
    const authorization = code ? this.authorizationCodes.get(code) : undefined;
    if (!code || !verifier || !authorization ||
      authorization.challenge !== challenge(verifier) ||
      authorization.clientId !== "broker-client" ||
      authorization.redirectUri !== body.get("redirect_uri") ||
      authorization.resource !== body.get("resource")) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.authorizationCodes.delete(code);
    const grantId = `grant-${authorization.subject}-${this.sequence}`;
    const grant = {
      accessToken: `upstream-access-${authorization.subject}-${this.sequence}`,
      refreshToken: `upstream-refresh-${authorization.subject}-${this.sequence}`,
      subject: authorization.subject
    };
    this.upstreamGrants.set(grantId, grant);
    this.upstreamTokens.add(grant.accessToken);
    this.upstreamTokens.add(grant.refreshToken);
    return this.#issueDownstream(grantId);
  }

  private exchangeRefreshToken(body: URLSearchParams): Response {
    const refreshToken = body.get("refresh_token");
    const grantId = refreshToken ? this.#tokenToGrant.get(refreshToken) : undefined;
    const grant = grantId ? this.upstreamGrants.get(grantId) : undefined;
    if (!refreshToken || !grantId || !grant) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.refreshCalls += 1;
    this.#deleteTokenMappings(grantId);
    const rotatedGrant = {
      accessToken: `upstream-access-${grant.subject}-refresh-${this.refreshCalls}`,
      refreshToken: `upstream-refresh-${grant.subject}-refresh-${this.refreshCalls}`,
      subject: grant.subject
    };
    this.upstreamGrants.set(grantId, rotatedGrant);
    this.upstreamTokens.add(rotatedGrant.accessToken);
    this.upstreamTokens.add(rotatedGrant.refreshToken);
    return this.#issueDownstream(grantId);
  }

  #issueDownstream(grantId: string): Response {
    const suffix = ++this.sequence;
    const accessToken = `broker-mcp-at-${suffix}`;
    const refreshToken = `broker-mcp-rt-${suffix}`;
    this.downstreamTokens.add(accessToken);
    this.downstreamTokens.add(refreshToken);
    this.#tokenToGrant.set(accessToken, grantId);
    this.#tokenToGrant.set(refreshToken, grantId);
    return Response.json({
      access_token: accessToken,
      expires_in: 3_600,
      refresh_token: refreshToken,
      scope: "remote.read",
      token_type: "Bearer"
    } satisfies OAuthTokens);
  }

  #deleteGrant(grantId: string): void {
    this.#deleteTokenMappings(grantId);
    this.upstreamGrants.delete(grantId);
  }

  #deleteTokenMappings(grantId: string): void {
    for (const [token, mappedGrantId] of this.#tokenToGrant) {
      if (mappedGrantId === grantId) this.#tokenToGrant.delete(token);
    }
  }
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("generic MCP OAuth service", () => {
  it("runs the complete OAuth lifecycle over production HTTP while retaining exact-origin policy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const fixture = new StandardsOAuthFixture();
      const http = await startInsecureHttpOAuthServer(fixture);
      closeServer = http.close;
      const serverUrl = `${http.origin}/mcp`;
      const redirectUri = `${http.origin}/api/me/mcp/server-1/oauth/callback`;
      fixture.expectedRedirectUri = redirectUri;
      fixture.resource = serverUrl;
      const repository = new MemoryOAuthRepository(httpPolicy({
        allowPrivateNetwork: true,
        allowedAuthorizationServerOrigins: [http.origin],
        redirectUri,
        resource: serverUrl,
        serverUrl
      }));
      const service = new McpOAuthService({
        fetchForPolicy: (policy) => createMcpSafeFetch({
          allowInsecureHttp: true,
          allowPrivateNetwork: policy.allowPrivateNetwork
        }),
        now: () => repository.now,
        repository
      });

      expect(service.allowInsecureHttp).toBe(true);
      const started = await service.startAuthorization({
        forceReconnect: false,
        purpose: "user",
        redirectUri,
        serverId: "server-1",
        state: "http-state",
        userId: "user-1"
      });
      expect(started.kind).toBe("redirect");
      if (started.kind !== "redirect") return;
      const authorizationUrl = new URL(started.authorizationUrl);
      expect(authorizationUrl.origin).toBe(http.origin);
      expect(authorizationUrl.searchParams.get("state")).toBe("http-state");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("code_challenge"))
        .toBe(challenge(started.flow.codeVerifier));

      fixture.authorizationCodeVerifier = started.flow.codeVerifier;
      const connection = await service.completeAuthorization({
        authorizationCode: "fixture-code",
        flow: started.flow
      });
      expect(connection.tokens).toMatchObject({
        access_token: "access-1",
        refresh_token: "refresh-1"
      });

      const provider = await service.createRuntimeProvider(connection.id);
      const runtimeFetch = await service.createRuntimeFetch(
        connection.id,
        async () => new Response(null, { status: 204 })
      );
      await expect(runtimeFetch(serverUrl)).resolves.toMatchObject({ status: 204 });
      await expect(runtimeFetch("http://unreviewed.example.test/mcp"))
        .rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });

      repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
      await expect(provider.tokens()).resolves.toMatchObject({
        access_token: "access-refresh-1",
        refresh_token: "refresh-2"
      });
      const runtime = new McpClientSession({
        authProvider: provider,
        fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }),
        limits: {
          maxListDurationMs: 10_000,
          maxToolArgumentBytes: 1_024,
          maxToolMetadataBytes: 8_192,
          maxToolResultBytes: 8_192,
          maxToolSchemaBytes: 4_096,
          maxTools: 8
        },
        requestTimeoutMs: 2_000,
        url: new URL(serverUrl)
      });
      try {
        await runtime.initialize({ timeoutMs: 2_000 });
        await expect(runtime.listAllTools({ timeoutMs: 2_000 }))
          .resolves.toMatchObject([{ name: "read_http_fixture" }]);
      } finally {
        await runtime.close();
      }
      await expect(service.disconnect({
        purpose: "user",
        serverId: "server-1",
        userId: "user-1"
      })).resolves.toBe("disconnected");
      expect(fixture.revokedHints.sort()).toEqual(["access_token", "refresh_token"]);
    } finally {
      await closeServer?.();
      vi.unstubAllEnvs();
    }
  });

  it("uses an HTTP Client ID Metadata Document when the authorization server accepts it", async () => {
    const clientDocument = "http://mcp.fixture.test/client-metadata";
    const repository = new MemoryOAuthRepository(httpPolicy({
      clientIdMetadataDocumentUrl: clientDocument
    }));
    const fixture = new StandardsOAuthFixture();
    fixture.expectedRedirectUri = HTTP_REDIRECT_URI;
    fixture.metadataDocumentSupported = true;
    fixture.publicClient = true;
    fixture.publicClientId = clientDocument;
    fixture.resource = HTTP_SERVER_URL;
    const service = new McpOAuthService({
      fetchForPolicy: () => insecureHttpFixtureFetch(fixture),
      repository
    });

    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: HTTP_REDIRECT_URI,
      serverId: "server-1",
      state: "http-cimd-state",
      userId: "user-1"
    });
    expect(started.kind).toBe("redirect");
    if (started.kind !== "redirect") return;
    expect(started.flow.clientId).toBe(clientDocument);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(clientDocument);
    expect(fixture.dcrCalls).toBe(0);

    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    const connection = await service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    });
    expect(connection).toMatchObject({ state: "ready" });

    repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
    fixture.invalidRefresh = true;
    const provider = await service.createRuntimeProvider(connection.id);
    await expect(provider.tokens()).rejects.toMatchObject({
      code: "mcp_oauth_reauthorization_required"
    });
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
  });

  it.each(["advertised", "streamed"] as const)(
    "rejects an oversized %s HTTP token response before parsing it",
    async (responseKind) => {
      const fixture = new StandardsOAuthFixture();
      const { repository, service, started } = await startMappedHttpAuthorization(fixture);
      fixture.tokenResponseOverride = () => {
        if (responseKind === "advertised") {
          return new Response("{}", {
            headers: {
              "content-length": String(512 * 1_024 + 1),
              "content-type": "application/json"
            }
          });
        }
        const chunk = new Uint8Array(300 * 1_024);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
            controller.close();
          }
        }), { headers: { "content-type": "application/json" } });
      };

      await expect(service.completeAuthorization({
        authorizationCode: "fixture-code",
        flow: started.flow
      })).rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
      expect(repository.connections.size).toBe(0);
    }
  );

  it("rejects malformed JSON from an HTTP token endpoint", async () => {
    const fixture = new StandardsOAuthFixture();
    const { repository, service, started } = await startMappedHttpAuthorization(fixture);
    fixture.tokenResponseOverride = () => new Response("{", {
      headers: { "content-type": "application/json" }
    });

    await expect(service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    })).rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(repository.connections.size).toBe(0);
  });

  it("uses client_secret_post over HTTP and preserves an unrotated refresh token", async () => {
    const fixture = new StandardsOAuthFixture();
    fixture.clientSecretPost = true;
    const { repository, service, started } = await startMappedHttpAuthorization(fixture);
    const connection = await service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    });

    fixture.omitRefreshTokenOnRefresh = true;
    repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
    const provider = await service.createRuntimeProvider(connection.id);
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "access-refresh-1",
      refresh_token: "refresh-1"
    });
    expect(repository.connections.get(connection.id)?.tokens.refresh_token).toBe("refresh-1");

    await expect(service.disconnect({
      purpose: "user",
      serverId: "server-1",
      userId: "user-1"
    })).resolves.toBe("disconnected");
    expect(fixture.revokedHints.sort()).toEqual(["access_token", "refresh_token"]);
  });

  it("accepts the exact required issuer on the HTTP callback path", async () => {
    const fixture = new StandardsOAuthFixture();
    fixture.issuerResponseParameterSupported = true;
    const { service, started } = await startMappedHttpAuthorization(fixture);

    await expect(service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow,
      issuer: HTTP_AUTH_ORIGIN
    })).resolves.toMatchObject({ state: "ready" });
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "http://other-auth.fixture.test"]
  ] as const)("rejects a %s required issuer on the HTTP callback path", async (_label, issuer) => {
    const fixture = new StandardsOAuthFixture();
    fixture.issuerResponseParameterSupported = true;
    const { repository, service, started } = await startMappedHttpAuthorization(fixture);

    await expect(service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow,
      issuer
    })).rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(repository.connections.size).toBe(0);
  });

  it("can retain an explicit HTTPS-only OAuth policy", async () => {
    const service = new McpOAuthService({
      allowInsecureHttp: false,
      fetchForPolicy: () => async () => new Response(null, { status: 500 }),
      repository: new MemoryOAuthRepository(httpPolicy())
    });

    await expect(service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: HTTP_REDIRECT_URI,
      serverId: "server-1",
      state: "https-only-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
  });

  it("adopts a discovered same-origin protected resource when the draft omitted it", async () => {
    const repository = new MemoryOAuthRepository({
      ...fixturePolicy(),
      resourceMode: "auto_same_origin"
    });
    const fixture = new StandardsOAuthFixture();
    fixture.resource = "https://mcp.fixture.test/";
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      repository
    });

    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "auto-resource-state",
      userId: "user-1"
    });
    expect(started.kind).toBe("redirect");
    if (started.kind !== "redirect") return;
    expect(new URL(started.authorizationUrl).searchParams.get("resource"))
      .toBe("https://mcp.fixture.test/");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;

    const connection = await service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    });
    expect(connection.policy).toMatchObject({
      resource: "https://mcp.fixture.test/",
      resourceMode: "auto_same_origin"
    });
    await expect(service.createRuntimeProvider(connection.id)).resolves.toBeTruthy();
  });

  it("rejects an auto-discovered protected resource outside the MCP origin", async () => {
    const repository = new MemoryOAuthRepository({
      ...fixturePolicy(),
      resourceMode: "auto_same_origin"
    });
    const fixture = new StandardsOAuthFixture();
    fixture.resource = "https://unreviewed.example.test/resource";
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      repository
    });

    await expect(service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "cross-origin-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
  });

  it("keeps brokered upstream grants private and isolated across users", async () => {
    const repository = new MemoryOAuthRepository(brokerPolicy(), ["user-2"]);
    const fixture = new BrokeredOAuthFixture();
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      now: () => repository.now,
      repository
    });
    const connect = async (userId: string, state: string) => {
      const started = await service.startAuthorization({
        forceReconnect: true,
        purpose: "user",
        redirectUri: REDIRECT_URI,
        serverId: "server-1",
        state,
        userId
      });
      if (started.kind !== "redirect") throw new Error("expected redirect");
      const approval = fixture.approve(started.authorizationUrl, `external-${userId}`);
      expect(approval.state).toBe(state);
      expect(new URL(started.authorizationUrl).searchParams.get("code_challenge"))
        .toBe(challenge(started.flow.codeVerifier));
      return service.completeAuthorization({
        authorizationCode: approval.code,
        flow: started.flow
      });
    };

    const userOne = await connect("user-1", "broker-state-1");
    const userTwo = await connect("user-2", "broker-state-2");
    expect(fixture.dcrCalls).toBe(1);
    expect(fixture.upstreamGrants.size).toBe(2);
    expect(userOne.tokens.access_token).not.toBe(userTwo.tokens.access_token);
    expect(userOne.tokens.refresh_token).not.toBe(userTwo.tokens.refresh_token);
    expect([...fixture.downstreamTokens]).toEqual(expect.arrayContaining([
      userOne.tokens.access_token,
      userOne.tokens.refresh_token,
      userTwo.tokens.access_token,
      userTwo.tokens.refresh_token
    ]));
    expect([...fixture.downstreamTokens].some((token) => fixture.upstreamTokens.has(token)))
      .toBe(false);

    const userOneProvider = await service.createRuntimeProvider(userOne.id);
    const userOneRuntimeFetch = await service.createRuntimeFetch(userOne.id, fixture.fetch);
    const readResponse = await userOneRuntimeFetch(BROKER_SERVER_URL, {
      headers: { authorization: `Bearer ${userOne.tokens.access_token}` },
      method: "POST"
    });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toEqual({ open_issue_count: 2 });
    expect(fixture.readSubjects).toEqual(["external-user-1"]);
    const upstreamToken = [...fixture.upstreamTokens][0];
    await expect(fixture.fetch(BROKER_SERVER_URL, {
      headers: { authorization: `Bearer ${upstreamToken}` },
      method: "POST"
    }).then((response) => response.status)).resolves.toBe(401);

    repository.connections.set(userTwo.id, {
      ...userTwo,
      expiresAt: new Date(userTwo.expiresAt!.getTime() + 7_200_000)
    });
    repository.now = new Date(userOne.expiresAt!.getTime() - 30_000);
    const refreshed = await Promise.all(
      Array.from({ length: 8 }, () => userOneProvider.tokens())
    );
    expect(fixture.refreshCalls).toBe(1);
    const refreshedAccessToken = refreshed[0]?.access_token;
    const refreshedRefreshToken = refreshed[0]?.refresh_token;
    expect(refreshedAccessToken).toMatch(/^broker-mcp-at-/u);
    expect(refreshedRefreshToken).toMatch(/^broker-mcp-rt-/u);
    expect(refreshed.every((tokens) => tokens?.access_token === refreshedAccessToken)).toBe(true);
    expect(repository.connections.get(userTwo.id)?.tokens).toEqual(userTwo.tokens);

    await expect(service.disconnect({
      purpose: "user",
      serverId: "server-1",
      userId: "user-1"
    })).resolves.toBe("disconnected");
    expect(fixture.revokedDownstreamTokens).toEqual(expect.arrayContaining([
      refreshedAccessToken,
      refreshedRefreshToken
    ]));
    expect(fixture.revokedDownstreamTokens.some((token) => fixture.upstreamTokens.has(token)))
      .toBe(false);
    expect(fixture.upstreamGrants.size).toBe(1);
    expect([...fixture.upstreamGrants.values()].map((grant) => grant.subject))
      .toEqual(["external-user-2"]);
    expect(repository.connections.get(userTwo.id)?.state).toBe("ready");

    const reconnectedUserOne = await connect("user-1", "broker-state-reconnect");
    expect(reconnectedUserOne.tokens.access_token).not.toBe(refreshedAccessToken);
    expect(fixture.dcrCalls).toBe(1);
    expect(fixture.upstreamGrants.size).toBe(2);
    expect([...fixture.upstreamGrants.values()].map((grant) => grant.subject).sort())
      .toEqual(["external-user-1", "external-user-2"]);
    expect(repository.connections.get(userTwo.id)?.tokens).toEqual(userTwo.tokens);
  });

  it("discovers, registers, exchanges, singleflights refresh, reuses registration, and revokes", async () => {
    const repository = new MemoryOAuthRepository();
    const fixture = new StandardsOAuthFixture();
    fixture.issuerResponseParameterSupported = true;
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      now: () => repository.now,
      repository
    });
    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "state-1",
      userId: "user-1"
    });
    expect(started.kind).toBe("redirect");
    if (started.kind !== "redirect") return;
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe(AUTH_ORIGIN);
    expect(authorizationUrl.searchParams.get("state")).toBe("state-1");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge"))
      .toBe(challenge(started.flow.codeVerifier));
    expect(authorizationUrl.searchParams.get("resource")).toBe(SERVER_URL);
    expect(fixture.dcrCalls).toBe(1);

    const connection = await service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow,
      issuer: AUTH_ORIGIN
    });
    expect(connection.externalAccountLabel).toBe("Fixture Workspace");
    expect(connection.tokens.access_token).toBe("access-1");
    const runtimeProvider = await service.createRuntimeProvider(connection.id);
    expect(runtimeProvider.exactKnownSecrets()).toEqual(expect.arrayContaining([
      "access-1",
      "refresh-1"
    ]));

    const replacementUrl = "https://replacement-mcp.fixture.test/mcp";
    const runtimeFetch = await service.createRuntimeFetch(
      connection.id,
      async () => new Response(null, { status: 204 }),
      replacementUrl
    );
    await expect(runtimeFetch(replacementUrl)).resolves.toMatchObject({ status: 204 });
    await expect(runtimeFetch("https://unreviewed.example.test/mcp"))
      .rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });

    await expect(service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "state-2",
      userId: "user-1"
    })).resolves.toEqual({
      configurationIdentity: "revision-1",
      kind: "already_connected"
    });
    expect(fixture.dcrCalls).toBe(1);

    repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
    const refreshed = await Promise.all(Array.from({ length: 12 }, () => runtimeProvider.tokens()));
    expect(fixture.refreshCalls).toBe(1);
    expect(refreshed.every((tokens) => tokens?.access_token === "access-refresh-1")).toBe(true);
    expect(runtimeProvider.exactKnownSecrets()).toEqual(expect.arrayContaining([
      "access-1",
      "refresh-1",
      "access-refresh-1",
      "refresh-2"
    ]));

    repository.activeBindings = true;
    repository.ineligibleConnectionIds.add(connection.id);
    await service.reconcileDisconnecting();
    expect(repository.eligibilityReconcileCalls).toBe(1);
    expect(repository.connections.get(connection.id)?.state).toBe("disconnecting");
    expect(fixture.revokedHints).toEqual([]);

    repository.activeBindings = false;
    await service.reconcileDisconnecting();
    expect(repository.eligibilityReconcileCalls).toBe(2);
    expect(fixture.revokedHints.sort()).toEqual(["access_token", "refresh_token"]);
    expect(repository.connections.get(connection.id)?.state).toBe("disconnected");
  });

  it("turns invalid_grant into one actionable reauthorization state", async () => {
    const repository = new MemoryOAuthRepository();
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      now: () => repository.now,
      repository
    });
    const started = await service.startAuthorization({
      forceReconnect: true,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "state-invalid",
      userId: "user-1"
    });
    if (started.kind !== "redirect") throw new Error("expected redirect");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    const connection = await service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    });
    repository.now = new Date(connection.expiresAt!.getTime() - 10_000);
    fixture.invalidRefresh = true;
    await expect(service.tokensForConnection(connection.id)).rejects.toMatchObject({
      code: "mcp_oauth_reauthorization_required"
    } satisfies Partial<McpOAuthError>);
    expect(fixture.refreshCalls).toBe(1);
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
  });

  it("rejects a discovered credential endpoint outside the reviewed origin policy", async () => {
    const repository = new MemoryOAuthRepository();
    const fixture = new StandardsOAuthFixture();
    fixture.foreignTokenEndpoint = true;
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      repository
    });

    await expect(service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "state-policy",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
    expect(fixture.dcrCalls).toBe(0);
  });

  it("prepares and completes the same pinned administrator validation identity", async () => {
    const redirectUri =
      "https://aiqsa.fixture.test/api/admin/mcp/server-1/oauth/validation/callback";
    const repository = new MemoryOAuthRepository({
      ...fixturePolicy(),
      configurationIdentity: "tested-draft-hash",
      purpose: "validation",
      redirectUri,
      userId: "admin-1"
    });
    const fixture = new StandardsOAuthFixture();
    fixture.expectedRedirectUri = redirectUri;
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      now: () => repository.now,
      repository
    });
    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "validation",
      redirectUri,
      serverId: "server-1",
      state: "validation-state",
      userId: "admin-1"
    });
    expect(repository.validationPrepareCalls).toBe(1);
    expect(started.kind).toBe("redirect");
    if (started.kind !== "redirect") return;
    expect(started.flow.configurationIdentity).toBe("tested-draft-hash");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    await expect(service.completeAuthorization({
      authorizationCode: "fixture-code",
      flow: started.flow
    })).resolves.toMatchObject({
      purpose: "validation",
      state: "ready",
      userId: "admin-1"
    });

    Object.assign(repository.policy, { configurationIdentity: "edited-draft-hash" });
    const validationProvider = await service.createValidationProvider({
      redirectUri, serverId: "server-1", userId: "admin-1"
    });
    expect(validationProvider).not.toBeNull();
    await expect(validationProvider!.tokens()).resolves.toMatchObject({ access_token: "access-1" });
    expect(repository.validationPrepareCalls).toBe(1);
    expect(fixture.dcrCalls).toBe(1);

    for (const changed of [
      { requestedScopes: ["new.scope"] },
      { serverUrl: "https://replacement.fixture.test/mcp" },
      { allowPrivateNetwork: true },
      { redirectUri: "https://aiqsa.fixture.test/another-callback" }
    ]) {
      const prior = { ...repository.policy };
      Object.assign(repository.policy, changed);
      await expect(service.createValidationProvider({
        redirectUri: repository.policy.redirectUri, serverId: "server-1", userId: "admin-1"
      })).resolves.toBeNull();
      Object.assign(repository.policy, prior);
    }
  });

  it("refuses callback completion after the bound revision stops being eligible", async () => {
    const repository = new MemoryOAuthRepository();
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      repository
    });
    const started = await service.startAuthorization({
      forceReconnect: true,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "revision-state",
      userId: "user-1"
    });
    if (started.kind !== "redirect") throw new Error("expected redirect");
    repository.policyAvailable = false;

    await expect(service.completeAuthorization({
      authorizationCode: "must-not-exchange",
      flow: started.flow
    })).rejects.toMatchObject({ code: "mcp_oauth_configuration_changed" });
    expect(repository.connections.size).toBe(0);
  });

  it("uses a Client ID Metadata Document without dynamic registration when advertised", async () => {
    const clientDocument = "https://aiqsa.fixture.test/.well-known/mcp-oauth-client";
    const repository = new MemoryOAuthRepository({
      ...fixturePolicy(),
      clientIdMetadataDocumentUrl: clientDocument
    });
    const fixture = new StandardsOAuthFixture();
    fixture.metadataDocumentSupported = true;
    const service = new McpOAuthService({
      fetchForPolicy: () => fixture.fetch,
      repository
    });
    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "metadata-state",
      userId: "user-1"
    });

    expect(started.kind).toBe("redirect");
    if (started.kind !== "redirect") return;
    expect(started.flow.clientId).toBe(clientDocument);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(clientDocument);
    expect(fixture.dcrCalls).toBe(0);
  });
});

type DisposableTokenMode = "hang" | "hold" | "ok" | "oversized";

// A real loopback token endpoint: the reviewed HTTPS policy URL is mapped onto
// it below the policy fetch, so the SDK refresh path, abort propagation and
// socket teardown run without external services.
async function startDisposableTokenServer() {
  const held: (() => void)[] = [];
  const requests: { closed: Promise<void>; refreshToken: string | null }[] = [];
  const state: { mode: DisposableTokenMode } = { mode: "ok" };
  let issued = 0;
  const server = createServer((request, response) => {
    response.on("error", () => undefined);
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
      requests.push({ closed, refreshToken: body.get("refresh_token") });
      const respond = () => {
        if (response.destroyed) return;
        issued += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          access_token: `disposable-access-${issued}`,
          expires_in: 3_600,
          refresh_token: `disposable-refresh-${issued}`,
          scope: "mcp.read mcp.write",
          token_type: "Bearer"
        } satisfies OAuthTokens));
      };
      if (state.mode === "hang") return;
      if (state.mode === "hold") {
        held.push(respond);
        return;
      }
      if (state.mode === "oversized") {
        response.writeHead(200, { "content-type": "application/json" });
        const filler = Buffer.alloc(64 * 1_024, 0x20);
        for (let index = 0; index < 10; index += 1) response.write(filler);
        response.end("{}");
        return;
      }
      respond();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    held,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    state
  };
}

function fetchedUrl(input: Parameters<FetchLike>[0]): string {
  return new URL(input instanceof Request ? input.url : input.toString()).toString();
}

function isRefreshRequest(input: Parameters<FetchLike>[0], init?: RequestInit): boolean {
  return fetchedUrl(input) === `${AUTH_ORIGIN}/token` &&
    new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
}

function disposableAuthorizationFetch(
  fixture: StandardsOAuthFixture,
  tokenOrigin: string | null,
  revokedTokens: string[],
  onRevoke?: () => Promise<void>
): FetchLike {
  return async (input, init) => {
    if (tokenOrigin && isRefreshRequest(input, init)) return fetch(`${tokenOrigin}/token`, init);
    if (fetchedUrl(input) === `${AUTH_ORIGIN}/revoke`) {
      revokedTokens.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      await onRevoke?.();
    }
    return fixture.fetch(fetchedUrl(input), init);
  };
}

async function connectedHttpsService(input: Readonly<{
  fetchFn: FetchLike;
  fixture: StandardsOAuthFixture;
  repository?: MemoryOAuthRepository;
  requestTimeoutMs: number;
}>) {
  const repository = input.repository ?? new MemoryOAuthRepository();
  const service = new McpOAuthService({
    fetchForPolicy: () => input.fetchFn,
    now: () => repository.now,
    repository,
    requestTimeoutMs: input.requestTimeoutMs
  });
  const started = await service.startAuthorization({
    forceReconnect: true,
    purpose: "user",
    redirectUri: REDIRECT_URI,
    serverId: "server-1",
    state: "deadline-state",
    userId: "user-1"
  });
  if (started.kind !== "redirect") throw new Error("expected redirect");
  input.fixture.authorizationCodeVerifier = started.flow.codeVerifier;
  const connection = await service.completeAuthorization({
    authorizationCode: "fixture-code",
    flow: started.flow
  });
  repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
  return { connection, repository, service };
}

const USER_DISCONNECT = { purpose: "user", serverId: "server-1", userId: "user-1" } as const;

describe("bounded MCP OAuth refresh and revocation", () => {
  it("fails a stalled HTTPS token endpoint within the deadline and starts the next refresh afresh", async () => {
    const tokenServer = await startDisposableTokenServer();
    try {
      const fixture = new StandardsOAuthFixture();
      const { connection, repository, service } = await connectedHttpsService({
        fetchFn: disposableAuthorizationFetch(fixture, tokenServer.origin, []),
        fixture,
        requestTimeoutMs: 200
      });
      tokenServer.state.mode = "hang";
      const startedAt = Date.now();
      const stalled = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.tokensForConnection(connection.id))
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(stalled).toEqual(Array.from({ length: 4 }, () => ({
        reason: expect.objectContaining({ code: "mcp_oauth_authorization_failed" }),
        status: "rejected"
      })));
      expect(tokenServer.requests).toHaveLength(1);
      // The deadline aborts the socket instead of abandoning it.
      await tokenServer.requests[0]!.closed;
      expect(repository.connections.get(connection.id)).toMatchObject({
        state: "ready",
        tokenVersion: connection.tokenVersion
      });

      tokenServer.state.mode = "ok";
      await expect(service.tokensForConnection(connection.id)).resolves.toMatchObject({
        access_token: "disposable-access-1",
        refresh_token: "disposable-refresh-1"
      });
      expect(tokenServer.requests.map((request) => request.refreshToken))
        .toEqual(["refresh-1", "refresh-1"]);
    } finally {
      await tokenServer.close();
    }
  });

  it("settles the refresh singleflight even when a transport ignores its abort signal", async () => {
    const fixture = new StandardsOAuthFixture();
    let stalls = 0;
    const { connection, service } = await connectedHttpsService({
      fetchFn: async (input, init) => {
        if (isRefreshRequest(input, init) && stalls === 0) {
          stalls += 1;
          return new Promise<Response>(() => undefined);
        }
        return fixture.fetch(fetchedUrl(input), init);
      },
      fixture,
      requestTimeoutMs: 100
    });
    await expect(service.tokensForConnection(connection.id)).rejects.toMatchObject({
      code: "mcp_oauth_authorization_failed"
    } satisfies Partial<McpOAuthError>);
    await expect(service.tokensForConnection(connection.id)).resolves.toMatchObject({
      access_token: "access-refresh-1"
    });
    expect(stalls).toBe(1);
    expect(fixture.refreshCalls).toBe(1);
  });

  it("rejects an oversized HTTPS token response without rotating the stored generation", async () => {
    const tokenServer = await startDisposableTokenServer();
    try {
      const fixture = new StandardsOAuthFixture();
      const { connection, repository, service } = await connectedHttpsService({
        fetchFn: disposableAuthorizationFetch(fixture, tokenServer.origin, []),
        fixture,
        requestTimeoutMs: 5_000
      });
      tokenServer.state.mode = "oversized";
      await expect(service.tokensForConnection(connection.id)).rejects.toMatchObject({
        code: "mcp_oauth_authorization_failed"
      } satisfies Partial<McpOAuthError>);
      expect(repository.connections.get(connection.id)).toMatchObject({
        state: "ready",
        tokenVersion: connection.tokenVersion,
        tokens: { access_token: "access-1", refresh_token: "refresh-1" }
      });
    } finally {
      await tokenServer.close();
    }
  });

  it("stops a local refresh when a drained disconnect revokes the connection", async () => {
    const tokenServer = await startDisposableTokenServer();
    try {
      const fixture = new StandardsOAuthFixture();
      const revoked: string[] = [];
      const { connection, repository, service } = await connectedHttpsService({
        fetchFn: disposableAuthorizationFetch(fixture, tokenServer.origin, revoked),
        fixture,
        requestTimeoutMs: 30_000
      });
      tokenServer.state.mode = "hold";
      const refreshing = service.tokensForConnection(connection.id);
      await vi.waitFor(() => expect(tokenServer.requests).toHaveLength(1));

      await expect(service.disconnect(USER_DISCONNECT)).resolves.toBe("disconnected");
      await expect(refreshing).rejects.toMatchObject({
        code: "mcp_oauth_authorization_failed"
      } satisfies Partial<McpOAuthError>);
      await tokenServer.requests[0]!.closed;
      tokenServer.held.splice(0).forEach((respond) => respond());
      expect(revoked).toEqual(["access-1", "refresh-1"]);
      expect(repository.connections.get(connection.id)?.state).toBe("disconnected");
    } finally {
      await tokenServer.close();
    }
  });

  it("revokes a generation rotated after revocation before clearing the connection", async () => {
    const fixture = new StandardsOAuthFixture();
    const repository = new MemoryOAuthRepository();
    const revoked: string[] = [];
    let connectionId = "";
    let lateRotation = false;
    const { connection, service } = await connectedHttpsService({
      fetchFn: disposableAuthorizationFetch(fixture, null, revoked, async () => {
        if (lateRotation) return;
        lateRotation = true;
        // Another process stores its refresh result while this revocation runs.
        const current = await repository.loadConnection(connectionId);
        await repository.rotateTokens({
          connectionId,
          expectedTokenVersion: current!.tokenVersion,
          tokens: { access_token: "late-access", refresh_token: "late-refresh", token_type: "Bearer" }
        });
      }),
      fixture,
      repository,
      requestTimeoutMs: 5_000
    });
    connectionId = connection.id;

    await expect(service.disconnect(USER_DISCONNECT)).resolves.toBe("disconnected");
    expect(revoked).toEqual(["access-1", "refresh-1", "late-access", "late-refresh"]);
    expect(repository.connections.get(connection.id)?.state).toBe("disconnected");
  });

  it("revokes tokens from a refresh that completes after another process finalized the disconnect", async () => {
    const tokenServer = await startDisposableTokenServer();
    try {
      const fixture = new StandardsOAuthFixture();
      const repository = new MemoryOAuthRepository();
      const revoked: string[] = [];
      const fetchFn = disposableAuthorizationFetch(fixture, tokenServer.origin, revoked);
      const { connection, service: refresher } = await connectedHttpsService({
        fetchFn,
        fixture,
        repository,
        requestTimeoutMs: 30_000
      });
      const disconnector = new McpOAuthService({
        fetchForPolicy: () => fetchFn,
        now: () => repository.now,
        repository
      });
      tokenServer.state.mode = "hold";
      const refreshing = refresher.tokensForConnection(connection.id);
      await vi.waitFor(() => expect(tokenServer.requests).toHaveLength(1));

      await expect(disconnector.disconnect(USER_DISCONNECT)).resolves.toBe("disconnected");
      tokenServer.held.splice(0).forEach((respond) => respond());
      await expect(refreshing).rejects.toMatchObject({
        code: "mcp_oauth_reauthorization_required"
      } satisfies Partial<McpOAuthError>);
      expect(revoked).toEqual([
        "access-1",
        "refresh-1",
        "disposable-access-1",
        "disposable-refresh-1"
      ]);
      expect(repository.connections.get(connection.id)).toMatchObject({
        state: "disconnected",
        tokens: { access_token: "access-1" }
      });
    } finally {
      await tokenServer.close();
    }
  });

  it("keeps a failing revocation's token for 24 h after the request, then wipes it with a content-free event", async () => {
    const fixture = new StandardsOAuthFixture();
    const repository = new MemoryOAuthRepository();
    // Distinct scope ids: failure reporting deduplicates process-wide.
    repository.connectionSequence = 9_100;
    const fetchFn: FetchLike = async (input, init) => fetchedUrl(input) === `${AUTH_ORIGIN}/revoke`
      ? new Response(null, { status: 503 })
      : fixture.fetch(fetchedUrl(input), init);
    const { connection, service } = await connectedHttpsService({
      fetchFn,
      fixture,
      repository,
      requestTimeoutMs: 5_000
    });
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    try {
      const requestedAt = repository.now;
      repository.ineligibleConnectionIds.add(connection.id);
      await service.reconcileDisconnecting();
      expect(repository.connections.get(connection.id)?.state).toBe("disconnecting");

      repository.now = new Date(requestedAt.getTime() + MCP_OAUTH_REVOCATION_ABANDON_MS - 1);
      await service.reconcileDisconnecting();
      expect(repository.connections.get(connection.id)?.state).toBe("disconnecting");

      repository.now = new Date(requestedAt.getTime() + MCP_OAUTH_REVOCATION_ABANDON_MS + 1);
      await service.reconcileDisconnecting();
      expect(repository.connections.get(connection.id)?.state).toBe("disconnected");
      expect(fixture.revokedHints).toEqual([]);
      await service.reconcileDisconnecting();

      const events = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
      const lifecycle = { event: "runtime_lifecycle", outcome: "failed", stage: "cleanup", subsystem: "mcp" };
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ ...lifecycle, action: "retry", code: "mcp_oauth_revocation_failed" }),
        expect.objectContaining({ ...lifecycle, action: "stop", code: "mcp_oauth_revocation_abandoned" })
      ]));
      expect(events.filter((event) => event.code === "mcp_oauth_revocation_abandoned")).toHaveLength(1);
      expect(lines.join("")).not.toContain(connection.id);
      expect(lines.join("")).not.toContain("access-1");
    } finally {
      writer.mockRestore();
    }
  });

  it("records a revocation that fails before any request without its cause and still applies the bound", async () => {
    const fixture = new StandardsOAuthFixture();
    const repository = new MemoryOAuthRepository();
    repository.connectionSequence = 9_200;
    const { connection, service } = await connectedHttpsService({
      fetchFn: disposableAuthorizationFetch(fixture, null, []),
      fixture,
      repository,
      requestTimeoutMs: 5_000
    });
    vi.spyOn(repository, "loadConnection").mockRejectedValue(new Error("PRIVATE stored-envelope failure"));
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    try {
      const requestedAt = repository.now;
      repository.ineligibleConnectionIds.add(connection.id);
      await service.reconcileDisconnecting();
      expect(repository.connections.get(connection.id)?.state).toBe("disconnecting");
      expect(lines.join("")).toContain("mcp_oauth_revocation_failed");
      expect(lines.join("")).not.toContain("PRIVATE");

      repository.now = new Date(requestedAt.getTime() + MCP_OAUTH_REVOCATION_ABANDON_MS + 1);
      await service.reconcileDisconnecting();
      expect(repository.connections.get(connection.id)?.state).toBe("disconnected");
      expect(fixture.revokedHints).toEqual([]);
    } finally {
      writer.mockRestore();
    }
  });
});

describe("personal MCP OAuth transport, origin and client lifecycle", () => {
  async function connect(repository: MemoryOAuthRepository, fixture: StandardsOAuthFixture, service: McpOAuthService) {
    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: repository.policy.redirectUri,
      serverId: "server-1",
      state: "lifecycle-state",
      userId: "user-1"
    });
    if (started.kind !== "redirect") throw new Error("expected redirect");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    return service.completeAuthorization({ authorizationCode: "fixture-code", flow: started.flow });
  }

  it("passes the route's server kind to the policy lookup", async () => {
    const repository = new MemoryOAuthRepository();
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({ fetchForPolicy: () => fixture.fetch, repository });
    await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      sourceKind: "personal",
      state: "kind-state",
      userId: "user-1"
    });
    expect(repository.loadPolicyInputs.at(-1)).toMatchObject({ serverId: "server-1", sourceKind: "personal" });
  });

  it("keeps an https personal server off http OAuth endpoints even inside its stored origin set", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }));
    const personal = new McpOAuthService({
      fetchForPolicy: () => fetch,
      repository: new MemoryOAuthRepository({
        ...fixturePolicy(),
        allowedAuthorizationServerOrigins: [AUTH_ORIGIN, HTTP_AUTH_ORIGIN],
        personal: true
      })
    });
    await expect(personal.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "transport-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses http metadata advertised to an https personal server at OAuth start", async () => {
    const fixture = new StandardsOAuthFixture();
    const requested: string[] = [];
    const service = new McpOAuthService({
      fetchForPolicy: () => async (input, init) => {
        requested.push(input.toString());
        const response = await fixture.fetch(input.toString(), init);
        if (!input.toString().includes("oauth-protected-resource")) return response;
        const body = await response.text();
        return new Response(body.replaceAll(AUTH_ORIGIN, HTTP_AUTH_ORIGIN), { headers: response.headers });
      },
      repository: new MemoryOAuthRepository({ ...fixturePolicy(), personal: true })
    });
    await expect(service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "http-metadata-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
    expect(requested.every((url) => url.startsWith("https:"))).toBe(true);
    expect(fixture.dcrCalls).toBe(0);
  });

  it("lets an acknowledged http personal server use http OAuth on its own hostname through the manual token path", async () => {
    const fixture = new StandardsOAuthFixture();
    fixture.expectedRedirectUri = HTTP_REDIRECT_URI;
    fixture.resource = HTTP_SERVER_URL;
    const requested: string[] = [];
    const repository = new MemoryOAuthRepository(httpPolicy({
      allowedAuthorizationServerOrigins: [OWN_HOST_HTTP_AUTH_ORIGIN],
      personal: true
    }));
    const service = new McpOAuthService({
      fetchForPolicy: () => ownHostHttpFixtureFetch(fixture, requested),
      now: () => repository.now,
      repository
    });
    const connection = await connect(repository, fixture, service);
    expect(connection.state).toBe("ready");
    expect(requested).toContain(`${OWN_HOST_HTTP_AUTH_ORIGIN}/token`);

    repository.now = new Date(connection.expiresAt!.getTime() - 30_000);
    await expect(service.tokensForConnection(connection.id)).resolves.toMatchObject({
      access_token: "access-refresh-1"
    });
  });

  it("refuses http OAuth on another hostname for an http personal server but keeps installation behavior", async () => {
    const fixture = new StandardsOAuthFixture();
    fixture.expectedRedirectUri = HTTP_REDIRECT_URI;
    fixture.resource = HTTP_SERVER_URL;
    const personal = new McpOAuthService({
      fetchForPolicy: () => insecureHttpFixtureFetch(fixture),
      repository: new MemoryOAuthRepository(httpPolicy({ personal: true }))
    });
    await expect(personal.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: HTTP_REDIRECT_URI,
      serverId: "server-1",
      state: "other-host-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
    expect(fixture.dcrCalls).toBe(0);

    const { started } = await startMappedHttpAuthorization(fixture);
    expect(started.kind).toBe("redirect");
  });

  it("cannot widen the stored origins when metadata changes after creation", async () => {
    const repository = new MemoryOAuthRepository({ ...fixturePolicy(), personal: true });
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({ fetchForPolicy: () => fixture.fetch, now: () => repository.now, repository });
    await connect(repository, fixture, service);
    fixture.foreignTokenEndpoint = true;
    await expect(service.startAuthorization({
      forceReconnect: true,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "widen-state",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "mcp_oauth_policy_forbidden" });
    expect(fixture.dcrCalls).toBe(1);
  });

  it.each([
    ["invalid_client", "personal"],
    ["unauthorized_client", "personal"],
    ["invalid_client", "installation"],
    ["unauthorized_client", "installation"]
  ] as const)("turns %s into reauthorization for a %s connection and registers a new client next time", async (code, kind) => {
    const repository = new MemoryOAuthRepository(kind === "personal" ? { ...fixturePolicy(), personal: true } : fixturePolicy());
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({ fetchForPolicy: () => fixture.fetch, now: () => repository.now, repository });
    const connection = await connect(repository, fixture, service);
    expect(fixture.dcrCalls).toBe(1);

    fixture.tokenResponseOverride = () => Response.json({ error: code }, { status: code === "invalid_client" ? 401 : 400 });
    repository.now = new Date(connection.expiresAt!.getTime() - 10_000);
    await expect(service.tokensForConnection(connection.id)).rejects.toMatchObject({
      code: "mcp_oauth_reauthorization_required"
    });
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
    expect(repository.retiredClientIds).toEqual([connection.client.id]);

    fixture.tokenResponseOverride = null;
    const restarted = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state: "re-register-state",
      userId: "user-1"
    });
    expect(restarted.kind).toBe("redirect");
    expect(fixture.dcrCalls).toBe(2);
    if (restarted.kind === "redirect") expect(restarted.flow.oauthClientId).not.toBe(connection.client.id);
  });
});

describe("rejected OAuth client registrations", () => {
  const KINDS = ["personal", "installation"] as const;

  function setup(kind: (typeof KINDS)[number]) {
    const repository = new MemoryOAuthRepository(kind === "personal" ? { ...fixturePolicy(), personal: true } : fixturePolicy());
    const fixture = new StandardsOAuthFixture();
    const service = new McpOAuthService({ fetchForPolicy: () => fixture.fetch, now: () => repository.now, repository });
    const start = (state: string) => service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: "server-1",
      state,
      userId: "user-1"
    });
    const connect = async () => {
      const started = await start("connect-state");
      if (started.kind !== "redirect") throw new Error("expected redirect");
      fixture.authorizationCodeVerifier = started.flow.codeVerifier;
      return service.completeAuthorization({ authorizationCode: "fixture-code", flow: started.flow });
    };
    return { connect, fixture, repository, service, start };
  }

  function rejectTokenRequests(fixture: StandardsOAuthFixture, grantType: string) {
    const rejected: string[] = [];
    fixture.tokenResponseOverride = (body) => {
      rejected.push(body.get("grant_type") ?? "");
      return body.get("grant_type") === grantType
        ? Response.json({ error: "invalid_client" }, { status: 401 })
        : Response.json({ error: "unexpected_grant" }, { status: 400 });
    };
    return rejected;
  }

  it.each(KINDS)("retires a client rejected at the %s callback and registers a new one on the next start", async (kind) => {
    const { fixture, repository, service, start } = setup(kind);
    const started = await start("callback-state");
    if (started.kind !== "redirect") throw new Error("expected redirect");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    rejectTokenRequests(fixture, "authorization_code");
    await expect(service.completeAuthorization({ authorizationCode: "fixture-code", flow: started.flow }))
      .rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(repository.connections.size).toBe(0);
    expect(repository.retiredClientIds).toEqual([started.flow.oauthClientId]);

    fixture.tokenResponseOverride = null;
    const restarted = await start("callback-restart-state");
    expect(restarted.kind).toBe("redirect");
    expect(fixture.dcrCalls).toBe(2);
    if (restarted.kind === "redirect") expect(restarted.flow.oauthClientId).not.toBe(started.flow.oauthClientId);
  });

  it("retires a client rejected on the manual HTTP token path", async () => {
    const fixture = new StandardsOAuthFixture();
    const { repository, service, started } = await startMappedHttpAuthorization(fixture);
    rejectTokenRequests(fixture, "authorization_code");
    await expect(service.completeAuthorization({ authorizationCode: "fixture-code", flow: started.flow }))
      .rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(repository.retiredClientIds).toEqual([started.flow.oauthClientId]);
  });

  it("retires a client rejected on the personal own-host HTTP token path", async () => {
    const fixture = new StandardsOAuthFixture();
    fixture.expectedRedirectUri = HTTP_REDIRECT_URI;
    fixture.resource = HTTP_SERVER_URL;
    const repository = new MemoryOAuthRepository(httpPolicy({
      allowedAuthorizationServerOrigins: [OWN_HOST_HTTP_AUTH_ORIGIN],
      personal: true
    }));
    const service = new McpOAuthService({ fetchForPolicy: () => ownHostHttpFixtureFetch(fixture), repository });
    const started = await service.startAuthorization({
      forceReconnect: false,
      purpose: "user",
      redirectUri: HTTP_REDIRECT_URI,
      serverId: "server-1",
      state: "own-host-callback-state",
      userId: "user-1"
    });
    if (started.kind !== "redirect") throw new Error("expected redirect");
    fixture.authorizationCodeVerifier = started.flow.codeVerifier;
    rejectTokenRequests(fixture, "authorization_code");
    await expect(service.completeAuthorization({ authorizationCode: "fixture-code", flow: started.flow }))
      .rejects.toMatchObject({ code: "mcp_oauth_authorization_failed" });
    expect(repository.retiredClientIds).toEqual([started.flow.oauthClientId]);
  });

  it.each(KINDS)("takes the %s connection out of ready when the MCP server rejects its unexpired bearer and the client is dead", async (kind) => {
    const { connect, fixture, repository, service, start } = setup(kind);
    const connection = await connect();
    // The access token is still valid by its recorded expiry, so the
    // ordinary refresh never runs.
    expect(connection.expiresAt!.getTime()).toBeGreaterThan(repository.now.getTime() + 60_000);
    const rejected = rejectTokenRequests(fixture, "refresh_token");
    const provider = await service.createRuntimeProvider(connection.id);
    // What the SDK transport does after a 401 from the MCP server.
    await expect(auth(provider, { fetchFn: fixture.fetch, serverUrl: SERVER_URL }))
      .rejects.toMatchObject({ code: "mcp_oauth_reauthorization_required" });
    expect(rejected).toEqual(["refresh_token"]);
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
    expect(repository.retiredClientIds).toEqual([connection.client.id]);

    fixture.tokenResponseOverride = null;
    const restarted = await start("runtime-restart-state");
    expect(restarted.kind).toBe("redirect");
    expect(fixture.dcrCalls).toBe(2);
  });

  it("keeps a connection ready with rotated tokens when the forced refresh after a rejected bearer succeeds", async () => {
    const { connect, fixture, repository, service } = setup("installation");
    const connection = await connect();
    const provider = await service.createRuntimeProvider(connection.id);
    await expect(auth(provider, { fetchFn: fixture.fetch, serverUrl: SERVER_URL }))
      .rejects.toMatchObject({ code: "mcp_oauth_reauthorization_required" });
    expect(repository.connections.get(connection.id)).toMatchObject({
      state: "ready",
      tokens: { access_token: "access-refresh-1" }
    });
    expect(repository.retiredClientIds).toEqual([]);
  });

  it("requires reauthorization when a rejected bearer has no refresh token", async () => {
    const { connect, fixture, repository, service } = setup("personal");
    fixture.tokenResponseOverride = () => Response.json({
      access_token: "access-only", expires_in: 3_600, scope: "mcp.read mcp.write", token_type: "Bearer"
    } satisfies OAuthTokens);
    const connection = await connect();
    const provider = await service.createRuntimeProvider(connection.id);
    await expect(auth(provider, { fetchFn: fixture.fetch, serverUrl: SERVER_URL }))
      .rejects.toMatchObject({ code: "mcp_oauth_reauthorization_required" });
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
    expect(fixture.refreshCalls).toBe(0);
  });

  it.each(KINDS)("registers a new client when the stored client secret has expired (%s server)", async (kind) => {
    const { connect, fixture, repository, start } = setup(kind);
    const connection = await connect();
    const [registrationKey, stored] = [...repository.clients.entries()][0]!;
    repository.clients.set(registrationKey, {
      ...stored,
      clientInformation: {
        ...stored.clientInformation,
        client_secret_expires_at: Math.floor(repository.now.getTime() / 1_000) - 60
      }
    });
    const restarted = await start("expired-secret-state");
    expect(restarted.kind).toBe("redirect");
    expect(fixture.dcrCalls).toBe(2);
    expect(repository.retiredClientIds).toEqual([stored.id]);
    expect(repository.connections.get(connection.id)?.state).toBe("reauthorization_required");
  });

  it("keeps reusing a client whose secret never expires", async () => {
    const { connect, fixture, repository, start } = setup("installation");
    await connect();
    const [registrationKey, stored] = [...repository.clients.entries()][0]!;
    repository.clients.set(registrationKey, {
      ...stored,
      clientInformation: { ...stored.clientInformation, client_secret_expires_at: 0 }
    });
    await expect(start("non-expiring-state")).resolves.toMatchObject({ kind: "already_connected" });
    expect(fixture.dcrCalls).toBe(1);
  });
});
