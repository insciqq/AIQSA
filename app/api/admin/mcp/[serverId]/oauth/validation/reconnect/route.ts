import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { settleDefaultMcpOAuth } from "@/lib/server/mcp/defaultActivation";
import { mcpOAuthService } from "@/lib/server/mcp/defaultOAuth";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpOAuthStartHandler } from "@/lib/server/mcp/oauthHandlers";

export const runtime = "nodejs";

const start: AsyncRouteHandler<ReturnType<typeof createMcpOAuthStartHandler>> = createMcpOAuthStartHandler({
  getConfig: getAuthConfig,
  onRuntimeChanged: kickDefaultMcpRuntime,
  resolveAuth: resolveRequestAuth,
  settleAuthorization: settleDefaultMcpOAuth,
  service: mcpOAuthService
}, { forceReconnect: true, purpose: "validation" });

export { start as GET, start as POST };
