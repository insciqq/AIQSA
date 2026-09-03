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
  it("publishes one canonical resource and a scope-free public-client server", () => {
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
    expect(inboundMcpAuthorizationServerMetadata(configuration)).not.toHaveProperty(
      "scopes_supported"
    );
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
