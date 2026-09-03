import {
  OAuthError,
  OAuthErrorCode,
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectClientAuthMethod,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens
} from "@modelcontextprotocol/client";
import { createMcpSafeFetch } from "./safeFetch";
import {
  bindMcpOAuthPolicyResource,
  mcpOAuthPolicyFingerprint,
  mcpOAuthRegistrationKey,
  sanitizeMcpOAuthAccountLabel,
  type McpOAuthPolicy,
  type McpOAuthPurpose
} from "./oauthPolicy";
import type {
  McpOAuthRepository,
  McpOAuthStoredClient,
  McpOAuthStoredConnection
} from "./oauthRepository";

const REFRESH_SKEW_MS = 60_000;
const MAX_AUTHORIZATION_URL_BYTES = 8 * 1_024;

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
}>;

type OAuthProviderMode = "callback" | "runtime" | "start";

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
  requireHttps(url, allowInsecureHttp);
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

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#client?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.#mode === "runtime") {
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

  async invalidateCredentials(): Promise<void> {
    if (this.#mode === "runtime") await this.#invalidateRuntime();
    else this.#invalidated = true;
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
  readonly #refreshes = new Map<string, Promise<OAuthTokens>>();
  readonly #repository: McpOAuthRepository;

  constructor(input: Readonly<{
    repository: McpOAuthRepository;
    allowInsecureHttp?: boolean;
    fetchForPolicy?: (policy: McpOAuthPolicy) => FetchLike;
    now?: () => Date;
  }>) {
    this.#repository = input.repository;
    this.allowInsecureHttp = input.allowInsecureHttp ?? process.env.NODE_ENV !== "production";
    this.#fetchForPolicy = input.fetchForPolicy ?? ((policy) => createMcpSafeFetch({
      allowInsecureHttp: this.allowInsecureHttp,
      allowPrivateNetwork: policy.allowPrivateNetwork
    }));
    this.#now = input.now ?? (() => new Date());
  }

  async startAuthorization(input: Readonly<{
    forceReconnect: boolean;
    purpose: McpOAuthPurpose;
    redirectUri: string;
    serverId: string;
    state: string;
    userId: string;
  }>): Promise<McpOAuthStartResult> {
    const loadedPolicy = input.purpose === "validation"
      ? await this.#repository.prepareValidationPolicy(input)
      : await this.#repository.loadPolicy(input);
    if (!loadedPolicy) throw new McpOAuthError("mcp_oauth_not_available");
    this.#validatePolicy(loadedPolicy);
    const fetchFn = this.#oauthFetch(loadedPolicy);
    let discovered: OAuthDiscoveryState;
    let policy: McpOAuthPolicy;
    try {
      discovered = discoveryState(await discoverOAuthServerInfo(loadedPolicy.serverUrl, { fetchFn }));
      policy = policyForDiscovery(loadedPolicy, discovered);
      this.#validatePolicy(policy);
      validateDiscovery(discovered, policy, this.allowInsecureHttp);
    } catch (error) {
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
    const registrationKey = mcpOAuthRegistrationKey(policy, discovered.authorizationServerUrl);
    const client = await this.#repository.findClient(registrationKey);
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
      const result = await auth(provider, {
        fetchFn,
        scope: policy.requestedScopes.join(" ") || undefined,
        serverUrl: policy.serverUrl
      });
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
    try {
      const result = await auth(provider, {
        authorizationCode: input.authorizationCode,
        fetchFn: this.#oauthFetch(policy),
        scope: policy.requestedScopes.join(" ") || undefined,
        serverUrl: policy.serverUrl
      });
      if (result !== "AUTHORIZED" || !provider.capturedTokens) {
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
      throw new McpOAuthError("mcp_oauth_authorization_failed");
    }
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
    if (existing) return existing;
    const promise = this.#refresh(connection).finally(() => {
      if (this.#refreshes.get(connectionId) === promise) this.#refreshes.delete(connectionId);
    });
    this.#refreshes.set(connectionId, promise);
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
    const connection = await this.#repository.loadConnection(connectionId);
    if (!connection) return "not_found";
    if (await this.#repository.hasActiveRunBindings(connectionId)) return "disconnecting";
    try {
      await this.#revoke(connection);
    } catch {
      return "disconnecting";
    }
    return await this.#repository.finalizeDisconnected(connectionId)
      ? "disconnected"
      : "disconnecting";
  }

  async reconcileDisconnecting(): Promise<void> {
    await this.#repository.requestDisconnectForIneligibleConnections();
    const connectionIds = await this.#repository.listDisconnectingConnectionIds();
    await Promise.allSettled(
      connectionIds.map((connectionId) => this.revokeConnectionIfDrained(connectionId))
    );
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
  }>): Promise<OAuthClientProvider | null> {
    const policy = await this.#repository.loadPolicy({ ...input, purpose: "validation" });
    if (!policy) return null;
    const connection = await this.#repository.findLatestReadyConnection({
      purpose: "validation",
      serverId: input.serverId,
      userId: input.userId
    });
    if (!connection || connection.policy.configurationIdentity !== policy.configurationIdentity ||
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

  #oauthFetch(policy: McpOAuthPolicy): FetchLike {
    return policyFetch(this.#fetchForPolicy(policy), policy, this.allowInsecureHttp);
  }

  #validatePolicy(policy: McpOAuthPolicy): void {
    requireHttps(new URL(policy.redirectUri), this.allowInsecureHttp);
    requirePolicyUrl(policy.serverUrl, policy, this.allowInsecureHttp);
    requirePolicyUrl(policy.resource, policy, this.allowInsecureHttp);
    if (policy.clientIdMetadataDocumentUrl) {
      const url = new URL(policy.clientIdMetadataDocumentUrl);
      // URL-based client IDs are externally fetched by the authorization server and
      // therefore remain HTTPS-only even in local development.
      if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.hash) {
        throw new McpOAuthError("mcp_oauth_policy_forbidden");
      }
    }
    for (const origin of policy.allowedAuthorizationServerOrigins) {
      const url = new URL(origin);
      requireHttps(url, this.allowInsecureHttp);
      if (url.origin !== origin) throw new McpOAuthError("mcp_oauth_policy_forbidden");
    }
  }

  async #refresh(connection: McpOAuthStoredConnection): Promise<OAuthTokens> {
    const latest = await this.#repository.loadConnection(connection.id);
    if (!latest || !["ready", "disconnecting"].includes(latest.state)) {
      throw new McpOAuthError("mcp_oauth_reauthorization_required");
    }
    if (!latest.expiresAt || latest.expiresAt.getTime() > this.#now().getTime() + REFRESH_SKEW_MS) {
      return latest.tokens;
    }
    const refreshToken = latest.tokens.refresh_token;
    if (!refreshToken) throw new McpOAuthError("mcp_oauth_reauthorization_required");
    try {
      validateDiscovery(latest.client.discoveryState, latest.policy, this.allowInsecureHttp);
      const tokens = await refreshAuthorization(latest.client.discoveryState.authorizationServerUrl, {
        clientInformation: latest.client.clientInformation,
        fetchFn: this.#oauthFetch(latest.policy),
        metadata: latest.client.discoveryState.authorizationServerMetadata,
        refreshToken,
        resource: new URL(latest.policy.resource)
      });
      const rotated = await this.#repository.rotateTokens({
        connectionId: latest.id,
        expectedTokenVersion: latest.tokenVersion,
        tokens
      });
      if (!rotated) throw new McpOAuthError("mcp_oauth_reauthorization_required");
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
      const response = await this.#oauthFetch(connection.policy)(endpoint, {
        body,
        headers,
        method: "POST"
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpOAuthError("mcp_oauth_authorization_failed");
      }
      await response.body?.cancel().catch(() => undefined);
    }
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
