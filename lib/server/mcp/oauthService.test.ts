import { createHash } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";
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
import { McpOAuthError, McpOAuthService } from "./oauthService";

const SERVER_URL = "https://mcp.fixture.test/mcp";
const AUTH_ORIGIN = "https://auth.fixture.test";
const REDIRECT_URI = "https://aiqsa.fixture.test/api/me/mcp/server-1/oauth/callback";
const BROKER_SERVER_URL = "https://broker.fixture.test/mcp";
const BROKER_AUTH_ORIGIN = "https://broker-auth.fixture.test";

function fixturePolicy(): McpOAuthPolicy {
  return {
    allowPrivateNetwork: false,
    allowedAuthorizationServerOrigins: [AUTH_ORIGIN],
    configurationIdentity: "revision-1",
    purpose: "user",
    redirectUri: REDIRECT_URI,
    requestedScopes: ["mcp.read", "mcp.write"],
    resource: SERVER_URL,
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
  readonly ineligibleConnectionIds = new Set<string>();
  readonly policy: McpOAuthPolicy;
  activeBindings = false;
  connectionSequence = 0;
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
      policy: resolvedPolicy,
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

  async finalizeDisconnected(connectionId: string): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state !== "disconnecting" || this.activeBindings) return false;
    this.connections.set(connectionId, { ...connection, state: "disconnected" });
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
    return this.connections.get(connectionId) ?? null;
  }

  async prepareValidationPolicy(input: { redirectUri: string; serverId: string; userId: string }):
    Promise<McpOAuthPolicy | null> {
    this.validationPrepareCalls += 1;
    return this.policy.purpose === "validation" && input.redirectUri === this.policy.redirectUri &&
      input.serverId === this.policy.serverId
      ? this.policyForUser(input.userId)
      : null;
  }

  async loadPolicy(input: { purpose: McpOAuthPurpose; redirectUri: string; serverId: string; userId: string }):
    Promise<McpOAuthPolicy | null> {
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
      updated += 1;
    }
    return updated;
  }

  async rotateTokens(input: Parameters<McpOAuthRepository["rotateTokens"]>[0]):
    Promise<McpOAuthStoredConnection | null> {
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.tokenVersion !== input.expectedTokenVersion) {
      return connection ?? null;
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
    const client: McpOAuthStoredClient = {
      clientInformation: input.clientInformation,
      clientMetadata: input.clientMetadata,
      discoveryState: input.discoveryState,
      id: `client-${this.clients.size + 1}`,
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
  dcrCalls = 0;
  expectedRedirectUri = REDIRECT_URI;
  foreignTokenEndpoint = false;
  invalidRefresh = false;
  metadataDocumentSupported = false;
  refreshCalls = 0;
  revokedHints: string[] = [];
  resource = SERVER_URL;

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
      return Response.json({
        authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
        client_id_metadata_document_supported: this.metadataDocumentSupported,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: AUTH_ORIGIN,
        registration_endpoint: `${AUTH_ORIGIN}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${AUTH_ORIGIN}/revoke`,
        revocation_endpoint_auth_methods_supported: ["client_secret_basic"],
        token_endpoint: this.foreignTokenEndpoint
          ? "https://unreviewed.example.test/token"
          : `${AUTH_ORIGIN}/token`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"]
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
        token_endpoint_auth_method: "client_secret_basic"
      }, { status: 201 });
    }
    if (url.toString() === `${AUTH_ORIGIN}/token`) {
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("resource")).toBe(this.resource);
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
        refresh_token: `refresh-${this.refreshCalls + 1}`,
        scope: "mcp.read mcp.write",
        token_type: "Bearer"
      } satisfies OAuthTokens);
    }
    if (url.toString() === `${AUTH_ORIGIN}/revoke`) {
      const body = new URLSearchParams(String(init?.body));
      this.revokedHints.push(body.get("token_type_hint") ?? "");
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: "fixture_not_found" }, { status: 404 });
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
      flow: started.flow
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
