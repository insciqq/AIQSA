import { createHash } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";
import type { McpOAuthPolicy, McpOAuthPurpose } from "./oauthPolicy";
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

class MemoryOAuthRepository implements McpOAuthRepository {
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

  constructor(policy: McpOAuthPolicy = fixturePolicy()) {
    this.policy = policy;
  }

  async createConnection(input: Parameters<McpOAuthRepository["createConnection"]>[0]):
    Promise<McpOAuthRepositoryResult<McpOAuthStoredConnection>> {
    if (input.configurationIdentity !== this.policy.configurationIdentity) {
      return { kind: "configuration_changed" };
    }
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
      policy: this.policy,
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
      input.serverId === this.policy.serverId && input.userId === this.policy.userId
      ? this.policy
      : null;
  }

  async loadPolicy(input: { purpose: McpOAuthPurpose; redirectUri: string; serverId: string; userId: string }):
    Promise<McpOAuthPolicy | null> {
    return this.policyAvailable && input.purpose === this.policy.purpose && input.redirectUri === this.policy.redirectUri &&
      input.serverId === this.policy.serverId && input.userId === this.policy.userId
      ? this.policy
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

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.origin === "https://mcp.fixture.test" &&
      url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        authorization_servers: [AUTH_ORIGIN],
        resource: SERVER_URL,
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
      expect(body.get("resource")).toBe(SERVER_URL);
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

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("generic MCP OAuth service", () => {
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
