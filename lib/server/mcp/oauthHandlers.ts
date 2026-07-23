import { randomBytes } from "node:crypto";
import type { AuthConfig } from "@/lib/server/auth/config";
import type {
  AuthenticatedSession,
  RequestAuthResolver
} from "@/lib/server/auth/requestAuth";
import {
  clearMcpOAuthFlowCookie,
  exactMcpOAuthState,
  MCP_OAUTH_FLOW_MAX_AGE_SECONDS,
  mcpOAuthFlowCookie,
  readMcpOAuthFlow,
  signMcpOAuthFlow
} from "./oauthFlow";
import {
  McpOAuthError,
  type McpOAuthService
} from "./oauthService";
import type { McpOAuthPurpose } from "./oauthPolicy";
import type { McpOAuthSettler } from "./oauthSettlement";

type McpOAuthRouteContext = {
  params: Promise<{ serverId: string }> | { serverId: string };
};

type McpOAuthWebConfig = Pick<
  AuthConfig,
  "appBaseUrl" | "configured" | "cookieSecure" | "sessionSecret"
>;

export type McpOAuthHandlerDeps = Readonly<{
  getConfig(): McpOAuthWebConfig;
  onRuntimeChanged?(userId?: string): void;
  resolveAuth: RequestAuthResolver;
  settleAuthorization?: McpOAuthSettler;
  service: Pick<
    McpOAuthService,
    "completeAuthorization" | "disconnect" | "startAuthorization"
  >;
  now?: () => Date;
  randomState?: () => string;
}>;

function randomState(): string {
  return randomBytes(32).toString("base64url");
}

function validServerId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function singleValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 && values[0] ? values[0] : null;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "referrer-policy": "no-referrer" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { headers, status: 303 });
}

function callbackPath(serverId: string, purpose: McpOAuthPurpose): string {
  const encoded = encodeURIComponent(serverId);
  return purpose === "validation"
    ? `/api/admin/mcp/${encoded}/oauth/validation/callback`
    : `/api/me/mcp/${encoded}/oauth/callback`;
}

function outcomeUrl(input: Readonly<{
  appBaseUrl: string;
  outcome: "cancelled" | "connected" | "failed";
  purpose: McpOAuthPurpose;
  serverId: string;
}>): string {
  const url = new URL(input.purpose === "validation" ? "/admin" : "/", input.appBaseUrl);
  if (input.purpose === "validation") url.searchParams.set("section", "mcp");
  else url.searchParams.set("settings", "mcp");
  url.searchParams.set("oauth", input.outcome);
  url.searchParams.set("server", input.serverId);
  return url.toString();
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function notifyRuntimeChanged(deps: McpOAuthHandlerDeps, userId?: string): void {
  try {
    deps.onRuntimeChanged?.(userId);
  } catch {
    // Persistence is authoritative; normal reconciliation retries the kick.
  }
}

async function settleAuthorization(
  deps: McpOAuthHandlerDeps,
  input: Parameters<McpOAuthSettler>[0]
): Promise<boolean> {
  if (!deps.settleAuthorization) return true;
  try {
    return (await deps.settleAuthorization(input)).kind === "ok";
  } catch {
    // Automatic setup failures collapse to the same browser-safe outcome as callback failures.
    return false;
  }
}

async function authorizedSession(
  request: Request,
  deps: McpOAuthHandlerDeps,
  purpose: McpOAuthPurpose
): Promise<
  | { session: AuthenticatedSession; status: null }
  | { session: null; status: 401 | 403 }
> {
  const session = await deps.resolveAuth(request);
  if (!session) return { session: null, status: 401 };
  if (session.user.status !== "active" ||
    (purpose === "validation" && session.user.role !== "admin")) {
    return { session: null, status: 403 };
  }
  return { session, status: null };
}

function serviceError(error: unknown): Response {
  if (!(error instanceof McpOAuthError)) return errorResponse("mcp_oauth_unavailable", 503);
  if (error.code === "mcp_oauth_not_available") return errorResponse(error.code, 404);
  if (error.code === "mcp_oauth_configuration_changed") return errorResponse(error.code, 409);
  if (error.code === "mcp_oauth_policy_forbidden") return errorResponse(error.code, 422);
  return errorResponse(error.code, 502);
}

export function createMcpOAuthStartHandler(
  deps: McpOAuthHandlerDeps,
  options: Readonly<{ forceReconnect: boolean; purpose: McpOAuthPurpose }>
) {
  return async function POST(request: Request, context: McpOAuthRouteContext): Promise<Response> {
    const config = deps.getConfig();
    if (!config.configured) return errorResponse("auth_not_configured", 503);
    const auth = await authorizedSession(request, deps, options.purpose);
    if (!auth.session) {
      return errorResponse(auth.status === 401 ? "unauthorized" : "forbidden", auth.status);
    }
    const session = auth.session;
    const { serverId } = await context.params;
    if (!validServerId(serverId)) return errorResponse("mcp_not_found", 404);
    const redirectUri = new URL(callbackPath(serverId, options.purpose), config.appBaseUrl).toString();
    const state = (deps.randomState ?? randomState)();
    try {
      const result = await deps.service.startAuthorization({
        forceReconnect: options.forceReconnect,
        purpose: options.purpose,
        redirectUri,
        serverId,
        state,
        userId: session.userId
      });
      if (result.kind === "already_connected") {
        const settled = await settleAuthorization(deps, {
          configurationIdentity: result.configurationIdentity,
          purpose: options.purpose,
          serverId,
          userId: session.userId
        });
        if (!settled) {
          return redirect(outcomeUrl({
            appBaseUrl: config.appBaseUrl,
            outcome: "failed",
            purpose: options.purpose,
            serverId
          }));
        }
        notifyRuntimeChanged(deps, options.purpose === "user" ? session.userId : undefined);
        return redirect(outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          outcome: "connected",
          purpose: options.purpose,
          serverId
        }));
      }
      const signed = await signMcpOAuthFlow({
        flow: result.flow,
        now: deps.now?.() ?? new Date(),
        sessionSecret: config.sessionSecret
      });
      return redirect(result.authorizationUrl, mcpOAuthFlowCookie({
        maxAge: MCP_OAUTH_FLOW_MAX_AGE_SECONDS,
        secure: config.cookieSecure,
        value: signed
      }));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createMcpOAuthCallbackHandler(
  deps: McpOAuthHandlerDeps,
  purpose: McpOAuthPurpose
) {
  return async function GET(request: Request, context: McpOAuthRouteContext): Promise<Response> {
    const config = deps.getConfig();
    const { serverId } = await context.params;
    const clearCookie = clearMcpOAuthFlowCookie(config.cookieSecure);
    const failed = () => redirect(outcomeUrl({
      appBaseUrl: config.appBaseUrl,
      outcome: "failed",
      purpose,
      serverId
    }), clearCookie);
    if (!config.configured || !validServerId(serverId)) return failed();
    const auth = await authorizedSession(request, deps, purpose);
    const session = auth.session;
    const flow = await readMcpOAuthFlow({
      now: deps.now?.() ?? new Date(),
      request,
      sessionSecret: config.sessionSecret
    });
    const query = new URL(request.url).searchParams;
    const state = singleValue(query, "state");
    if (!session || !flow || flow.userId !== session.userId || flow.serverId !== serverId ||
      flow.purpose !== purpose || !state || !exactMcpOAuthState(state, flow.state) ||
      flow.redirectUri !== new URL(callbackPath(serverId, purpose), config.appBaseUrl).toString()) {
      return failed();
    }
    const errors = query.getAll("error");
    const codes = query.getAll("code");
    if (errors.length > 1 || codes.length > 1 || (errors.length && codes.length)) return failed();
    if (errors[0]) {
      return redirect(outcomeUrl({
        appBaseUrl: config.appBaseUrl,
        outcome: errors[0] === "access_denied" ? "cancelled" : "failed",
        purpose,
        serverId
      }), clearCookie);
    }
    const authorizationCode = codes[0];
    if (!authorizationCode || authorizationCode.length > 8_192) return failed();
    try {
      await deps.service.completeAuthorization({ authorizationCode, flow });
      const settled = await settleAuthorization(deps, {
        configurationIdentity: flow.configurationIdentity,
        purpose,
        serverId,
        userId: session.userId
      });
      if (!settled) return failed();
      notifyRuntimeChanged(deps, purpose === "user" ? session.userId : undefined);
      return redirect(outcomeUrl({
        appBaseUrl: config.appBaseUrl,
        outcome: "connected",
        purpose,
        serverId
      }), clearCookie);
    } catch {
      // Provider and policy failures intentionally collapse to a browser-safe outcome.
      return failed();
    }
  };
}

export function createMcpOAuthDisconnectHandler(
  deps: McpOAuthHandlerDeps,
  purpose: McpOAuthPurpose
) {
  return async function POST(request: Request, context: McpOAuthRouteContext): Promise<Response> {
    const config = deps.getConfig();
    if (!config.configured) return errorResponse("auth_not_configured", 503);
    const auth = await authorizedSession(request, deps, purpose);
    if (!auth.session) {
      return errorResponse(auth.status === 401 ? "unauthorized" : "forbidden", auth.status);
    }
    const session = auth.session;
    const { serverId } = await context.params;
    if (!validServerId(serverId)) return errorResponse("mcp_not_found", 404);
    try {
      const result = await deps.service.disconnect({ purpose, serverId, userId: session.userId });
      notifyRuntimeChanged(deps, purpose === "user" ? session.userId : undefined);
      return Response.json({
        status: result === "not_found" ? "disconnected" : result
      });
    } catch (error) {
      return serviceError(error);
    }
  };
}
