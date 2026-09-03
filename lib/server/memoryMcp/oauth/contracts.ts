import { z } from "zod";
import { canonicalIp, isLoopbackHostname } from "../../auth/clientIdentity";

export const INBOUND_MCP_OAUTH_CLIENT_ID_MAX_LENGTH = 2_048;
export const INBOUND_MCP_OAUTH_CLIENT_NAME_MAX_LENGTH = 200;
export const INBOUND_MCP_OAUTH_REDIRECT_URI_MAX_LENGTH = 2_048;
export const INBOUND_MCP_OAUTH_REDIRECT_URI_MAX_COUNT = 10;
export const INBOUND_MCP_OAUTH_STATE_MAX_LENGTH = 1_024;
export const INBOUND_MCP_OAUTH_TOKEN_MAX_LENGTH = 512;

export type OAuthDecodeResult<T, E extends string> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ error: E; ok: false }>;

const boundedProtocolText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "control character");
const clientIdSchema = boundedProtocolText(INBOUND_MCP_OAUTH_CLIENT_ID_MAX_LENGTH);
const redirectUriSchema = boundedProtocolText(INBOUND_MCP_OAUTH_REDIRECT_URI_MAX_LENGTH);
const clientNameSchema = boundedProtocolText(INBOUND_MCP_OAUTH_CLIENT_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim(), "client name is not trimmed");
const stateSchema = z.string().max(INBOUND_MCP_OAUTH_STATE_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "control character");
const resourceSchema = boundedProtocolText(INBOUND_MCP_OAUTH_CLIENT_ID_MAX_LENGTH);
const codeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const codeVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u);
const opaqueTokenSchema = z.string().min(32).max(INBOUND_MCP_OAUTH_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);

const authorizationParameterNames = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state"
]);

export type InboundMcpAuthorizationRequest = Readonly<{
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  state: string | null;
}>;

export type InboundMcpAuthorizationRequestError =
  | "invalid_request"
  | "invalid_scope"
  | "unsupported_response_type";

function singleParameters(
  input: URLSearchParams,
  allowed: ReadonlySet<string>
): Record<string, string> | null {
  const output: Record<string, string> = {};
  for (const key of input.keys()) {
    if (!allowed.has(key) || input.getAll(key).length !== 1) return null;
    output[key] = input.get(key) ?? "";
  }
  return output;
}

export function decodeAuthorizationRequest(
  input: URLSearchParams
): OAuthDecodeResult<InboundMcpAuthorizationRequest, InboundMcpAuthorizationRequestError> {
  const values = singleParameters(input, authorizationParameterNames);
  if (!values) return { error: "invalid_request", ok: false };
  if ((values.scope ?? "") !== "") return { error: "invalid_scope", ok: false };
  if (values.response_type !== "code") {
    return { error: "unsupported_response_type", ok: false };
  }
  const decoded = z.strictObject({
    client_id: clientIdSchema,
    code_challenge: codeChallengeSchema,
    code_challenge_method: z.literal("S256"),
    redirect_uri: redirectUriSchema,
    resource: resourceSchema,
    response_type: z.literal("code"),
    scope: z.literal("").optional(),
    state: stateSchema.optional()
  }).safeParse(values);
  if (!decoded.success) return { error: "invalid_request", ok: false };
  return {
    ok: true,
    value: {
      clientId: decoded.data.client_id,
      codeChallenge: decoded.data.code_challenge,
      redirectUri: decoded.data.redirect_uri,
      resource: decoded.data.resource,
      state: decoded.data.state ?? null
    }
  };
}

const tokenParameterNames = new Set([
  "client_id",
  "code",
  "code_verifier",
  "grant_type",
  "redirect_uri",
  "refresh_token",
  "resource",
  "scope"
]);

export type InboundMcpTokenRequest =
  | Readonly<{
      clientId: string;
      code: string;
      codeVerifier: string;
      grantType: "authorization_code";
      redirectUri: string;
      resource: string;
    }>
  | Readonly<{
      clientId: string;
      grantType: "refresh_token";
      refreshToken: string;
      resource: string;
    }>;

export type InboundMcpTokenRequestError =
  | "invalid_request"
  | "invalid_scope"
  | "unsupported_grant_type";

export function decodeTokenRequest(
  input: URLSearchParams
): OAuthDecodeResult<InboundMcpTokenRequest, InboundMcpTokenRequestError> {
  const values = singleParameters(input, tokenParameterNames);
  if (!values) return { error: "invalid_request", ok: false };
  if ((values.scope ?? "") !== "") return { error: "invalid_scope", ok: false };
  if (values.grant_type !== "authorization_code" && values.grant_type !== "refresh_token") {
    return { error: "unsupported_grant_type", ok: false };
  }
  if (values.grant_type === "authorization_code") {
    const decoded = z.strictObject({
      client_id: clientIdSchema,
      code: opaqueTokenSchema,
      code_verifier: codeVerifierSchema,
      grant_type: z.literal("authorization_code"),
      redirect_uri: redirectUriSchema,
      resource: resourceSchema,
      scope: z.literal("").optional()
    }).safeParse(values);
    return decoded.success
      ? {
          ok: true,
          value: {
            clientId: decoded.data.client_id,
            code: decoded.data.code,
            codeVerifier: decoded.data.code_verifier,
            grantType: "authorization_code",
            redirectUri: decoded.data.redirect_uri,
            resource: decoded.data.resource
          }
        }
      : { error: "invalid_request", ok: false };
  }
  const decoded = z.strictObject({
    client_id: clientIdSchema,
    grant_type: z.literal("refresh_token"),
    refresh_token: opaqueTokenSchema,
    resource: resourceSchema,
    scope: z.literal("").optional()
  }).safeParse(values);
  return decoded.success
    ? {
        ok: true,
        value: {
          clientId: decoded.data.client_id,
          grantType: "refresh_token",
          refreshToken: decoded.data.refresh_token,
          resource: decoded.data.resource
        }
      }
    : { error: "invalid_request", ok: false };
}

const revocationParameterNames = new Set([
  "client_id",
  "token",
  "token_type_hint"
]);

export type InboundMcpRevocationRequest = Readonly<{
  clientId: string;
  token: string;
  tokenTypeHint: "access_token" | "refresh_token" | null;
}>;

export function decodeRevocationRequest(
  input: URLSearchParams
): OAuthDecodeResult<InboundMcpRevocationRequest, "invalid_request"> {
  const values = singleParameters(input, revocationParameterNames);
  if (!values) return { error: "invalid_request", ok: false };
  const decoded = z.strictObject({
    client_id: clientIdSchema,
    token: opaqueTokenSchema,
    token_type_hint: z.enum(["access_token", "refresh_token"]).optional()
  }).safeParse(values);
  return decoded.success
    ? {
        ok: true,
        value: {
          clientId: decoded.data.client_id,
          token: decoded.data.token,
          tokenTypeHint: decoded.data.token_type_hint ?? null
        }
      }
    : { error: "invalid_request", ok: false };
}

const redirectUrisSchema = z.array(redirectUriSchema)
  .min(1)
  .max(INBOUND_MCP_OAUTH_REDIRECT_URI_MAX_COUNT)
  .refine((values) => new Set(values).size === values.length, "duplicate redirect URI");
const grantTypesSchema = z.array(z.enum(["authorization_code", "refresh_token"]))
  .max(2)
  .refine((values) => new Set(values).size === values.length, "duplicate grant type")
  .refine((values) => values.includes("authorization_code"), "authorization code required");
const responseTypesSchema = z.array(z.literal("code"))
  .max(1)
  .refine((values) => values.length === 1, "code response required");

const baseClientMetadataSchema = z.object({
  application_type: z.enum(["native", "web"]).optional(),
  client_name: clientNameSchema,
  client_uri: boundedProtocolText(INBOUND_MCP_OAUTH_CLIENT_ID_MAX_LENGTH).optional(),
  grant_types: grantTypesSchema.optional(),
  redirect_uris: redirectUrisSchema,
  response_types: responseTypesSchema.optional(),
  scope: z.literal("").optional(),
  token_endpoint_auth_method: z.literal("none").optional()
});

export type InboundMcpClientMetadata = Readonly<{
  applicationType: "NATIVE" | "WEB";
  clientId: string;
  clientName: string;
  clientOrigin: string;
  clientUri: string | null;
  redirectUris: readonly string[];
}>;

function forbiddenCredentialMaterial(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return [
    "client_secret",
    "client_secret_expires_at",
    "jwks",
    "jwks_uri"
  ].some((key) => Object.hasOwn(input, key));
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasSafeUrlEnvelope(url: URL): boolean {
  return !url.username && !url.password && !url.hash;
}

export function validClientIdentifierUrl(
  value: string,
  allowLoopbackHttp: boolean
): boolean {
  const url = parsedUrl(value);
  if (!url || !hasSafeUrlEnvelope(url) || url.pathname === "/") return false;
  if (url.pathname.split("/").some((component) => component === "." || component === "..")) {
    return false;
  }
  if (url.protocol === "https:") return true;
  return allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

export function validRedirectUri(
  value: string,
  applicationType: "NATIVE" | "WEB"
): boolean {
  const url = parsedUrl(value);
  if (!url || !hasSafeUrlEnvelope(url)) return false;
  if (applicationType === "WEB") return url.protocol === "https:";
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) &&
    !new Set(["data:", "file:", "ftp:", "javascript:"]).has(url.protocol);
}

function loopbackIpLiteral(hostname: string): string | null {
  const canonical = canonicalIp(hostname.replace(/^\[|\]$/gu, ""));
  return canonical === "::1" || canonical?.startsWith("127.")
    ? canonical
    : null;
}

/** RFC 8252 permits a native loopback redirect to vary only its port. */
export function registeredRedirectUriMatches(input: Readonly<{
  applicationType: "NATIVE" | "WEB";
  presented: string;
  registered: string;
}>): boolean {
  if (input.presented === input.registered) return true;
  if (input.applicationType !== "NATIVE") return false;
  const presented = parsedUrl(input.presented);
  const registered = parsedUrl(input.registered);
  if (!presented || !registered || presented.protocol !== "http:" ||
    registered.protocol !== "http:" || !hasSafeUrlEnvelope(presented) ||
    !hasSafeUrlEnvelope(registered)) return false;
  const presentedHost = loopbackIpLiteral(presented.hostname);
  const registeredHost = loopbackIpLiteral(registered.hostname);
  return presentedHost !== null && presentedHost === registeredHost &&
    presented.pathname === registered.pathname &&
    presented.search === registered.search;
}

function validClientUri(value: string | undefined, allowLoopbackHttp: boolean): boolean {
  if (value === undefined) return true;
  const url = parsedUrl(value);
  if (!url || !hasSafeUrlEnvelope(url)) return false;
  return url.protocol === "https:" ||
    allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

function inferredApplicationType(redirectUris: readonly string[]): "NATIVE" | "WEB" {
  return redirectUris.some((value) => {
    const url = parsedUrl(value);
    return url?.protocol !== "https:" || isLoopbackHostname(url.hostname);
  }) ? "NATIVE" : "WEB";
}

function normalizedClientMetadata(input: Readonly<{
  allowLoopbackHttp: boolean;
  clientId: string;
  raw: unknown;
  requireApplicationType: boolean;
}>): InboundMcpClientMetadata | null {
  if (forbiddenCredentialMaterial(input.raw)) return null;
  const decoded = baseClientMetadataSchema.safeParse(input.raw);
  if (!decoded.success || input.requireApplicationType && !decoded.data.application_type) {
    return null;
  }
  const applicationType = decoded.data.application_type
    ? decoded.data.application_type === "native" ? "NATIVE" : "WEB"
    : inferredApplicationType(decoded.data.redirect_uris);
  if (!decoded.data.redirect_uris.every((uri) => validRedirectUri(uri, applicationType)) ||
    !validClientUri(decoded.data.client_uri, input.allowLoopbackHttp)) {
    return null;
  }
  const clientIdentifierUrl = parsedUrl(input.clientId);
  const originSource = clientIdentifierUrl &&
    (clientIdentifierUrl.protocol === "https:" || clientIdentifierUrl.protocol === "http:")
    ? input.clientId
    : decoded.data.client_uri ?? decoded.data.redirect_uris[0];
  const originUrl = parsedUrl(originSource);
  if (!originUrl) return null;
  return {
    applicationType,
    clientId: input.clientId,
    clientName: decoded.data.client_name,
    // Private-use native redirect URIs have an opaque URL origin. Expose only
    // their scheme as the stable client identity; callback paths and queries
    // are neither an origin nor useful Connected Apps metadata.
    clientOrigin: originUrl.origin === "null" ? originUrl.protocol : originUrl.origin,
    clientUri: decoded.data.client_uri ?? null,
    redirectUris: Object.freeze([...decoded.data.redirect_uris])
  };
}

export function decodeClientIdMetadataDocument(input: Readonly<{
  allowLoopbackHttp: boolean;
  clientId: string;
  value: unknown;
}>): InboundMcpClientMetadata | null {
  if (!validClientIdentifierUrl(input.clientId, input.allowLoopbackHttp) ||
    !input.value || typeof input.value !== "object" || Array.isArray(input.value) ||
    (input.value as Record<string, unknown>).client_id !== input.clientId) {
    return null;
  }
  return normalizedClientMetadata({
    allowLoopbackHttp: input.allowLoopbackHttp,
    clientId: input.clientId,
    raw: input.value,
    requireApplicationType: false
  });
}

export function decodeDynamicClientRegistration(input: Readonly<{
  allowLoopbackHttp: boolean;
  clientId: string;
  value: unknown;
}>): InboundMcpClientMetadata | null {
  return normalizedClientMetadata({
    allowLoopbackHttp: input.allowLoopbackHttp,
    clientId: input.clientId,
    raw: input.value,
    requireApplicationType: true
  });
}
