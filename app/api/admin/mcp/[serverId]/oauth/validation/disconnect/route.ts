import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpOAuthService } from "@/lib/server/mcp/defaultOAuth";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpOAuthDisconnectHandler } from "@/lib/server/mcp/oauthHandlers";

export const runtime = "nodejs";

export const POST = createMcpOAuthDisconnectHandler({
  getConfig: getAuthConfig,
  onRuntimeChanged: kickDefaultMcpRuntime,
  resolveAuth: resolveRequestAuth,
  service: mcpOAuthService
}, "validation");
