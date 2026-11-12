import type { AuthProvider, FetchLike } from "@modelcontextprotocol/client";
import type { McpClientCredentialsAuthMethod, McpDraftConfiguration } from "@/lib/contracts/mcp";
import { hashCanonicalMcpValue } from "./definitions";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  mcpClientCredentialsSecretEnvelopeContext
} from "./encryption";
import { boundedOAuthResponse } from "./oauthService";
import { mcpDestinationSafeFetchOptions } from "./personalNetworkPolicy";
import {
  createMcpSafeFetch,
  mcpNetworkPolicyRefusal,
  type McpNetworkPolicyRefusalCode
} from "./safeFetch";

/**
 * OAuth client credentials (RFC 6749 §4.4, RFC 8707 `resource`) for
 * installation MCP servers: one token per server and secret generation, held
 * only in this process and asked for again shortly before it expires. No
 * refresh token is kept and no token is ever stored; a restart signs in again.
 */

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
/** A token answer without `expires_in` counts as valid this long, so it is renewed after 50 minutes. */
const DEFAULT_TOKEN_LIFETIME_MS = 51 * 60_000;
/** A longer lifetime is not trusted: the token is renewed at least daily. */
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
const RENEWAL_LEAD_MS = 60_000;
/**
 * A 401 drops the token that was sent, so the next request signs in again,
 * unless that token is younger than this: a server that rejects even a fresh
 * token is not asked for another one on every request.
 */
const REJECTED_TOKEN_MIN_AGE_MS = 30_000;
/** After a failed token request the endpoint is asked again only after this delay, doubled per failure. */
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Distinct grants a process keeps tokens for; older entries go first. */
const MAX_CACHED_TOKENS = 256;
/** Tokens a session remembers for redaction: the current one and a few it replaced. */
const KNOWN_TOKEN_LIMIT = 4;
const ACCESS_TOKEN = /^[\x21-\x7E]+$/u;
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/u;

export type McpClientCredentialsErrorCode =
  | McpNetworkPolicyRefusalCode
  | "mcp_client_credentials_invalid_response"
  | "mcp_client_credentials_rejected"
  | "mcp_client_credentials_unreachable";

/**
 * Content-free: a stable code and the field a refusal points at, read only
 * from the endpoint's registered RFC 6749 error code. The endpoint's own text
 * is never kept, logged or shown.
 */
export class McpClientCredentialsError extends Error {
  readonly code: McpClientCredentialsErrorCode;
  readonly path: string;

  constructor(code: McpClientCredentialsErrorCode, path = "auth.tokenEndpoint") {
    super(code);
    this.name = "McpClientCredentialsError";
    this.code = code;
    this.path = path;
  }
}

const SIGN_IN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "mcp_client_credentials_invalid_response",
  "mcp_client_credentials_rejected",
  "mcp_client_credentials_unreachable"
]);

/** The sign-in failure an error carries, read by code so an error from another bundle still counts. */
export function mcpClientCredentialsFailureCode(error: unknown): McpClientCredentialsErrorCode | null {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "McpClientCredentialsError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SIGN_IN_FAILURE_CODES.has(code) ? code as McpClientCredentialsErrorCode
    : mcpNetworkPolicyRefusal(error);
}

/** Which draft field an RFC 6749 / RFC 8707 refusal is about. */
const REFUSAL_PATHS: Readonly<Record<string, string>> = {
  invalid_client: "clientSecret",
  invalid_scope: "auth.scopes",
  invalid_target: "auth.resource",
  unauthorized_client: "auth.clientId"
};

export type McpClientCredentialsGrant = Readonly<{
  /** The server's reviewed internal-network permission applies to its token endpoint too. */
  allowPrivateNetwork: boolean;
  authMethod: McpClientCredentialsAuthMethod;
  clientId: string;
  clientSecret: string;
  resource: string;
  scopes: readonly string[];
  tokenEndpoint: string;
}>;

/** What a runtime launch carries to sign in: the grant and whose secret generation it is. */
export type McpClientCredentialsLaunch = Readonly<{
  grant: McpClientCredentialsGrant;
  secretGeneration: number;
  serverId: string;
}>;

export type McpClientCredentialsToken = Readonly<{
  accessToken: string;
  expiresAt: number;
  obtainedAt: number;
  renewAt: number;
}>;

/** The configuration's grant with its secret, or null when it does not sign in with client credentials. */
export function mcpClientCredentialsGrant(
  configuration: McpDraftConfiguration,
  clientSecret: string
): McpClientCredentialsGrant | null {
  if (configuration.auth.mode !== "client_credentials") return null;
  return {
    allowPrivateNetwork: configuration.source.allowPrivateNetwork === true,
    authMethod: configuration.auth.authMethod,
    clientId: configuration.auth.clientId,
    clientSecret,
    resource: configuration.auth.resource ?? configuration.source.url,
    scopes: configuration.auth.scopes,
    tokenEndpoint: configuration.auth.tokenEndpoint
  };
}

/** The token endpoint transport: https only, under the server's own address rules. */
export function mcpClientCredentialsFetch(grant: Pick<McpClientCredentialsGrant, "allowPrivateNetwork">): FetchLike {
  return createMcpSafeFetch(mcpDestinationSafeFetchOptions({
    allowInsecureHttp: false,
    allowPrivateNetwork: grant.allowPrivateNetwork,
    personal: false
  }, undefined));
}

// RFC 6749 §2.3.1: the client identifier and secret are form-encoded before
// they are joined for HTTP Basic authentication.
function formEncoded(value: string): string {
  return new URLSearchParams([["v", value]]).toString().slice(2);
}

function tokenLifetimeMs(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_TOKEN_LIFETIME_MS;
  const seconds = typeof value === "number" ? value
    : typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(MAX_TOKEN_LIFETIME_MS, seconds * 1_000);
}

/** One token request, uncached. Every failure is a `McpClientCredentialsError`. */
export async function requestMcpClientCredentialsToken(
  grant: McpClientCredentialsGrant,
  options: Readonly<{ fetch: FetchLike; now?: () => number; signal?: AbortSignal; timeoutMs?: number }>
): Promise<McpClientCredentialsToken> {
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (grant.scopes.length) body.set("scope", grant.scopes.join(" "));
  body.set("resource", grant.resource);
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded"
  });
  if (grant.authMethod === "client_secret_basic") {
    const credentials = `${formEncoded(grant.clientId)}:${formEncoded(grant.clientSecret)}`;
    headers.set("authorization", `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`);
  } else {
    body.set("client_id", grant.clientId);
    body.set("client_secret", grant.clientSecret);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const requestedAt = now();
  let response: Response;
  try {
    response = await options.fetch(grant.tokenEndpoint, { body, headers, method: "POST", redirect: "error", signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new McpClientCredentialsError(mcpNetworkPolicyRefusal(error) ?? "mcp_client_credentials_unreachable");
  }
  const refused = response.status === 400 || response.status === 401 || response.status === 403;
  if (!response.ok && !refused) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpClientCredentialsError(response.status === 408 || response.status === 429 || response.status >= 500
      ? "mcp_client_credentials_unreachable"
      : "mcp_client_credentials_invalid_response");
  }
  let text = "";
  try {
    text = await boundedOAuthResponse(response).text();
  } catch {
    options.signal?.throwIfAborted();
    if (!refused) throw new McpClientCredentialsError("mcp_client_credentials_invalid_response");
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Neither a token nor an OAuth error document; none of it is kept.
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (refused) {
    const code = typeof record?.error === "string" && OAUTH_ERROR_CODE.test(record.error) ? record.error : null;
    throw new McpClientCredentialsError("mcp_client_credentials_rejected", (code && REFUSAL_PATHS[code]) ?? "auth");
  }
  const accessToken = record?.access_token;
  const tokenType = record?.token_type;
  const lifetime = tokenLifetimeMs(record?.expires_in);
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    !ACCESS_TOKEN.test(accessToken) || typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer" ||
    lifetime === null) {
    throw new McpClientCredentialsError("mcp_client_credentials_invalid_response");
  }
  return {
    accessToken,
    expiresAt: requestedAt + lifetime,
    obtainedAt: requestedAt,
    // 60 s before expiry; a very short lifetime is renewed at half its length.
    renewAt: requestedAt + Math.max(lifetime - RENEWAL_LEAD_MS, lifetime / 2)
  };
}

type StoredSecret = Readonly<{ secret: string; tokenEndpointOrigin: string; updatedAt: string; version: 1 }>;

/** The sealed secret, bound to the token endpoint origin it was entered for. */
export function sealMcpClientCredentialsSecret(input: Readonly<{
  generation: number;
  key: Buffer;
  secret: string;
  serverId: string;
  tokenEndpoint: string;
  updatedAt: Date;
}>): string {
  const stored: StoredSecret = {
    secret: input.secret,
    tokenEndpointOrigin: new URL(input.tokenEndpoint).origin,
    updatedAt: input.updatedAt.toISOString(),
    version: 1
  };
  return encryptMcpEnvelope(stored, input.key, mcpClientCredentialsSecretEnvelopeContext(input.serverId, input.generation));
}

/** Opens a stored secret; an envelope that does not decode throws, like any stored MCP value. */
export function openMcpClientCredentialsSecret(input: Readonly<{
  envelope: string | null;
  generation: number;
  key: Buffer;
  serverId: string;
}>): StoredSecret | null {
  if (!input.envelope) return null;
  const decoded = decryptMcpEnvelope<unknown>(
    input.envelope,
    input.key,
    mcpClientCredentialsSecretEnvelopeContext(input.serverId, input.generation)
  );
  const record = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
  if (!record || record.version !== 1 || typeof record.secret !== "string" || !record.secret ||
    typeof record.tokenEndpointOrigin !== "string" || typeof record.updatedAt !== "string") {
    throw Object.assign(new Error("mcp_values_invalid"), { code: "mcp_values_invalid" });
  }
  return {
    secret: record.secret,
    tokenEndpointOrigin: record.tokenEndpointOrigin,
    updatedAt: record.updatedAt,
    version: 1
  };
}

/**
 * The stored secret only for a configuration whose token endpoint has the
 * origin it was entered for: a changed origin needs the secret entered again
 * before it is ever sent there.
 */
export function mcpClientCredentialsSecretFor(
  stored: StoredSecret | null,
  configuration: McpDraftConfiguration
): string | null {
  if (!stored || configuration.auth.mode !== "client_credentials") return null;
  return new URL(configuration.auth.tokenEndpoint).origin === stored.tokenEndpointOrigin ? stored.secret : null;
}

/** One cache entry per server, secret generation and grant, so a revision or rotation never shares a token. */
export function mcpClientCredentialsCacheKey(launch: McpClientCredentialsLaunch): string {
  return hashCanonicalMcpValue({
    allowPrivateNetwork: launch.grant.allowPrivateNetwork,
    authMethod: launch.grant.authMethod,
    clientId: launch.grant.clientId,
    resource: launch.grant.resource,
    scopes: [...launch.grant.scopes].sort(),
    secretGeneration: launch.secretGeneration,
    serverId: launch.serverId,
    tokenEndpoint: launch.grant.tokenEndpoint
  });
}

type CachedToken = McpClientCredentialsToken & { rejected: boolean };

type Failure = Readonly<{ code: McpClientCredentialsErrorCode; failures: number; path: string; retryAt: number }>;

/**
 * The process's client-credentials tokens. Only the app process runs the MCP
 * runtime coordinator, so every session of one server shares one entry and
 * one renewal at a time.
 */
export class McpClientCredentialsTokens {
  readonly #entries = new Map<string, CachedToken>();
  readonly #failures = new Map<string, Failure>();
  readonly #fetchForGrant: (grant: McpClientCredentialsGrant) => FetchLike;
  readonly #inflight = new Map<string, Promise<CachedToken>>();
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;

  constructor(input: Readonly<{
    fetchForGrant?: (grant: McpClientCredentialsGrant) => FetchLike;
    now?: () => number;
    requestTimeoutMs?: number;
  }> = {}) {
    this.#fetchForGrant = input.fetchForGrant ?? mcpClientCredentialsFetch;
    this.#now = input.now ?? Date.now;
    this.#requestTimeoutMs = input.requestTimeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  }

  /** The current token, renewed when due; concurrent callers share one request. */
  async accessToken(key: string, grant: McpClientCredentialsGrant): Promise<string> {
    const now = this.#now();
    const cached = this.#entries.get(key);
    if (cached && !cached.rejected && now < cached.renewAt) return cached.accessToken;
    const usable = cached && !cached.rejected && now < cached.expiresAt ? cached.accessToken : null;
    const failure = this.#failures.get(key);
    if (!this.#inflight.has(key) && failure && now < failure.retryAt) {
      if (usable) return usable;
      throw new McpClientCredentialsError(failure.code, failure.path);
    }
    try {
      return (await this.#renew(key, grant)).accessToken;
    } catch (error) {
      // Renewal starts before expiry: a failed one leaves the still-valid token in use.
      if (usable && error instanceof McpClientCredentialsError) return usable;
      throw error;
    }
  }

  /**
   * The MCP server answered 401 to a request that carried `accessToken`:
   * drop it so the next request signs in again. Another token than the
   * current one (a concurrent session already renewed) changes nothing.
   */
  rejected(key: string, accessToken: string): void {
    const entry = this.#entries.get(key);
    if (!entry || entry.accessToken !== accessToken) return;
    if (this.#now() - entry.obtainedAt < REJECTED_TOKEN_MIN_AGE_MS) return;
    entry.rejected = true;
  }

  #renew(key: string, grant: McpClientCredentialsGrant): Promise<CachedToken> {
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const promise = requestMcpClientCredentialsToken(grant, {
      fetch: this.#fetchForGrant(grant),
      now: this.#now,
      timeoutMs: this.#requestTimeoutMs
    }).then((token) => {
      const entry: CachedToken = { ...token, rejected: false };
      this.#failures.delete(key);
      this.#store(key, entry);
      return entry;
    }, (error: unknown) => {
      if (error instanceof McpClientCredentialsError) this.#failed(key, error);
      throw error;
    }).finally(() => {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
    });
    this.#inflight.set(key, promise);
    return promise;
  }

  #store(key: string, entry: CachedToken): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size <= MAX_CACHED_TOKENS) return;
    const now = this.#now();
    for (const [candidate, value] of this.#entries) {
      if (value.expiresAt <= now) this.#entries.delete(candidate);
    }
    for (const candidate of this.#entries.keys()) {
      if (this.#entries.size <= MAX_CACHED_TOKENS) break;
      this.#entries.delete(candidate);
    }
  }

  #failed(key: string, error: McpClientCredentialsError): void {
    const failures = (this.#failures.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16));
    this.#failures.delete(key);
    this.#failures.set(key, { code: error.code, failures, path: error.path, retryAt: this.#now() + delay });
    for (const candidate of this.#failures.keys()) {
      if (this.#failures.size <= MAX_CACHED_TOKENS) break;
      this.#failures.delete(candidate);
    }
  }
}

export type McpClientCredentialsAuthProvider = AuthProvider & Readonly<{
  /** The client secret and the tokens this session sent, for result redaction. */
  exactKnownSecrets(): readonly string[];
  /** Wraps the session's transport so a 401 drops the token that request carried. */
  observeFetch(fetch: FetchLike): FetchLike;
}>;

function bearerToken(headers: HeadersInit | undefined): string | null {
  try {
    const value = new Headers(headers).get("authorization");
    const match = value ? /^Bearer\s+(\S+)$/iu.exec(value) : null;
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A runtime session's sign-in. The transport asks `token()` before every
 * request; after a 401 to initialize, tools/list or ping it awaits
 * `onUnauthorized()` (a renewal, since `observeFetch` dropped the rejected
 * token) and resends that request once. A tools/call answered 401 is never
 * resent (`lib/server/mcp/clientSession.ts`): its token is dropped, and only
 * the run's own rule may call again, for a read-only tool.
 */
export function createMcpClientCredentialsAuthProvider(input: Readonly<{
  launch: McpClientCredentialsLaunch;
  tokens: McpClientCredentialsTokens;
}>): McpClientCredentialsAuthProvider {
  const key = mcpClientCredentialsCacheKey(input.launch);
  const seen: string[] = [];
  const token = async () => {
    const value = await input.tokens.accessToken(key, input.launch.grant);
    if (!seen.includes(value)) {
      seen.push(value);
      if (seen.length > KNOWN_TOKEN_LIMIT) seen.shift();
    }
    return value;
  };
  return {
    token,
    async onUnauthorized() {
      await token();
    },
    exactKnownSecrets: () => [input.launch.grant.clientSecret, ...seen],
    observeFetch: (fetch) => async (url, init) => {
      const response = await fetch(url, init);
      if (response.status === 401) {
        const sent = bearerToken(init?.headers);
        if (sent) input.tokens.rejected(key, sent);
      }
      return response;
    }
  };
}
