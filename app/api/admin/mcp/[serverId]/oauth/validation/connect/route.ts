import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { settleDefaultMcpOAuth } from "@/lib/server/mcp/defaultActivation";
import { mcpOAuthService } from "@/lib/server/mcp/defaultOAuth";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpOAuthStartHandler } from "@/lib/server/mcp/oauthHandlers";

export const runtime = "nodejs";

export const POST = createMcpOAuthStartHandler({
  getConfig: getAuthConfig,
  onRuntimeChanged: kickDefaultMcpRuntime,
  resolveAuth: resolveRequestAuth,
  settleAuthorization: settleDefaultMcpOAuth,
  service: mcpOAuthService
}, { forceReconnect: false, purpose: "validation" });
