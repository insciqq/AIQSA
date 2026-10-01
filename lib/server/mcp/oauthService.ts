import {
  OAuthError,
  OAuthErrorCode,
  auth,
  discoverOAuthServerInfo,
  parseErrorResponse,
  refreshAuthorization,
  selectClientAuthMethod,
  specTypeSchemas,
  validateAuthorizationResponseIssuer,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens
} from "@modelcontextprotocol/client";
import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { createMcpSafeFetch } from "./safeFetch";
import type { McpEndpointCorrection } from "./draftValidator";
import {
  bindMcpOAuthPolicyResource,
  mcpOAuthPolicyFingerprint,
  mcpOAuthRegistrationKey,
  personalMcpOAuthTransportAllowed,
  sanitizeMcpOAuthAccountLabel,
  type McpOAuthPolicy,
  type McpOAuthPurpose,
  type McpOAuthSourceKind
} from "./oauthPolicy";
import type {
  McpOAuthRepository,
  McpOAuthStoredClient,
  McpOAuthStoredConnection
} from "./oauthRepository";

const REFRESH_SKEW_MS = 60_000;
const MAX_AUTHORIZATION_URL_BYTES = 8 * 1_024;
const MAX_OAUTH_RESPONSE_BYTES = 512 * 1_024;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REVOCATION_PASSES = 3;
/** Revocation retries end this long after the disconnect request; the token is then wiped locally. */
export const MCP_OAUTH_REVOCATION_ABANDON_MS = 24 * 60 * 60_000;
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Every authorization-server response, including the ones the SDK parses with
// response.json(), passes through this byte bound before it is buffered.
function boundedOAuthResponse(response: Response): Response {
  if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_OAUTH_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => undefined);
    throw new McpOAuthError("mcp_oauth_authorization_failed");
  }
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        controller.error(new McpOAuthError("mcp_oauth_authorization_failed"));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}

// Settles on the deadline even when the underlying fetch or SDK call ignores
// its signal, so a stalled authorization server cannot pin a singleflight.
async function withinDeadline<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  operation.catch(() => undefined);
  if (signal.aborted) throw new McpOAuthError("mcp_oauth_authorization_failed");
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new McpOAuthError("mcp_oauth_authorization_failed"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Content-free: a stable code and the server-owned connection scope only. */
function reportRevocationFailure(connectionId: string, code: string, error?: unknown): void {
  reportSubsystemFailure({
    action: code === "mcp_oauth_revocation_abandoned" ? "stop" : "retry",
    code,
    ...(error === undefined ? {} : { prisma_code: databaseFailureCode(error) }),
    scope_id: connectionId,
    stage: "cleanup",
    subsystem: "mcp"
  });
}

export type McpOAuthErrorCode =
  | "mcp_oauth_authorization_failed"
  | "mcp_oauth_configuration_changed"
  | "mcp_oauth_not_available"
  | "mcp_oauth_policy_forbidden"
  | "mcp_oauth_reauthorization_required";

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;

  constructor(code: McpOAuthErrorCode) {
    super(code);
    this.name = "McpOAuthError";
    this.code = code;
  }
}

export type McpOAuthFlowBinding = Readonly<{
  clientId: string;
  codeVerifier: string;
  configurationIdentity: string;
  oauthClientId: string;
  policyFingerprint: string;
  purpose: McpOAuthPurpose;
  redirectUri: string;
  registrationKey: string;
  serverId: string;
  state: string;
  userId: string;
}>;

export type McpOAuthStartResult =
  | Readonly<{ configurationIdentity: string; kind: "already_connected" }>
  | Readonly<{
      authorizationUrl: string;
      flow: McpOAuthFlowBinding;
      kind: "redirect";
    }>;

export type McpOAuthDisconnectResult = "disconnected" | "disconnecting" | "not_found";

export type McpOAuthRuntimeProvider = OAuthClientProvider & Readonly<{
  exactKnownSecrets(): readonly string[];
  validationBinding(): McpEndpointCorrection["oauthBinding"];
}>;

type OAuthProviderMode = "callback" | "runtime" | "start";

type OAuthCredentialScope = "all" | "client" | "discovery" | "tokens" | "verifier";

type OAuthSubject = Pick<McpOAuthPolicy, "purpose" | "serverId" | "userId">;

/** The authorization server no longer accepts this client registration. */
function clientRejected(error: unknown): boolean {
  return error instanceof OAuthError && (error.code === OAuthErrorCode.InvalidClient ||
    error.code === OAuthErrorCode.UnauthorizedClient);
}

/** RFC 7591: a non-zero `client_secret_expires_at` in the past ends the registration. */
function clientSecretExpired(client: McpOAuthStoredClient, now: Date): boolean {
  const information = client.clientInformation;
  const expiresAt = "client_secret_expires_at" in information ? information.client_secret_expires_at : undefined;
  return typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1_000 <= now.getTime();
}

function subjectOf(policy: McpOAuthPolicy): OAuthSubject {
  return { purpose: policy.purpose, serverId: policy.serverId, userId: policy.userId };
}

function clientMetadata(policy: McpOAuthPolicy): OAuthClientMetadata {
  return {
    client_name: "AIQSA MCP client",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [policy.redirectUri],
    response_types: ["code"],
    ...(policy.requestedScopes.length ? { scope: policy.requestedScopes.join(" ") } : {})
  };
}

function normalizedUrl(value: string): string {
  return new URL(value).toString();
}

function allowedOrigins(policy: McpOAuthPolicy): Set<string> {
  return new Set([
    new URL(policy.resource).origin,
    new URL(policy.serverUrl).origin,
    ...policy.allowedAuthorizationServerOrigins
  ]);
}

function requireHttps(url: URL, allowInsecureHttp: boolean): void {
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new McpOAuthError("mcp_oauth_policy_forbidden");
  }
  if (url.username || url.password || url.hash) {
    throw new McpOAuthError("mcp_oauth_policy_forbidden");
  }
}

/** Installation policies keep the service-wide rule; personal policies add
 * the endpoint-bound transport rule. */
function requirePolicyTransport(url: URL, policy: McpOAuthPolicy, allowInsecureHttp: boolean): void {
  requireHttps(url, allowInsecureHttp);
  if (policy.personal && !personalMcpOAuthTransportAllowed(policy.serverUrl, url)) {
    throw new McpOAuthError("mcp_oauth_policy_forbidden");
  }
}

function requirePolicyUrl(
  value: string,
  policy: McpOAuthPolicy,
  allowInsecureHttp: boolean,
  options: Readonly<{ authorizationServerOnly?: boolean }> = {}
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError("mcp_oauth_policy_forbidden");
  }
  requirePolicyTransport(url, policy, allowInsecureHttp);
  const origins = options.authorizationServerOnly
    ? new Set(policy.allowedAuthorizationServerOrigins)
    : allowedOrigins(policy);
  if (!origins.has(url.origin)) throw new McpOAuthError("mcp_oauth_policy_forbidden");
  return url;
}

function metadataEndpoints(metadata: AuthorizationServerMetadata | undefined): string[] {
  if (!metadata) return [];
  const revocationEndpoint = "revocation_endpoint" in metadata &&
    typeof metadata.revocation_endpoint === "string"
    ? metadata.revocation_endpoint
    : undefined;
  return [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    revocationEndpoint
  ].flatMap((value) => typeof value === "string" && value ? [value] : []);
}

function validateDiscovery(
  state: OAuthDiscoveryState,
  policy: McpOAuthPolicy,
  allowInsecureHttp: boolean
): void {
  requirePolicyUrl(state.authorizationServerUrl, policy, allowInsecureHttp, {
    authorizationServerOnly: true
  });
  for (const endpoint of metadataEndpoints(state.authorizationServerMetadata)) {
    requirePolicyUrl(endpoint, policy, allowInsecureHttp, { authorizationServerOnly: true });
  }
  for (const authorizationServer of state.resourceMetadata?.authorization_servers ?? []) {
    requirePolicyUrl(authorizationServer, policy, allowInsecureHttp, {
      authorizationServerOnly: true
    });
  }
  if (state.resourceMetadata?.resource) {
    const resource = new URL(state.resourceMetadata.resource).toString();
    if (resource !== normalizedUrl(policy.resource)) {
      throw new McpOAuthError("mcp_oauth_policy_forbidden");
    }
  }
}

function policyFetch(
  baseFetch: FetchLike,
  policy: McpOAuthPolicy,
  allowInsecureHttp: boolean
): FetchLike {
  return async (input, init) => {
    requirePolicyUrl(input instanceof Request ? input.url : input.toString(), policy, allowInsecureHttp);
    return baseFetch(input, { ...init, redirect: "error" });
  };
}

function discoveryState(input: Awaited<ReturnType<typeof discoverOAuthServerInfo>>): OAuthDiscoveryState {
  return {
    authorizationServerUrl: input.authorizationServerUrl,
    ...(input.authorizationServerMetadata
      ? { authorizationServerMetadata: input.authorizationServerMetadata }
      : {}),
    ...(input.resourceMetadata ? { resourceMetadata: input.resourceMetadata } : {})
  };
}

function policyForDiscovery(
  policy: McpOAuthPolicy,
  state: OAuthDiscoveryState
): McpOAuthPolicy {
  const resolved = bindMcpOAuthPolicyResource(policy, state.resourceMetadata?.resource);
  if (!resolved) throw new McpOAuthError("mcp_oauth_policy_forbidden");
  return resolved;
}

function resourceLabel(state: OAuthDiscoveryState, policy: McpOAuthPolicy): string | null {
  return sanitizeMcpOAuthAccountLabel(
    state.resourceMetadata?.resource_name ?? new URL(policy.resource).hostname
  );
}

class DurableOAuthProvider implements OAuthClientProvider {
  #authorizationUrl: URL | null = null;
  #client: McpOAuthStoredClient | null;
  #codeVerifier: string | null;
  #connection: McpOAuthStoredConnection | null;
  #discoveryState: OAuthDiscoveryState;
  #invalidated = false;
  readonly #knownSecrets = new Set<string>();
  readonly #mode: OAuthProviderMode;
  readonly #policy: McpOAuthPolicy;
  readonly #repository: McpOAuthRepository;
  readonly #service: McpOAuthService;
  readonly #state: string | null;
  #tokens: OAuthTokens | null = null;

  constructor(input: Readonly<{
    client: McpOAuthStoredClient | null;
    codeVerifier?: string;
    connection?: McpOAuthStoredConnection;
    discoveryState: OAuthDiscoveryState;
    mode: OAuthProviderMode;
    policy: McpOAuthPolicy;
    repository: McpOAuthRepository;
    service: McpOAuthService;
    state?: string;
  }>) {
    this.#client = input.client;
    this.#codeVerifier = input.codeVerifier ?? null;
    this.#connection = input.connection ?? null;
    this.#discoveryState = input.discoveryState;
    this.#mode = input.mode;
    this.#policy = input.policy;
    this.#repository = input.repository;
    this.#service = input.service;
    this.#state = input.state ?? null;
    this.#rememberClientSecret(input.client);
    if (input.connection) this.#rememberTokens(input.connection.tokens);
  }

  get authorizationUrl(): URL | null {
    return this.#authorizationUrl;
  }

  get capturedCodeVerifier(): string | null {
    return this.#codeVerifier;
  }

  get capturedTokens(): OAuthTokens | null {
    return this.#tokens;
  }

  get client(): McpOAuthStoredClient | null {
    return this.#client;
  }

  get redirectUrl(): string {
    return this.#policy.redirectUri;
  }

  get clientMetadataUrl(): string | undefined {
    return this.#policy.clientIdMetadataDocumentUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.#policy);
  }

  state(): string {
    return this.#state ?? "non-interactive";
  }

  exactKnownSecrets(): readonly string[] {
    return [...this.#knownSecrets];
  }

  validationBinding(): McpEndpointCorrection["oauthBinding"] {
    const connection = this.#connection;
    if (this.#mode !== "runtime" || connection?.purpose !== "validation" || connection.state !== "ready") return undefined;
    return { connectionId: connection.id, policyFingerprint: connection.policyFingerprint, tokenVersion: connection.tokenVersion };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#client?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.#mode === "runtime") {
      // Only the SDK's recovery after the server rejected the bearer reaches
      // this. Settle the connection instead of leaving it ready: a forced
      // refresh either rotates usable tokens or marks reauthorization (and
      // retires a rejected client).
      if (this.#connection && !this.#invalidated) {
        await this.#service.recoverRejectedAuthorization(this.#connection.id);
      }
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    this.#client = await this.#repository.saveClient({
      clientInformation,
      clientMetadata: this.clientMetadata,
      discoveryState: this.#discoveryState,
      registrationKey: mcpOAuthRegistrationKey(
        this.#policy,
        this.#discoveryState.authorizationServerUrl
      )
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.#mode !== "runtime" || !this.#connection) return undefined;
    const tokens = await this.#service.tokensForConnection(this.#connection.id);
    this.#rememberTokens(tokens);
    this.#connection = await this.#repository.loadConnection(this.#connection.id);
    if (this.#connection) this.#rememberTokens(this.#connection.tokens);
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#rememberTokens(tokens);
    if (this.#mode !== "runtime" || !this.#connection) {
      this.#tokens = tokens;
      return;
    }
    const rotated = await this.#repository.rotateTokens({
      connectionId: this.#connection.id,
      expectedTokenVersion: this.#connection.tokenVersion,
      tokens
    });
    if (!rotated) throw new McpOAuthError("mcp_oauth_reauthorization_required");
    this.#connection = rotated;
    this.#rememberTokens(rotated.tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.#mode === "runtime") {
      await this.#invalidateRuntime();
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    requirePolicyUrl(authorizationUrl.toString(), this.#policy, this.#service.allowInsecureHttp, {
      authorizationServerOnly: true
    });
    if (Buffer.byteLength(authorizationUrl.toString(), "utf8") > MAX_AUTHORIZATION_URL_BYTES) {
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
    this.#authorizationUrl = new URL(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.#mode === "runtime") throw new McpOAuthError("mcp_oauth_reauthorization_required");
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.#codeVerifier) throw new McpOAuthError("mcp_oauth_authorization_failed");
    return this.#codeVerifier;
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL> {
    if (resource && normalizedUrl(resource) !== normalizedUrl(this.#policy.resource)) {
      throw new McpOAuthError("mcp_oauth_policy_forbidden");
    }
    return new URL(this.#policy.resource);
  }

  async invalidateCredentials(scope: OAuthCredentialScope = "all"): Promise<void> {
    const rejectedClient = scope === "all" || scope === "client" ? this.#client : null;
    if (rejectedClient) await this.#service.retireRejectedClient(rejectedClient, subjectOf(this.#policy));
    if (this.#mode === "runtime") {
      await this.#invalidateRuntime();
      // Never register a replacement client from a runtime request.
      if (rejectedClient) throw new McpOAuthError("mcp_oauth_reauthorization_required");
      return;
    }
    this.#invalidated = true;
    // An authorization code is bound to the rejected client; do not retry.
    if (rejectedClient && this.#mode === "callback") throw new McpOAuthError("mcp_oauth_authorization_failed");
    // A start retries with a fresh registration.
    if (rejectedClient) this.#client = null;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    validateDiscovery(state, this.#policy, this.#service.allowInsecureHttp);
    this.#discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState {
    return this.#discoveryState;
  }

  async #invalidateRuntime(): Promise<void> {
    if (!this.#connection || this.#invalidated) return;
    this.#invalidated = true;
    await this.#repository.markReauthorizationRequired({
      connectionId: this.#connection.id,
      tokenVersion: this.#connection.tokenVersion
    });
  }

  #rememberClientSecret(client: McpOAuthStoredClient | null): void {
    const secret = client?.clientInformation.client_secret;
    if (secret) this.#knownSecrets.add(secret);
  }

  #rememberTokens(tokens: OAuthTokens): void {
    if (tokens.access_token) this.#knownSecrets.add(tokens.access_token);
    if (tokens.refresh_token) this.#knownSecrets.add(tokens.refresh_token);
  }
}

export class McpOAuthService {
  readonly allowInsecureHttp: boolean;
  readonly #fetchForPolicy: (policy: McpOAuthPolicy) => FetchLike;
  readonly #now: () => Date;
  readonly #refreshes = new Map<string, Readonly<{
    abort: AbortController;
    promise: Promise<OAuthTokens>;
  }>>();
  readonly #repository: McpOAuthRepository;
  readonly #requestTimeoutMs: number;

  constructor(input: Readonly<{
    repository: McpOAuthRepository;
    allowInsecureHttp?: boolean;
    fetchForPolicy?: (policy: McpOAuthPolicy) => FetchLike;
    now?: () => Date;
    requestTimeoutMs?: number;
  }>) {
    this.#repository = input.repository;
    this.allowInsecureHttp = input.allowInsecureHttp ?? true;
    this.#fetchForPolicy = input.fetchForPolicy ?? ((policy) => createMcpSafeFetch({
      allowInsecureHttp: this.allowInsecureHttp,
      allowPrivateNetwork: policy.allowPrivateNetwork
    }));
    this.#now = input.now ?? (() => new Date());
    this.#requestTimeoutMs = input.requestTimeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  }

  async startAuthorization(input: Readonly<{
    forceReconnect: boolean;
    purpose: McpOAuthPurpose;
    redirectUri: string;
    serverId: string;
    /** Restricts a user route to its own kind of server; absent accepts both. */
    sourceKind?: McpOAuthSourceKind;
    state: string;
    userId: string;
  }>): Promise<McpOAuthStartResult> {
    const loadedPolicy = input.purpose === "validation"
      ? await this.#repository.prepareValidationPolicy(input)
      : await this.#repository.loadPolicy(input);
    if (!loadedPolicy) throw new McpOAuthError("mcp_oauth_not_available");
    this.#validatePolicy(loadedPolicy);
    const deadline = this.#deadline();
    const fetchFn = this.#oauthFetch(loadedPolicy, deadline);
    let discovered: OAuthDiscoveryState;
    let policy: McpOAuthPolicy;
    try {
      discovered = discoveryState(await withinDeadline(
        deadline,
        discoverOAuthServerInfo(loadedPolicy.serverUrl, { fetchFn })
      ));
      policy = policyForDiscovery(loadedPolicy, discovered);
      this.#validatePolicy(policy);
      validateDiscovery(discovered, policy, this.allowInsecureHttp);
    } catch (error) {
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
    const registrationKey = mcpOAuthRegistrationKey(policy, discovered.authorizationServerUrl);
    let client = await this.#repository.findClient(registrationKey);
    if (client && clientSecretExpired(client, this.#now())) {
      await this.retireRejectedClient(client, subjectOf(policy));
      client = null;
    }
    if (client && !input.forceReconnect) {
      const fingerprint = mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id);
      if (await this.#repository.findReadyConnection({
        policyFingerprint: fingerprint,
        purpose: policy.purpose,
        serverId: policy.serverId,
        userId: policy.userId
      })) {
        return {
          configurationIdentity: policy.configurationIdentity,
          kind: "already_connected"
        };
      }
    }

    const provider = new DurableOAuthProvider({
      client,
      discoveryState: discovered,
      mode: "start",
      policy,
      repository: this.#repository,
      service: this,
      state: input.state
    });
    try {
      if (!client && policy.clientIdMetadataDocumentUrl?.startsWith("http:") &&
        discovered.authorizationServerMetadata?.client_id_metadata_document_supported === true) {
        // The pinned SDK accepts HTTP discovery and registration, but its SEP-991
        // helper rejects HTTP URL-based client IDs before invoking the provider.
        // The administrator-reviewed policy has already validated this exact URL,
        // so persist it before entering the SDK flow.
        await provider.saveClientInformation({
          client_id: policy.clientIdMetadataDocumentUrl
        });
      }
      const result = await withinDeadline(deadline, auth(provider, {
        fetchFn,
        scope: policy.requestedScopes.join(" ") || undefined,
        serverUrl: policy.serverUrl
      }));
      if (result !== "REDIRECT" || !provider.authorizationUrl ||
        !provider.capturedCodeVerifier || !provider.client) {
        throw new McpOAuthError("mcp_oauth_authorization_failed");
      }
      const clientId = provider.client.clientInformation.client_id;
      const policyFingerprint = mcpOAuthPolicyFingerprint(policy, clientId);
      return {
        authorizationUrl: provider.authorizationUrl.toString(),
        flow: {
          clientId,
          codeVerifier: provider.capturedCodeVerifier,
          configurationIdentity: policy.configurationIdentity,
          oauthClientId: provider.client.id,
          policyFingerprint,
          purpose: policy.purpose,
          redirectUri: policy.redirectUri,
          registrationKey,
          serverId: policy.serverId,
          state: input.state,
          userId: policy.userId
        },
        kind: "redirect"
      };
    } catch (error) {
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
  }

  async completeAuthorization(input: Readonly<{
    authorizationCode: string;
    flow: McpOAuthFlowBinding;
    issuer?: string;
  }>): Promise<McpOAuthStoredConnection> {
    const loadedPolicy = await this.#repository.loadPolicy(input.flow);
    if (!loadedPolicy || loadedPolicy.configurationIdentity !== input.flow.configurationIdentity ||
      loadedPolicy.redirectUri !== input.flow.redirectUri) {
      throw new McpOAuthError("mcp_oauth_configuration_changed");
    }
    this.#validatePolicy(loadedPolicy);
    const client = await this.#repository.findClient(input.flow.registrationKey);
    if (!client || client.id !== input.flow.oauthClientId ||
      client.clientInformation.client_id !== input.flow.clientId) {
      throw new McpOAuthError("mcp_oauth_configuration_changed");
    }
    const policy = policyForDiscovery(loadedPolicy, client.discoveryState);
    this.#validatePolicy(policy);
    if (
      mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id) !== input.flow.policyFingerprint) {
      throw new McpOAuthError("mcp_oauth_configuration_changed");
    }
    validateDiscovery(client.discoveryState, policy, this.allowInsecureHttp);
    const provider = new DurableOAuthProvider({
      client,
      codeVerifier: input.flow.codeVerifier,
      discoveryState: client.discoveryState,
      mode: "callback",
      policy,
      repository: this.#repository,
      service: this
    });
    const deadline = this.#deadline();
    try {
      if (this.#tokenEndpoint(client.discoveryState, policy).protocol === "http:") {
        // SDK v2 intentionally refuses non-loopback HTTP token endpoints. AIQSA's
        // reviewed HTTP policy uses the same client-authentication and PKCE fields
        // through its pinned safe fetch instead.
        const metadata = client.discoveryState.authorizationServerMetadata;
        validateAuthorizationResponseIssuer({
          expectedIssuer: metadata?.issuer,
          iss: input.issuer,
          issParameterSupported:
            metadata?.authorization_response_iss_parameter_supported === true
        });
        await provider.saveTokens(await withinDeadline(deadline, this.#requestTokens({
          client: client.clientInformation,
          discoveryState: client.discoveryState,
          parameters: new URLSearchParams({
            code: input.authorizationCode,
            code_verifier: input.flow.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: policy.redirectUri
          }),
          policy,
          signal: deadline
        })));
      } else {
        const result = await withinDeadline(deadline, auth(provider, {
          authorizationCode: input.authorizationCode,
          fetchFn: this.#oauthFetch(policy, deadline),
          iss: input.issuer,
          scope: policy.requestedScopes.join(" ") || undefined,
          serverUrl: policy.serverUrl
        }));
        if (result !== "AUTHORIZED") {
          throw new McpOAuthError("mcp_oauth_authorization_failed");
        }
      }
      if (!provider.capturedTokens) {
        throw new McpOAuthError("mcp_oauth_authorization_failed");
      }
      const created = await this.#repository.createConnection({
        clientId: client.clientInformation.client_id,
        configurationIdentity: policy.configurationIdentity,
        externalAccountLabel: resourceLabel(client.discoveryState, policy),
        oauthClientId: client.id,
        policyFingerprint: input.flow.policyFingerprint,
        purpose: policy.purpose,
        redirectUri: policy.redirectUri,
        resource: policy.resource,
        serverId: policy.serverId,
        tokens: provider.capturedTokens,
        userId: policy.userId
      });
      if (created.kind === "configuration_changed") {
        throw new McpOAuthError("mcp_oauth_configuration_changed");
      }
      if (created.kind !== "ok") throw new McpOAuthError("mcp_oauth_not_available");
      return created.value;
    } catch (error) {
      if (error instanceof McpOAuthError) throw error;
      // The manual HTTP token path reports a rejected client directly.
      if (clientRejected(error)) await this.retireRejectedClient(client, subjectOf(policy));
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
  }

  /**
   * Stops reusing a registration the authorization server rejected, so the
   * next start registers again, and takes the subject's ready connection on
   * that client out of `ready`.
   */
  async retireRejectedClient(client: McpOAuthStoredClient, subject?: OAuthSubject): Promise<void> {
    await this.#repository.retireClient({
      clientId: client.clientInformation.client_id,
      id: client.id,
      registrationKey: client.registrationKey
    });
    if (!subject) return;
    const ready = await this.#repository.findLatestReadyConnection(subject);
    if (ready && ready.client.id === client.id) {
      await this.#repository.markReauthorizationRequired({
        connectionId: ready.id,
        tokenVersion: ready.tokenVersion
      });
    }
  }

  /**
   * After the MCP server rejected a stored bearer, refresh once regardless of
   * the recorded expiry. Success keeps the connection with rotated tokens;
   * a rejected grant or client, or no refresh token, requires reauthorization.
   */
  async recoverRejectedAuthorization(connectionId: string): Promise<void> {
    const connection = await this.#repository.loadConnection(connectionId);
    if (!connection || !["ready", "disconnecting"].includes(connection.state)) return;
    if (!connection.tokens.refresh_token) {
      await this.#repository.markReauthorizationRequired({
        connectionId,
        tokenVersion: connection.tokenVersion
      });
      return;
    }
    const existing = this.#refreshes.get(connectionId);
    if (existing) {
      await existing.promise.catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    const deadline = this.#deadline(abort.signal);
    const promise = withinDeadline(deadline, this.#refresh(connection, deadline, { force: true })).finally(() => {
      if (this.#refreshes.get(connectionId)?.promise === promise) this.#refreshes.delete(connectionId);
    });
    this.#refreshes.set(connectionId, { abort, promise });
    await promise.catch(() => undefined);
  }

  async tokensForConnection(connectionId: string): Promise<OAuthTokens> {
    const connection = await this.#repository.loadConnection(connectionId);
    if (!connection || !["ready", "disconnecting"].includes(connection.state)) {
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    if (!connection.expiresAt || connection.expiresAt.getTime() > this.#now().getTime() + REFRESH_SKEW_MS) {
      return connection.tokens;
    }
    if (!connection.tokens.refresh_token) {
      await this.#repository.markReauthorizationRequired({
        connectionId,
        tokenVersion: connection.tokenVersion
      });
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    const existing = this.#refreshes.get(connectionId);
    if (existing) return existing.promise;
    const abort = new AbortController();
    const deadline = this.#deadline(abort.signal);
    const promise = withinDeadline(deadline, this.#refresh(connection, deadline)).finally(() => {
      if (this.#refreshes.get(connectionId)?.promise === promise) this.#refreshes.delete(connectionId);
    });
    this.#refreshes.set(connectionId, { abort, promise });
    return promise;
  }

  async disconnect(input: Readonly<{
    purpose: McpOAuthPurpose;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthDisconnectResult> {
    const connection = await this.#repository.requestDisconnect(input);
    if (!connection) return "not_found";
    return this.revokeConnectionIfDrained(connection.id);
  }

  async revokeConnectionIfDrained(connectionId: string): Promise<McpOAuthDisconnectResult> {
    for (let pass = 0; pass < MAX_REVOCATION_PASSES; pass += 1) {
      const connection = await this.#repository.loadConnection(connectionId);
      if (!connection) return pass ? "disconnecting" : "not_found";
      if (await this.#repository.hasActiveRunBindings(connectionId)) return "disconnecting";
      // A drained disconnect stops any local refresh before revoking.
      this.#refreshes.get(connectionId)?.abort.abort();
      try {
        await this.#revoke(connection);
      } catch {
        // The token stays stored; reconcileDisconnecting retries within its bound.
        reportRevocationFailure(connectionId, "mcp_oauth_revocation_failed");
        return "disconnecting";
      }
      if (await this.#repository.finalizeDisconnected({
        connectionId,
        tokenVersion: connection.tokenVersion
      })) {
        reportSubsystemHealthy("mcp", "cleanup", connectionId);
        return "disconnected";
      }
      const current = await this.#repository.loadConnection(connectionId);
      // Only a refresh that rotated after revocation earns another pass; its
      // new generation must be revoked before the connection is cleared.
      if (!current || current.state !== "disconnecting" ||
        current.tokenVersion === connection.tokenVersion) {
        return "disconnecting";
      }
    }
    return "disconnecting";
  }

  /**
   * Marks ineligible connections (archived personal or installation servers,
   * inactive owners, lost grants) disconnecting, retries each revocation and,
   * 24 h after the disconnect request, wipes the token locally instead, so no
   * connection stays disconnecting forever and finalization can proceed.
   */
  async reconcileDisconnecting(): Promise<void> {
    await this.#repository.requestDisconnectForIneligibleConnections();
    const connectionIds = await this.#repository.listDisconnectingConnectionIds();
    const requestedBefore = new Date(this.#now().getTime() - MCP_OAUTH_REVOCATION_ABANDON_MS);
    const settled = await Promise.allSettled(
      connectionIds.map((connectionId) => this.#settleDisconnecting(connectionId, requestedBefore))
    );
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        reportRevocationFailure(connectionIds[index]!, "mcp_oauth_revocation_failed", result.reason);
      }
    });
  }

  async #settleDisconnecting(connectionId: string, requestedBefore: Date): Promise<void> {
    try {
      if (await this.revokeConnectionIfDrained(connectionId) === "disconnected") return;
    } catch (error) {
      reportRevocationFailure(connectionId, "mcp_oauth_revocation_failed", error);
    }
    if (await this.#repository.abandonRevocation({ connectionId, requestedBefore })) {
      this.#refreshes.get(connectionId)?.abort.abort();
      reportRevocationFailure(connectionId, "mcp_oauth_revocation_abandoned");
    }
  }

  async createRuntimeProvider(connectionId: string): Promise<McpOAuthRuntimeProvider> {
    const connection = await this.#repository.loadConnection(connectionId);
    if (!connection || !["ready", "disconnecting"].includes(connection.state)) {
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    validateDiscovery(connection.client.discoveryState, connection.policy, this.allowInsecureHttp);
    return new DurableOAuthProvider({
      client: connection.client,
      connection,
      discoveryState: connection.client.discoveryState,
      mode: "runtime",
      policy: connection.policy,
      repository: this.#repository,
      service: this
    });
  }

  async createValidationProvider(input: Readonly<{
    redirectUri: string;
    serverId: string;
    userId: string;
  }>): Promise<McpOAuthRuntimeProvider | null> {
    const policy = await this.#repository.loadPolicy({ ...input, purpose: "validation" });
    if (!policy) return null;
    const connection = await this.#repository.findLatestReadyConnection({
      purpose: "validation",
      serverId: input.serverId,
      userId: input.userId
    });
    if (!connection || connection.policy.serverUrl !== policy.serverUrl ||
      connection.policy.allowPrivateNetwork !== policy.allowPrivateNetwork ||
      connection.policy.redirectUri !== policy.redirectUri ||
      connection.policyFingerprint !== mcpOAuthPolicyFingerprint(
        policy,
        connection.client.clientInformation.client_id
      )) {
      return null;
    }
    return this.createRuntimeProvider(connection.id);
  }

  async createRuntimeFetch(
    connectionId: string,
    baseFetch: FetchLike,
    serverUrl?: string
  ): Promise<FetchLike> {
    const connection = await this.#repository.loadConnection(connectionId);
    if (!connection || !["ready", "disconnecting"].includes(connection.state)) {
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    const runtimePolicy: McpOAuthPolicy = serverUrl
      ? { ...connection.policy, serverUrl: new URL(serverUrl).toString() }
      : connection.policy;
    this.#validatePolicy(runtimePolicy);
    validateDiscovery(connection.client.discoveryState, runtimePolicy, this.allowInsecureHttp);
    return policyFetch(baseFetch, runtimePolicy, this.allowInsecureHttp);
  }

  #deadline(abort?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    return abort ? AbortSignal.any([timeout, abort]) : timeout;
  }

  #oauthFetch(policy: McpOAuthPolicy, deadline: AbortSignal): FetchLike {
    const baseFetch = this.#fetchForPolicy(policy);
    return policyFetch(async (input, init) => boundedOAuthResponse(await baseFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    })), policy, this.allowInsecureHttp);
  }

  #validatePolicy(policy: McpOAuthPolicy): void {
    requireHttps(new URL(policy.redirectUri), this.allowInsecureHttp);
    requirePolicyUrl(policy.serverUrl, policy, this.allowInsecureHttp);
    requirePolicyUrl(policy.resource, policy, this.allowInsecureHttp);
    if (policy.clientIdMetadataDocumentUrl) {
      const url = new URL(policy.clientIdMetadataDocumentUrl);
      if ((url.protocol !== "https:" && !(this.allowInsecureHttp && url.protocol === "http:")) ||
        url.pathname === "/" || url.username || url.password || url.hash) {
        throw new McpOAuthError("mcp_oauth_policy_forbidden");
      }
    }
    for (const origin of policy.allowedAuthorizationServerOrigins) {
      const url = new URL(origin);
      requirePolicyTransport(url, policy, this.allowInsecureHttp);
      if (url.origin !== origin) throw new McpOAuthError("mcp_oauth_policy_forbidden");
    }
  }

  async #refresh(
    connection: McpOAuthStoredConnection,
    deadline: AbortSignal,
    options: Readonly<{ force?: boolean }> = {}
  ): Promise<OAuthTokens> {
    const latest = await this.#repository.loadConnection(connection.id);
    if (!latest || !["ready", "disconnecting"].includes(latest.state)) {
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    if (options.force && latest.tokenVersion !== connection.tokenVersion) return latest.tokens;
    if (!options.force &&
      (!latest.expiresAt || latest.expiresAt.getTime() > this.#now().getTime() + REFRESH_SKEW_MS)) {
      return latest.tokens;
    }
    const refreshToken = latest.tokens.refresh_token;
    if (!refreshToken) throw new McpOAuthError("mcp_oauth_reauthorization_required");
    try {
      validateDiscovery(latest.client.discoveryState, latest.policy, this.allowInsecureHttp);
      const tokens = this.#tokenEndpoint(latest.client.discoveryState, latest.policy).protocol === "http:"
        ? await this.#requestTokens({
            client: latest.client.clientInformation,
            discoveryState: latest.client.discoveryState,
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken
            }),
            policy: latest.policy,
            signal: deadline
          }).then((refreshed) => refreshed.refresh_token
            ? refreshed
            : { ...refreshed, refresh_token: refreshToken })
        : await refreshAuthorization(latest.client.discoveryState.authorizationServerUrl, {
            clientInformation: latest.client.clientInformation,
            fetchFn: this.#oauthFetch(latest.policy, deadline),
            metadata: latest.client.discoveryState.authorizationServerMetadata,
            refreshToken,
            resource: new URL(latest.policy.resource)
          });
      const rotated = await this.#repository.rotateTokens({
        connectionId: latest.id,
        expectedTokenVersion: latest.tokenVersion,
        tokens
      });
      if (!rotated || !["ready", "disconnecting"].includes(rotated.state)) {
        // The connection finished disconnecting while this refresh was in
        // flight: the new generation was never stored, so revoke it here.
        if (!rotated) await this.#revoke({ ...latest, tokens }).catch(() => undefined);
        throw new McpOAuthError("mcp_oauth_reauthorization_required");
      }
      return rotated.tokens;
    } catch (error) {
      if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant) {
        const winner = await this.#repository.loadConnection(latest.id);
        if (winner && winner.tokenVersion !== latest.tokenVersion &&
          ["ready", "disconnecting"].includes(winner.state)) {
          return winner.tokens;
        }
        await this.#repository.markReauthorizationRequired({
          connectionId: latest.id,
          tokenVersion: latest.tokenVersion
        });
        throw new McpOAuthError("mcp_oauth_reauthorization_required");
      }
      if (clientRejected(error)) {
        // The authorization server no longer accepts this registration. The
        // connection needs consent again, and the next start must register a
        // fresh client instead of reusing the dead one.
        await this.#repository.markReauthorizationRequired({
          connectionId: latest.id,
          tokenVersion: latest.tokenVersion
        });
        await this.retireRejectedClient(latest.client);
        throw new McpOAuthError("mcp_oauth_reauthorization_required");
      }
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
  }

  async #revoke(connection: McpOAuthStoredConnection): Promise<void> {
    const metadata = connection.client.discoveryState.authorizationServerMetadata;
    const revocationEndpoint = metadata && "revocation_endpoint" in metadata &&
      typeof metadata.revocation_endpoint === "string"
      ? metadata.revocation_endpoint
      : null;
    if (!metadata || !revocationEndpoint) return;
    const endpoint = requirePolicyUrl(
      revocationEndpoint,
      connection.policy,
      this.allowInsecureHttp,
      { authorizationServerOnly: true }
    );
    const revocationMethods = "revocation_endpoint_auth_methods_supported" in metadata &&
      Array.isArray(metadata.revocation_endpoint_auth_methods_supported)
      ? metadata.revocation_endpoint_auth_methods_supported.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const methods = revocationMethods.length
      ? revocationMethods
      : metadata.token_endpoint_auth_methods_supported ?? [];
    const method = selectClientAuthMethod(connection.client.clientInformation, methods);
    const tokens = [
      connection.tokens.access_token
        ? { hint: "access_token", token: connection.tokens.access_token }
        : null,
      connection.tokens.refresh_token
        ? { hint: "refresh_token", token: connection.tokens.refresh_token }
        : null
    ].filter((value): value is { hint: string; token: string } => Boolean(value));
    const deadline = this.#deadline();
    const fetchFn = this.#oauthFetch(connection.policy, deadline);
    for (const token of tokens) {
      const body = new URLSearchParams({ token: token.token, token_type_hint: token.hint });
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      });
      this.#applyClientAuthentication(
        method,
        connection.client.clientInformation,
        headers,
        body
      );
      const response = await withinDeadline(deadline, fetchFn(endpoint, {
        body,
        headers,
        method: "POST"
      }));
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpOAuthError("mcp_oauth_authorization_failed");
      }
      await response.body?.cancel().catch(() => undefined);
    }
  }

  #tokenEndpoint(discoveryState: OAuthDiscoveryState, policy: McpOAuthPolicy): URL {
    const endpoint = discoveryState.authorizationServerMetadata?.token_endpoint ??
      new URL("/token", discoveryState.authorizationServerUrl).toString();
    return requirePolicyUrl(endpoint, policy, this.allowInsecureHttp, {
      authorizationServerOnly: true
    });
  }

  async #requestTokens(input: Readonly<{
    client: OAuthClientInformationMixed;
    discoveryState: OAuthDiscoveryState;
    parameters: URLSearchParams;
    policy: McpOAuthPolicy;
    signal: AbortSignal;
  }>): Promise<OAuthTokens> {
    const endpoint = this.#tokenEndpoint(input.discoveryState, input.policy);
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    });
    const parameters = new URLSearchParams(input.parameters);
    parameters.set("resource", input.policy.resource);
    const methods = input.discoveryState.authorizationServerMetadata
      ?.token_endpoint_auth_methods_supported ?? [];
    this.#applyClientAuthentication(
      selectClientAuthMethod(input.client, methods),
      input.client,
      headers,
      parameters
    );
    const response = await this.#oauthFetch(input.policy, input.signal)(endpoint, {
      body: parameters,
      headers,
      method: "POST"
    });
    const body = await response.text();
    if (!response.ok) throw await parseErrorResponse(body);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
    const parsed = await specTypeSchemas.OAuthTokens["~standard"].validate(payload);
    if (parsed.issues) throw new McpOAuthError("mcp_oauth_authorization_failed");
    return {
      ...parsed.value,
      issuer: input.discoveryState.authorizationServerMetadata?.issuer ??
        input.discoveryState.authorizationServerUrl
    };
  }

  #applyClientAuthentication(
    method: "client_secret_basic" | "client_secret_post" | "none",
    client: OAuthClientInformationMixed,
    headers: Headers,
    body: URLSearchParams
  ): void {
    if (method === "client_secret_basic") {
      if (!client.client_secret) throw new McpOAuthError("mcp_oauth_authorization_failed");
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`, "utf8").toString("base64")}`
      );
      return;
    }
    body.set("client_id", client.client_id);
    if (method === "client_secret_post" && client.client_secret) {
      body.set("client_secret", client.client_secret);
    }
  }
}
