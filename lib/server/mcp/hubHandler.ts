import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo
} from "@modelcontextprotocol/server";
import { isLoopbackHostname, resolveLoginRateLimitIdentity } from "@/lib/server/auth/clientIdentity";
import type { LoginRateLimiter } from "@/lib/server/auth/rateLimit";
import { hashToken } from "@/lib/server/auth/token";
import { getAuthConfig } from "@/lib/server/auth/config";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/server/http/requestBody";
import { defaultInboundMcpOAuthConfiguration, defaultInboundMcpOAuthService } from "@/lib/server/memoryMcp/oauth/default";
import { inboundMcpProtectedResourceMetadataUrl } from "@/lib/server/memoryMcp/oauth/resources";
import type { InboundMcpOAuthService } from "@/lib/server/memoryMcp/oauth/service";
import { defaultMcpHubRateLimiter, defaultMcpHubService } from "./defaultHub";
import { createMcpHubServer, MCP_HUB_REQUEST_DEADLINE_MS } from "./hubServer";
import { McpHubServiceError } from "./hubService";
import {
  isMcpHubEnabled,
  MCP_HUB_MAX_CONCURRENT_REQUESTS,
  MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL
} from "./hubConfiguration";

export const MCP_HUB_BODY_MAX_BYTES = 128 * 1_024;
const RESPONSE_GRACE_MS = 250;

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { headers: { "cache-control": "no-store", ...headers }, status });
}

function withDeadline(request: Request, deadlineMs: number): Readonly<{ abort(): void; clear(): void; request: Request }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, deadlineMs);
  return {
    abort,
    clear() { clearTimeout(timer); request.signal.removeEventListener("abort", abort); },
    request: new Request(request, { signal: controller.signal })
  };
}

function holdResponse(
  response: Response,
  bounded: ReturnType<typeof withDeadline>,
  release: () => void
): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  const signal = bounded.request.signal;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (finished) return false;
    finished = true;
    signal.removeEventListener("abort", abort);
    release();
    return true;
  };
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    if (finish()) controller.error(new DOMException("The request was aborted", "AbortError"));
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (finish()) controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      bounded.abort();
      return reader.cancel(reason).catch(() => undefined);
    }
  });
  return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
}

function allowedHostnames(resource: string): string[] {
  const hostname = new URL(resource).hostname;
  return isLoopbackHostname(hostname) ? [...new Set([...localhostAllowedHostnames(), hostname])] : [hostname];
}

export function createMcpHubHandler(input: Readonly<{
  bodyMaxBytes?: number;
  deadlineMs?: number;
  getConfig?: typeof getAuthConfig;
  isEnabled?: () => boolean;
  limiter?: LoginRateLimiter;
  issuer?: string;
  oauthService?: Pick<InboundMcpOAuthService, "resolveAccessToken">;
  service?: typeof defaultMcpHubService;
}> = {}) {
  const config = input.getConfig ?? getAuthConfig;
  const service = input.service ?? defaultMcpHubService;
  const oauthService = input.oauthService ?? defaultInboundMcpOAuthService;
  const issuer = input.issuer ?? defaultInboundMcpOAuthConfiguration.issuer;
  const deadlineMs = input.deadlineMs ?? MCP_HUB_REQUEST_DEADLINE_MS;
  const bodyMaxBytes = input.bodyMaxBytes ?? MCP_HUB_BODY_MAX_BYTES;
  const resource = new URL("/mcp/hub", issuer);
  const resourceMetadataUrl = inboundMcpProtectedResourceMetadataUrl(
    issuer,
    "/mcp/hub"
  );
  const limiter = input.limiter ?? defaultMcpHubRateLimiter;
  let activeRequests = 0;
  const activeByPrincipal = new Map<string, number>();
  const hosts = allowedHostnames(resource.toString());
  const authenticate = requireBearerAuth({
    resourceMetadataUrl,
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        const resolved = await oauthService.resolveAccessToken(token, resource.toString());
        if (!resolved || resolved.capability !== "mcp:hub") throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
        return {
          token,
          clientId: resolved.clientId,
          scopes: ["mcp:hub"],
          expiresAt: Math.floor(resolved.expiresAt.getTime() / 1_000),
          resource,
          extra: { grantId: resolved.grantId, userId: resolved.userId }
        };
      }
    }
  });
  const mcp = createMcpHandler((context) => {
    const userId = context.authInfo?.extra?.userId;
    if (typeof userId !== "string" || !userId) throw new Error("mcp_hub_principal_unavailable");
    const clientId = context.authInfo?.clientId;
    const grantId = context.authInfo?.extra?.grantId;
    const token = context.authInfo?.token;
    if (typeof clientId !== "string" || !clientId || typeof grantId !== "string" || !grantId || !token) {
      throw new Error("mcp_hub_principal_unavailable");
    }
    return createMcpHubServer({
      authority: {
        clientId,
        grantId,
        userId,
        async assertActive() {
          const current = await oauthService.resolveAccessToken(token, resource.toString());
          if (!current || current.capability !== "mcp:hub" || current.userId !== userId ||
            current.clientId !== clientId || current.grantId !== grantId) {
            throw new McpHubServiceError("authorization_required");
          }
        }
      },
      deadlineMs,
      service
    });
  }, { legacy: "stateless", responseMode: "json" });

  async function authorize(request: Request): Promise<AuthInfo | Response> {
    if (!(input.isEnabled ?? isMcpHubEnabled)()) return jsonError("mcp_hub_disabled", 503);
    const invalidHost = hostHeaderValidationResponse(request, hosts);
    if (invalidHost) return invalidHost;
    const invalidOrigin = originValidationResponse(request, hosts);
    if (invalidOrigin) return invalidOrigin;
    const authorization = request.headers.get("authorization");
    if (authorization && authorization.length > 512) return bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token"), { resourceMetadataUrl }
    );
    const identity = resolveLoginRateLimitIdentity(request, config());
    if (identity.status === "unavailable") return jsonError("temporarily_unavailable", 503);
    const caller = identity.status === "available" ? identity.key : "installation";
    const key = `inbound-mcp-hub:caller:${caller}`;
    const decision = await limiter.check(key);
    if (!decision.allowed) return jsonError("temporarily_unavailable", 429, { "retry-after": String(decision.retryAfterSeconds) });
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    const principal = hashToken(`${auth.extra?.userId}:${auth.clientId}`);
    const principalDecision = await limiter.check(`inbound-mcp-hub:principal:${principal}`);
    if (!principalDecision.allowed) return jsonError("temporarily_unavailable", 429, { "retry-after": String(principalDecision.retryAfterSeconds) });
    return auth;
  }

  async function POST(request: Request): Promise<Response> {
    const auth = await authorize(request);
    if (auth instanceof Response) return auth;
    const principal = hashToken(`${auth.extra?.userId}:${auth.clientId}`);
    const active = activeByPrincipal.get(principal) ?? 0;
    if (activeRequests >= MCP_HUB_MAX_CONCURRENT_REQUESTS ||
      active >= MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL) {
      return jsonError("temporarily_unavailable", 429, { "retry-after": "1" });
    }
    activeRequests += 1;
    activeByPrincipal.set(principal, active + 1);
    let bounded: ReturnType<typeof withDeadline> | undefined;
    let transferred = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      bounded?.clear();
      activeRequests -= 1;
      const remaining = activeByPrincipal.get(principal)! - 1;
      if (remaining) activeByPrincipal.set(principal, remaining);
      else activeByPrincipal.delete(principal);
    };
    try {
      bounded = withDeadline(request, deadlineMs + RESPONSE_GRACE_MS);
      if (!request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase().endsWith("json")) {
        return jsonError("unsupported_media_type", 415);
      }
      try {
        const bytes = await readBoundedRequestBody(bounded.request, { maxBytes: bodyMaxBytes });
        const parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        if (Array.isArray(parsedBody)) return jsonError("invalid_request", 400);
        // The legacy transport returns headers while its tool call is still running.
        const response = holdResponse(await mcp.fetch(bounded.request, { authInfo: auth, parsedBody }), bounded, release);
        transferred = true;
        return response;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return jsonError("request_body_too_large", 413);
        if (bounded.request.signal.aborted) return jsonError("temporarily_unavailable", 504);
        return jsonError("invalid_request", 400);
      }
    } finally {
      if (!transferred) release();
    }
  }
  return Object.freeze({
    async GET(request: Request) { const auth = await authorize(request); return auth instanceof Response ? auth : mcp.fetch(request, { authInfo: auth }); },
    POST
  });
}
