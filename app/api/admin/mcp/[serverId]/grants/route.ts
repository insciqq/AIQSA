import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createAdminMcpGrantHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const PUT: AsyncRouteHandler<ReturnType<typeof createAdminMcpGrantHandler>> = createAdminMcpGrantHandler({
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
