import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLoopbackHostname } from "../../auth/clientIdentity";
import { hashToken } from "../../auth/token";
import {
  decodeDynamicClientRegistration,
  registeredRedirectUriMatches,
  validClientIdentifierUrl,
  type InboundMcpAuthorizationRequest,
  type InboundMcpClientMetadata,
  type InboundMcpTokenRequest
} from "./contracts";
import {
  inboundMcpClientMetadataFingerprint,
  type InboundMcpClientMetadataResolver
} from "./clientMetadata";
import type {
  InboundMcpConnectedApp,
  InboundMcpOAuthClientRecord,
  InboundMcpOAuthRepository
} from "./repository";

export const INBOUND_MCP_AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1_000;
export const INBOUND_MCP_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;
export const INBOUND_MCP_REFRESH_TOKEN_INACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const INBOUND_MCP_CONSENT_TOKEN_TTL_MS = 10 * 60 * 1_000;

const CONSENT_MAC_DOMAIN = "aiqsa:inbound-memory-mcp-consent:v1\0";

export type InboundMcpOAuthErrorCode =
  | "access_denied"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_target"
  | "server_error";

export class InboundMcpOAuthError extends Error {
  constructor(readonly code: InboundMcpOAuthErrorCode) {
    super(code);
    this.name = "InboundMcpOAuthError";
  }
}

export type InboundMcpOAuthConfiguration = Readonly<{
  allowLoopbackDevelopment: boolean;
  authorizationEndpoint: string;
  issuer: string;
  protectedResourceMetadataUrl: string;
  registrationEndpoint: string;
  resource: string;
  revocationEndpoint: string;
  tokenEndpoint: string;
}>;

export type InboundMcpOAuthTokenResponse = Readonly<{
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: "Bearer";
}>;

export type InboundMcpAuthorizationView = Readonly<{
  clientName: string;
  clientOrigin: string;
  consentToken: string;
}>;

export type InboundMcpDynamicRegistrationResponse = Readonly<{
  application_type: "native" | "web";
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  client_uri?: string;
  grant_types: readonly ["authorization_code", "refresh_token"];
  redirect_uris: readonly string[];
  response_types: readonly ["code"];
  token_endpoint_auth_method: "none";
}>;

export type InboundMcpOAuthService = Readonly<{
  approveAuthorization(input: Readonly<{
    consentToken: string;
    request: InboundMcpAuthorizationRequest;
    sessionId: string;
    signal?: AbortSignal;
    userId: string;
  }>): Promise<string>;
  configuration: InboundMcpOAuthConfiguration;
  denyAuthorization(input: Readonly<{
    consentToken: string;
    request: InboundMcpAuthorizationRequest;
    sessionId: string;
    signal?: AbortSignal;
    userId: string;
  }>): Promise<void>;
  listConnectedApps(userId: string): Promise<readonly InboundMcpConnectedApp[]>;
  prepareAuthorization(input: Readonly<{
    request: InboundMcpAuthorizationRequest;
    sessionId: string;
    signal?: AbortSignal;
    userId: string;
  }>): Promise<InboundMcpAuthorizationView>;
  registerClient(value: unknown): Promise<InboundMcpDynamicRegistrationResponse>;
  resolveAccessToken(token: string): Promise<Readonly<{
    clientId: string;
    expiresAt: Date;
    grantId: string;
    userId: string;
  }> | null>;
  revokeConnectedApp(userId: string, grantId: string): Promise<boolean>;
  revokeToken(clientId: string, token: string): Promise<void>;
  token(request: InboundMcpTokenRequest): Promise<InboundMcpOAuthTokenResponse>;
}>;

function failure(code: InboundMcpOAuthErrorCode): never {
  throw new InboundMcpOAuthError(code);
}

export function inboundMcpOAuthConfiguration(
  appBaseUrl: string,
  nodeEnv = process.env.NODE_ENV
): InboundMcpOAuthConfiguration {
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    return failure("server_error");
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.username || url.password || url.hash ||
    url.protocol !== "https:" && !(url.protocol === "http:" && loopback && nodeEnv !== "production")) {
    return failure("server_error");
  }
  const issuer = url.origin;
  return Object.freeze({
    allowLoopbackDevelopment: url.protocol === "http:" && loopback && nodeEnv !== "production",
    authorizationEndpoint: new URL("/oauth/authorize", issuer).toString(),
    issuer,
    protectedResourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource/mcp",
      issuer
    ).toString(),
    registrationEndpoint: new URL("/oauth/register", issuer).toString(),
    resource: new URL("/mcp", issuer).toString(),
    revocationEndpoint: new URL("/oauth/revoke", issuer).toString(),
    tokenEndpoint: new URL("/oauth/token", issuer).toString()
  });
}

export function inboundMcpProtectedResourceMetadata(
  configuration: InboundMcpOAuthConfiguration
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    authorization_servers: [configuration.issuer],
    bearer_methods_supported: ["header"],
    resource: configuration.resource,
    resource_name: "AIQSA Personal Memory"
  });
}

export function inboundMcpAuthorizationServerMetadata(
  configuration: InboundMcpOAuthConfiguration
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    authorization_endpoint: configuration.authorizationEndpoint,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: configuration.issuer,
    registration_endpoint: configuration.registrationEndpoint,
    resource_indicators_supported: true,
    response_types_supported: ["code"],
    revocation_endpoint: configuration.revocationEndpoint,
    revocation_endpoint_auth_methods_supported: ["none"],
    token_endpoint: configuration.tokenEndpoint,
    token_endpoint_auth_methods_supported: ["none"]
  });
}

function consentPayload(input: Readonly<{
  expiresAtMs: number;
  metadataFingerprint: string;
  request: InboundMcpAuthorizationRequest;
  sessionId: string;
  userId: string;
}>): string {
  return JSON.stringify([
    input.expiresAtMs,
    input.sessionId,
    input.userId,
    input.request.clientId,
    input.request.codeChallenge,
    input.request.redirectUri,
    input.request.resource,
    input.request.state,
    input.metadataFingerprint
  ]);
}

function createConsentToken(input: Readonly<{
  expiresAtMs: number;
  metadataFingerprint: string;
  request: InboundMcpAuthorizationRequest;
  secret: string;
  sessionId: string;
  userId: string;
}>): string {
  const mac = createHmac("sha256", input.secret)
    .update(CONSENT_MAC_DOMAIN, "utf8")
    .update(consentPayload(input), "utf8")
    .digest("base64url");
  return `${input.expiresAtMs.toString(36)}.${input.metadataFingerprint}.${mac}`;
}

function validConsentToken(input: Readonly<{
  metadataFingerprint: string;
  nowMs: number;
  request: InboundMcpAuthorizationRequest;
  secret: string;
  sessionId: string;
  token: string;
  userId: string;
}>): boolean {
  if (!input.secret || !/^[0-9a-z]{8,16}\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/u
    .test(input.token)) return false;
  const separator = input.token.indexOf(".");
  const expiresAtMs = Number.parseInt(input.token.slice(0, separator), 36);
  const fingerprint = input.token.slice(separator + 1, input.token.lastIndexOf("."));
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= input.nowMs ||
    fingerprint !== input.metadataFingerprint) return false;
  const expected = createConsentToken({ ...input, expiresAtMs });
  const actualBytes = Buffer.from(input.token, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function rawCredential(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function expiresAt(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validRawCredential(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function clientMetadataWrite(
  metadata: InboundMcpClientMetadata,
  input: Readonly<{
    kind: "CLIENT_ID_METADATA_DOCUMENT" | "DYNAMIC_REGISTRATION";
    metadataExpiresAt: Date | null;
    metadataFingerprint: string;
    now: Date;
  }>
) {
  return {
    ...metadata,
    kind: input.kind,
    metadataExpiresAt: input.metadataExpiresAt,
    metadataFingerprint: input.metadataFingerprint,
    now: input.now
  } as const;
}

export function createInboundMcpOAuthService(input: Readonly<{
  clientMetadataResolver: InboundMcpClientMetadataResolver;
  clock?: () => Date;
  configuration: InboundMcpOAuthConfiguration;
  consentSigningSecret: () => string;
  repository: InboundMcpOAuthRepository;
}>): InboundMcpOAuthService {
  const clock = input.clock ?? (() => new Date());

  function assertResource(resource: string): void {
    if (resource !== input.configuration.resource) failure("invalid_target");
  }

  async function resolveClient(
    clientId: string,
    signal?: AbortSignal
  ): Promise<InboundMcpOAuthClientRecord> {
    const now = clock();
    const existing = await input.repository.findClient(clientId);
    if (existing && (
      existing.kind === "DYNAMIC_REGISTRATION" ||
      existing.metadataExpiresAt && existing.metadataExpiresAt > now
    )) return existing;
    if (!validClientIdentifierUrl(
      clientId,
      input.configuration.allowLoopbackDevelopment
    )) return failure("invalid_client");
    try {
      const metadata = await input.clientMetadataResolver.resolve(clientId, signal);
      return input.repository.upsertMetadataClient(clientMetadataWrite(metadata, {
        kind: "CLIENT_ID_METADATA_DOCUMENT",
        metadataExpiresAt: metadata.metadataExpiresAt,
        metadataFingerprint: metadata.metadataFingerprint,
        now
      }));
    } catch (error) {
      if (signal?.aborted) throw error;
      return failure("invalid_client");
    }
  }

  async function checkedAuthorizationClient(
    request: InboundMcpAuthorizationRequest,
    signal?: AbortSignal
  ): Promise<InboundMcpOAuthClientRecord> {
    assertResource(request.resource);
    const client = await resolveClient(request.clientId, signal);
    if (!client.redirectUris.some((registered) => registeredRedirectUriMatches({
      applicationType: client.applicationType,
      presented: request.redirectUri,
      registered
    }))) failure("invalid_request");
    return client;
  }

  function issueTokenPair(now: Date): Readonly<{
    accessExpiresAt: Date;
    accessToken: string;
    refreshExpiresAt: Date;
    refreshToken: string;
  }> {
    return {
      accessExpiresAt: expiresAt(now, INBOUND_MCP_ACCESS_TOKEN_TTL_MS),
      accessToken: rawCredential("aiqsa_ma_"),
      refreshExpiresAt: expiresAt(now, INBOUND_MCP_REFRESH_TOKEN_INACTIVITY_TTL_MS),
      refreshToken: rawCredential("aiqsa_mr_")
    };
  }

  function tokenResponse(tokens: Readonly<{
    accessToken: string;
    refreshToken: string;
  }>): InboundMcpOAuthTokenResponse {
    return {
      access_token: tokens.accessToken,
      expires_in: INBOUND_MCP_ACCESS_TOKEN_TTL_MS / 1_000,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer"
    };
  }

  async function validateConsent(requestInput: Readonly<{
    consentToken: string;
    request: InboundMcpAuthorizationRequest;
    sessionId: string;
    signal?: AbortSignal;
    userId: string;
  }>): Promise<InboundMcpOAuthClientRecord> {
    const client = await checkedAuthorizationClient(
      requestInput.request,
      requestInput.signal
    );
    const secret = input.consentSigningSecret();
    if (!secret || !validConsentToken({
      metadataFingerprint: client.metadataFingerprint,
      nowMs: clock().getTime(),
      request: requestInput.request,
      secret,
      sessionId: requestInput.sessionId,
      token: requestInput.consentToken,
      userId: requestInput.userId
    })) return failure("invalid_request");
    return client;
  }

  return Object.freeze({
    async approveAuthorization(requestInput) {
      const now = clock();
      const client = await validateConsent(requestInput);
      const code = rawCredential("aiqsa_mc_");
      const approved = await input.repository.approveAuthorization({
        clientRecordId: client.id,
        codeChallenge: requestInput.request.codeChallenge,
        codeHash: hashToken(code),
        expiresAt: expiresAt(now, INBOUND_MCP_AUTHORIZATION_CODE_TTL_MS),
        issuer: input.configuration.issuer,
        now,
        redirectUri: requestInput.request.redirectUri,
        resource: input.configuration.resource,
        userId: requestInput.userId
      });
      return approved ? code : failure("access_denied");
    },

    configuration: input.configuration,

    async denyAuthorization(requestInput) {
      await validateConsent(requestInput);
    },

    listConnectedApps(userId) {
      return input.repository.listConnectedApps(userId);
    },

    async prepareAuthorization(requestInput) {
      const client = await checkedAuthorizationClient(
        requestInput.request,
        requestInput.signal
      );
      const now = clock();
      const secret = input.consentSigningSecret();
      if (!secret) return failure("server_error");
      return {
        clientName: client.clientName,
        clientOrigin: client.clientOrigin,
        consentToken: createConsentToken({
          expiresAtMs: now.getTime() + INBOUND_MCP_CONSENT_TOKEN_TTL_MS,
          metadataFingerprint: client.metadataFingerprint,
          request: requestInput.request,
          secret,
          sessionId: requestInput.sessionId,
          userId: requestInput.userId
        })
      };
    },

    async registerClient(value) {
      const now = clock();
      const clientId = `aiqsa_dcr_${randomBytes(24).toString("base64url")}`;
      const metadata = decodeDynamicClientRegistration({
        allowLoopbackHttp: input.configuration.allowLoopbackDevelopment,
        clientId,
        value
      });
      if (!metadata) return failure("invalid_client");
      const fingerprint = inboundMcpClientMetadataFingerprint(metadata);
      const client = await input.repository.createDynamicClient(clientMetadataWrite(metadata, {
        kind: "DYNAMIC_REGISTRATION",
        metadataExpiresAt: null,
        metadataFingerprint: fingerprint,
        now
      }));
      return {
        application_type: client.applicationType === "NATIVE" ? "native" : "web",
        client_id: client.clientId,
        client_id_issued_at: Math.floor(now.getTime() / 1_000),
        client_name: client.clientName,
        ...(client.clientUri ? { client_uri: client.clientUri } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [...client.redirectUris],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      };
    },

    async resolveAccessToken(token) {
      if (!validRawCredential(token)) return null;
      return input.repository.resolveAccessToken({
        issuer: input.configuration.issuer,
        now: clock(),
        resource: input.configuration.resource,
        tokenHash: hashToken(token)
      });
    },

    revokeConnectedApp(userId, grantId) {
      return input.repository.revokeGrant({ grantId, now: clock(), userId });
    },

    async revokeToken(clientId, token) {
      if (!validRawCredential(token)) return;
      await input.repository.revokeTokenFamily({
        clientId,
        now: clock(),
        tokenHash: hashToken(token)
      });
    },

    async token(request) {
      assertResource(request.resource);
      const now = clock();
      const tokens = issueTokenPair(now);
      if (request.grantType === "authorization_code") {
        const exchanged = await input.repository.exchangeAuthorizationCode({
          accessExpiresAt: tokens.accessExpiresAt,
          accessTokenHash: hashToken(tokens.accessToken),
          clientId: request.clientId,
          codeChallenge: pkceChallenge(request.codeVerifier),
          codeHash: hashToken(request.code),
          issuer: input.configuration.issuer,
          now,
          redirectUri: request.redirectUri,
          refreshExpiresAt: tokens.refreshExpiresAt,
          refreshTokenHash: hashToken(tokens.refreshToken),
          resource: input.configuration.resource
        });
        return exchanged ? tokenResponse(tokens) : failure("invalid_grant");
      }
      const rotated = await input.repository.rotateRefreshToken({
        accessExpiresAt: tokens.accessExpiresAt,
        accessTokenHash: hashToken(tokens.accessToken),
        clientId: request.clientId,
        issuer: input.configuration.issuer,
        nextRefreshTokenHash: hashToken(tokens.refreshToken),
        now,
        presentedRefreshTokenHash: hashToken(request.refreshToken),
        refreshExpiresAt: tokens.refreshExpiresAt,
        resource: input.configuration.resource
      });
      return rotated === "rotated" ? tokenResponse(tokens) : failure("invalid_grant");
    }
  });
}
