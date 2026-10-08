import { randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import {
  isMultiTenantOidcIssuer,
  type AuthSignInMethodConfig,
  type AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";
import {
  extractOidcGroups,
  hasOidcClaimOverage,
  oidcDisplayName,
  oidcEmail,
  oidcEmailVerified,
  type OidcClaims
} from "./oidcClaims";
import {
  boundedOidcFetch,
  OIDC_JWKS_MAX_BYTES,
  OIDC_REQUEST_TIMEOUT_MS,
  oidcSafeFetch,
  readOidcJson
} from "./oidcFetch";

type OidcConfig = AuthSignInMethodConfig<"oidc">;
type OidcSecrets = AuthSignInMethodSecrets<"oidc">;

/** Asymmetric algorithms only: never `none`, never HS* (a client secret is not a signing key). */
export const OIDC_ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"] as const;
export const OIDC_CLOCK_TOLERANCE_SECONDS = 60;
const DISCOVERY_TTL_MS = 15 * 60 * 1000;
const ID_TOKEN_MAX_LENGTH = 32 * 1024;
const SUBJECT_MAX_LENGTH = 255;

/**
 * Content-free failure codes. Tester verdicts, sign-in health and logs carry these, never a
 * provider response, token, code or claim.
 */
export type OidcFailureCode =
  | "client_auth_unsupported"
  | "client_rejected"
  | "discovery_invalid"
  | "discovery_unreachable"
  | "id_token_alg_unsupported"
  | "id_token_invalid"
  | "issuer_mismatch"
  | "jwks_invalid"
  | "jwks_unreachable"
  | "multi_tenant_issuer"
  | "pkce_unsupported"
  | "response_type_unsupported"
  | "token_endpoint_unreachable"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "userinfo_subject_mismatch"
  | "userinfo_unsupported";

export class OidcError extends Error {
  constructor(readonly code: OidcFailureCode) {
    super(code);
    this.name = "OidcError";
  }
}

export type OidcProviderMetadata = {
  authorizationEndpoint: string;
  endSessionEndpoint: string | null;
  issuer: string;
  jwksUri: string;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post";
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
};

/** What a validated sign-in asserts, ready for settlement. */
export type OidcSignInClaims = {
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  groups: readonly string[] | null;
  subject: string;
};

export type OidcClient = {
  authorizationUrl(input: {
    codeChallenge: string;
    config: OidcConfig;
    nonce: string;
    redirectUri: string;
    state: string;
  }): Promise<URL>;
  /** The IdP logout target for `idpLogout`, or null when the IdP has none. Never throws. */
  endSessionUrl(input: { config: OidcConfig; postLogoutRedirectUri: string }): Promise<string | null>;
  /** Exchanges the code and validates everything the sign-in asserts; throws `OidcError`. */
  signIn(input: {
    code: string;
    codeVerifier: string;
    config: OidcConfig;
    nonce: string;
    now: Date;
    redirectUri: string;
    secrets: OidcSecrets;
  }): Promise<OidcSignInClaims>;
  /** The admin tester: discovery, issuer, keys, PKCE and client authentication. */
  test(input: {
    appBaseUrl: string;
    config: OidcConfig;
    secrets: OidcSecrets;
    signal: AbortSignal;
  }): Promise<{ code: string; passed: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;
}

function endpoint(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new OidcError("discovery_invalid");
    return null;
  }
  if (typeof value !== "string" || value.length > 2_048) throw new OidcError("discovery_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError("discovery_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new OidcError("discovery_invalid");
  }
  return url.toString();
}

/** `<issuer>/.well-known/openid-configuration`, per OpenID Connect Discovery 1.0 §4. */
export function oidcDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
}

/** Validates a discovery document against the configured issuer. */
export function parseOidcMetadata(issuer: string, document: unknown): OidcProviderMetadata {
  if (!isRecord(document)) throw new OidcError("discovery_invalid");
  if (document.issuer !== issuer) throw new OidcError("issuer_mismatch");
  const responseTypes = stringList(document.response_types_supported);
  if (responseTypes && !responseTypes.includes("code")) {
    throw new OidcError("response_type_unsupported");
  }
  const challengeMethods = stringList(document.code_challenge_methods_supported);
  if (challengeMethods && !challengeMethods.includes("S256")) throw new OidcError("pkce_unsupported");
  const signingAlgorithms = stringList(document.id_token_signing_alg_values_supported);
  if (signingAlgorithms && !signingAlgorithms.some((alg) => (OIDC_ID_TOKEN_ALGORITHMS as readonly string[]).includes(alg))) {
    throw new OidcError("id_token_alg_unsupported");
  }
  // Absent means `client_secret_basic` (RFC 8414 §2).
  const authMethods = stringList(document.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"];
  const tokenAuthMethod = authMethods.includes("client_secret_basic")
    ? "client_secret_basic"
    : authMethods.includes("client_secret_post") ? "client_secret_post" : null;
  if (!tokenAuthMethod) throw new OidcError("client_auth_unsupported");

  return {
    authorizationEndpoint: endpoint(document.authorization_endpoint, true)!,
    endSessionEndpoint: endpoint(document.end_session_endpoint, false),
    issuer,
    jwksUri: endpoint(document.jwks_uri, true)!,
    tokenAuthMethod,
    tokenEndpoint: endpoint(document.token_endpoint, true)!,
    userinfoEndpoint: endpoint(document.userinfo_endpoint, false)
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** `application/x-www-form-urlencoded` encoding for HTTP Basic client credentials (RFC 6749 §2.3.1). */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/gu, "+");
}

function tokenRequest(input: {
  body: Record<string, string>;
  clientId: string;
  clientSecret: string;
  metadata: OidcProviderMetadata;
  signal: AbortSignal;
}): RequestInit & { signal: AbortSignal } {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded"
  });
  const body = new URLSearchParams(input.body);
  if (input.metadata.tokenAuthMethod === "client_secret_basic") {
    const credentials = `${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`;
    headers.set("authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
  } else {
    body.set("client_id", input.clientId);
    body.set("client_secret", input.clientSecret);
  }
  return { body, headers, method: "POST", signal: input.signal };
}

function audienceList(payload: JWTPayload): string[] {
  return typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
}

export function createOidcClient(input: { fetchImpl?: typeof fetch; now?: () => number } = {}): OidcClient {
  const fetchImpl = input.fetchImpl ?? oidcSafeFetch;
  const clock = input.now ?? Date.now;
  const discovery = new Map<string, { expiresAt: number; metadata: Promise<OidcProviderMetadata> }>();
  const keySets = new Map<string, JWTVerifyGetKey>();
  const jwksFetch = boundedOidcFetch(fetchImpl, OIDC_JWKS_MAX_BYTES);

  async function fetchJson(
    url: string,
    init: RequestInit & { signal: AbortSignal },
    failure: OidcFailureCode,
    maxBytes?: number
  ) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new OidcError(failure);
    }
    let body: unknown;
    try {
      body = await readOidcJson(response, { maxBytes, signal: init.signal });
    } catch {
      throw new OidcError(failure);
    }
    return { body, status: response.status };
  }

  async function loadMetadata(issuer: string, signal?: AbortSignal): Promise<OidcProviderMetadata> {
    if (isMultiTenantOidcIssuer(issuer)) throw new OidcError("multi_tenant_issuer");
    const { body, status } = await fetchJson(
      oidcDiscoveryUrl(issuer),
      { headers: { accept: "application/json" }, method: "GET", signal: requestSignal(signal) },
      "discovery_unreachable"
    );
    if (status !== 200) throw new OidcError("discovery_unreachable");
    return parseOidcMetadata(issuer, body);
  }

  /** Cached per issuer for the process; a failure is never cached. */
  function metadata(issuer: string): Promise<OidcProviderMetadata> {
    const cached = discovery.get(issuer);
    if (cached && cached.expiresAt > clock()) return cached.metadata;
    const loading = loadMetadata(issuer);
    discovery.set(issuer, { expiresAt: clock() + DISCOVERY_TTL_MS, metadata: loading });
    loading.catch(() => {
      if (discovery.get(issuer)?.metadata === loading) discovery.delete(issuer);
    });
    return loading;
  }

  /** jose refetches the key set on an unknown key id (rotation), at most every 30 s. */
  function keySet(jwksUri: string): JWTVerifyGetKey {
    let keys = keySets.get(jwksUri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(jwksUri), {
        [customFetch]: jwksFetch,
        timeoutDuration: OIDC_REQUEST_TIMEOUT_MS
      });
      keySets.set(jwksUri, keys);
    }
    return keys;
  }

  async function verifyIdToken(
    idToken: string,
    context: { config: OidcConfig; metadata: OidcProviderMetadata; nonce: string; now: Date }
  ): Promise<JWTPayload> {
    const { payload } = await jwtVerify(idToken, keySet(context.metadata.jwksUri), {
      algorithms: [...OIDC_ID_TOKEN_ALGORITHMS],
      audience: context.config.clientId,
      clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
      currentDate: context.now,
      issuer: context.config.issuer,
      requiredClaims: ["exp", "iat", "sub"]
    });
    const audiences = audienceList(payload);
    const nowSeconds = Math.floor(context.now.getTime() / 1000);
    if (
      payload.nonce !== context.nonce ||
      (payload.azp !== undefined && payload.azp !== context.config.clientId) ||
      (audiences.length > 1 && payload.azp !== context.config.clientId) ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + OIDC_CLOCK_TOLERANCE_SECONDS ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > SUBJECT_MAX_LENGTH
    ) {
      throw new OidcError("id_token_invalid");
    }
    return payload;
  }

  async function validatedIdToken(
    idToken: string,
    context: { config: OidcConfig; metadata: OidcProviderMetadata; nonce: string; now: Date }
  ): Promise<JWTPayload> {
    try {
      return await verifyIdToken(idToken, context);
    } catch (error) {
      if (error instanceof OidcError) throw error;
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid || !(error instanceof joseErrors.JOSEError)) {
        throw new OidcError("jwks_unreachable");
      }
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw new OidcError("id_token_invalid");
    }
    // No cached key matched (jose refetches at most every 30 s): the IdP rotated its keys or
    // moved them, so discovery and the key set are read again and the token checked once more.
    // The token came from the IdP's token endpoint, so this refetch is not attacker-driven.
    discovery.delete(context.config.issuer);
    const current = await metadata(context.config.issuer);
    keySets.delete(current.jwksUri);
    try {
      return await verifyIdToken(idToken, { ...context, metadata: current });
    } catch (error) {
      throw error instanceof OidcError ? error : new OidcError("id_token_invalid");
    }
  }

  async function userinfo(metadata: OidcProviderMetadata, accessToken: string, subject: string): Promise<OidcClaims> {
    const { body, status } = await fetchJson(
      metadata.userinfoEndpoint!,
      {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        method: "GET",
        signal: requestSignal()
      },
      "userinfo_failed"
    );
    if (status !== 200 || !isRecord(body)) throw new OidcError("userinfo_failed");
    if (body.sub !== subject) throw new OidcError("userinfo_subject_mismatch");
    return body;
  }

  return {
    async authorizationUrl({ codeChallenge, config, nonce, redirectUri, state }) {
      const url = new URL((await metadata(config.issuer)).authorizationEndpoint);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scopes);
      url.searchParams.set("state", state);
      return url;
    },

    async endSessionUrl({ config, postLogoutRedirectUri }) {
      try {
        const endpointUrl = (await metadata(config.issuer)).endSessionEndpoint;
        if (!endpointUrl) return null;
        // No `id_token_hint`: the id token is never kept, so the IdP may ask to confirm.
        const url = new URL(endpointUrl);
        url.searchParams.set("client_id", config.clientId);
        url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
        return url.toString();
      } catch {
        return null;
      }
    },

    async signIn({ code, codeVerifier, config, nonce, now, redirectUri, secrets }) {
      const provider = await metadata(config.issuer);
      const { body, status } = await fetchJson(
        provider.tokenEndpoint,
        tokenRequest({
          body: { code, code_verifier: codeVerifier, grant_type: "authorization_code", redirect_uri: redirectUri },
          clientId: config.clientId,
          clientSecret: secrets.clientSecret,
          metadata: provider,
          signal: requestSignal()
        }),
        "token_exchange_failed"
      );
      if (status !== 200 || !isRecord(body) || typeof body.id_token !== "string" || !body.id_token || body.id_token.length > ID_TOKEN_MAX_LENGTH) {
        throw new OidcError("token_exchange_failed");
      }
      // Tokens stay in this scope: never stored, logged or returned.
      const accessToken = typeof body.access_token === "string" && body.access_token ? body.access_token : null;
      const idClaims = await validatedIdToken(body.id_token, { config, metadata: provider, nonce, now });
      const subject = idClaims.sub!;
      const idGroups = extractOidcGroups(idClaims, config.groupsClaimPath);
      const groupsFromUserinfo = config.groupsFrom === "userinfo" ||
        (config.groupsFrom === "id_token_then_userinfo" && idGroups === null && !hasOidcClaimOverage(idClaims, config.groupsClaimPath));
      const needsUserinfo = groupsFromUserinfo || oidcEmail(idClaims) === null;
      let userinfoClaims: OidcClaims | null = null;

      if (needsUserinfo && provider.userinfoEndpoint && accessToken) {
        userinfoClaims = await userinfo(provider, accessToken, subject);
      } else if (config.groupsFrom === "userinfo") {
        throw new OidcError("userinfo_unsupported");
      }

      const emailClaims = oidcEmail(idClaims) === null && userinfoClaims ? userinfoClaims : idClaims;
      const groups = config.groupsFrom === "id_token" || !groupsFromUserinfo
        ? idGroups
        : userinfoClaims ? extractOidcGroups(userinfoClaims, config.groupsClaimPath) : null;

      return {
        displayName: oidcDisplayName(idClaims) || (userinfoClaims ? oidcDisplayName(userinfoClaims) : ""),
        email: oidcEmail(emailClaims),
        emailVerified: oidcEmailVerified(emailClaims),
        groups,
        subject
      };
    },

    async test({ appBaseUrl, config, secrets, signal }) {
      try {
        const provider = await loadMetadata(config.issuer, signal);
        if (config.groupsFrom === "userinfo" && !provider.userinfoEndpoint) throw new OidcError("userinfo_unsupported");

        const jwks = await fetchJson(
          provider.jwksUri,
          { headers: { accept: "application/json" }, method: "GET", signal: requestSignal(signal) },
          "jwks_unreachable",
          OIDC_JWKS_MAX_BYTES
        );
        if (jwks.status !== 200) throw new OidcError("jwks_unreachable");
        const keys = isRecord(jwks.body) && Array.isArray(jwks.body.keys) ? jwks.body.keys : [];
        const usable = keys.some((key) =>
          isRecord(key) &&
          (key.kty === "RSA" || key.kty === "EC") &&
          key.use !== "enc" &&
          (key.alg === undefined || (OIDC_ID_TOKEN_ALGORITHMS as readonly string[]).includes(String(key.alg))));
        if (!usable) throw new OidcError("jwks_invalid");

        // An unknown code proves the client credentials without a sign-in: IdPs authenticate
        // the client first and answer `invalid_client` to a wrong secret.
        const probe = await fetchJson(
          provider.tokenEndpoint,
          tokenRequest({
            body: {
              code: randomBytes(24).toString("base64url"),
              code_verifier: randomBytes(32).toString("base64url"),
              grant_type: "authorization_code",
              redirect_uri: new URL("/api/auth/oauth/oidc/callback", appBaseUrl).toString()
            },
            clientId: config.clientId,
            clientSecret: secrets.clientSecret,
            metadata: provider,
            signal: requestSignal(signal)
          }),
          "token_endpoint_unreachable"
        );
        if (probe.status === 401 || (isRecord(probe.body) && probe.body.error === "invalid_client")) {
          throw new OidcError("client_rejected");
        }

        discovery.delete(config.issuer);
        return { code: "oidc_checked", passed: true };
      } catch (error) {
        return { code: error instanceof OidcError ? error.code : "test_failed", passed: false };
      }
    }
  };
}

const DEFAULT_CLIENT = Symbol.for("aiqsa.oidc-client.v1");
const slot = globalThis as typeof globalThis & { [DEFAULT_CLIENT]?: OidcClient };

/** The process-wide client, so every route bundle shares one discovery and key cache. */
export function defaultOidcClient(): OidcClient {
  return (slot[DEFAULT_CLIENT] ??= createOidcClient());
}
