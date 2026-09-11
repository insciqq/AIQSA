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
import { createFixedWindowLoginRateLimiter, resolveLoginRateLimiter, type LoginRateLimiter } from "@/lib/server/auth/rateLimit";
import { hashToken } from "@/lib/server/auth/token";
import { getAuthConfig } from "@/lib/server/auth/config";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/server/http/requestBody";
import { defaultInboundMcpOAuthConfiguration, defaultInboundMcpOAuthService } from "@/lib/server/memoryMcp/oauth/default";
import { inboundMcpProtectedResourceMetadataUrl } from "@/lib/server/memoryMcp/oauth/resources";
import { defaultMcpHubService } from "./defaultHub";
import { createMcpHubServer, MCP_HUB_REQUEST_DEADLINE_MS } from "./hubServer";

export const MCP_HUB_BODY_MAX_BYTES = 128 * 1_024;
const RESPONSE_GRACE_MS = 250;

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { headers: { "cache-control": "no-store", ...headers }, status });
}

function withDeadline(request: Request, deadlineMs: number): Readonly<{ clear(): void; request: Request }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deadlineMs);
  return {
    clear() { clearTimeout(timer); request.signal.removeEventListener("abort", abort); },
    request: new Request(request, { signal: controller.signal })
  };
}

function allowedHostnames(resource: string): string[] {
  const hostname = new URL(resource).hostname;
  return isLoopbackHostname(hostname) ? [...new Set([...localhostAllowedHostnames(), hostname])] : [hostname];
}

export function createMcpHubHandler(input: Readonly<{
  bodyMaxBytes?: number;
  deadlineMs?: number;
  getConfig?: typeof getAuthConfig;
  limiter?: LoginRateLimiter;
  service?: typeof defaultMcpHubService;
}> = {}) {
  const config = input.getConfig ?? getAuthConfig;
  const service = input.service ?? defaultMcpHubService;
  const deadlineMs = input.deadlineMs ?? MCP_HUB_REQUEST_DEADLINE_MS;
  const bodyMaxBytes = input.bodyMaxBytes ?? MCP_HUB_BODY_MAX_BYTES;
  const resource = new URL(`${defaultInboundMcpOAuthConfiguration.issuer}/mcp/hub`);
  const resourceMetadataUrl = inboundMcpProtectedResourceMetadataUrl(
    defaultInboundMcpOAuthConfiguration.issuer,
    "/mcp/hub"
  );
  const limiter = resolveLoginRateLimiter(input.limiter, createFixedWindowLoginRateLimiter({ maxAttempts: 120, windowMs: 60_000 }));
  const hosts = allowedHostnames(resource.toString());
  const authenticate = requireBearerAuth({
    resourceMetadataUrl,
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        const resolved = await defaultInboundMcpOAuthService.resolveAccessToken(token, resource.toString());
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
    return createMcpHubServer({ deadlineMs, service, userId });
  }, { legacy: "stateless", responseMode: "json" });

  async function authorize(request: Request): Promise<AuthInfo | Response> {
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
    const key = `inbound-mcp-hub:${caller}:${authorization ? hashToken(authorization).slice(0, 32) : "anonymous"}`;
    const decision = await limiter.check(key);
    if (!decision.allowed) return jsonError("temporarily_unavailable", 429, { "retry-after": String(decision.retryAfterSeconds) });
    return authenticate(request);
  }

  async function POST(request: Request): Promise<Response> {
    const auth = await authorize(request);
    if (auth instanceof Response) return auth;
    const bounded = withDeadline(request, deadlineMs + RESPONSE_GRACE_MS);
    try {
      if (!request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase().endsWith("json")) {
        return jsonError("unsupported_media_type", 415);
      }
      try {
        const bytes = await readBoundedRequestBody(bounded.request, { maxBytes: bodyMaxBytes });
        const parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        return await mcp.fetch(bounded.request, { authInfo: auth, parsedBody });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return jsonError("request_body_too_large", 413);
        if (bounded.request.signal.aborted) return jsonError("temporarily_unavailable", 504);
        return jsonError("invalid_request", 400);
      }
    } finally { bounded.clear(); }
  }
  return Object.freeze({
    async GET(request: Request) { const auth = await authorize(request); return auth instanceof Response ? auth : mcp.fetch(request, { authInfo: auth }); },
    POST
  });
}
