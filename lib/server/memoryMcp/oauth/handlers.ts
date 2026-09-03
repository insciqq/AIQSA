import type { AuthConfig } from "../../auth/config";
import { resolveLoginRateLimitIdentity } from "../../auth/clientIdentity";
import { isAllowedMutationOrigin } from "../../auth/csrf";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimiter
} from "../../auth/rateLimit";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { hashToken } from "../../auth/token";
import {
  readBoundedRequestBody,
  readJsonBodyOrNull,
  RequestBodyTooLargeError
} from "../../http/requestBody";
import {
  decodeAuthorizationRequest,
  decodeRevocationRequest,
  decodeTokenRequest,
  type InboundMcpAuthorizationRequest
} from "./contracts";
import {
  InboundMcpOAuthError,
  type InboundMcpOAuthService
} from "./service";

const OAUTH_FORM_MAX_BYTES = 32 * 1_024;
const authorizationFormNames = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "consent_token",
  "decision",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state"
]);
const authorizationRequestNames = [
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state"
] as const;

type OAuthHandlerDeps = Readonly<{
  getConfig: () => AuthConfig;
  rateLimiter?: LoginRateLimiter;
  service: InboundMcpOAuthService;
}>;

type AuthorizationHandlerDeps = OAuthHandlerDeps & Readonly<{
  resolveAuth: RequestAuthResolver;
}>;

function oauthJson(
  body: Readonly<Record<string, unknown>>,
  status = 200,
  headers?: HeadersInit
): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      ...headers
    },
    status
  });
}

function oauthError(error: string, status = 400, headers?: HeadersInit): Response {
  return oauthJson({ error }, status, headers);
}

function isFormContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded";
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!isFormContentType(request.headers.get("content-type"))) return null;
  try {
    const body = await readBoundedRequestBody(request, { maxBytes: OAUTH_FORM_MAX_BYTES });
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof RequestBodyTooLargeError) return null;
    return null;
  }
}

function rateLimitKey(input: Readonly<{
  config: AuthConfig;
  credential?: string;
  prefix: string;
  request: Request;
}>): string | null {
  const identity = resolveLoginRateLimitIdentity(input.request, input.config);
  if (identity.status === "unavailable") return null;
  const client = identity.status === "available" ? identity.key : "installation";
  const credential = input.credential
    ? `:${hashToken(input.credential).slice(0, 32)}`
    : "";
  return `${input.prefix}:${client}${credential}`;
}

async function admitted(input: Readonly<{
  config: AuthConfig;
  credential?: string;
  limiter: LoginRateLimiter;
  prefix: string;
  request: Request;
}>): Promise<Response | null> {
  const key = rateLimitKey(input);
  if (!key) return oauthError("temporarily_unavailable", 503);
  const decision = await input.limiter.check(key);
  return decision.allowed
    ? null
    : oauthError("temporarily_unavailable", 429, {
        "retry-after": String(decision.retryAfterSeconds)
      });
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "'": "&#39;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  })[character] ?? character);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`;
}

function authorizationFields(
  request: InboundMcpAuthorizationRequest,
  consentToken: string
): string {
  return [
    hidden("response_type", "code"),
    hidden("client_id", request.clientId),
    hidden("redirect_uri", request.redirectUri),
    hidden("code_challenge", request.codeChallenge),
    hidden("code_challenge_method", "S256"),
    hidden("resource", request.resource),
    ...(request.state === null ? [] : [hidden("state", request.state)]),
    hidden("consent_token", consentToken)
  ].join("");
}

function authorizationPage(input: Readonly<{
  clientName: string;
  clientOrigin: string;
  consentToken: string;
  installation: string;
  request: InboundMcpAuthorizationRequest;
}>): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Personal Memory · AIQSA</title>
<style>body{margin:0;background:#0c1018;color:#eef2ff;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;margin:8vh auto;padding:2rem;border:1px solid #30394b;border-radius:1rem;background:#151b27}h1{margin-top:0;font-size:1.6rem}p,li{color:#c7cfdf}.client{padding:1rem;border-radius:.75rem;background:#0e1420}.origin{font-family:ui-monospace,monospace;font-size:.85rem;overflow-wrap:anywhere}form{display:flex;gap:.75rem;margin-top:1.5rem}button{border:0;border-radius:.65rem;padding:.75rem 1.1rem;font:inherit;cursor:pointer}.approve{background:#8fb4ff;color:#08111f}.cancel{background:#2a3344;color:#eef2ff}</style></head>
<body><main><p>AIQSA · ${htmlEscape(input.installation)}</p><h1>Connect Personal Memory?</h1>
<div class="client"><strong>${htmlEscape(input.clientName)}</strong><div class="origin">${htmlEscape(input.clientOrigin)}</div></div>
<p>Callback host: <span class="origin">${htmlEscape(new URL(input.request.redirectUri).hostname)}</span></p>
<p>This app can read, add, change, and delete your Personal Memory facts.</p>
<ul><li>Chat history is not available through this connection.</li><li>The app decides when to call Memory tools; AIQSA does not answer on its behalf.</li><li>You can revoke access later in Connected Apps. Your facts will remain.</li></ul>
<form method="post" action="/oauth/authorize">${authorizationFields(input.request, input.consentToken)}
<button class="approve" type="submit" name="decision" value="approve">Approve</button>
<button class="cancel" type="submit" name="decision" value="cancel">Cancel</button></form></main></body></html>`;
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      pragma: "no-cache",
      "referrer-policy": "no-referrer"
    }
  });
}

function authorizationErrorPage(status = 400): Response {
  return new Response(
    "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Authorization failed · AIQSA</title><body><main><h1>Authorization could not be completed</h1><p>Return to your MCP client and try connecting again.</p></main></body></html>",
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer"
      },
      status
    }
  );
}

function authorizationRedirect(input: Readonly<{
  code?: string;
  error?: "access_denied";
  issuer: string;
  request: InboundMcpAuthorizationRequest;
}>): Response {
  const location = new URL(input.request.redirectUri);
  if (input.code) location.searchParams.append("code", input.code);
  if (input.error) location.searchParams.append("error", input.error);
  if (input.request.state !== null) location.searchParams.append("state", input.request.state);
  location.searchParams.append("iss", input.issuer);
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location: location.toString(),
      pragma: "no-cache",
      "referrer-policy": "no-referrer"
    },
    status: 303
  });
}

function authorizationForm(
  form: URLSearchParams
): Readonly<{
  consentToken: string;
  decision: "approve" | "cancel";
  request: InboundMcpAuthorizationRequest;
}> | null {
  for (const key of form.keys()) {
    if (!authorizationFormNames.has(key) || form.getAll(key).length !== 1) return null;
  }
  const decision = form.get("decision");
  const consentToken = form.get("consent_token");
  if ((decision !== "approve" && decision !== "cancel") || !consentToken ||
    consentToken.length > 128) return null;
  const requestParameters = new URLSearchParams();
  for (const name of authorizationRequestNames) {
    const value = form.get(name);
    if (value !== null) requestParameters.set(name, value);
  }
  const decoded = decodeAuthorizationRequest(requestParameters);
  return decoded.ok ? { consentToken, decision, request: decoded.value } : null;
}

export function createInboundMcpAuthorizationHandlers(deps: AuthorizationHandlerDeps) {
  const fallback = createFixedWindowLoginRateLimiter({ maxAttempts: 30 });
  const limiter = resolveLoginRateLimiter(deps.rateLimiter, fallback);
  return Object.freeze({
    async GET(request: Request): Promise<Response> {
      const auth = await deps.resolveAuth(request);
      if (!auth) return authorizationErrorPage(401);
      const decoded = decodeAuthorizationRequest(new URL(request.url).searchParams);
      if (!decoded.ok) return authorizationErrorPage();
      const config = deps.getConfig();
      const limited = await admitted({
        config,
        credential: `${auth.userId}:${decoded.value.clientId}`,
        limiter,
        prefix: "inbound-mcp-authorize",
        request
      });
      if (limited) return limited;
      try {
        const view = await deps.service.prepareAuthorization({
          request: decoded.value,
          sessionId: auth.id,
          signal: request.signal,
          userId: auth.userId
        });
        return authorizationPage({
          ...view,
          installation: deps.service.configuration.issuer,
          request: decoded.value
        });
      } catch {
        return authorizationErrorPage();
      }
    },

    async POST(request: Request): Promise<Response> {
      const config = deps.getConfig();
      if (!isAllowedMutationOrigin({
        appBaseUrl: config.appBaseUrl,
        origin: request.headers.get("origin"),
        requestOrigin: new URL(request.url).origin,
        secFetchSite: request.headers.get("sec-fetch-site")
      })) return authorizationErrorPage(403);
      const auth = await deps.resolveAuth(request);
      if (!auth) return authorizationErrorPage(401);
      const form = await readForm(request);
      const decoded = form ? authorizationForm(form) : null;
      if (!decoded) return authorizationErrorPage();
      const limited = await admitted({
        config,
        credential: `${auth.userId}:${decoded.request.clientId}`,
        limiter,
        prefix: "inbound-mcp-authorize",
        request
      });
      if (limited) return limited;
      try {
        if (decoded.decision === "cancel") {
          await deps.service.denyAuthorization({
            consentToken: decoded.consentToken,
            request: decoded.request,
            sessionId: auth.id,
            signal: request.signal,
            userId: auth.userId
          });
          return authorizationRedirect({
            error: "access_denied",
            issuer: deps.service.configuration.issuer,
            request: decoded.request
          });
        }
        const code = await deps.service.approveAuthorization({
          consentToken: decoded.consentToken,
          request: decoded.request,
          sessionId: auth.id,
          signal: request.signal,
          userId: auth.userId
        });
        return authorizationRedirect({
          code,
          issuer: deps.service.configuration.issuer,
          request: decoded.request
        });
      } catch (error) {
        if (error instanceof InboundMcpOAuthError && error.code === "access_denied") {
          return authorizationRedirect({
            error: "access_denied",
            issuer: deps.service.configuration.issuer,
            request: decoded.request
          });
        }
        return authorizationErrorPage();
      }
    }
  });
}

export function createInboundMcpRegistrationHandler(deps: OAuthHandlerDeps) {
  const fallback = createFixedWindowLoginRateLimiter({ maxAttempts: 20, windowMs: 60 * 60 * 1_000 });
  const limiter = resolveLoginRateLimiter(deps.rateLimiter, fallback);
  return async function POST(request: Request): Promise<Response> {
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return oauthError("invalid_client_metadata");
    }
    const config = deps.getConfig();
    const limited = await admitted({
      config,
      limiter,
      prefix: "inbound-mcp-register",
      request
    });
    if (limited) return limited;
    const value = await readJsonBodyOrNull(request, "auth");
    if (!value || value instanceof RequestBodyTooLargeError) {
      return oauthError("invalid_client_metadata");
    }
    try {
      return oauthJson(await deps.service.registerClient(value), 201);
    } catch {
      return oauthError("invalid_client_metadata");
    }
  };
}

export function createInboundMcpTokenHandler(deps: OAuthHandlerDeps) {
  const fallback = createFixedWindowLoginRateLimiter({ maxAttempts: 30 });
  const limiter = resolveLoginRateLimiter(deps.rateLimiter, fallback);
  return async function POST(request: Request): Promise<Response> {
    if (request.headers.has("authorization")) return oauthError("invalid_client", 401);
    const form = await readForm(request);
    const decoded = form ? decodeTokenRequest(form) : { error: "invalid_request", ok: false } as const;
    if (!decoded.ok) return oauthError(decoded.error);
    const config = deps.getConfig();
    const credential = decoded.value.grantType === "authorization_code"
      ? decoded.value.code
      : decoded.value.refreshToken;
    const limited = await admitted({
      config,
      credential,
      limiter,
      prefix: decoded.value.grantType === "authorization_code"
        ? "inbound-mcp-token-code"
        : "inbound-mcp-token-refresh",
      request
    });
    if (limited) return limited;
    try {
      return oauthJson(await deps.service.token(decoded.value));
    } catch (error) {
      if (error instanceof InboundMcpOAuthError) {
        return oauthError(error.code, error.code === "server_error" ? 503 : 400);
      }
      return oauthError("server_error", 503);
    }
  };
}

export function createInboundMcpRevocationHandler(deps: OAuthHandlerDeps) {
  const fallback = createFixedWindowLoginRateLimiter({ maxAttempts: 30 });
  const limiter = resolveLoginRateLimiter(deps.rateLimiter, fallback);
  return async function POST(request: Request): Promise<Response> {
    if (request.headers.has("authorization")) return oauthError("invalid_client", 401);
    const form = await readForm(request);
    const decoded = form ? decodeRevocationRequest(form) : { error: "invalid_request", ok: false } as const;
    if (!decoded.ok) return oauthError(decoded.error);
    const config = deps.getConfig();
    const limited = await admitted({
      config,
      credential: decoded.value.token,
      limiter,
      prefix: "inbound-mcp-revoke",
      request
    });
    if (limited) return limited;
    try {
      await deps.service.revokeToken(decoded.value.clientId, decoded.value.token);
      return new Response(null, {
        headers: { "cache-control": "no-store", pragma: "no-cache" },
        status: 200
      });
    } catch {
      return oauthError("server_error", 503);
    }
  };
}
