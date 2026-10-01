import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { settleDefaultMcpOAuth } from "@/lib/server/mcp/defaultActivation";
import { mcpOAuthService } from "@/lib/server/mcp/defaultOAuth";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpOAuthStartHandler } from "@/lib/server/mcp/oauthHandlers";

export const runtime = "nodejs";

const start: AsyncRouteHandler<ReturnType<typeof createMcpOAuthStartHandler>> = createMcpOAuthStartHandler({
  callbackPath: () => "/api/me/connectors/oauth/callback",
  userSettingsSection: "connections",
  getConfig: getAuthConfig,
  onRuntimeChanged: kickDefaultMcpRuntime,
  resolveAuth: resolveRequestAuth,
  settleAuthorization: settleDefaultMcpOAuth,
  service: mcpOAuthService
}, { allowQueryServerId: true, forceReconnect: false, purpose: "user" });

export { start as POST };
