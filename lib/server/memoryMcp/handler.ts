import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  isJsonContentType,
  localhostAllowedHostnames,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo
} from "@modelcontextprotocol/server";
import type { AuthConfig } from "../auth/config";
import { isLoopbackHostname, resolveLoginRateLimitIdentity } from "../auth/clientIdentity";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimiter
} from "../auth/rateLimit";
import { hashToken } from "../auth/token";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError
} from "../http/requestBody";
import type { MemoryConsumerService } from "../memory/consumer/service";
import type { MemoryNativeFactSearchService } from
  "../memory/retrieval/nativeFactSearch";
import type { InboundMcpOAuthService } from "./oauth/service";
import {
  createMemoryMcpServer,
  MEMORY_MCP_REQUEST_DEADLINE_MS
} from "./server";

export const MEMORY_MCP_BODY_MAX_BYTES = 128 * 1_024;
export const MEMORY_MCP_AUTHORIZATION_MAX_LENGTH = 512;
const MEMORY_MCP_RESPONSE_GRACE_MS = 250;

type MemoryMcpHandlerDeps = Readonly<{
  bodyMaxBytes?: number;
  deadlineMs?: number;
  getConfig: () => AuthConfig;
  oauthService: InboundMcpOAuthService;
  rateLimiter?: LoginRateLimiter;
  searchService: MemoryNativeFactSearchService;
  service: MemoryConsumerService;
}>;

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, {
    headers: {
      "cache-control": "no-store",
      ...headers
    },
    status
  });
}

function allowedHostnames(resource: string): string[] {
  const hostname = new URL(resource).hostname;
  return isLoopbackHostname(hostname)
    ? Array.from(new Set([...localhostAllowedHostnames(), hostname]))
    : [hostname];
}

function rateLimitKey(
  request: Request,
  config: AuthConfig,
  authorization: string | null
): string | null {
  const identity = resolveLoginRateLimitIdentity(request, config);
  if (identity.status === "unavailable") return null;
  const caller = identity.status === "available" ? identity.key : "installation";
  const credential = authorization
    ? hashToken(authorization).slice(0, 32)
    : "anonymous";
  return `inbound-memory-mcp:${caller}:${credential}`;
}

function requestWithDeadline(request: Request, deadlineMs: number): Readonly<{
  clear: () => void;
  request: Request;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deadlineMs);
  return {
    clear() {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    },
    request: new Request(request, { signal: controller.signal })
  };
}

async function parseBody(request: Request, maxBytes: number): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonError("unsupported_media_type", 415);
  }
  try {
    const bytes = await readBoundedRequestBody(request, { maxBytes });
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (request.signal.aborted) throw error;
    return error instanceof RequestBodyTooLargeError
      ? jsonError("request_body_too_large", 413)
      : jsonError("invalid_request", 400);
  }
}

export function createMemoryMcpHandler(deps: MemoryMcpHandlerDeps) {
  const deadlineMs = deps.deadlineMs ?? MEMORY_MCP_REQUEST_DEADLINE_MS;
  const bodyMaxBytes = deps.bodyMaxBytes ?? MEMORY_MCP_BODY_MAX_BYTES;
  const fallbackLimiter = createFixedWindowLoginRateLimiter({
    maxAttempts: 120,
    windowMs: 60 * 1_000
  });
  const limiter = resolveLoginRateLimiter(deps.rateLimiter, fallbackLimiter);
  const resourceMetadataUrl = deps.oauthService.configuration.protectedResourceMetadataUrl;
  const resource = new URL(deps.oauthService.configuration.resource);
  const hosts = allowedHostnames(resource.toString());
  const authenticate = requireBearerAuth({
    resourceMetadataUrl,
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        const resolved = await deps.oauthService.resolveAccessToken(token);
        if (!resolved) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
        }
        return {
          token,
          clientId: resolved.clientId,
          scopes: [],
          expiresAt: Math.floor(resolved.expiresAt.getTime() / 1_000),
          resource,
          extra: {
            grantId: resolved.grantId,
            userId: resolved.userId
          }
        };
      }
    }
  });
  const mcp = createMcpHandler((context) => {
    const userId = context.authInfo?.extra?.userId;
    if (typeof userId !== "string" || !userId) {
      throw new Error("memory_mcp_principal_unavailable");
    }
    return createMemoryMcpServer({
      deadlineMs,
      searchService: deps.searchService,
      service: deps.service,
      userId
    });
  }, {
    legacy: "stateless",
    responseMode: "json"
  });

  async function authorize(request: Request): Promise<AuthInfo | Response> {
    const invalidHost = hostHeaderValidationResponse(request, hosts);
    if (invalidHost) return invalidHost;
    const invalidOrigin = originValidationResponse(request, hosts);
    if (invalidOrigin) return invalidOrigin;

    const authorization = request.headers.get("authorization");
    if (authorization && authorization.length > MEMORY_MCP_AUTHORIZATION_MAX_LENGTH) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token"),
        { resourceMetadataUrl }
      );
    }

    const config = deps.getConfig();
    const key = rateLimitKey(request, config, authorization);
    if (!key) return jsonError("temporarily_unavailable", 503);
    const admitted = await limiter.check(key);
    if (!admitted.allowed) {
      return jsonError("temporarily_unavailable", 429, {
        "retry-after": String(admitted.retryAfterSeconds)
      });
    }

    return authenticate(request);
  }

  return Object.freeze({
    async GET(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    },

    async POST(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;

      const bounded = requestWithDeadline(
        request,
        deadlineMs + MEMORY_MCP_RESPONSE_GRACE_MS
      );
      try {
        const body = await parseBody(bounded.request, bodyMaxBytes);
        if (body instanceof Response) return body;
        return await mcp.fetch(bounded.request, {
          authInfo: auth,
          parsedBody: body
        });
      } catch {
        return jsonError("temporarily_unavailable", 504);
      } finally {
        bounded.clear();
      }
    }
  });
}
