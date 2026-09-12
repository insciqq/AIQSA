import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../../auth/token";
import type { InboundMcpAuthorizationRequest } from "./contracts";
import {
  createInboundMcpOAuthService,
  inboundMcpAuthorizationServerMetadata,
  inboundMcpOAuthConfiguration,
  inboundMcpProtectedResourceMetadata,
  InboundMcpOAuthError
} from "./service";

const NOW = new Date("2026-09-03T01:00:00.000Z");
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

function authorizationRequest(
  overrides: Partial<InboundMcpAuthorizationRequest> = {}
): InboundMcpAuthorizationRequest {
  return {
    clientId: "https://client.example/oauth/client.json",
    codeChallenge: CHALLENGE,
    redirectUri: "http://127.0.0.1:43119/oauth/callback",
    resource: "https://aiqsa.example/mcp",
    state: "client-state",
    ...overrides
  };
}

function dependencies() {
  const client = {
    applicationType: "NATIVE" as const,
    clientId: "https://client.example/oauth/client.json",
    clientName: "Example client",
    clientOrigin: "https://client.example",
    clientUri: "https://client.example",
    id: "client-record-1",
    kind: "CLIENT_ID_METADATA_DOCUMENT" as const,
    metadataExpiresAt: new Date("2026-09-03T01:05:00.000Z"),
    metadataFingerprint: "a".repeat(64),
    redirectUris: ["http://127.0.0.1:43119/oauth/callback"]
  };
  const repository = {
    approveAuthorization: vi.fn(async () => true),
    createDynamicClient: vi.fn(async (input) => ({
      ...input,
      id: "dynamic-client-record"
    })),
    exchangeAuthorizationCode: vi.fn(async () => true),
    findClient: vi.fn(async () => client),
    listConnectedApps: vi.fn(async () => []),
    resolveAccessToken: vi.fn(async () => ({
      clientId: client.clientId,
      expiresAt: new Date("2026-09-03T02:00:00.000Z"),
      grantId: "grant-1",
      userId: "user-1"
    })),
    revokeGrant: vi.fn(async () => true),
    revokeTokenFamily: vi.fn(async () => undefined),
    rotateRefreshToken: vi.fn(async () => "rotated" as const),
    upsertMetadataClient: vi.fn(async () => client)
  };
  const clientMetadataResolver = {
    resolve: vi.fn(async () => ({
      ...client,
      metadataExpiresAt: new Date("2026-09-03T01:05:00.000Z")
    }))
  };
  const configuration = inboundMcpOAuthConfiguration(
    "https://aiqsa.example",
    "production"
  );
  const service = createInboundMcpOAuthService({
    clientMetadataResolver,
    clock: () => NOW,
    configuration,
    consentSigningSecret: () => "test-consent-secret",
    repository: repository as never
  });
  return { client, clientMetadataResolver, configuration, repository, service };
}

describe("inbound Memory MCP OAuth service", () => {
  it.each([undefined, "mcp:hub"] as const)("binds Hub consent and issuance when wire scope is %s", async (scope) => {
    const { repository, service } = dependencies();
    const request = authorizationRequest({ resource: "https://aiqsa.example/mcp/hub", scope });
    const authorization = { request, sessionId: "session-1", userId: "user-1" };
    const view = await service.prepareAuthorization(authorization);
    const code = await service.approveAuthorization({ ...authorization, consentToken: view.consentToken });
    expect(repository.approveAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      resource: request.resource, resourcePath: "/mcp/hub", capability: "mcp:hub"
    }));
    const pair = await service.token({
      clientId: request.clientId, code, codeVerifier: VERIFIER,
      grantType: "authorization_code", redirectUri: request.redirectUri,
      resource: request.resource, scope
    });
    expect(pair.scope).toBe("mcp:hub");
    expect(repository.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      resource: request.resource, capability: "mcp:hub"
    }));
    await service.token({ clientId: request.clientId, grantType: "refresh_token",
      refreshToken: pair.refresh_token, resource: request.resource, scope });
    expect(repository.rotateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
      resource: request.resource, capability: "mcp:hub"
    }));
    await expect(service.approveAuthorization({ ...authorization, consentToken: view.consentToken,
      request: { ...request, resource: "https://aiqsa.example/mcp", scope: undefined }
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_request"));
    await service.resolveAccessToken(pair.access_token, request.resource);
    expect(repository.resolveAccessToken).toHaveBeenLastCalledWith(expect.objectContaining({
      resource: request.resource, capability: "mcp:hub"
    }));
    await service.resolveAccessToken(pair.access_token);
    expect(repository.resolveAccessToken).toHaveBeenLastCalledWith(expect.objectContaining({
      resource: "https://aiqsa.example/mcp", capability: "memory:facts"
    }));
  });

  it("rejects Hub scope on Memory and noncanonical resource URLs before persistence", async () => {
    const { repository, service } = dependencies();
    await expect(service.prepareAuthorization({
      request: authorizationRequest({ scope: "mcp:hub" }), sessionId: "s", userId: "u"
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_scope"));
    for (const resource of ["https://aiqsa.example/mcp/hub/", "https://aiqsa.example/mcp/hub?x=1", "https://other.example/mcp/hub"]) {
      await expect(service.prepareAuthorization({
        request: authorizationRequest({ resource }), sessionId: "s", userId: "u"
      })).rejects.toEqual(new InboundMcpOAuthError("invalid_target"));
    }
    expect(repository.findClient).not.toHaveBeenCalled();
  });

  it("publishes separate resource audiences on one public-client server", () => {
    const { configuration } = dependencies();
    expect(inboundMcpProtectedResourceMetadata(configuration)).toEqual({
      authorization_servers: ["https://aiqsa.example"],
      bearer_methods_supported: ["header"],
      resource: "https://aiqsa.example/mcp",
      resource_name: "AIQSA Personal Memory"
    });
    expect(inboundMcpAuthorizationServerMetadata(configuration)).toMatchObject({
      authorization_endpoint: "https://aiqsa.example/oauth/authorize",
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      issuer: "https://aiqsa.example",
      registration_endpoint: "https://aiqsa.example/oauth/register",
      resource_indicators_supported: true,
      token_endpoint_auth_methods_supported: ["none"]
    });
    expect(inboundMcpAuthorizationServerMetadata(configuration)).toHaveProperty(
      "scopes_supported", ["mcp:hub"]
    );
    expect(inboundMcpProtectedResourceMetadata(configuration, "/mcp/hub")).toMatchObject({
      resource: "https://aiqsa.example/mcp/hub", scopes_supported: ["mcp:hub"]
    });
  });

  it("publishes HTTP issuer and resource metadata in production", () => {
    const configuration = inboundMcpOAuthConfiguration(
      "http://192.168.1.10:3000",
      "production"
    );
    expect(configuration).toMatchObject({
      allowLoopbackDevelopment: false,
      authorizationEndpoint: "http://192.168.1.10:3000/oauth/authorize",
      issuer: "http://192.168.1.10:3000",
      registrationEndpoint: "http://192.168.1.10:3000/oauth/register",
      resource: "http://192.168.1.10:3000/mcp",
      tokenEndpoint: "http://192.168.1.10:3000/oauth/token"
    });
    expect(inboundMcpProtectedResourceMetadata(configuration, "/mcp/hub")).toMatchObject({
      authorization_servers: ["http://192.168.1.10:3000"],
      resource: "http://192.168.1.10:3000/mcp/hub"
    });
    expect(inboundMcpAuthorizationServerMetadata(configuration)).toMatchObject({
      authorization_endpoint: "http://192.168.1.10:3000/oauth/authorize",
      issuer: "http://192.168.1.10:3000",
      token_endpoint: "http://192.168.1.10:3000/oauth/token"
    });
  });

  it("binds browser consent and a one-time code to owner, session, client, and PKCE", async () => {
    const { repository, service } = dependencies();
    const request = authorizationRequest();
    const view = await service.prepareAuthorization({
      request,
      sessionId: "session-1",
      userId: "user-1"
    });
    expect(view).toMatchObject({
      clientName: "Example client",
      clientOrigin: "https://client.example"
    });
    expect(view.consentToken).not.toContain("user-1");

    const code = await service.approveAuthorization({
      consentToken: view.consentToken,
      request,
      sessionId: "session-1",
      userId: "user-1"
    });
    expect(code).toMatch(/^aiqsa_mc_[A-Za-z0-9_-]{43}$/u);
    expect(repository.approveAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      clientRecordId: "client-record-1",
      codeChallenge: CHALLENGE,
      codeHash: hashToken(code),
      issuer: "https://aiqsa.example",
      resource: "https://aiqsa.example/mcp",
      userId: "user-1"
    }));
    expect(JSON.stringify(repository.approveAuthorization.mock.calls)).not.toContain(code);

    await expect(service.approveAuthorization({
      consentToken: `${view.consentToken.slice(0, -1)}A`,
      request,
      sessionId: "session-1",
      userId: "user-1"
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_request"));
    expect(repository.approveAuthorization).toHaveBeenCalledTimes(1);
  });

  it("rejects consent when the displayed client metadata identity changes", async () => {
    const { client, clientMetadataResolver, repository, service } = dependencies();
    const request = authorizationRequest();
    const view = await service.prepareAuthorization({
      request,
      sessionId: "session-1",
      userId: "user-1"
    });
    const changedClient = {
      ...client,
      clientName: "Changed client",
      metadataExpiresAt: new Date("2026-09-03T01:05:00.000Z"),
      metadataFingerprint: "b".repeat(64)
    };
    repository.findClient.mockResolvedValueOnce({
      ...client,
      metadataExpiresAt: NOW
    });
    clientMetadataResolver.resolve.mockResolvedValueOnce(changedClient);
    repository.upsertMetadataClient.mockResolvedValueOnce(changedClient);

    await expect(service.approveAuthorization({
      consentToken: view.consentToken,
      request,
      sessionId: "session-1",
      userId: "user-1"
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_request"));
    expect(repository.approveAuthorization).not.toHaveBeenCalled();
  });

  it("accepts an ephemeral port only for the registered native loopback callback", async () => {
    const { service } = dependencies();
    await expect(service.prepareAuthorization({
      request: authorizationRequest({
        redirectUri: "http://127.0.0.1:54321/oauth/callback"
      }),
      sessionId: "session-1",
      userId: "user-1"
    })).resolves.toMatchObject({ clientName: "Example client" });
    await expect(service.prepareAuthorization({
      request: authorizationRequest({
        redirectUri: "http://127.0.0.1:54321/other"
      }),
      sessionId: "session-1",
      userId: "user-1"
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_request"));
  });

  it("exchanges PKCE codes, rotates refresh tokens, and stores only hashes", async () => {
    const { repository, service } = dependencies();
    const first = await service.token({
      clientId: "https://client.example/oauth/client.json",
      code: `aiqsa_mc_${"A".repeat(43)}`,
      codeVerifier: VERIFIER,
      grantType: "authorization_code",
      redirectUri: "http://127.0.0.1:43119/oauth/callback",
      resource: "https://aiqsa.example/mcp"
    });
    expect(first).toMatchObject({ expires_in: 3600, token_type: "Bearer" });
    expect(repository.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      accessTokenHash: hashToken(first.access_token),
      codeChallenge: CHALLENGE,
      codeHash: hashToken(`aiqsa_mc_${"A".repeat(43)}`),
      refreshTokenHash: hashToken(first.refresh_token)
    }));

    const second = await service.token({
      clientId: "https://client.example/oauth/client.json",
      grantType: "refresh_token",
      refreshToken: first.refresh_token,
      resource: "https://aiqsa.example/mcp"
    });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(repository.rotateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
      nextRefreshTokenHash: hashToken(second.refresh_token),
      presentedRefreshTokenHash: hashToken(first.refresh_token)
    }));
    expect(JSON.stringify(repository.rotateRefreshToken.mock.calls)).not.toContain(
      first.refresh_token
    );
  });

  it("rejects another resource before repository token work", async () => {
    const { repository, service } = dependencies();
    await expect(service.token({
      clientId: "https://client.example/oauth/client.json",
      grantType: "refresh_token",
      refreshToken: `aiqsa_mr_${"A".repeat(43)}`,
      resource: "https://other.example/mcp"
    })).rejects.toEqual(new InboundMcpOAuthError("invalid_target"));
    expect(repository.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("registers only a public DCR client and never returns a client secret", async () => {
    const { repository, service } = dependencies();
    const response = await service.registerClient({
      application_type: "native",
      client_name: "Codex CLI",
      redirect_uris: ["http://127.0.0.1:43119/callback"],
      token_endpoint_auth_method: "none"
    });
    expect(response).toMatchObject({
      application_type: "native",
      client_id: expect.stringMatching(/^aiqsa_dcr_/u),
      client_name: "Codex CLI",
      token_endpoint_auth_method: "none"
    });
    expect(response).not.toHaveProperty("client_secret");
    expect(repository.createDynamicClient).toHaveBeenCalledOnce();
  });

  it("registers a web client with exact LAN HTTP callback and client URI", async () => {
    const { repository, service } = dependencies();
    const response = await service.registerClient({
      application_type: "web",
      client_name: "LAN web client",
      client_uri: "http://192.168.1.20/client",
      redirect_uris: ["http://192.168.1.20/oauth/callback"],
      token_endpoint_auth_method: "none"
    });
    expect(response).toMatchObject({
      application_type: "web",
      client_uri: "http://192.168.1.20/client",
      redirect_uris: ["http://192.168.1.20/oauth/callback"]
    });
    expect(repository.createDynamicClient).toHaveBeenCalledWith(expect.objectContaining({
      applicationType: "WEB",
      clientOrigin: "http://192.168.1.20",
      clientUri: "http://192.168.1.20/client",
      redirectUris: ["http://192.168.1.20/oauth/callback"]
    }));
  });

  it("resolves and revokes opaque credentials through hashes", async () => {
    const { repository, service } = dependencies();
    const accessToken = `aiqsa_ma_${"A".repeat(43)}`;
    await expect(service.resolveAccessToken(accessToken)).resolves.toEqual({
      clientId: "https://client.example/oauth/client.json",
      expiresAt: new Date("2026-09-03T02:00:00.000Z"),
      grantId: "grant-1",
      userId: "user-1"
    });
    expect(repository.resolveAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      tokenHash: hashToken(accessToken)
    }));
    await service.revokeToken("https://client.example/oauth/client.json", accessToken);
    expect(repository.revokeTokenFamily).toHaveBeenCalledWith(expect.objectContaining({
      tokenHash: hashToken(accessToken)
    }));
  });
});
