import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { settleDefaultMcpOAuth } from "@/lib/server/mcp/defaultActivation";
import { mcpOAuthService } from "@/lib/server/mcp/defaultOAuth";
import { personalMcpRateLimiter } from "@/lib/server/mcp/defaultPersonalRateLimit";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpOAuthStartHandler } from "@/lib/server/mcp/oauthHandlers";

export const runtime = "nodejs";

const start: AsyncRouteHandler<ReturnType<typeof createMcpOAuthStartHandler>> = createMcpOAuthStartHandler({
  getConfig: getAuthConfig,
  onRuntimeChanged: kickDefaultMcpRuntime,
  rateLimiter: personalMcpRateLimiter,
  resolveAuth: resolveRequestAuth,
  settleAuthorization: settleDefaultMcpOAuth,
  service: mcpOAuthService,
  userSettingsSection: "connections"
}, { forceReconnect: false, purpose: "user", sourceKind: "personal" });

export { start as POST };
